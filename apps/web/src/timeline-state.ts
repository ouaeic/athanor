import type { BotWall, Task, TaskEvent } from './types.js';
import { terminalTaskStatuses } from './task-status.js';
import { harnessRun, type HarnessCheck } from './completion-card.js';

/*
 * What the agent is doing, in the owner's words.
 *
 * Anything missing here falls back to the tool's own name, which is what the waiting owner used to
 * be shown: "browser_snapshot", "parallel_web_read". Two of the keys were `browser` and `desktop`,
 * which are not tools and never matched anything.
 */
const activityLabels: Record<string, string> = {
  browser_action: 'Using the browser',
  browser_snapshot: 'Reading a page',
  code_diagnostics: 'Checking the code',
  code_search: 'Searching the code',
  coding_agent: 'Handing work to a coding agent',
  connector_action: 'Using a connection',
  connector_list: 'Checking connections',
  delegate: 'Splitting the work up',
  desktop_action: 'Using the computer',
  desktop_launch: 'Opening an app',
  desktop_observe: 'Looking at the screen',
  document_read: 'Reading a document',
  document_search: 'Searching a document',
  file_patch: 'Editing a file',
  file_read: 'Reading a file',
  file_write: 'Writing a file',
  files_list: 'Checking files',
  finish: 'Wrapping up',
  generate_media: 'Generating media',
  image_read: 'Inspecting an image',
  memory: 'Updating what it remembers',
  parallel_web_read: 'Reading several pages',
  print_pdf: 'Printing a PDF',
  process: 'Checking a background job',
  publish_artifact: 'Preparing a result',
  publish_preview: 'Preparing the preview',
  publish_site: 'Publishing the site',
  read_elements: 'Checking the page',
  repo_overview: 'Reading the repository',
  schedule: 'Changing scheduled work',
  session_search: 'Searching earlier conversations',
  set_plan: 'Updating the plan',
  shell: 'Running a command',
  skill: 'Updating a skill',
  tool_search: 'Looking for the right tool',
  web_search: 'Searching the web'
};

const eventPayload = (event: TaskEvent): Record<string, unknown> =>
  event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};

/** Any of these arriving after a tool start means that start can no longer be in flight. */
const settlingKinds = new Set(['artifact', 'preview', 'error', 'completed']);

/**
 * A predicate that answers "is this tool start already resolved" in constant time.
 *
 * The obvious implementation — scan forward from each start looking for its result — is quadratic,
 * and it runs on the hottest path there is: a streaming turn rebuilds the whole transcript on every
 * frame. One backwards pass collects everything a start could be waiting on, so the per-event
 * answer becomes a set lookup.
 */
export const settledToolStarts = (
  events: TaskEvent[],
  taskStatus: string
): ((event: TaskEvent) => boolean) => {
  // Nothing can still be in flight once the task itself has stopped.
  if (terminalTaskStatuses.has(taskStatus)) return () => true;
  const settled = new Set<string>();
  const resolvedCallIds = new Set<string>();
  let sawSettlingKind = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === 'tool_started') {
      const toolCallId = eventPayload(event).toolCallId;
      if (sawSettlingKind || (typeof toolCallId === 'string' && resolvedCallIds.has(toolCallId)))
        settled.add(event.id);
    } else if (event.kind === 'tool_result') {
      const toolCallId = eventPayload(event).toolCallId;
      if (typeof toolCallId === 'string') resolvedCallIds.add(toolCallId);
    }
    if (settlingKinds.has(event.kind)) sawSettlingKind = true;
  }
  return (event) => settled.has(event.id);
};

export const activityOverview = (taskStatus: string, events: TaskEvent[]): string => {
  let actionCount = 0;
  let turnCount = 0;
  for (const event of events) {
    if (event.kind === 'tool_started') actionCount += 1;
    else if (event.kind === 'cost') turnCount += 1;
  }
  if (terminalTaskStatuses.has(taskStatus)) {
    const parts = [
      actionCount ? `${actionCount} ${actionCount === 1 ? 'action' : 'actions'}` : '',
      turnCount ? `${turnCount} AI ${turnCount === 1 ? 'turn' : 'turns'}` : ''
    ].filter(Boolean);
    return parts.length ? `${parts.join(' · ')} · finished` : 'Finished';
  }
  if (taskStatus === 'awaiting_user') return 'Waiting for your approval';
  if (taskStatus === 'awaiting_resource') return 'Waiting for the computer';
  if (taskStatus === 'paused') return 'Paused';
  const settled = settledToolStarts(events, taskStatus);
  let current: TaskEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === 'tool_started' && !settled(event)) {
      current = event;
      break;
    }
  }
  if (current) {
    const rawTool = eventPayload(current).tool;
    const tool = typeof rawTool === 'string' ? rawTool : '';
    return activityLabels[tool] ?? current.summary.replace(/^Running\s+/i, '');
  }
  return taskStatus === 'queued' || taskStatus === 'planning' ? 'Preparing the task' : 'Thinking';
};

