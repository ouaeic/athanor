import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  BellRing,
  BookOpen,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileOutput,
  Globe2,
  GitBranch,
  Hourglass,
  LoaderCircle,
  MonitorUp,
  Pencil,
  RotateCcw,
  ShieldAlert,
  Terminal,
  UserRoundCheck,
  XCircle
} from 'lucide-react';
import type { BotWall, Task, TaskEvent } from './types.js';
import { TaskPlanPanel, planProgress, useTaskPlan } from './TaskPlanPanel.js';
import { CopyButton, Markdown } from './Markdown.js';
import { DiffView } from './DiffView.js';
import {
  activityLine,
  activityOverview,
  agentQuestion,
  botWallClearance,
  buildConversation,
  compactResultSummary,
  conversationCost,
  formatBytes,
  forkFamily,
  hostOf,
  liveActivityId,
  previewLifetime,
  lastLine,
  reasoningEffortLabel,
  settledToolStarts,
  toolLabel,
  workEvidence,
  type ActivityEntry,
  type ConversationNode,
  type ConversationSource,
  type SpendPause,
  type ToolCall,
  type WorkEvidence
} from './timeline-state.js';
import { externalRead, provenanceReport, sourcesPhrase } from './provenance.js';
import { completionCard, verificationReceiptLabel, type HarnessCheck } from './completion-card.js';
import { terminalTaskStatuses } from './task-status.js';
import { formatUsd } from './usage-model.js';
import { fileKindLabel, splitAttachments } from './attachments.js';
import { AttachmentStrip } from './AttachmentTray.js';

type Surface = 'files' | 'computer' | 'terminal' | 'preview';

/**
 * The one page the agent cannot get past, said out loud.
 *
 * A challenge stops that tab and that site and nothing else: athanor keeps the browser and keeps
 * working elsewhere, so this is a request rather than a stopped task. The one thing that clears it
 * is a person opening the page, which is what the button is for.
 */
function Handoff({ wall, onOpenSurface }: { wall: BotWall; onOpenSurface?: (s: Surface) => void }) {
  return (
    <div className="handoff-card">
      <ShieldAlert />
      <div>
        <p className="eyebrow">One page needs you</p>
        <strong>{hostOf(wall.url)} is checking that a person is here</strong>
        <span>
          {wall.vendor}
          {wall.reason ? ` · ${wall.reason}` : ''}
        </span>
        <p>
          athanor will not answer a challenge on your behalf. It has left this page alone and is
          carrying on with the rest of the work; {hostOf(wall.url)} stays closed to it until you
          open it and hand the browser back. {botWallClearance(wall)}
        </p>
      </div>
      {onOpenSurface && (
        <button className="primary" onClick={() => onOpenSurface('computer')}>
          Open it
        </button>
      )}
    </div>
  );
}

/**
 * A run the owner's own spending ceiling stopped, said where they are reading.
 *
 * The box has already worked out the sentence — what was spent, against what, in which window — so
 * all this adds is the way to act on it. Resume alone is not that: the ceiling is still where it
 * was, and the next step would halt against it again.
 */
function SpendPauseCard({ pause, onOpenCaps }: { pause: SpendPause; onOpenCaps?: () => void }) {
  return (
    <div className="spend-pause-card">
      <CircleDollarSign />
      <div>
        <p className="eyebrow">Paused by your spending cap</p>
        <strong>{pause.message}</strong>
      </div>
      {onOpenCaps && (
        <button className="primary" onClick={onOpenCaps}>
          Spending caps
        </button>
      )}
    </div>
  );
}

/** A message the agent chose to send, shown where it was decided as well as on the device. */
function AgentNote({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="agent-note">
      <BellRing />
      <div>
        <p className="eyebrow">athanor told you</p>
        <strong>{headline}</strong>
        {detail && <Markdown>{detail}</Markdown>}
      </div>
    </div>
  );
}

/**
 * The computer went back; this conversation did not.
 *
 * The one rewind that forks nothing is also the one an owner can otherwise not see happened: the
 * transcript above and below it is unchanged, and every file underneath it is different. So it gets
 * a line of its own rather than a row inside a collapsed activity group.
 */
function ComputerRewound({ onOpenSurface }: { onOpenSurface?: (surface: Surface) => void }) {
  return (
    <div className="computer-rewound">
      <RotateCcw />
      <div>
        <strong>The computer was put back</strong>
        <span>
          Files went back to an earlier point in this conversation. Nothing installed since then was
          removed, and this conversation carried on from where it was.
        </span>
      </div>
      {onOpenSurface && (
        <button className="secondary" onClick={() => onOpenSurface('files')}>
          Open files
        </button>
      )}
    </div>
  );
}

const payload = (event: TaskEvent) =>
  event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
const textValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;
const truncateLongStrings = (_key: string, value: unknown): unknown =>
  typeof value === 'string' && value.length > 4000 ? `${value.slice(0, 4000)}…` : value;

/**
 * The raw payload, serialised once per event instead of once per frame.
 *
 * A streaming answer re-renders every open work log on every frame, and each render re-serialised
 * every tool payload in it — including browser results carrying a whole accessibility tree.
 * Measured on an 800-event log holding 136 tool entries: 161 µs per frame, which is as much as
 * rebuilding the entire transcript from scratch, spent on text that sits inside a disclosure the
 * reader has not opened. A settled event's payload never changes, so the string is derived once and
 * every frame after it reuses the same one. `replacer` must be a module-level function for the
 * comparison to hold.
 */
const PayloadDump = memo(function PayloadDump({
  value,
  replacer
}: {
  value: unknown;
  replacer?: (key: string, value: unknown) => unknown;
}) {
  return <pre>{JSON.stringify(value ?? {}, replacer, 2)}</pre>;
});

/**
 * The line that ran, what it ended as, and what it said.
 *
 * `finished` is the difference between a command that printed nothing and one that has not printed
 * anything *yet*. A row drawn from the start alone has no result to read, so an empty output there
 * is the absence of a record rather than a fact about the command — and "It printed nothing", over
 * a build still running, is exactly the confident falsehood this whole panel exists to remove.
 */
