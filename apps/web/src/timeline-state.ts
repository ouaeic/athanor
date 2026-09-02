import type { BotWall, Task, TaskEvent } from './types.js';
import { taskIsGenerating, terminalTaskStatuses } from './task-status.js';
import { harnessRun, type HarnessCheck } from './completion-card.js';
import { externalRead } from './provenance.js';
import { fileChangesFromTool, type FileChange } from './diff.js';

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
  // One line for both reaches: this table is keyed on the tool name and the two publishing tools
  // merged onto a `reach` argument it cannot see. "Preparing the preview" over a public deployment
  // would be the wrong half of that.
  publish_preview: 'Publishing a link',
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

/**
 * What one call is, in the owner's words, wherever it is printed.
 *
 * The table above was read only by the one line under the work log's heading. Inside the log, every
 * row printed the worker's own sentence — "shell", "file_write completed" — so a single screen
 * described the same action in two registers, the machine's underneath the owner's. The table
 * already covers all thirty tools; nothing here needed writing except the export.
 *
 * `ledgerRow` splits what comes back at its first space, because every entry is written as a verb
 * and its object. A label added here that is not will read as a verb with no subject; that is the
 * only thing the shape of this table now has to hold.
 */
export const toolLabel = (tool: string, fallback: string): string =>
  activityLabels[tool] ?? fallback.replace(/^Running\s+/i, '');

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

/** Events that belong in the transcript rather than among the steps in the turn ledger. */
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
  // The agent stopping to ask something is the most conversational thing in the log: it is the one
  // event whose whole purpose is to be read and replied to, and folded into the work log it would be
  // a question nobody was shown.
  'question_asked',
  'completed'
]);

/**
 * What a folded run of narration is called on the event itself, for anything that reads a summary
 * rather than the row. The ledger draws it as one word, `thought`, and no subject.
 */
export const NARRATION_SUMMARY = 'Thinking out loud';

/** A run of streamed frames ends here, unclassified, and whatever it holds stays an answer. */
const closesStream = new Set([
  // The consolidated reply. Its arrival is the whole test: the worker publishes one for every step
  // whose content the owner is meant to read, so a run it closes is an answer by construction.
  'assistant_message',
  'user_message',
  'queued_message',
  'question_asked',
  'completed'
]);

/**
 * The streamed frames that are the model working out loud rather than answering.
 *
 * Measured on one live task: 1,015 `assistant_delta` frames against 29 `assistant_reasoning`, for
 * five consolidated replies. The model was putting its deliberation in the content channel - "let
 * me think about what gives the cleanest true result", and worse - and this client promotes content
 * as the answer, so the owner's reading column filled with it and the five real replies were buried.
 * The contract now says where thinking goes; a model will narrate anyway, and this is what stops
 * the narration being promoted.
 *
 * The rule is the one the client can actually apply, from evidence it already holds. A run of
 * frames that the worker went on to consolidate into an `assistant_message` is an answer - that is
 * exactly what the worker publishes that message for. A run it never consolidated, that ends
 * because the turn reached for a tool, is prose written between two tool calls, which is narration.
 * Everything else - a run still arriving, a run the turn ended on - is left alone and reads as an
 * answer, because the cost of folding a genuine reply away is far higher than the cost of promoting
 * one paragraph of narration.
 *
 * Note what this deliberately does *not* fold: an answer that streams, is consolidated, and is then
 * followed by more tool calls. That is the ordinary shape of a turn that says something and carries
 * on working, and it stays an answer.
 *
 * What makes that safe is one fact about the other side, and it is worth writing down here because
 * nothing else joins the two: the worker publishes a step's `assistant_message` *before* it starts
 * any of that step's tools. So a run this rule folds is never a reply the worker meant to publish
 * and this client happened to miss - it is a run the worker itself declined to consolidate, which
 * it does in exactly one case, a step the harness asked for rather than the owner (a rejected
 * finish, a held plan, an acceptance hold, a failed check, the completion nag). The client is
 * agreeing with a decision already taken, not taking one. If that emit ever moves after the tool
 * loop, every answer in the product folds into the work log at once - so if this rule starts
 * swallowing replies, look there first and not here.
 */