export const compactResultSummary = (markdown: string, maxLength = 320): string => {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*#>]/g, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxLength) return plain;
  const candidate = plain.slice(0, maxLength + 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('! '),
    candidate.lastIndexOf('? ')
  );
  if (sentenceEnd >= Math.floor(maxLength * 0.55)) return candidate.slice(0, sentenceEnd + 1);
  const wordEnd = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, wordEnd > 0 ? wordEnd : maxLength).trim()}…`;
};

/** Events that belong in the transcript rather than inside a collapsed activity group. */
const conversationalKinds = new Set([
  'user_message',
  'queued_message',
  'assistant_message',
  'assistant_delta',
  'assistant_reasoning',
  'artifact',
  'preview',
  'approval_requested',
  // The answer belongs beside the question. Without this the request sat in the transcript reading
  // "Waiting for your approval" for as long as the conversation existed, while the decision that
  // answered it was filed inside a collapsed activity group - so the one thing the owner might scroll
  // back to check, whether they said yes, was the one thing the transcript would not say.
  'approval_resolved',
  'warning',
  'error',
  'completed'
]);

/**
 * The conversational events that close the work log where they stand.
 *
 * A turn boundary, and the things whose meaning depends on sitting next to what produced them: a
 * decision beside its request, an output card where it was produced, the completion card last.
 * Everything else conversational - the agent's prose, its reasoning, a warning, an error - renders
 * in transcript order without breaking the group, because none of them is a boundary of the work.
 */
const activityBoundary = new Set([
  'user_message',
  'queued_message',
  'approval_requested',
  'approval_resolved',
  'artifact',
  'preview',
  'completed'
]);

export interface ConversationSource {
  url: string;
  host: string;
  title: string;
}

/**
 * What the worker publishes when the agent decides the owner should be told something.
 *
 * Read from the event rather than from the push, because the two answer different questions: the
 * push asks whether a device was awake, and this asks what athanor decided to say. A note reaches
 * the conversation whether or not any device was subscribed to receive it.
 */
const NOTICE_EVENT = 'notice';

export interface AgentNotice {
  /** The line the owner sees on a lock screen: short, and enough to act on. */
  headline: string;
  /** Everything past the headline, which is often nothing. */
  detail: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const firstString = (source: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

export const agentNotice = (event: TaskEvent): AgentNotice | undefined => {
  // Widened deliberately: this client is served by boxes either side of the kind being added, and
  // an unknown kind is a line to render rather than an error to make.
  const kind: string = event.kind;
  if (kind !== NOTICE_EVENT) return undefined;
  const data = eventPayload(event);
  const headline = firstString(data, ['headline']) || event.summary.trim();
  if (!headline) return undefined;
  return { headline, detail: firstString(data, ['detail']) };
};

/**
 * A browser tool result, and only a browser one.
 *
 * The desktop observer returns a holder too, so a look at the screen after a blocked page would
 * otherwise read as the browser being free again.
 */
const browserResult = (event: TaskEvent): Record<string, unknown> | undefined => {
  if (event.kind !== 'tool_result') return undefined;
  const result = record(eventPayload(event).result);
  if (!result || 'activeApplication' in result || 'nodes' in result) return undefined;
  return typeof result.holder === 'string' ? result : undefined;
};

/**
 * The site a challenge is on, which is the part of it a person recognises.
 *
 * One implementation for the transcript, the Computer pane and the conversation card: three copies
 * of a URL parser are three chances to disagree about which page the owner is being sent to.
 */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
};

export const asBotWall = (value: unknown): BotWall | undefined => {
  const wall = record(value);
  if (!wall) return undefined;
  const vendor = firstString(wall, ['vendor']);
  const url = firstString(wall, ['url']);
  const reason = firstString(wall, ['reason']);
  if (!vendor || !url) return undefined;
  const evidence = firstString(wall, ['evidence']);
  return {
    vendor,
    url,
    reason,
    // Both are carried by a current box and by neither an older one nor an older event, and the
    // pane behaves sensibly without them: the banner drops a clause and takes over the front tab.
    ...(evidence === 'page' || evidence === 'response' ? { evidence } : {}),
    ...(typeof wall.tabId === 'string' ? { tabId: wall.tabId } : {})
  };
};

/**
 * Whether waiting is worth anything, which is the only question the owner has about a challenge.
 *
 * The runner records where it saw the evidence, and the two answers are genuinely different: a
 * challenge recognised on the page itself is re-judged against what the tab shows now, so most of
 * them clear a few seconds later on their own; one recognised in the response headers can only be
 * re-tested by making the request again, and that request is exactly the retry that must not
 * happen. A box that predates the field says neither, so this says nothing rather than guessing.
 */
export const botWallClearance = (wall: BotWall): string =>
  wall.evidence === 'page'
    ? 'Many of these clear by themselves within a few seconds — opening the page may be all it needs.'
    : wall.evidence === 'response'
      ? 'This one came back in the site’s own answer, so waiting will not clear it.'
      : '';

/** The code the runner refuses with when a page asks for a person. */
const BOT_WALL_CODE = 'browser_bot_wall';

/**
 * The wall carried by a refusal rather than by a result.
 *
 * `browser_snapshot` returns a challenge in its body, because a snapshot of a challenge page is
 * still a successful read of what the browser is showing. Every other browser route — the search
 * that starts most research, a click, a PDF print — refuses with 409, and the worker records that
 * as an `error` event carrying the same `botWall` fields. Reading only the first is how a challenge
 * raised by a search showed the owner a red "web_search failed" line and no way to take over.
 */
const botWallRefusal = (event: TaskEvent): BotWall | undefined => {
  if (event.kind !== 'error') return undefined;
  const data = eventPayload(event);
  return data.code === BOT_WALL_CODE ? asBotWall(data.botWall) : undefined;
};

/**
 * The conversation stopped because it reached one of the owner's own spending ceilings.
 *
 * The worker writes this as a `status` event whose summary already says what was spent, against
 * what, and in which window — and then pauses the task. `status` is not a conversational kind, so
 * that sentence used to be folded into the collapsed work log under a tick, next to a Resume button
 * that would simply halt again. Recognising it is the difference between "athanor stopped for no
 * reason" and "raise the daily cap, or leave it here".
 */
export interface SpendPause {
  /** The box's own sentence about the ceiling; there is nothing this client can add to it. */
  message: string;
  /** Which ceiling stopped it, when the decision named one. */
  window: 'task' | 'daily' | 'monthly' | '';
}

const spendWindowNames = new Set(['task', 'daily', 'monthly']);

export const spendPause = (event: TaskEvent): SpendPause | undefined => {
  if (event.kind !== 'status') return undefined;
  const data = eventPayload(event);
  // Both fields together are what a halt writes, and no other status event carries either.
  if (!('blockedBy' in data) || !Array.isArray(data.windows)) return undefined;
  const message = event.summary.trim();
  if (!message) return undefined;
  const window = typeof data.blockedBy === 'string' ? data.blockedBy : '';
  return { message, window: spendWindowNames.has(window) ? (window as SpendPause['window']) : '' };
};

/** A browser result that came back without a challenge, which is how a cleared wall is reported. */
const clearsBotWall = (event: TaskEvent): boolean => {
  const result = browserResult(event);
  return Boolean(result) && !asBotWall(result?.botWall);
};

/** The challenge one event recorded, however it arrived. */
export const botWallFromEvent = (event: TaskEvent): BotWall | undefined => {
  const refused = botWallRefusal(event);
  if (refused) return refused;
  const result = browserResult(event);
  return result ? asBotWall(result.botWall) : undefined;
};

/**
 * The challenge the browser is sitting behind right now, or nothing.
 *
 * A wall belongs to the browser session rather than to the conversation, so it outlives the turn
 * that hit it and is only cleared by the owner handing control back — which the next browser
 * result reports by returning without one.
 */
export const activeBotWall = (events: TaskEvent[]): BotWall | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const refused = botWallRefusal(event);
    if (refused) return refused;
    const result = browserResult(event);
    if (result) return asBotWall(result.botWall);
  }
  return undefined;
};

export type ConversationNode =
  | { kind: 'user'; id: string; event: TaskEvent; markdown: string }
  | { kind: 'queued'; id: string; event: TaskEvent; markdown: string }
  | {
      kind: 'assistant';
      id: string;
      event: TaskEvent;
      markdown: string;
      streaming: boolean;
      /** The model that actually answered, from the `cost` event that settles the turn. */
      model?: string;
      /** What this turn settled at, from the nearest following `cost`. */
      costUsd?: number;
      /** Pages the browser actually visited while producing this answer. */
      sources?: ConversationSource[];
    }
  /**
   * The model's own working, shown while it is happening and foldable once it is not.
   *
   * A high-effort step on a full window thinks for the better part of a minute before the first
   * word of the answer, and the owner used to watch a spinner through all of it. Its own node
   * rather than part of the answer, because it is how the answer was reached and not the answer -
   * it is often much longer, and nobody wants it glued to the top of what they asked for.
   */
  | { kind: 'thinking'; id: string; event: TaskEvent; markdown: string; streaming: boolean }
  | { kind: 'activity'; id: string; events: Array<{ event: TaskEvent; index: number }> }
  | { kind: 'output'; id: string; event: TaskEvent }
  | { kind: 'notice'; id: string; event: TaskEvent }
  /** The agent stopped at a challenge and the browser is waiting for the owner. */
  | { kind: 'handoff'; id: string; event: TaskEvent; wall: BotWall }
  /** A spending ceiling the owner set stopped the run; only they can decide what happens next. */
  | { kind: 'paused'; id: string; event: TaskEvent; pause: SpendPause }
  /** Something the agent decided was worth telling the owner, whether or not a device rang. */
  | { kind: 'told'; id: string; event: TaskEvent; notice: AgentNotice }
  /** The owner put the files back to an earlier point while leaving this conversation running. */
  | { kind: 'rewound'; id: string; event: TaskEvent }
  /**
   * `harness` is the acceptance run that let this completion happen. It is published as its own
   * event while the turn is still going — the completion itself carries only one flattened line per
   * check — so it is collected on the way past and handed to the card that reports the ending.
   */
  | { kind: 'completion'; id: string; event: TaskEvent; harness?: HarnessCheck[] };

/**
 * Which activity group the agent is working in right now.
 *
 * Live progress — "Step 3 of 5 · Build the deck" — is a fact about the task, so every group in the
 * transcript was rendering it and a four-turn conversation claimed the agent was in four places at
 * once. Only the newest group is live; the rest are history and say what they did.
 */
export const liveActivityId = (nodes: ConversationNode[]): string | undefined => {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node?.kind === 'activity') return node.id;
  }
  return undefined;
};

/**
 * The pages a turn actually visited, pulled out of the tool results that visited them.
 *
 * One of the three starter prompts promises a briefing with links, and the only record of what a
 * research answer was based on was `JSON.stringify` inside a disclosure that starts closed. The
 * walk is depth-bounded because a browser result can carry a whole accessibility tree.
 */
export const sourcesFromEvents = (events: TaskEvent[]): ConversationSource[] => {
  const found = new Map<string, ConversationSource>();
  const visit = (value: unknown, depth: number, inheritedTitle: string): void => {
    if (found.size >= 12 || depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, inheritedTitle);
      return;
    }
    const record = value as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : inheritedTitle;
    const url = record.url;
    /*
     * A ranked snippet is a link the agent was offered, not a page it read. Search results carry
     * both of these and nothing the agent actually opens does, so without this a single search
     * would put ten uncited addresses under "Sources for this answer".
     */
    const offered = typeof record.rank === 'number' && typeof record.snippet === 'string';
    if (!offered && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      try {
        const parsed = new URL(url);
        const host = parsed.host.replace(/^www\./, '');
        // Same page reached twice in one turn is one source; the query string is part of identity.
        const key = `${host}${parsed.pathname}${parsed.search}`;
        if (!found.has(key)) found.set(key, { url, host, title: title.trim() || host });
      } catch {
        // A malformed URL is not a source.
      }
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1, title);
  };
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    visit(eventPayload(event).result, 0, '');
  }
  return [...found.values()];
};

const payloadText = (event: TaskEvent, key: string): string => {
  const value = eventPayload(event)[key];
  return typeof value === 'string' ? value : '';
};

const assistantMarkdown = (event: TaskEvent): string =>
  (payloadText(event, 'markdown') || event.summary)
    .trim()
    // The worker prefixes some published results with this fragment; it is never useful prose.
    .replace(/^into chat\s*/i, '')
    .trim();

/**
 * A streamed frame carrying only what arrived since the last one.
 *
 * The worker publishes these with `append: true`, because repeating the whole answer in every frame
 * makes the bytes written quadratic in reply length. They are deliberately *not* trimmed: the space
 * between two words routinely lands on a frame boundary, and trimming each frame welds the words on
 * either side of it together.
 */
const streamFragment = (event: TaskEvent): string | undefined =>
  event.kind === 'assistant_delta' && eventPayload(event).append === true
    ? payloadText(event, 'markdown')
    : undefined;

/**
 * Turns the raw event log into an ordered transcript.
 *
 * Two things make this more than a filter. Streaming emits many small assistant events for one
 * answer, so consecutive assistant events must collapse into a single growing node or the reply
 * renders as a cascade of separate bubbles. And tool traffic has to fold into a collapsed group
 * that sits between messages, so the conversation stays readable while every action remains
 * inspectable.
 */
export const buildConversation = (events: TaskEvent[], taskStatus: string): ConversationNode[] => {
  const nodes: ConversationNode[] = [];
  const terminal = terminalTaskStatuses.has(taskStatus);
  const settled = settledToolStarts(events, taskStatus);
  // Whether the assistant node currently at the tail was built by streamed frames. A settled
  // answer is not extended by the next turn's first frame, and only a streamed node is superseded
  // by the message that closes it.
  let openStreamed = false;
  // Queued notices are retired by matching text, which was an O(n) rescan of the whole log per
  // notice. The set of texts that actually ran is the same answer for one pass.
  const ranMessages = new Set<string>();
  for (const event of events)
    if (event.kind === 'user_message') ranMessages.add(payloadText(event, 'markdown'));
  let activity: Array<{ event: TaskEvent; index: number }> = [];
  /*
   * The site whose challenge is currently standing.
   *
   * A blocked search is retried, and the next two calls to the same site are refused the same way,
   * so one challenge can produce three or four refusals in a single turn. The first is news; the
   * rest are the same fact and stay in the work log rather than repeating a card that fills the
   * screen. A clean browser result means the wall is gone, so the next one is news again.
   */
  let standingWallSite = '';

  /*
   * Which model answered, and what the turn cost, both come from the `cost` event that settles the
   * turn — it is the only event that records either. The plan event was read for a `model` field it
   * has never carried, so every answer in the product was labelled with the time and the price and
   * no model at all, on a client whose default is to pick the model automatically per turn.
   *
   * A streaming provider settles the cost after the frames and before the closing message, so the
   * answer is already on screen and is patched in place. A non-streaming one settles it first, and
   * then the model waits here for exactly one answer — carrying it further would label a turn with
   * the model that wrote the one before it.
   */
  let pendingModel = '';
  let pendingSources: ConversationSource[] = [];
  /**
   * The last acceptance run the harness published, waiting for the completion it belongs to.
   *
   * A finish that fails its own checks is refused and tried again, so one turn can publish several
   * runs; the one that matters is the last, because it is the one that let the turn end. It is
   * cleared onto the completion rather than carried past it, so a second turn that declares nothing
   * cannot inherit the first turn's ticks.
   */
  let pendingHarness: HarnessCheck[] | undefined;
  /**
   * Where the answer being built lives, tracked rather than assumed to be the tail. Tool traffic and
   * the turn's own cost event flush an activity group between the last streamed frame and the
   * settled message that closes it, so "the last node" stopped being the answer exactly when the
   * answer needed closing — and the settled message became a second copy of the whole reply.
   */
  let openAssistantIndex = -1;
  const openAnswer = (): Extract<ConversationNode, { kind: 'assistant' }> | undefined => {
    const node = openAssistantIndex >= 0 ? nodes[openAssistantIndex] : undefined;
    return node?.kind === 'assistant' ? node : undefined;
  };
  /** Anything addressed to the owner other than the answer itself ends it. */
  const closeAnswer = (): void => {
    openStreamed = false;
    openAssistantIndex = -1;
  };
  /*
   * The turn's thinking, held by position rather than by being whatever happens to be last.
   *
   * `thinkingStepStart` is where the current model step's reasoning begins inside that node. A step
   * closes with its `cost` event, and the row that carries a whole step's reasoning (`replace`)
   * supersedes only its own step. Without that scoping a node spanning several steps would be
   * truncated back to one step's text by the first `replace` row to arrive - the earlier steps'
   * reasoning silently deleted - and without holding the node by index, that row lands after the
   * answer and renders the same thinking a second time underneath it.
   */
  let openThinkingIndex = -1;
  let thinkingStepStart = 0;
  const openThinking = (): Extract<ConversationNode, { kind: 'thinking' }> | undefined => {
    const node = openThinkingIndex >= 0 ? nodes[openThinkingIndex] : undefined;
    return node?.kind === 'thinking' ? node : undefined;
  };

  /*
   * Where the work log belongs, remembered from when its first entry arrived.
   *
   * The group is placed where the agent started working, but it is not closed until the turn ends,
   * so it collects everything the turn did rather than everything it did between two thoughts. The
   * two used to be the same moment, which is why one file write rendered as six work logs: every
   * reasoning frame closed the open group and started another.
   */
  let activityAnchor = -1;
  const openActivity = (event: TaskEvent, index: number): void => {
    if (activityAnchor < 0) activityAnchor = nodes.length;
    activity.push({ event, index });
    /*
     * Sources are collected as the pages are read, not when the group is closed. The group now
     * stays open until the end of the turn, and the answer it feeds is written before that - so
     * reading them off the flush cited nothing at all.
     */
    const seen = new Set(pendingSources.map((source) => source.url));
    for (const source of sourcesFromEvents([event]))
      if (!seen.has(source.url)) {
        seen.add(source.url);
        pendingSources = [...pendingSources, source];
      }
  };

  const flushActivity = (): void => {
    if (!activity.length) {
      activityAnchor = -1;
      return;
    }
    const at = activityAnchor >= 0 ? activityAnchor : nodes.length;
    nodes.splice(at, 0, {
      kind: 'activity',
      id: `activity-${activity[0]!.event.id}`,
      events: activity
    });
    // Everything the group was inserted in front of has moved down one.
    if (openAssistantIndex >= at) openAssistantIndex += 1;
    if (openThinkingIndex >= at) openThinkingIndex += 1;
    activity = [];
    activityAnchor = -1;
  };

  events.forEach((event, index) => {
    // Taken wherever it lands: the harness publishes a run as a status event when it passes and
    // repeats it on the warning that refuses a finish, and both are ordinary work-log entries that
    // would otherwise be folded into a collapsed group and never reach the card.
    const run = harnessRun(event);
    if (run) pendingHarness = run;
    /*
     * Two things the agent does are addressed to the owner rather than to the model, and both used
     * to be buried in the collapsed activity group: a message it chose to send, and the stop it
     * cannot get past on its own. A conversation is where a person reads both.
     */
    const notice = agentNotice(event);
    if (notice) {
      flushActivity();
      closeAnswer();
      nodes.push({ kind: 'told', id: event.id, event, notice });
      return;
    }
    const pause = spendPause(event);
    if (pause) {
      flushActivity();
      closeAnswer();
      nodes.push({ kind: 'paused', id: event.id, event, pause });
      return;
    }
    /*
     * Taking only the computer back forks nothing, so the rewind dialog promises the conversation
     * carries on "with a line in it recording what happened to the files". The server writes that
     * line as a `status` event — a kind that is folded into the collapsed activity strip, where the
     * one thing an owner has to be able to find afterwards was invisible.
     */
    if (event.kind === 'status' && eventPayload(event).filesystemRestored === true) {
      flushActivity();
      closeAnswer();
      nodes.push({ kind: 'rewound', id: event.id, event });
      return;
    }
    const wall = botWallFromEvent(event);
    if (wall) {
      const site = hostOf(wall.url);
      if (site && site === standingWallSite) {
        openActivity(event, index);
        return;
      }
      standingWallSite = site;
      flushActivity();
      closeAnswer();
      nodes.push({ kind: 'handoff', id: event.id, event, wall });
      return;
    }
    if (standingWallSite && clearsBotWall(event)) standingWallSite = '';
    if (!conversationalKinds.has(event.kind)) {
      if (event.kind === 'cost') {
        const metadata = record(eventPayload(event).metadata);
        const model = typeof metadata?.model === 'string' ? metadata.model.trim() : '';
        const answer = openAnswer();
        const spent = eventPayload(event).costUsd;
        if (answer) {
          nodes[openAssistantIndex] = {
            ...answer,
            ...(answer.costUsd === undefined && typeof spent === 'number'
              ? { costUsd: spent }
              : {}),
            ...(answer.model === undefined && model ? { model } : {})
          };
          // Spent on the answer it belongs to; the next one gets its own.
          pendingModel = '';
        } else pendingModel = model;
        // A model step ends here, so the next step's reasoning starts after everything written so
        // far and a `replace` row can no longer reach back past it.
        thinkingStepStart = openThinking()?.markdown.length ?? 0;
        /*
         * And it goes no further. What was spent is already on the answer and in the conversation
         * total; inside the work log it rendered as a "Step 4 completed" row per model call, which
         * is a disclosure opening onto a counter.
         */
        return;
      }
      // A tool start that already has its result is noise while running and redundant once the
      // task is finished; the matching tool_result carries the same label plus the outcome.
      if (event.kind === 'tool_started' && settled(event)) return;
      openActivity(event, index);
      return;
    }
    /*
     * A turn is the unit, not a step.
     *
     * This used to flush on every conversational event, so anything the agent said or thought
     * mid-turn closed the work log and opened another - six of them, plus four thinking rows, for
     * a task that wrote two bytes. Only the boundaries below actually need the group closed: the
     * end of the turn, and the things that must be read in place next to what produced them. The
     * agent's own reasoning and prose are not among them, and no test protected that.
     */
    if (activityBoundary.has(event.kind)) flushActivity();

    if (event.kind === 'assistant_reasoning') {
      // Frames append onto the open thinking node, and a new turn opens a new one - the same rule
      // the answer stream follows, for the same reason: gluing two turns together reads as one.
      //
      // The row that closes the turn's thinking carries the whole of it with `replace`, so that the
      // frames underneath it can be dropped from the log. It supersedes the open node rather than
      // extending it: a client that watched the stream has those frames already, and appending
      // would show the same thinking twice over.
      //
      // Frames merge whether the task is still running or is being replayed. Merging used to be
      // for live turns only, so a conversation reloaded after it finished broke the one block its
      // author had watched arrive into a frame-by-frame stack of identical "How it got there"
      // rows - forty of them for a turn that streamed as one. The reader of a finished task is
      // owed what the reader of a running one saw.
      const markdown = payloadText(event, 'markdown');
      const whole = eventPayload(event).replace === true;
      const open = openThinking();
      if (open) {
        // `replace` carries one model step's whole reasoning, so it supersedes that step and not
        // the ones before it in the same turn.
        const kept = whole ? open.markdown.slice(0, thinkingStepStart) : open.markdown;
        const separator = whole && kept && !kept.endsWith('\n\n') ? '\n\n' : '';
        nodes[openThinkingIndex] = {
          ...open,
          markdown: kept + separator + markdown,
          streaming: !terminal
        };
        return;
      }
      openThinkingIndex = nodes.length;
      thinkingStepStart = 0;
      nodes.push({ kind: 'thinking', id: event.id, event, markdown, streaming: !terminal });
      return;
    }

    if (event.kind === 'assistant_message' || event.kind === 'assistant_delta') {
      // The answer arriving closes the thinking that produced it.
      const thinking = openThinking();
      if (thinking?.streaming) nodes[openThinkingIndex] = { ...thinking, streaming: false };
      const open = openAnswer();
      const fragment = streamFragment(event);
      const streaming = event.kind === 'assistant_delta' && !terminal;
      /*
       * Three shapes reach this branch, and they merge differently.
       *
       * A fragment is only the newest slice of the answer, so it concatenates onto the node its own
       * stream built — and onto nothing else, since the next turn's first frame lands on a settled
       * answer and gluing there would run two turns together.
       *
       * The settled `assistant_message` closes the stream that produced it and supersedes the
       * frames rather than following them; the worker normalises the final text, so the two are not
       * required to match.
       *
       * A cumulative snapshot (`replace`, or a payload from a server predating fragment frames)
       * carries everything so far, so it extends the node it is a prefix of. That path stays
       * because the event log is persistent and old conversations are replayed by this client.
       */
      if (fragment !== undefined && openStreamed && open) {
        nodes[openAssistantIndex] = {
          ...open,
          event,
          markdown: `${open.markdown}${fragment}`,
          streaming
        };
        return;
      }
      const markdown = fragment === undefined ? assistantMarkdown(event) : fragment.trimStart();
      if (!markdown) return;
      if (open && fragment === undefined) {
        const supersedes = event.kind === 'assistant_message' && openStreamed;
        const snapshot = markdown.startsWith(open.markdown) || open.markdown.startsWith(markdown);
        if (supersedes || snapshot) {
          const merged =
            supersedes || markdown.length >= open.markdown.length ? markdown : open.markdown;
          nodes[openAssistantIndex] = {
            ...open,
            // The node answers to the newest event that shaped it, so Retry and Branch anchor to
            // the settled message rather than to whichever frame happened to be longest.
            event: merged === open.markdown && !supersedes ? open.event : event,
            markdown: merged,
            streaming
          };
          openStreamed = event.kind === 'assistant_delta';
          return;
        }
      }
      openAssistantIndex = nodes.length;
      nodes.push({
        kind: 'assistant',
        id: event.id,
        event,
        markdown,
        streaming,
        ...(pendingModel ? { model: pendingModel } : {}),
        ...(pendingSources.length ? { sources: pendingSources } : {})
      });
      // Both consumed: the pages and the model belong to the answer they were recorded for, not to
      // every answer after it.
      pendingSources = [];
      pendingModel = '';
      openStreamed = event.kind === 'assistant_delta';
      return;
    }
    closeAnswer();
    /*
     * A turn boundary. The next turn's reasoning starts a block of its own rather than continuing
     * the last one, which is what keeps two turns from reading as one.
     */
    if (event.kind === 'user_message' || event.kind === 'queued_message') {
      openThinkingIndex = -1;
      thinkingStepStart = 0;
    }

    if (event.kind === 'user_message') {
      nodes.push({
        kind: 'user',
        id: event.id,
        event,
        markdown: payloadText(event, 'markdown') || event.summary
      });
      return;
    }
    if (event.kind === 'queued_message') {
      // A queued message is promoted into a real user_message when it runs. Showing both would
      // leave a permanent "waiting" notice under a message that already ran.
      const markdown = payloadText(event, 'markdown') || event.summary;
      if (ranMessages.has(markdown)) return;
      nodes.push({ kind: 'queued', id: event.id, event, markdown });
      return;
    }
    if (event.kind === 'artifact' || event.kind === 'preview') {
      nodes.push({ kind: 'output', id: event.id, event });
      return;
    }
    if (event.kind === 'completed') {
      nodes.push({
        kind: 'completion',
        id: event.id,
        event,
        ...(pendingHarness ? { harness: pendingHarness } : {})
      });
      pendingHarness = undefined;
      return;
    }
    nodes.push({ kind: 'notice', id: event.id, event });
  });

  flushActivity();
  return nodes;
};

/**
 * Folds one arriving stream frame into the event list.
 *
 * The stream delivers events in ascending `sequence`, so the overwhelmingly common case is a tail
 * append. Sorting the whole array again — on an array that is already sorted — for every one of the
 * hundreds of frames a single long answer produces is pure waste; a binary search covers the rare
 * out-of-order or replayed frame for the same result.
 */
export const mergeTaskEvent = (events: TaskEvent[], incoming: TaskEvent): TaskEvent[] => {
  const last = events[events.length - 1];
  if (!last) return [incoming];
  if (incoming.sequence > last.sequence) return [...events, incoming];

  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle]!.sequence < incoming.sequence) low = middle + 1;
    else high = middle;
  }
  // Sequences are allocated per task and are normally unique, but a reconnect can replay one, so
  // the whole run at this sequence is checked before inserting.
  for (
    let index = low;
    index < events.length && events[index]!.sequence === incoming.sequence;
    index += 1
  )
    if (events[index]!.id === incoming.id) return events;
  return [...events.slice(0, low), incoming, ...events.slice(low)];
};

export interface PendingUserMessage {
  id: string;
  taskId: string | undefined;
  markdown: string;
  createdAt: string;
}

/**
 * Shows the message the moment Enter is pressed instead of when the server echoes it back.
 *
 * Acknowledgment is local and instant; the round trip only decides when the agent starts. The
 * optimistic node disappears on its own as soon as the real `user_message` arrives, so there is no
 * reconciliation step that can leave a duplicate behind.
 */
export const withPendingMessage = (
  events: TaskEvent[],
  pending: PendingUserMessage | undefined
): TaskEvent[] => {
  if (!pending) return events;
  const text = pending.markdown.trim();
  if (!text) return events;
  const echoed = events.some(
    (event) =>
      (event.kind === 'user_message' || event.kind === 'queued_message') &&
      (payloadText(event, 'markdown') || event.summary).trim() === text
  );
  if (echoed) return events;
  return [
    ...events,
    {
      id: pending.id,
      taskId: pending.taskId ?? '',
      sequence: (events[events.length - 1]?.sequence ?? 0) + 1,
      kind: 'user_message',
      summary: text,
      payload: { markdown: text },
      createdAt: pending.createdAt
    }
  ];
};

const statusAnnouncements: Record<string, string> = {
  queued: 'Work queued.',
  planning: 'The agent is planning.',
  running: 'The agent is working.',
  awaiting_user: 'The agent needs your approval.',
  awaiting_resource: 'The agent is waiting on a resource. It can be resumed.',
  paused: 'Paused.',
  completed: 'Work finished.',
  failed: 'The work stopped with a problem.',
  cancelled: 'Stopped.'
};

/** One short sentence per state change, for the transcript's live region. */
export const taskStateAnnouncement = (title: string, status: string): string =>
  `${title}: ${statusAnnouncements[status] ?? status.replace('_', ' ')}`;

/** Rolled-up cost for the whole task, for the one place the user should see it. */
export const conversationCost = (
  events: TaskEvent[]
): { costUsd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number } => {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const event of events) {
    if (event.kind !== 'cost') continue;
    const payload = eventPayload(event);
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    const numeric = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0;
    costUsd += numeric(payload.costUsd);
    inputTokens += numeric(usage.inputTokens);
    outputTokens += numeric(usage.outputTokens);
    cachedInputTokens += numeric(usage.cachedInputTokens);
  }
  return { costUsd, inputTokens, outputTokens, cachedInputTokens };
};

export interface ForkFamily {
  /** Every version of this point in the conversation, oldest first. */
  versions: Task[];
  /** Position of the currently open task within `versions`, 0-based. */
  index: number;
  /** Forks that branch off the open task itself, rather than sharing its parent. */
  children: Task[];
  parent: Task | undefined;
}

/**
 * Editing a prompt, retrying an answer, or branching creates a whole sibling task rather than
 * mutating history. Grouping the original with every fork taken from the same event reconstructs
 * the familiar "version 2 of 3" switcher from that flat list.
 */
export const forkFamily = (task: Task, tasks: Task[]): ForkFamily => {
  const byCreation = (left: Task, right: Task): number =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  const children = tasks.filter((item) => item.parentTaskId === task.id).sort(byCreation);
  const parent = task.parentTaskId
    ? tasks.find((item) => item.id === task.parentTaskId)
    : undefined;

  if (!parent || !task.branchedFromEventId) return { versions: [], index: -1, children, parent };

  const siblings = tasks
    .filter(
      (item) =>
        item.parentTaskId === parent.id && item.branchedFromEventId === task.branchedFromEventId
    )
    .sort(byCreation);
  const versions = [parent, ...siblings];
  return {
    versions,
    index: versions.findIndex((item) => item.id === task.id),
    children,
    parent
  };
};

/**
 * The conversation as text somebody can paste somewhere else.
 *
 * Tool activity is left out on purpose: this is for the answer that was worked out, not the log of
 * how. Everything it needs is already decrypted in the client, so there is no server involved.
 */
export const conversationMarkdown = (title: string, events: TaskEvent[]): string => {
  const lines: string[] = [`# ${title}`, ''];
  for (const node of buildConversation(events, 'completed')) {
    if (node.kind === 'user' || node.kind === 'queued') {
      lines.push('## You', '', node.markdown.trim(), '');
      continue;
    }
    if (node.kind === 'assistant') {
      lines.push('## athanor', '', node.markdown.trim(), '');
      continue;
    }
    // A note the agent sent while nobody was watching is part of what was said, not part of the log.
    if (node.kind === 'told') {
      lines.push('## athanor', '', node.notice.headline, '');
      if (node.notice.detail) lines.push(node.notice.detail, '');
      continue;
    }
    if (node.kind === 'output') {
      const data = eventPayload(node.event);
      const name = typeof data.name === 'string' ? data.name : node.event.summary;
      const url = typeof data.url === 'string' ? data.url : '';
      lines.push(url ? `- ${name}: ${url}` : `- ${name}`, '');
      continue;
    }
    if (node.kind === 'completion') {
      const summary = eventPayload(node.event).summary;
      lines.push('## Result', '', typeof summary === 'string' ? summary : node.event.summary, '');
    }
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
};

/**
 * How hard the model was told to think on this step. It varies per step and it is the single
 * biggest lever on what a step costs, so it belongs next to the cost rather than in a payload.
 */
export const reasoningEffortLabel = (value: unknown): string =>
  value === 'low' || value === 'medium' || value === 'high' ? `${value} reasoning effort` : '';

export const formatTokens = (count: number): string =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1_000
      ? `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`
      : String(count);

/**
 * How long a preview lasts, said the way the box actually behaves.
 *
 * The deadline on a private preview is an idle window that every visit pushes back out, so
 * "expires 3 September" was wrong in the direction that matters: it reads as a countdown on an app
 * the owner opens every day, and it used to be a real one — two hours, chosen by this client. A
 * published site has no deadline at all.
 */
export const previewLifetime = (expiresAt: string | null | undefined): string => {
  const closesAt = expiresAt ? new Date(expiresAt) : undefined;
  return !closesAt || Number.isNaN(closesAt.getTime())
    ? 'stays available'
    : `closes if unused by ${closesAt.toLocaleDateString()}`;
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1_000;
  let index = 0;
  while (value >= 1_000 && index < units.length - 1) {
    value /= 1_000;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};