function CommandEvidence({
  evidence,
  finished
}: {
  evidence: Extract<WorkEvidence, { kind: 'command' }>;
  finished: boolean;
}) {
  return (
    <div className="tool-command">
      <p className="tool-command-line">
        <Terminal />
        <code>{evidence.command}</code>
        {evidence.status && <span className="tool-command-status">{evidence.status}</span>}
      </p>
      {evidence.output ? <pre className="tool-output">{evidence.output}</pre> : null}
      {finished && !evidence.output && <p className="tool-quiet">It printed nothing.</p>}
    </div>
  );
}

/** The pages a read actually loaded: what the answer above was built out of, and whose they were. */
function PageEvidence({ evidence }: { evidence: Extract<WorkEvidence, { kind: 'pages' }> }) {
  return (
    <ul className="tool-pages">
      {evidence.pages.map((page) => (
        <li key={page.url}>
          <a href={page.url} target="_blank" rel="noreferrer noopener">
            <Globe2 />
            <span>
              <strong>{page.title}</strong>
              <small>{page.host}</small>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a call did, promoted above the payload that records it.
 *
 * Memoised on the four values rather than on the joined call, because the join rebuilds its objects
 * on every rebuild of the transcript and a streaming turn rebuilds the transcript once per frame -
 * so a component keyed on the call itself would re-derive every open work log's evidence sixty
 * times a second. `arguments` and `result` are the payload objects the event carries, which are the
 * same references for the life of the event, so the shallow comparison holds.
 *
 * The raw payload is one more disclosure down rather than gone. This is about what is promoted.
 *
 * Exported for the test that guards the bug this replaced: a work log's body is mounted only once
 * the reader opens the group, so nothing rendered from the transcript's own root can reach it, and
 * the shipped defect was exactly a row rendered from the wrong branch.
 */
export const ToolEvidence = memo(function ToolEvidence({
  tool,
  args,
  before,
  result,
  stage
}: {
  tool: string;
  args: unknown;
  before?: string;
  result?: unknown;
  /** Which half of the call this row is, which decides what the raw disclosure holds. */
  stage: 'started' | 'result';
}) {
  const call: ToolCall = { tool, arguments: args, ...(before === undefined ? {} : { before }) };
  const evidence = workEvidence(call, result);
  const raw = stage === 'result' ? result : args;
  if (!evidence) return <PayloadDump value={raw} replacer={truncateLongStrings} />;
  return (
    <div className="tool-evidence">
      {evidence.kind === 'files' &&
        evidence.changes.map((change) => (
          <DiffView
            key={change.path}
            path={change.path}
            before={change.before}
            after={change.after}
            defaultOpen={evidence.changes.length === 1}
          />
        ))}
      {evidence.kind === 'command' && (
        <CommandEvidence evidence={evidence} finished={stage === 'result'} />
      )}
      {evidence.kind === 'pages' && <PageEvidence evidence={evidence} />}
      <details className="tool-raw">
        <summary>Raw {stage === 'result' ? 'result' : 'arguments'}</summary>
        <PayloadDump value={raw} replacer={truncateLongStrings} />
      </details>
    </div>
  );
});

function MessageActions({
  markdown,
  event,
  onEdit,
  onRetry,
  onBranch
}: {
  markdown: string;
  event: TaskEvent;
  onEdit?: (event: TaskEvent) => void;
  onRetry?: (event: TaskEvent) => void;
  onBranch?: (event: TaskEvent) => void;
}) {
  return (
    <span className="message-actions">
      <CopyButton value={markdown} />
      {onEdit && (
        <button onClick={() => onEdit(event)} title="Edit this message and send it again">
          <Pencil /> Edit
        </button>
      )}
      {onRetry && (
        <button onClick={() => onRetry(event)} title="Answer again from the message before this">
          <RotateCcw /> Retry
        </button>
      )}
      {onBranch && (
        <button
          onClick={() => onBranch(event)}
          title="Start a branch here, keeping this conversation"
        >
          <GitBranch /> Branch
        </button>
      )}
    </span>
  );
}

function UserMessage({
  node,
  workspaceId,
  onEdit,
  onBranch
}: {
  node: Extract<ConversationNode, { kind: 'user' }>;
  workspaceId: string | undefined;
  onEdit?: (event: TaskEvent) => void;
  onBranch?: (event: TaskEvent) => void;
}) {
  // The files the message carried are shown as files. They used to be a line of UUID paths inside
  // the sentence, because that is literally what the message was.
  const { body, paths } = splitAttachments(node.markdown);
  return (
    <article className="user-brief user-message">
      {body && <Markdown>{body}</Markdown>}
      <AttachmentStrip workspaceId={workspaceId} paths={paths} />
      <MessageActions
        markdown={body || node.markdown}
        event={node.event}
        {...(onEdit ? { onEdit } : {})}
        {...(onBranch ? { onBranch } : {})}
      />
    </article>
  );
}

const shortTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

/**
 * Which model wrote this, when, and what it cost.
 *
 * Model selection defaults to Automatic and re-ranks on every bootstrap, so the model that answered
 * turn three may not be the one that answers turn four — and when a reply is wrong the first
 * question is which model that was. All three facts were already in the event log and all three
 * were folded into a collapsed activity group.
 */
function MessageMeta({
  node,
  modelName
}: {
  node: Extract<ConversationNode, { kind: 'assistant' }>;
  modelName?: (id: string) => string;
}) {
  const parts = [
    node.model ? (modelName?.(node.model) ?? node.model.split('/').pop()) : '',
    shortTime(node.event.createdAt),
    node.costUsd ? formatUsd(node.costUsd) : ''
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="message-meta answer-meta">{parts.join(' · ')}</span>;
}

/** What a research answer was actually based on, in front of the answer rather than inside a log. */
function Sources({ sources }: { sources: ConversationSource[] }) {
  return (
    <ol className="answer-sources" aria-label="Sources for this answer">
      {sources.map((source, index) => (
        <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer noopener">
            <span className="source-index">{index + 1}</span>
            <span className="source-copy">
              <strong>{source.title}</strong>
              <small>{source.host}</small>
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}

function AssistantMessage({
  node,
  modelName,
  onRetry,
  onBranch
}: {
  node: Extract<ConversationNode, { kind: 'assistant' }>;
  modelName?: (id: string) => string;
  onRetry?: (event: TaskEvent) => void;
  onBranch?: (event: TaskEvent) => void;
}) {
  return (
    <article className="assistant-message">
      <div className="ai-avatar" aria-hidden="true">
        a
      </div>
      <div className="assistant-message-body">
        <Markdown>{node.markdown}</Markdown>
        {node.sources && node.sources.length > 0 && <Sources sources={node.sources} />}
        {node.streaming ? (
          <span className="streaming-caret" role="img" aria-label="Still writing" />
        ) : (
          <>
            <MessageActions
              markdown={node.markdown}
              event={node.event}
              {...(onRetry ? { onRetry } : {})}
              {...(onBranch ? { onBranch } : {})}
            />
            <MessageMeta node={node} {...(modelName ? { modelName } : {})} />
          </>
        )}
      </div>
    </article>
  );
}

function Event({
  event,
  call,
  onOpenSurface,
  onOpenPreview,
  settled = false,
  compactCompletion = false,
  harness = [],
  resolution
}: {
  event: TaskEvent;
  /** The call a `tool_result` answers, joined to its start in the transcript pass. */
  call?: ToolCall;
  onOpenSurface?: (surface: Surface) => void;
  /** Asks the server for a fresh, openable address for a private preview. */
  onOpenPreview?: (previewId: string) => void;
  settled?: boolean;
  compactCompletion?: boolean;
  /** The acceptance checks the harness ran for this completion, where the turn declared any. */
  harness?: HarnessCheck[];
  /** The decision, when this is an approval that has since been answered. */
  resolution?: TaskEvent;
}) {
  const data = payload(event);
  /*
   * A plan event carries the plan, which the panel above the log already draws; its second line
   * here read two payload fields no server has ever written, so every plan carried an empty one.
   * A status line is a note about the run rather than an outcome, and both used to end with a tick
   * beside sentences like "this turn is nearly out of steps".
   */
  if (event.kind === 'plan' || event.kind === 'status')
    return (
      <div className="cost-event">
        <Clock3 />
        <span>{event.summary}</span>
      </div>
    );
  if (event.kind === 'tool_started') {
    const tool = textValue(data.tool);
    /*
     * A start only survives into the transcript when this log holds no result for it — see the
     * join in `buildConversation`. So while the task is live it is a call in flight, and once the
     * task has stopped it is a call that never came back: the interesting one, the one a reader
     * goes looking for after a conversation ends badly.
     *
     * `settled` is exactly that second case now, and it used to draw a green tick and the success
     * class over it. The tick was honest when this branch also drew calls that had returned; it
     * cannot stay, because the only rows left here are the ones that did not.
     */
    return (
      <details className={`tool-event ${settled ? 'unfinished' : ''}`}>
        <summary>
          {settled ? <Hourglass /> : <LoaderCircle className="spin" />}
          <span>
            {toolLabel(tool, event.summary)}
            {settled && ' · never finished'}
          </span>
          <ChevronRight />
        </summary>
        <ToolEvidence tool={tool} args={data.arguments} stage="started" />
      </details>
    );
  }
  if (event.kind === 'tool_result') {
    const result = data.result as Record<string, unknown> | undefined;
    const screenshot = result?.screenshotBase64;
    const isDesktop = Boolean(result && ('activeApplication' in result || 'nodes' in result));
    return (
      <>
        {typeof screenshot === 'string' && screenshot.length > 0 && (
          <figure className="browser-capture-card">
            <img
              src={`data:image/jpeg;base64,${screenshot}`}
              alt={
                isDesktop
                  ? 'Screenshot from the private agent computer'
                  : 'Screenshot from the private browser'
              }
            />
            <figcaption>
              <span>
                {isDesktop ? <MonitorUp /> : <Globe2 />}
                <strong>
                  {isDesktop
                    ? textValue(result?.activeApplication, 'Agent computer')
                    : textValue(result?.title, 'Private browser')}
                </strong>
              </span>
              {onOpenSurface && (
                <button onClick={() => onOpenSurface('computer')}>Open computer</button>
              )}
            </figcaption>
          </figure>
        )}
        <details className="tool-event success">
          <summary>
            <Check />
            {/* The call's own tool, not the summary's: the worker writes "file_write completed",
                and the owner has been reading "Writing a file" for the whole run. */}
            <span>{toolLabel(call?.tool ?? '', event.summary)}</span>
            <ChevronRight />
          </summary>
          <ToolEvidence
            tool={call?.tool ?? ''}
            args={call?.arguments}
            {...(call?.before === undefined ? {} : { before: call.before })}
            result={data.result}
            stage="result"
          />
        </details>
      </>
    );
  }
  if (event.kind === 'approval_requested') {
    /*
     * The question and its answer, on one card.
     *
     * They used to be two: "Approval requested", then a second card underneath saying "You approved
     * this" and repeating nothing useful. Ten approvals in one run meant twenty cards. What is
     * still waiting has its own card elsewhere, unmissable and carrying the buttons; this is the
     * record of what was asked and what was said, which is one fact.
     */
    const decision = resolution ? textValue(payload(resolution).decision, 'resolved') : '';
    const answered =
      decision === 'approved'
        ? 'You approved it'
        : decision === 'expired'
          ? 'It expired before it was answered'
          : decision
            ? 'You did not approve it'
            : '';
    return (
      <div className={`system-event approval${decision ? ` decision-${decision}` : ''}`}>
        {decision === 'approved' ? <CheckCircle2 /> : decision ? <XCircle /> : <UserRoundCheck />}
        <div>
          <strong>{answered || 'Approval requested'}</strong>
          <span>{event.summary}</span>
        </div>
      </div>
    );
  }
  if (event.kind === 'question_asked') {
    /*
     * The approval card's shape, and deliberately none of its colour.
     *
     * A question is not a risk: the sand and clay `.system-event.approval` wears is the product's
     * caution treatment, and putting a choice between two file formats in it teaches the owner to
     * read every pause in a run as a warning. So this is the ordinary lit panel, and the one thing
     * on it that is warm is the small dot - the mark reserved for "alive, or your move" - which
     * stops the moment the question has been answered. There is no Approve and no Deny, because
     * neither is an answer to "which of these"; the answer is whatever they type next, and the
     * options are shown as the ones the agent said it would act on rather than as controls.
     */
    const asked = agentQuestion(event);
    if (!asked) return null;
    return (
      <div className={`system-event question${resolution ? ' answered' : ''}`}>
        <UserRoundCheck />
        <div>
          <strong>
            {!resolution && <i className="question-live" aria-hidden="true" />}
            {resolution ? 'You answered' : 'athanor asked you'}
          </strong>
          <span>{asked.question}</span>
          {asked.options.length > 0 && (
            <ul className="question-options">
              {asked.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          )}
          {asked.why && <span>{asked.why}</span>}
        </div>
      </div>
    );
  }
  if (event.kind === 'approval_resolved') {
    const decision = textValue(data.decision, 'resolved');
    return (
      <div className={`system-event approval decision-${decision}`}>
        {decision === 'approved' ? <CheckCircle2 /> : <XCircle />}
        <div>
          <strong>
            {decision === 'approved'
              ? 'You approved this'
              : decision === 'expired'
                ? 'Expired before it was answered'
                : 'You did not approve this'}
          </strong>
          <span>{event.summary}</span>
        </div>
      </div>
    );
  }
  if (event.kind === 'artifact') {
    const artifactId = textValue(data.artifactId);
    const mimeType = textValue(data.mimeType, 'application/octet-stream');
    const name = textValue(data.name, event.summary);
    const size = formatBytes(Number(data.sizeBytes));
    const url = artifactId ? `/v1/artifacts/${encodeURIComponent(artifactId)}/content` : '';
    return (
      <>
        {url && mimeType === 'application/pdf' && (
          <div className="pdf-review-card">
            <iframe src={`${url}#toolbar=0&navpanes=0`} title={event.summary} />
          </div>
        )}
        <div className={`artifact-card ${mimeType.startsWith('image/') ? 'with-preview' : ''}`}>
          {url && mimeType.startsWith('image/') ? (
            <a className="artifact-thumb" href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={name} loading="lazy" />
            </a>
          ) : (
            <FileOutput />
          )}
          <div>
            <strong>{name}</strong>
            <span>
              {fileKindLabel(mimeType, name)}
              {size ? ` · ${size}` : ''}
            </span>
          </div>
          <span className="artifact-actions">
            {onOpenSurface && <button onClick={() => onOpenSurface('files')}>Files</button>}
            {url && (
              <a href={url} target="_blank" rel="noreferrer">
                Open
              </a>
            )}
            {url && (
              <a href={url} download={name}>
                Download
              </a>
            )}
          </span>
        </div>
      </>
    );
  }
  if (event.kind === 'preview') {
    const url = textValue(data.url);
    const previewId = textValue(data.previewId);
    return (
      <div className="preview-chat-card">
        <span className="preview-chat-icon">
          <MonitorUp />
        </span>
        <div>
          <p className="eyebrow">
            {textValue(data.visibility) === 'public' ? 'Published site' : 'Private preview'}
          </p>
          <strong>{textValue(data.label, event.summary)}</strong>
          <span>
            Port {textValue(data.port)} ·{' '}
            {previewLifetime(typeof data.expiresAt === 'string' ? data.expiresAt : null)}
          </span>
        </div>
        <span className="artifact-actions">
          {/* Named for where it goes. The pane was renamed and this one control was left pointing
              at a tab that no longer exists by that name. */}
          {onOpenSurface && <button onClick={() => onOpenSurface('preview')}>Running</button>}
          {/*
            A private preview is opened by asking for an address, not by holding one.
            Its access token is minted once and only its hash is kept, so the URL carried on the
            event has no token on it and answers 401 - which is what this button did, on the card
            that appears at the end of "build me something and give me a link I can open". The
            Preview tab always got this right; the card in the conversation did not.
          */}
          {textValue(data.visibility) === 'public' && url ? (
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open
            </a>
          ) : (
            previewId &&
            onOpenPreview && (
              <button onClick={() => onOpenPreview(previewId)}>
                <ExternalLink /> Open
              </button>
            )
          )}
        </span>
      </div>
    );
  }
  /*
   * A crossing into untrusted content is not a warning, and drawing it as one teaches the owner to
   * dismiss the row that matters most. It is a change of character in the transcript: from here on,
   * everything the agent writes was produced with an outsider's text in its context. It is drawn as
   * a divider across the conversation, at the point where that became true.
   */
  const crossing = externalRead(event);
  if (crossing)
    return (
      <div className="external-content-mark">
        <BookOpen />
        <div>
          <strong>Read content from {crossing.origin}</strong>
          <span>
            {crossing.tool ? `${crossing.tool} · ` : ''}Nobody here wrote it. Everything below was
            produced with it in context.
          </span>
        </div>
      </div>
    );
  // The heading used to be a fixed phrase that added nothing above `event.summary`, which already
  // says what happened. What is worth a line of its own is what the owner can do about it.
  if (event.kind === 'warning' || event.kind === 'error')
    return (
      <div className={`system-event ${event.kind}`}>
        <AlertTriangle />
        <div>
          <strong>{event.summary}</strong>
          {/*
            Behind a disclosure, because the detail of a failure is for the moment somebody goes
            looking - and because a producer can always send something longer than a line. The
            runner now says what was wrong with a request in a sentence, but this is the last place
            it can be contained, so it is contained here too rather than trusted to be short.
          */}
          {textValue(data.message) && (
            <details className="event-detail">
              <summary>Details</summary>
              <span>{textValue(data.message)}</span>
            </details>
          )}
        </div>
      </div>
    );
  if (event.kind === 'cost') {
    const effort = reasoningEffortLabel(data.reasoningEffort);
    return (
      <div className="cost-event">
        <CircleDollarSign />
        <span>
          {event.summary}
          {effort ? ` · ${effort}` : ''}
        </span>
      </div>
    );
  }
  if (event.kind === 'completed') {
    const card = completionCard(event, harness);
    const conciseSummary = compactCompletion ? compactResultSummary(card.summary) : card.summary;
    const hasMore =
      compactCompletion && conciseSummary !== compactResultSummary(card.summary, 50_000);
    const receipt = verificationReceiptLabel(card);
    return (
      <div className={`completion-card task-result ${card.interrupted ? 'interrupted' : ''}`}>
        {card.interrupted ? <Hourglass /> : <CheckCircle2 />}
        <div>
          <strong>{card.headline}</strong>
          <p>{conciseSummary}</p>
          {hasMore && (
            <details className="result-details">
              <summary>Full summary</summary>
              <div className="completion-summary">
                <Markdown>{card.summary}</Markdown>
              </div>
            </details>
          )}
          {/* The one thing a step-limited turn needs to hand over: what it did not get to. It is
              open rather than folded away, because it is the reason this card is not a result. */}
          {card.outstanding.length > 0 && (
            <>
              <span className="completion-outstanding-label">
                Still open — reply to carry on from here
              </span>
              <ul className="completion-outstanding">
                {card.outstanding.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {/* A tick worth less than the last one says so beside the tick, never inside a
              disclosure: it is the difference between "this was proved" and "this passed checks
              that were already passing", and it is unreadable anywhere else. */}
          {card.harnessCaveats.map((caveat) => (
            <span className="completion-harness-caveat" key={caveat}>
              {caveat}
            </span>
          ))}
          {receipt && (
            <details className="result-details verification-receipt">
              <summary>{receipt}</summary>
              {/* The harness's own run leads, because it is the only evidence here that the agent
                  did not write, and each line keeps the exit code it actually observed. */}
              {card.harness.length > 0 && (
                <ul className="harness-checks">
                  {card.harness.map((check) => (
                    <li
                      key={check.id || check.label}
                      className={check.passed ? 'passed' : 'failed'}
                    >
                      {check.passed ? <Check /> : <AlertTriangle />}
                      <span>
                        <strong>{check.label}</strong>
                        <code>{check.detail}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {card.harness.length > 0 && card.evidence.length > 0 && (
                <p className="eyebrow">What the agent says it checked</p>
              )}
              {(card.evidence.length > 0 || card.caveats.length > 0) && (
                <ul>
                  {card.evidence.map((claim) => (
                    <li key={claim}>{claim}</li>
                  ))}
                  {card.caveats.map((risk) => (
                    <li key={risk}>Caveat: {risk}</li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="cost-event">
      <Check />
      <span>{event.summary}</span>
    </div>
  );
}

/**
 * `overview`, `settled` and `planSequence` are derived from the whole event log, which is why they
 * are passed in rather than computed here: every group would otherwise re-derive them from the
 * full array on every frame of a streaming answer.
 */
function ActivityLog({
  task,
  events,
  overview,
  settled,
  planSequence,
  live,
  onOpenSurface
}: {
  task: Task;
  events: ActivityEntry[];
  overview: string;
  settled: (event: TaskEvent) => boolean;
  planSequence: number;
  /** Whether this is the group the agent is working in right now. */
  live: boolean;
  onOpenSurface?: (surface: Surface) => void;
}) {
  const terminal = terminalTaskStatuses.has(task.status);
  const [open, setOpen] = useState(false);
  // Only the live group asks. This component is mounted once per activity group, so the plan - one
  // record on the box - was fetched once per group, and every one of those reads was discarded by
  // the `live ?` below except the last.
  const plan = useTaskPlan(live ? task.id : '', planSequence);
  const progress = live ? planProgress(plan?.steps ?? []) : null;
  const line = activityLine({
    progress: progress && !terminal ? progress : null,
    overview,
    steps: events.length,
    live
  });
  return (
    <details
      className={`task-activity ${terminal ? 'finished' : 'active'}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="task-activity-icon">
          {live && !terminal ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
        </span>
        <span className="task-activity-copy">
          <strong>{live && !terminal ? 'Agent activity' : 'Work log'}</strong>
          {/*
            "Step 2 of 5 · Writing a file" rather than "Thinking": the count is the answer to the
            question a waiting owner is actually asking, and it used to cost a click to reach. It
            belongs only to the group being worked in — every earlier group repeating the live
            progress made the transcript claim the agent was in four places at once. What it says
            when there is nothing to count, and when the count has run out, is `activityLine`.
          */}
          {line && <small>{line}</small>}
          {progress && !terminal && (
            <span
              className="task-activity-progress"
              role="progressbar"
              aria-label={`${progress.completed} of ${progress.total} steps done`}
              aria-valuenow={progress.completed}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <i style={{ width: `${(progress.completed / progress.total) * 100}%` }} />
            </span>
          )}
        </span>
        <ChevronRight className="task-activity-chevron" />
      </summary>
      {open && (
        <div className="task-activity-body">
          {/*
            The plan belongs to the conversation, not to one group of its steps, and it is a live
            editor with a Save button. Rendered in every group, a work log from twenty minutes ago
            presented today's plan as its own under a heading reading "Live plan", and expanding two
            groups put two editors for one record on the screen at once.
          */}
          {live && <TaskPlanPanel task={task} refreshKey={planSequence} />}
          {events.map(({ event, call }) => (
            <Event
              key={event.id}
              event={event}
              settled={settled(event)}
              {...(call ? { call } : {})}
              {...(onOpenSurface ? { onOpenSurface } : {})}
            />
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * Sticks the view to the newest content only while the reader is already at the bottom. Streaming
 * appends an event every ~160 characters, so an unconditional scroll makes it impossible to read
 * anything earlier while the agent is still working.
 *
 * `dependency` is what arrives at the bottom; `head` is how much is mounted above, which changes
 * when earlier material is revealed or fetched and would otherwise throw the reader down the page.
 */
const useStickyScroll = (dependency: number, head: number) => {
  const container = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  /*
   * Read inside the effect rather than depended on, so following the newest content happens when
   * new content arrives and not when the reader crosses the threshold themselves. Scrolling down
   * by hand used to flip `pinned`, which re-ran the effect, which animated the view out from under
   * the hand that was moving it - the other half of the bob.
   */
  const pinnedNow = useRef(true);

  const scrollToEnd = useCallback((node: HTMLDivElement | null) => {
    /*
     * The container is scrolled the same way `onScroll` measures it. It used to call
     * `scrollIntoView` on a sentinel inside `.timeline`, so the target was the sentinel's box and
     * the test was the scrollport's - two different bottoms, differing by exactly the padding the
     * transcript reserved. They could not both be satisfied, so the view settled a little short
     * and tried again on every frame. Scrolling the scrollport to its own scrollHeight makes the
     * effect's target and the predicate's distance the same quantity by construction.
     */
    node?.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, []);

  const anchor = useRef<number | null>(null);

  const onScroll = useCallback(() => {
    const node = container.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedNow.current = distance < 120;
    setPinned(pinnedNow.current);
    // A page of history is a round trip to the box, and the reader is free to keep scrolling while
    // it is in flight; the anchor has to describe where they are now, not where they clicked.
    if (anchor.current !== null) anchor.current = node.scrollHeight - node.scrollTop;
  }, []);

  useEffect(() => {
    if (pinnedNow.current) scrollToEnd(container.current);
  }, [dependency, scrollToEnd]);

  const jump = useCallback(() => {
    pinnedNow.current = true;
    setPinned(true);
    scrollToEnd(container.current);
  }, [scrollToEnd]);

  /*
   * Growing the transcript upwards moves everything the reader is looking at down the page by
   * exactly the height of what was added, because a scrollport measures from the top. Recording the
   * distance to the bottom before the growth and restoring it afterwards keeps the line they were
   * reading under the same pixel - the same quantity `onScroll` already uses, so the two agree by
   * construction.
   */
  const hold = useCallback(() => {
    const node = container.current;
    if (node) anchor.current = node.scrollHeight - node.scrollTop;
  }, []);
  /** Dropped when the growth it was recorded for is never going to arrive - a failed page. */
  const release = useCallback(() => {
    anchor.current = null;
  }, []);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node || anchor.current === null) return;
    // Before paint: a restore after it is a visible jump and back.
    node.scrollTop = node.scrollHeight - anchor.current;
    anchor.current = null;
  }, [head]);

  return { container, pinned, onScroll, jump, hold, release };
};

/**
 * What the conversation cost, and nothing else about how it was billed.
 *
 * This line used to read "$0.02 · 163k in · 1.6k out · 54% cached" at the foot of a transcript
 * whose answer was two lines of verse. Three of those four figures are the provider's telemetry:
 * they say nothing about the work and they cannot be acted on from here. The money is the one an
 * owner reads in passing, so the money is what stays; the split and the cache share are in the
 * usage pane, which is where somebody who wants them is already looking.
 */
function CostSummary({ task, events }: { task: Task | undefined; events: TaskEvent[] }) {
  /*
   * The transcript on screen is a window onto the conversation, not the whole of it, so adding up
   * the cost events in it understates a long conversation whose earlier pages have not been
   * fetched. The task carries its own settled total for the whole conversation, which is the
   * figure this line has always claimed to be. The window is still the fresher of the two mid-turn:
   * a cost event is on screen the moment it is written, seconds before the poll that settles the
   * task catches up, so whichever is larger is the honest one.
   */
  const total = Math.max(conversationCost(events).costUsd, task?.spentUsd ?? 0);
  if (!(total > 0)) return null;
  return (
    <div className="cost-event conversation-cost">
      <CircleDollarSign />
      <span>{formatUsd(total)}</span>
    </div>
  );
}

/**
 * What this conversation read from outside, and what it did after.
 *
 * It sits at the foot of the transcript beside the running cost, because both answer the same kind
 * of question about a conversation the owner was not watching. A conversation that never left this
 * computer draws nothing: the panel has to be rare enough to be read.
 */
function ProvenanceSummary({ events }: { events: TaskEvent[] }) {
  const report = provenanceReport(events);
  if (!report) return null;
  const after = report.changes.reduce((total, change) => total + change.count, 0);
  return (
    <details className="provenance-summary">
      <summary>
        <BookOpen />
        <span>
          Read from outside · {sourcesPhrase(report.sources)} ·{' '}
          {after > 0
            ? `${after} action${after === 1 ? '' : 's'} after it`
            : 'nothing changed after it'}
        </span>
        <ChevronRight />
      </summary>
      <div>
        <p className="eyebrow">Where the content came from</p>
        <ul>
          {report.sources.map((source) => (
            <li key={source}>{source}</li>
          ))}
        </ul>
        <p className="eyebrow">What athanor did afterwards that changed something</p>
        {report.changes.length > 0 ? (
          <ul>
            {report.changes.map((change) => (
              <li key={change.label}>
                {change.label}
                {change.count > 1 ? ` · ${change.count} times` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing. Everything after the read was reading, thinking, or writing this answer.</p>
        )}
      </div>
    </details>
  );
}

const forkLabel: Record<string, string> = {
  edit: 'Edited message',
  retry: 'Regenerated answer',
  branch: 'Branch'
};

/**
 * "Version 2 of 3" across the forks taken from one point, with a way back to the original.
 *
 * This is the only place a fork is described now. The workbench header carried the same two facts —
 * a "Branch" label under the title and an "Original" button beside it — so a forked conversation
 * said it three times on one screen, and the header's version of it could not say which version of
 * how many. The one case the header covered and this did not was a parent too old to be in the
 * loaded list, which is why the way back is drawn from the task's own `parentTaskId` rather than
 * from a sibling that happens to be on this device.
 */
function ForkBar({
  task,
  tasks,
  onOpenTask
}: {
  task: Task;
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
}) {
  const family = forkFamily(task, tasks);
  const hasVersions = family.index >= 0 && family.versions.length > 1;
  const parentId = family.parent?.id ?? task.parentTaskId ?? undefined;
  if (!hasVersions && family.children.length === 0 && !parentId) return null;
  return (
    <div className="fork-bar">
      <GitBranch />
      {hasVersions ? (
        <>
          <button
            disabled={family.index === 0}
            aria-label="Previous version"
            onClick={() => onOpenTask(family.versions[family.index - 1]!.id)}
          >
            ‹
          </button>
          <span>
            {forkLabel[task.forkKind ?? 'branch'] ?? 'Branch'} · version {family.index + 1} of{' '}
            {family.versions.length}
          </span>
          <button
            disabled={family.index === family.versions.length - 1}
            aria-label="Next version"
            onClick={() => onOpenTask(family.versions[family.index + 1]!.id)}
          >
            ›
          </button>
        </>
      ) : family.children.length > 0 ? (
        <span>
          {family.children.length} {family.children.length === 1 ? 'branch' : 'branches'} taken from
          this conversation
        </span>
      ) : (
        <span>{forkLabel[task.forkKind ?? 'branch'] ?? 'Branch'}</span>
      )}
      {parentId && (
        <button className="fork-origin" onClick={() => onOpenTask(parentId)}>
          Open original
        </button>
      )}
    </div>
  );
}

const starters = [
  {
    label: 'Build and host an app',
    prompt: 'Build a small web app and host it on this computer, then show me the preview link.'
  },
  {
    label: 'Analyze large files',
    prompt:
      'I will upload a large data file. Load it, summarise what is in it, and chart the trend.'
  },
  {
    label: 'Research across the web',
    prompt: 'Research this topic across several sources and write me a short briefing with links: '
  }
];

/**
 * How many transcript entries are mounted before the reader asks for more.
 *
 * A task the agent worked on for an hour replays its whole event log, and every node of it used to
 * be rendered: thousands of DOM elements, screenshots included, before the newest message appears.
 * The window is generous enough that an ordinary conversation never notices it exists.
 */
const VISIBLE_NODE_WINDOW = 80;

export function Timeline({
  task,
  tasks = [],
  events,
  missing = false,
  modelName,
  earlierAvailable = false,
  earlierLoading = false,
  onLoadEarlier,
  onOpenSurface,
  onOpenPreview,
  onOpenTask,
  onOpenSpendCaps,
  onBranch,
  onEdit,
  onRetry,
  onStarter
}: {
  task: Task | undefined;
  tasks?: Task[];
  events: TaskEvent[];
  missing?: boolean;
  modelName?: (id: string) => string;
  /** Whether the box holds any of this conversation older than what was sent to this device. */
  earlierAvailable?: boolean;
  earlierLoading?: boolean;
  onLoadEarlier?: () => void;
  onOpenSurface?: (surface: Surface) => void;
  onOpenPreview?: (previewId: string) => void;
  onOpenTask?: (taskId: string) => void;
  /** Where a run stopped by a spending ceiling sends the owner, since only they can raise it. */
  onOpenSpendCaps?: () => void;
  onBranch?: (event: TaskEvent) => void;
  onEdit?: (event: TaskEvent) => void;
  onRetry?: (event: TaskEvent) => void;
  onStarter?: (prompt: string) => void;
}) {
  const status = task?.status ?? 'queued';
  const [revealed, setRevealed] = useState(VISIBLE_NODE_WINDOW);
  useEffect(() => setRevealed(VISIBLE_NODE_WINDOW), [task?.id]);
  /*
   * Every one of these reads the entire event log, so the memo is what keeps a render that is not
   * about new events — a poll landing in the sidebar, a scroll, an activity group being opened —
   * from rebuilding the transcript for the second time with the same input.
   *
   * It cannot save a render that *is* about a new event, and nothing keyed on this array can: the
   * input genuinely changed. The old comment claimed the memo stopped "hundreds" of rebuilds per
   * reply, and that was never true, because a reply's hundreds of frames are hundreds of distinct
   * arrays. Measured on an 800-event log replayed the way the client replays it: 83 ms of rebuild
   * per event against 0.20 ms for the same log folded in once. What collects those frames into one
   * is the animation-frame buffer in App's transcript effect, not this line.
   *
   * The dependency stays the array itself rather than `[events.length, events.at(-1)?.id]`. That
   * key measures identical during streaming — every arriving event changes the length too — so it
   * buys nothing, and it would go stale the first time an event is revised in place.
   */
  const transcript = useMemo(() => {
    let planSequence = 0;
    for (let index = events.length - 1; index >= 0; index -= 1)
      if (events[index]!.kind === 'plan') {
        planSequence = events[index]!.sequence;
        break;
      }
    return {
      nodes: buildConversation(events, status),
      overview: activityOverview(status, events),
      settled: settledToolStarts(events, status),
      planSequence
    };
  }, [events, status]);
  /*
   * What is actually mounted, which is what the scrollport's height is made of. `events.length`
   * follows the newest content and `mounted` follows the oldest, and the two grow for different
   * reasons: an arriving answer at the bottom, a page of history at the top.
   */
  const nodeCount = transcript.nodes.length;
  const mounted = Math.min(nodeCount, revealed);
  const scroll = useStickyScroll(events.length, mounted);
  /*
   * A fetched page arrives above everything already held, so without this it would land entirely
   * inside the hidden part of the window and the click would appear to do nothing. Revealing
   * exactly what grew - measured, not assumed, because the node count is not the event count -
   * shows the reader what they asked for and nothing else.
   *
   * In a passive effect rather than at merge time so the growth is measured after the transcript
   * has been rebuilt, and so the layout effect that holds the scroll position runs on the commit
   * that actually mounts the nodes.
   */
  const awaitingEarlier = useRef(false);
  const knownNodeCount = useRef(nodeCount);
  const headNodeId = useRef(transcript.nodes[0]?.id);
  useEffect(() => {
    const grown = nodeCount - knownNodeCount.current;
    const head = transcript.nodes[0]?.id;
    const grewAtHead = grown > 0 && head !== headNodeId.current;
    knownNodeCount.current = nodeCount;
    headNodeId.current = head;
    if (!awaitingEarlier.current) return;
    // The head test separates the page that was asked for from an answer still streaming in at the
    // bottom, which also grows the node count and must not be mistaken for it.
    if (grewAtHead) {
      awaitingEarlier.current = false;
      setRevealed((current) => current + grown);
      return;
    }
    /*
     * The request ended and nothing was added above - it failed, or the box had nothing left. The
     * held scroll position is waiting for growth that is not coming, and the next thing to arrive
     * at the bottom would otherwise be restored against it and move the view.
     */
    if (!earlierLoading) {
      awaitingEarlier.current = false;
      scroll.release();
    }
  }, [nodeCount, earlierLoading, transcript.nodes, scroll.release]);
  if (missing)
    return (
      <div className="empty-canvas">
        <h1>That conversation is gone</h1>
        <p>
          It was deleted, or the link points at another install. Everything still here is in the
          sidebar and in search.
        </p>
      </div>
    );
  // The empty canvas gives way the moment there is something to show, which for a brand new
  // conversation is the optimistic copy of the message the user just sent.
  if (!task && events.length === 0)
    return (
      // Five stacked elements used to stand between opening athanor and typing: an eyebrow that
      // repeated the heading, the heading, a paragraph, the examples, and a note explaining that
      // panes open when needed - which the interface demonstrates the first time it happens.
      //
      // The heading went too, and it was the last of them. "A whole computer that keeps working
      // while you are away" is a claim about a machine that has, at that moment, done nothing: the
      // software talking about itself, on the one screen that should be showing the computer. The
      // three examples teach what this can do better than any sentence claiming it, and each one
      // writes the first message.
      <div className="empty-canvas">
        <div className="starter-capabilities">
          {starters.map((starter) => (
            <button key={starter.label} type="button" onClick={() => onStarter?.(starter.prompt)}>
              {starter.label}
            </button>
          ))}
        </div>
      </div>
    );

  const hidden = Math.max(0, transcript.nodes.length - revealed);
  const nodes = hidden ? transcript.nodes.slice(hidden) : transcript.nodes;
  // Only the newest activity group is the one the agent is working in; the rest are history.
  const lastActivityId = liveActivityId(transcript.nodes);

  return (
    <div
      className="timeline-viewport"
      ref={scroll.container}
      onScroll={scroll.onScroll}
      /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scroll container that
         cannot be reached from the keyboard is a WCAG 2.1.1 failure; the transcript is often the
         only scrollable thing on screen and frequently contains no focusable element at all. */
      tabIndex={0}
      /*
        A region, not a log.

        `log` carries an implicit `aria-live="polite"`, and the answer arrives here as a growing
        node rewritten on every frame - so a screen reader read the reply aloud a few words at a
        time, from the top, several times a second, for the whole of a turn. Turn boundaries are
        already announced through the polite region built for them, once each, in words.
      */
      role="region"
      aria-label={`Conversation: ${task?.title ?? 'New conversation'}`}
    >
      <div className="timeline">
        {task && onOpenTask && <ForkBar task={task} tasks={tasks} onOpenTask={onOpenTask} />}
        {/*
          One control for one question, whichever side of the wire the answer is on.

          It used to reveal transcript nodes this device already held and nothing else, so on a
          conversation opened at its newest page it would have run out at the top of that page with
          the rest of the conversation still on the box. Revealing what is here is instant and comes
          first; when there is nothing left to reveal, the same click asks for the page before it.
        */}
        {(hidden > 0 || earlierAvailable) && (
          <button
            className="earlier-in-conversation"
            disabled={earlierLoading}
            onClick={() => {
              scroll.hold();
              if (hidden > 0) {
                setRevealed((current) => current + VISIBLE_NODE_WINDOW);
                return;
              }
              awaitingEarlier.current = true;
              onLoadEarlier?.();
            }}
          >
            {earlierLoading && <LoaderCircle className="spin" />}
            Earlier in this conversation
            {hidden > 0 ? ` · ${hidden} more` : ''}
          </button>
        )}
        {task && nodes.length === 0 && (
          <div className="user-brief">
            <p>{task.title}</p>
            <span className="message-meta">
              Sent to {modelName?.(task.modelId) ?? task.modelId.split('/').pop()}
            </span>
          </div>
        )}
        {nodes.map((node) => {
          if (node.kind === 'user')
            return (
              <UserMessage
                key={node.id}
                node={node}
                workspaceId={task?.workspaceId}
                {...(onEdit ? { onEdit } : {})}
                {...(onBranch ? { onBranch } : {})}
              />
            );
          if (node.kind === 'assistant')
            return (
              <AssistantMessage
                key={node.id}
                node={node}
                {...(modelName ? { modelName } : {})}
                {...(onRetry ? { onRetry } : {})}
                {...(onBranch ? { onBranch } : {})}
              />
            );
          if (node.kind === 'queued')
            return (
              <article className="user-brief queued-user-message" key={node.id}>
                <Markdown>{node.markdown}</Markdown>
                <span className="message-meta">
                  <Clock3 /> Queued · runs after the current turn
                </span>
              </article>
            );
          if (node.kind === 'thinking')
            return (
              /*
                Closed, and left alone once the reader has an opinion about it.

                This was forced open for the whole time it was streaming, so every word a model
                thought was in the conversation above its answer - and because `open` was a
                controlled prop, a reader who shut it had it reopened under them on the next frame.
                It is uncontrolled now. While it runs the summary carries the latest line, which is
                what a reader actually wants from a block that has not finished: proof it is moving.
              */
              <details className="agent-thinking" key={node.id}>
                <summary>
                  <Brain />
                  {node.streaming ? (
                    <>
                      Thinking
                      {lastLine(node.markdown) && (
                        <span className="thinking-latest"> — {lastLine(node.markdown)}</span>
                      )}
                    </>
                  ) : (
                    'How it got there'
                  )}
                </summary>
                <Markdown>{node.markdown}</Markdown>
              </details>
            );
          if (node.kind === 'activity')
            return task ? (
              <ActivityLog
                key={node.id}
                task={task}
                events={node.events}
                overview={transcript.overview}
                settled={transcript.settled}
                planSequence={transcript.planSequence}
                live={node.id === lastActivityId}
                {...(onOpenSurface ? { onOpenSurface } : {})}
              />
            ) : null;
          if (node.kind === 'handoff')
            return (
              <Handoff
                key={node.id}
                wall={node.wall}
                {...(onOpenSurface ? { onOpenSurface } : {})}
              />
            );
          if (node.kind === 'told')
            return (
              <AgentNote
                key={node.id}
                headline={node.notice.headline}
                detail={node.notice.detail}
              />
            );
          if (node.kind === 'rewound')
            return <ComputerRewound key={node.id} {...(onOpenSurface ? { onOpenSurface } : {})} />;
          if (node.kind === 'paused')
            return (
              <SpendPauseCard
                key={node.id}
                pause={node.pause}
                {...(onOpenSpendCaps ? { onOpenCaps: onOpenSpendCaps } : {})}
              />
            );
          if (node.kind === 'completion')
            return (
              <Event
                key={node.id}
                event={node.event}
                compactCompletion
                {...(node.harness ? { harness: node.harness } : {})}
              />
            );
          return (
            <Event
              key={node.id}
              event={node.event}
              {...(node.kind === 'notice' && node.resolution
                ? { resolution: node.resolution }
                : {})}
              {...(onOpenSurface ? { onOpenSurface } : {})}
              {...(onOpenPreview ? { onOpenPreview } : {})}
            />
          );
        })}
        {/* Shown while the money is being spent, not only once it has been: the cost events are
            already in the stream and waiting for the task to finish is waiting too long. */}
        <ProvenanceSummary events={events} />
        <CostSummary task={task} events={events} />
      </div>
      {!scroll.pinned && (
        <button className="jump-to-latest" onClick={scroll.jump} title="Jump to the newest message">
          <ArrowDown /> Latest
        </button>
      )}
    </div>
  );
}