export const narratedDeltas = (events: TaskEvent[]): Set<string> => {
  const narrated = new Set<string>();
  let run: string[] = [];
  for (const event of events) {
    if (event.kind === 'assistant_delta') {
      run.push(event.id);
      continue;
    }
    if (!run.length) continue;
    if (event.kind === 'tool_started') {
      for (const id of run) narrated.add(id);
      run = [];
      continue;
    }
    if (closesStream.has(event.kind)) run = [];
  }
  return narrated;
};

/**
 * The warnings and errors that are the owner's business rather than the machine's.
 *
 * Measured on a live run: writing a two-line haiku produced a transcript whose visible content was
 * an amber "This turn has no undo point for the computer", a red "file_write failed" the agent had
 * already recovered from, and a cost line. The verse was the third thing on the page. Almost every
 * warning athanor writes is a note to itself about something it went on to handle, and those belong
 * in the work log with the rest of the machinery; the few that need the owner to act, or that they
 * would want to know happened, are marked at the site that raises them.
 */
const ownerFacing = (event: TaskEvent): boolean =>
  (event.kind === 'warning' || event.kind === 'error') && eventPayload(event).owner === true;

/**
 * And the crossing, which is a warning by kind and a divider by nature.
 *
 * The event that records outside content entering a turn is published as a `warning`, but it is not
 * one: it is drawn as a change of character in the conversation, and it is the single fact that
 * changes how everything below it should be read. Folding it away with the recovered machinery
 * would take out the one piece of evidence this overhaul exists to promote.
 */
const staysInTranscript = (event: TaskEvent): boolean =>
  ownerFacing(event) || externalRead(event) !== undefined;

/**
 * The conversational events that close the ledger where they stand.
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
  // The work stopped here and did not resume until the owner wrote back, so the group of steps
  // before the question and the group after the answer are two different stretches of work.
  'question_asked',
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

export interface AgentQuestion {
  /** The question, in the agent's own words. */
  question: string;
  /** What it cannot do until this is answered, which is what makes the question worth a stop. */
  why: string;
  /** The answers it would act on. Empty means any reply will do. */
  options: string[];
}

/**
 * The question card's contents, read out of the event.
 *
 * Written here rather than in the component for the same reason `agentNotice` is: the shapes a box
 * either side of this client can send are a thing to test, and a card that renders an empty question
 * is worse than no card. The summary is the fallback because the worker writes the question into it.
 */
export const agentQuestion = (event: TaskEvent): AgentQuestion | undefined => {
  const kind: string = event.kind;
  if (kind !== 'question_asked') return undefined;
  const data = eventPayload(event);
  const question = firstString(data, ['question']) || event.summary.trim();
  if (!question) return undefined;
  const options = Array.isArray(data.options)
    ? data.options
        .map((option) => (typeof option === 'string' ? option.trim() : ''))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  return { question, why: firstString(data, ['why']), options };
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
  | { kind: 'activity'; id: string; events: ActivityEntry[] }
  | { kind: 'output'; id: string; event: TaskEvent }
  /**
   * `resolution` is present on an approval that has since been answered, and on a question the owner
   * has since replied to; the two render as one. Nothing about it is approval-shaped - it is the
   * event that ended the wait, which for a question is the owner's own message.
   */
  | { kind: 'notice'; id: string; event: TaskEvent; resolution?: TaskEvent }
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
 * Every address anywhere inside one tool result, depth-bounded because a browser result can carry
 * a whole accessibility tree. Lifted out of `sourcesFromEvents` so it stays one walk with one set
 * of rules about what counts.
 */
const collectSources = (
  value: unknown,
  found: Map<string, ConversationSource>,
  depth: number,
  inheritedTitle: string
): void => {
  if (found.size >= 12 || depth > 4 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, found, depth + 1, inheritedTitle);
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
  for (const nested of Object.values(record)) collectSources(nested, found, depth + 1, title);
};

/**
 * The pages a turn actually visited, pulled out of the tool results that visited them.
 *
 * One of the three starter prompts promises a briefing with links, and the only record of what a
 * research answer was based on was `JSON.stringify` inside a disclosure that starts closed.
 */
export const sourcesFromEvents = (events: TaskEvent[]): ConversationSource[] => {
  const found = new Map<string, ConversationSource>();
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    collectSources(eventPayload(event).result, found, 0, '');
  }
  return [...found.values()];
};

