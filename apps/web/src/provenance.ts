/**
 * Whether this conversation read anything from outside, and what it did afterwards.
 *
 * The box records a crossing the moment a tool result brings in content nobody here wrote — a web
 * page, a mail body, a repository issue, the output of a networked command. It is the only fact in
 * the transcript that changes how the rest of it should be read: everything after the crossing was
 * produced by a model that had an outsider's text in its context, and an owner deciding whether an
 * answer is trustworthy needs to know both that it happened and what followed.
 *
 * Nothing here is a judgement about the content. Recognising an attack in text is the defence the
 * measured record says collapses against anyone who adapts; recording where the text came from is
 * the one that holds. So this counts crossings and lists consequences, and says neither that
 * something went wrong nor that nothing did.
 */
import type { TaskEvent } from './types.js';

/** One crossing, as the harness recorded it. */
export interface ExternalRead {
  /** The origin this crossing introduced: a host, a connected service, a kind of output. */
  origin: string;
  /** Everything the turn has read from outside up to this point, oldest first. */
  sources: string[];
  /** The tool whose result carried it in. */
  tool: string;
}

const payload = (event: TaskEvent): Record<string, unknown> =>
  event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter(Boolean) : [];

/**
 * A crossing, read out of the event the worker publishes for one.
 *
 * Keyed on the payload rather than on the summary wording, so rephrasing the sentence in the worker
 * does not silently remove the marker — the mistake the click gate in the approval floor made, and
 * the reason the transcript stopped offering the computer for a browser handoff.
 */
export const externalRead = (event: TaskEvent): ExternalRead | undefined => {
  if (event.kind !== 'warning') return undefined;
  const data = payload(event);
  const taint =
    data.taint && typeof data.taint === 'object' && !Array.isArray(data.taint)
      ? (data.taint as Record<string, unknown>)
      : undefined;
  if (!taint || text(taint.level) !== 'untrusted') return undefined;
  const sources = strings(taint.sources);
  return {
    // The newest source is the one this crossing added; older ones were already in the turn.
    origin: sources[sources.length - 1] ?? 'somewhere outside this computer',
    sources,
    tool: text(data.tool)
  };
};

/**
 * The actions worth listing after a crossing: the ones that change something, leave this computer,
 * or outlive the conversation.
 *
 * Reads are deliberately absent. A research task reads forty pages and changes nothing, and a panel
 * that lists forty reads teaches the owner to stop looking at it — which is the failure mode every
 * measurement of approval fatigue describes.
 */
const consequences: Record<string, string> = {
  file_write: 'Wrote a file',
  file_patch: 'Edited a file',
  print_pdf: 'Wrote a PDF',
  shell: 'Ran a command',
  browser_action: 'Acted on a website',
  desktop_action: 'Used an application',
  desktop_launch: 'Opened an application',
  connector_action: 'Used a connected account',
  publish_site: 'Published to the public internet',
  publish_preview: 'Created a preview link',
  publish_artifact: 'Published a file into this conversation',
  generate_media: 'Generated media at a provider',
  coding_agent: 'Handed work to a coding agent',
  memory: 'Changed what athanor remembers',
  skill: 'Changed a saved skill',
  schedule: 'Changed scheduled work'
};

export interface ProvenanceChange {
  /** What happened, in the owner's words. */
  label: string;
  /** How many times, because six file writes is a different fact from one. */
  count: number;
}

export interface ProvenanceReport {
  /** Everywhere this conversation read from, oldest first. */
  sources: string[];
  /** The sequence number of the first crossing, which is where the transcript changes character. */
  sinceSequence: number;
  /** What the agent did afterwards that changed something or left this computer. */
  changes: ProvenanceChange[];
}

/**
 * What the owner needs to know about this conversation's contact with the outside, or nothing at
 * all when it never had any — which is the common case and should cost the reader no attention.
 */
export const provenanceReport = (events: TaskEvent[]): ProvenanceReport | undefined => {
  let sinceSequence = 0;
  const sources: string[] = [];
  for (const event of events) {
    const read = externalRead(event);
    if (!read) continue;
    if (!sinceSequence) sinceSequence = event.sequence;
    for (const source of read.sources) if (!sources.includes(source)) sources.push(source);
  }
  if (!sinceSequence) return undefined;
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.sequence <= sinceSequence || event.kind !== 'tool_started') continue;
    const label = consequences[text(payload(event).tool)];
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return {
    sources,
    sinceSequence,
    changes: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
  };
};

/**
 * The one sentence somebody about to answer an approval needs, and does not currently get.
 *
 * The card states the call from the arguments rather than from the model's prose, which settles who
 * wrote what. It says nothing at all about the other half of the question: whether the agent asking
 * had somebody else's text in its context when it decided to ask. That is the difference between a
 * click the owner requested two turns ago and a click a web page requested, and it is a fact the
 * harness recorded — so the card can state it instead of leaving the owner to remember.
 *
 * It is scoped to the conversation rather than to the turn on purpose. Untrusted text does not
 * leave the context at the end of the turn that read it; every later turn is still deciding with it
 * in view, and an approval that arrives three turns after the crossing is not a safer approval.
 *
 * Both answers are stated. A row that only ever appears when something is wrong teaches its own
 * absence to mean nothing is, and the absence here would otherwise also cover "this card belongs to
 * a conversation that is not on screen, so nobody looked" — which is not the same claim at all.
 */
export interface ContextNote {
  exposed: boolean;
  text: string;
}

export const contextNote = (events: TaskEvent[]): ContextNote => {
  const report = provenanceReport(events);
  return report
    ? {
        exposed: true,
        text: `This conversation has read content from ${sourcesPhrase(report.sources)}. Whoever wrote that could be the one asking for this.`
      }
    : {
        exposed: false,
        text: 'Nothing from outside this computer has entered this conversation.'
      };
};

/** The sources, said as a phrase, with the tail folded once the list stops being readable. */
export const sourcesPhrase = (sources: string[], shown = 3): string => {
  if (!sources.length) return 'outside this computer';
  const head = sources.slice(0, shown);
  const rest = sources.length - head.length;
  return rest > 0 ? `${head.join(', ')} and ${rest} more` : head.join(', ');
};