/**
 * A tool call, joined back together from the two events that record it.
 *
 * The worker publishes the arguments on `tool_started` and the outcome on `tool_result`, keyed to
 * each other by `toolCallId`. Nothing in this client ever joined them, so every finished call in
 * every finished conversation rendered as its result alone — and a result on its own cannot say
 * which file it wrote or which command it ran, because those facts are in the arguments.
 */
export interface ToolCall {
  /** The tool as the worker named it: `file_patch`, `shell`, `browser_snapshot`. */
  tool: string;
  /** What the call was made with, from the start that opened it. */
  arguments: unknown;
  /** What the file held before a `file_write`, when this conversation read it whole first. */
  before?: string;
}

/** One row of the ledger: an event, and the call it belongs to where there is one. */
export interface ActivityEntry {
  event: TaskEvent;
  index: number;
  call?: ToolCall;
}

/**
 * What a finished call actually did, in the shape a person should read it in.
 *
 * The alternative — and what shipped — is `JSON.stringify(result)` at 9px, which for a file write
 * is a hash and a byte count, for a command is its own output re-escaped, and for a page read is a
 * whole accessibility tree. All three of those are the same evidence in a form nobody reads.
 */
export type WorkEvidence =
  | { kind: 'files'; changes: FileChange[] }
  /** `status` is empty for a command that succeeded: an exit code of zero is not news. */
  | { kind: 'command'; command: string; status: string; output: string }
  | { kind: 'pages'; pages: ConversationSource[] };

/** Shell metacharacters. A word holding any of them is quoted so the line can be pasted as read. */
const NEEDS_QUOTING = /[^\w@%+=:,./-]/;

const shellWord = (word: string): string =>
  word === '' || NEEDS_QUOTING.test(word) ? `'${word.replace(/'/g, `'\\''`)}'` : word;

/**
 * The command as it would be typed.
 *
 * `shell` takes an executable and an argument vector rather than a line, precisely so that nothing
 * expands — but an owner checking what ran wants the line, not a JSON array of eleven strings.
 */
const commandLine = (args: Record<string, unknown>): string => {
  const executable = typeof args.executable === 'string' ? args.executable : '';
  if (!executable) return '';
  const rest = Array.isArray(args.args) ? args.args : [];
  return [executable, ...rest.map((word) => String(word))].map(shellWord).join(' ');
};

/**
 * How much of a command's output is promoted, and which end of it.
 *
 * The tail, because a command is being looked at for how it ended: the failing assertion, the last
 * line of a build. Everything above it is still one disclosure away in the raw result, so this
 * bounds what is drawn without hiding anything.
 */
const OUTPUT_LINES = 40;
const OUTPUT_CHARS = 8_000;

const boundedOutput = (text: string): string => {
  const lines = text.replace(/\s+$/, '').split('\n');
  const kept =
    lines.length > OUTPUT_LINES
      ? `[${lines.length - OUTPUT_LINES} earlier lines not shown]\n${lines
          .slice(-OUTPUT_LINES)
          .join('\n')}`
      : lines.join('\n');
  // A single line can be a megabyte of minified output, which the line count alone would let past.
  return kept.length > OUTPUT_CHARS ? `…${kept.slice(-OUTPUT_CHARS)}` : kept;
};

const commandStatus = (result: Record<string, unknown>): string => {
  if (typeof result.sessionId === 'string' && result.sessionId) return 'still running';
  if (result.timedOut === true) return 'timed out';
  if (typeof result.signal === 'string' && result.signal) return `stopped by ${result.signal}`;
  const exitCode = result.exitCode;
  return typeof exitCode === 'number' && exitCode !== 0 ? `exit ${exitCode}` : '';
};

/** The tools whose result is a page the browser actually loaded, rather than links it was offered. */
const pageReads = new Set([
  'browser_action',
  'browser_snapshot',
  'parallel_web_read',
  'read_elements'
]);

/**
 * The page or pages one read loaded, and nothing else that happens to carry an address.
 *
 * Deliberately not the deep walk `sourcesFromEvents` uses. A browser result carries the page's own
 * `url` and `title` at the top and a whole accessibility tree underneath it, so walking it listed
 * every link on the page as a page that had been read - measured on one snapshot of a pricing page:
 * two identical-looking rows, because a nested link inherits the title of the page it sits on.
 * A read went to its own address, and `parallel_web_read` reports each of its own in `sources`.
 */
const pagesRead = (result: unknown): ConversationSource[] => {
  const found = new Map<string, ConversationSource>();
  const add = (value: unknown): void => {
    const page = record(value);
    if (!page) return;
    // `requestedUrl` is where the read meant to go, which is the honest address when a redirect or
    // a failure means the final one is missing.
    const url = firstString(page, ['url', 'requestedUrl']);
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const parsed = new URL(url);
      const host = parsed.host.replace(/^www\./, '');
      const key = `${host}${parsed.pathname}${parsed.search}`;
      if (!found.has(key))
        found.set(key, { url, host, title: firstString(page, ['title']) || host });
    } catch {
      // A malformed URL is not a page.
    }
  };
  const outcome = record(result);
  if (!outcome) return [];
  add(outcome);
  for (const entry of Array.isArray(outcome.sources) ? outcome.sources.slice(0, 12) : [])
    add(entry);
  return [...found.values()];
};

/**
 * The evidence one call produced, or nothing when the raw result is all there is.
 *
 * Pure, and taking the joined call rather than the events, so the three shapes this promotes are
 * decided in a module a test can reach rather than inside a React branch.
 */
export const workEvidence = (
  call: ToolCall | undefined,
  result: unknown
): WorkEvidence | undefined => {
  if (!call) return undefined;
  if (call.tool === 'file_write' || call.tool === 'file_patch') {
    const changes = fileChangesFromTool(call.tool, call.arguments).map((change) =>
      change.before === undefined && call.before !== undefined
        ? { ...change, before: call.before }
        : change
    );
    return changes.length ? { kind: 'files', changes } : undefined;
  }
  if (call.tool === 'shell') {
    const command = commandLine(record(call.arguments) ?? {});
    if (!command) return undefined;
    const outcome = record(result) ?? {};
    const streams = [outcome.stdout, outcome.stderr]
      .map((stream) => (typeof stream === 'string' ? stream.replace(/\s+$/, '') : ''))
      .filter(Boolean)
      .join('\n');
    return {
      kind: 'command',
      command,
      status: commandStatus(outcome),
      output: boundedOutput(streams)
    };
  }
  if (pageReads.has(call.tool)) {
    const pages = pagesRead(result);
    return pages.length ? { kind: 'pages', pages } : undefined;
  }
  return undefined;
};

/**
 * One line of the ledger: what happened, what it happened to, and the one figure worth a column.
 *
 * Three cells and a gutter, in that order, on every row without exception - which is what makes a
 * forty-step turn skimmable at all. Alignment is doing the work a disclosure triangle used to do
 * badly.
 */
export interface LedgerRow {
  verb: string;
  /** The elidable head of the subject - a directory, never the thing itself. Usually empty. */
  prefix: string;
  name: string;
  figure: string;
}

/**
 * The four participles this product uses whose past tense English does not derive.
 *
 * `thinking` is here because a folded run of narration is a row too, and by construction it is
 * always a run the turn moved on from.
 */
const irregularPast: Record<string, string> = {
  reading: 'read',
  running: 'ran',
  splitting: 'split',
  thinking: 'thought',
  writing: 'wrote'
};

/**
 * Tense is the state cue, and it is the only one that is not a colour.
 *
 * A row that is happening keeps its participle - `writing`, `running` - and a row that is finished
 * takes the past. The lit dot beside a live row says the same thing in ember, and a dot is exactly
 * the kind of thing a reader can be unable to see; the word cannot be missed by anybody who can
 * read the row at all. Stripping `-ing` and appending `-ed` is right for every label in this file
 * except the five above, and it leaves anything that is not a participle alone, because an unknown
 * tool falls back to the worker's own sentence and that must not be mangled.
 */
const pastTense = (participle: string): string =>
  irregularPast[participle] ??
  (participle.endsWith('ing') ? `${participle.slice(0, -3)}ed` : participle);

/**
 * The row one call is read as, from evidence that is already computed.
 *
 * Deliberately not `+82 −14` per row: line counts need the diff, and the note at `Timeline.tsx:167`
 * records what per-event work costs on a streaming frame. A byte length and an exit code are free
 * off the payload already in hand.
 */
export const ledgerRow = (
  tool: string,
  summary: string,
  evidence: WorkEvidence | undefined,
  live: boolean
): LedgerRow => {
  const row = (verb: string, prefix: string, name: string, figure = ''): LedgerRow => ({
    verb: live ? verb : pastTense(verb),
    prefix,
    name,
    figure
  });
  if (evidence?.kind === 'files') {
    const { changes } = evidence;
    const verb = tool === 'file_patch' ? 'editing' : 'writing';
    const bytes = formatBytes(changes.reduce((total, change) => total + change.after.length, 0));
    // One patch call can carry several files, and naming only the first is a lie by omission the
    // row has no room to correct. The count is the honest subject; the paths are one click below.
    if (changes.length !== 1) return row(verb, '', `${changes.length} files`, bytes);
    const path = changes[0]!.path;
    const cut = path.lastIndexOf('/') + 1;
    return row(verb, path.slice(0, cut), path.slice(cut), bytes);
  }
  // The command is already shell-quoted, and an exit code of zero is not news.
  if (evidence?.kind === 'command') return row('running', '', evidence.command, evidence.status);
  if (evidence?.kind === 'pages') {
    const { pages } = evidence;
    return row('reading', '', pages[0]!.host, pages.length > 1 ? `${pages.length} pages` : '');
  }
  /*
   * Everything else is the tool's own label, which is already written as a verb and its object -
   * "Searching the web", "Updating the plan" - so the split that gives this file its two columns
   * is the first space. The worker's sentence for the same call is `${tool} completed`, and
   * printing that beside the owner's words would be the machine's register underneath theirs.
   */
  const label = toolLabel(tool, summary).toLowerCase();
  const cut = label.indexOf(' ');
  return cut < 0 ? row(label, '', '') : row(label.slice(0, cut), '', label.slice(cut + 1));
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
  // Not `terminal`: a paused or waiting conversation is not writing anything either, and the
  // typing indicator under a half-finished reply is the difference between "stopped" and "stopping".
  const generating = taskIsGenerating(taskStatus);
  // Whether the assistant node currently at the tail was built by streamed frames. A settled
  // answer is not extended by the next turn's first frame, and only a streamed node is superseded
  // by the message that closes it.
  let openStreamed = false;
  // Queued notices are retired by matching text, which was an O(n) rescan of the whole log per
  // notice. The set of texts that actually ran is the same answer for one pass.
  const ranMessages = new Set<string>();
  /*
   * Which calls this log holds a result for.
   *
   * A start is dropped because its result carries the same call, not because the task moved on:
   * `settledToolStarts` answers `true` for every start in a finished conversation, so a call that
   * was cut off mid-flight - the interesting one - used to be dropped along with the rest and
   * appear in the transcript nowhere at all. Collected in the pass that is already walking the log.
   */
  const resolvedCalls = new Set<string>();
  /** Which streamed frames the turn never consolidated into a reply. One pass, read below. */
  const narrated = narratedDeltas(events);
  for (const event of events) {
    if (event.kind === 'user_message') ranMessages.add(payloadText(event, 'markdown'));
    else if (event.kind === 'tool_result') {
      const toolCallId = payloadText(event, 'toolCallId');
      if (toolCallId) resolvedCalls.add(toolCallId);
    }
  }
  /** Every call opened so far, so its result can be joined back to what it was asked to do. */
  const openCalls = new Map<string, ToolCall>();
  /*
   * What each file held the last time this conversation saw it.
   *
   * `file_write` carries only the new contents, so a diff built from its arguments alone calls
   * every write a new file: a one-line edit to an 800-line module rendered as "new file · +800",
   * which is this log's own evidence thrown away a second way. A whole-file `file_read` is exactly
   * the text a later write overwrites - the worker refuses a write whose file changed under it
   * (`file_write`'s `readFileHashes` check), so the read it claims is the read that stands - and a
   * write is itself what the next write to the same path starts from.
   */
  const fileContents = new Map<string, string>();
  let activity: ActivityEntry[] = [];
  /*
   * The site whose challenge is currently standing.
   *
   * A blocked search is retried, and the next two calls to the same site are refused the same way,
   * so one challenge can produce three or four refusals in a single turn. The first is news; the
   * rest are the same fact and stay among the steps rather than repeating a card that fills the
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
   * Where the ledger belongs, remembered from when its first entry arrived.
   *
   * The group is placed where the agent started working, but it is not closed until the turn ends,
   * so it collects everything the turn did rather than everything it did between two thoughts. The
   * two used to be the same moment, which is why one file write rendered as six work logs: every
   * reasoning frame closed the open group and started another.
   */
  let activityAnchor = -1;
  /**
   * Where the run of narration being folded is accumulating inside `activity`, or -1.
   *
   * One entry for a whole run, not one per frame. A run is hundreds of `assistant_delta` events -
   * the measured task published 1,015 of them - and filed individually they would be hundreds of
   * identical rows reading "Agent response", which is the same failure moved one screen across.
   */
  let narrationEntry = -1;
  const openActivity = (event: TaskEvent, index: number): void => {
    if (activityAnchor < 0) activityAnchor = nodes.length;
    // Anything else entering the log ends the run being folded, so the next one is its own block.
    narrationEntry = -1;
    // The join, done here so that every path into the log gets it - including the repeated browser
    // wall below, which files its result in the group rather than raising a second card.
    const call =
      event.kind === 'tool_result' ? openCalls.get(payloadText(event, 'toolCallId')) : undefined;
    activity.push({ event, index, ...(call ? { call } : {}) });
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
    narrationEntry = -1;
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

  /**
   * Files one frame of narration among the turn steps rather than in the reading column.
   *
   * The text is not dropped - it is the same words, one disclosure away, beside the calls they were
   * written between. What changes is that they are no longer promoted as the answer to a question
   * nobody asked here.
   */
  const foldNarration = (event: TaskEvent, index: number): void => {
    const fragment = streamFragment(event);
    const arriving = fragment === undefined ? assistantMarkdown(event) : fragment;
    const open = narrationEntry >= 0 ? activity[narrationEntry] : undefined;
    if (!open) {
      const opening = arriving.trimStart();
      if (!opening) return;
      openActivity({ ...event, summary: NARRATION_SUMMARY, payload: { markdown: opening } }, index);
      narrationEntry = activity.length - 1;
      return;
    }
    const held = payloadText(open.event, 'markdown');
    /*
     * A fragment carries only what arrived since the last frame, so it concatenates. A cumulative
     * snapshot - what a box predating fragment frames publishes - carries everything so far, so it
     * supersedes the text it is a longer version of. The same two shapes the answer path merges,
     * for the same reason: this log is a persistent stream replayed by one client across vintages.
     */
    const merged =
      fragment !== undefined
        ? `${held}${fragment}`
        : arriving.startsWith(held) || held.startsWith(arriving)
          ? arriving.length >= held.length
            ? arriving
            : held
          : `${held}\n\n${arriving}`;
    activity[narrationEntry] = { ...open, event: { ...open.event, payload: { markdown: merged } } };
  };

  /**
   * Keeps `fileContents` current, and stamps a write with what it overwrote.
   *
   * Runs on results rather than on starts because a write's outcome is the moment the file changed,
   * and because a read only counts once it has come back. Two map operations per file call.
   */
  const rememberWrittenFile = (event: TaskEvent): void => {
    const toolCallId = payloadText(event, 'toolCallId');
    const call = toolCallId ? openCalls.get(toolCallId) : undefined;
    if (!call || (call.tool !== 'file_read' && call.tool !== 'file_write')) return;
    const args = record(call.arguments) ?? {};
    // `./notes.md` and `notes.md` are one file; the worker normalises the same prefix for the same
    // reason. Nothing further is normalised, because collapsing two distinct paths onto one key
    // would diff a file against something that is not it.
    const path = (typeof args.path === 'string' ? args.path : '').replace(/^\.\//, '');
    if (!path) return;
    if (call.tool === 'file_read') {
      /*
       * Only a whole-file read is the file. `file_read` answers a windowed request with the window
       * it was asked for, and diffing a write against twenty lines out of nine hundred would invent
       * every other line as a deletion the write never made.
       */
      const result = record(eventPayload(event).result) ?? {};
      if (
        result.startLine === 1 &&
        result.truncated === false &&
        result.endLine === result.totalLines &&
        typeof result.content === 'string'
      )
        fileContents.set(path, result.content);
      return;
    }
    const before = fileContents.get(path);
    if (before !== undefined) openCalls.set(toolCallId, { ...call, before });
    // What is on disk now is what this write just put there, so a second write to the same path in
    // the same conversation is shown against the first rather than against the original.
    if (typeof args.content === 'string') fileContents.set(path, args.content);
  };

  events.forEach((event, index) => {
    // Taken wherever it lands: the harness publishes a run as a status event when it passes and
    // repeats it on the warning that refuses a finish, and both are ordinary ledger rows that
    // would otherwise never reach the card.
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
    if (!staysInTranscript(event) && !conversationalKinds.has(event.kind)) {
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
      if (event.kind === 'tool_started') {
        const data = eventPayload(event);
        const toolCallId = payloadText(event, 'toolCallId');
        if (toolCallId)
          openCalls.set(toolCallId, {
            tool: typeof data.tool === 'string' ? data.tool : '',
            arguments: data.arguments
          });
        /*
         * A start whose result is in this log is dropped because the result now carries the same
         * call, arguments and all - not because the task has moved on. Dropping it for the latter
         * is what left the file diffs unreachable: `DiffView` was rendered from this branch only,
         * and this branch was removed from every finished conversation.
         */
        // This one path leaves the log untouched, so it has to end the run being folded itself;
        // everywhere else `openActivity` does it. A start dropped in favour of its own result is
        // still the turn reaching for a tool, and prose after it is a new block, not a longer one.
        narrationEntry = -1;
        if (toolCallId && resolvedCalls.has(toolCallId)) return;
        openActivity(event, index);
        return;
      }
      if (event.kind === 'tool_result') rememberWrittenFile(event);
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

    /*
     * Narration is machinery, and the product already has a place for machinery. It is diverted
     * before the answer branch below, so it never opens or extends an assistant node - which is
     * what keeps a genuine reply arriving later in the same turn from being welded onto it.
     */
    if (event.kind === 'assistant_delta' && narrated.has(event.id)) {
      foldNarration(event, index);
      return;
    }

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
          streaming: generating
        };
        return;
      }
      openThinkingIndex = nodes.length;
      thinkingStepStart = 0;
      nodes.push({ kind: 'thinking', id: event.id, event, markdown, streaming: generating });
      return;
    }

    if (event.kind === 'assistant_message' || event.kind === 'assistant_delta') {
      // The answer arriving closes the thinking that produced it.
      const thinking = openThinking();
      if (thinking?.streaming) nodes[openThinkingIndex] = { ...thinking, streaming: false };
      const open = openAnswer();
      const fragment = streamFragment(event);
      const streaming = event.kind === 'assistant_delta' && generating;
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

    if (event.kind === 'user_message' || event.kind === 'queued_message') {
      /*
       * A message that answers a question closes it, the same way a decision closes an approval.
       *
       * Without this the question card stays lit for the life of the conversation, saying the agent
       * is waiting on the owner directly above the sentence in which they answered it - the exact
       * failure the approval pairing below was written to fix, arriving from the other direction.
       * The answer itself is left where it is: it is the owner's own message and belongs in the
       * transcript, so the card is only marked answered rather than absorbing it.
       *
       * A queued message counts, and that is the case that matters most. The answer is written to
       * the queue the instant they press Enter and is not promoted to a `user_message` until a
       * worker picks the conversation back up, which on a box under load is the whole window in
       * which the card would otherwise still be asking them a question they have just answered.
       */
      const asked = nodes.findIndex(
        (node) => node.kind === 'notice' && node.event.kind === 'question_asked' && !node.resolution
      );
      if (asked >= 0) {
        const question = nodes[asked];
        if (question?.kind === 'notice') nodes[asked] = { ...question, resolution: event };
      }
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
    /*
     * A decision belongs on the question, not underneath it.
     *
     * These were two cards: "Approval requested — allow this command to localhost", then "You
     * approved this — approved action resumed". One run raised ten of them, so twenty cards, and
     * the second of each pair carried nothing the first did not except the word yes. The request
     * node is rewritten in place with the decision on it, so the transcript keeps what was asked
     * and what was answered in the one place a reader looks for them.
     */
    if (event.kind === 'approval_resolved') {
      const approvalId = payloadText(event, 'approvalId');
      const asked = approvalId
        ? nodes.findIndex(
            (node) =>
              node.kind === 'notice' &&
              node.event.kind === 'approval_requested' &&
              payloadText(node.event, 'approvalId') === approvalId
          )
        : -1;
      if (asked >= 0) {
        const request = nodes[asked];
        if (request?.kind === 'notice') {
          nodes[asked] = { ...request, resolution: event };
          return;
        }
      }
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

/**
 * Folds a whole frame's worth of arrivals in one go.
 *
 * `mergeTaskEvent` copies the array per event, which is the right trade when events arrive one at a
 * time and wrong when they arrive in a run: reopening a conversation replays its entire log through
 * this path, so an 800-event catch-up did 800 copies of an array averaging 400 entries. The batch a
 * stream hands over is already in ascending `sequence` and already past the tail, so the common case
 * is a single concat; anything that is not — a replayed frame after a reconnect, an out-of-order
 * arrival — falls back to the per-event merge and gets exactly the same answer.
 */
export const mergeTaskEvents = (events: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] => {
  if (incoming.length === 0) return events;
  if (incoming.length === 1) return mergeTaskEvent(events, incoming[0]!);
  // Sequences are positive, so zero is the floor an empty list appends onto.
  let previous = events[events.length - 1]?.sequence ?? 0;
  let ascending = true;
  for (const event of incoming) {
    if (event.sequence <= previous) {
      ascending = false;
      break;
    }
    previous = event.sequence;
  }
  if (ascending) return [...events, ...incoming];
  let merged = events;
  for (const event of incoming) merged = mergeTaskEvent(merged, event);
  return merged;
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
  // One sentence for both waits. This is the live region's announcement and it has only the status
  // to go on, so it says the thing that is true of an approval and of a question alike rather than
  // announcing an Approve button to a screen-reader user who has been asked which of three files to
  // edit. The card in the transcript is where which one it is gets said.
  awaiting_user: 'The agent is waiting for you.',
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
/**
 * The newest line of a run of reasoning, for the one-line summary while it is still arriving.
 *
 * Live reasoning used to be shown open and in full, so a turn that thought for twenty steps put
 * every word of it in the conversation above the answer. What a reader wants from a block that is
 * still running is evidence that it is running and a hint of where it has got to; the rest is there
 * behind the disclosure when they want it.
 */
export const lastLine = (markdown: string, limit = 90): string => {
  const line = markdown
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return '';
  const flat = line
    .replace(/[#*`_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

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
