/*
 * What the model is sent: its size, its shape, and whether it describes the product it is part of.
 *
 * Split out of tools.test.ts with the catalogue itself. Nothing here calls the approval floor to
 * decide anything - where `approvalRequirement` appears below it is because the catalogue promised
 * the model a card would be raised, and a promise in a description that the floor does not keep is
 * a defect in the description.
 */
import { describe, expect, it } from 'vitest';
import {
  BrowserAction,
  DesktopAction,
  MAX_AGENT_NOTIFICATIONS_PER_TASK,
  TaskScheduleSpec,
  type MediaModelOption
} from '@athanor/contracts';
import {
  connectorActions,
  MEMORY_RECALL_ITEM_CEILING,
  MEMORY_RECALL_MAX_ITEMS
} from '@athanor/core';
import { agentTools, agentToolsFor } from './tool-catalogue.js';
import { approvalRequirement } from './approval-policy.js';
import { isMutatingToolCall } from './write-classification.js';
import { REPEATABLE_TOOLS } from './turn-bounds.js';
import { surfaceActionRequest } from './surface-actions.js';
import { MAX_NOTICES_PER_TURN } from './agent.js';
import { BASE_SYSTEM_PROMPT, COMPACT_CONTEXT_TOOL } from './context.js';
import { MEMORY_SESSION_SEARCH_MAX_RESULTS } from './memory-runtime.js';
import { managedMediaCatalog, resolvedMediaModel } from './media.js';
import { CODE_SEARCH_COLLAPSE_LINES, CODE_SEARCH_FILE_CEILING } from './tools/repository.js';

/** A stored media route, as the API seals one into the credential this worker decrypts. */
const mediaOption = (
  overrides: Partial<MediaModelOption> & Pick<MediaModelOption, 'id'>
): MediaModelOption => ({
  providerModelId: overrides.id,
  displayName: overrides.id,
  provider: 'openrouter',
  modality: 'image',
  usdPerImage: null,
  usdPerMillionCharacters: null,
  usdPerMinute: null,
  priceSource: 'provider',
  recommendationTags: [],
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...overrides
});

describe('plan tool schema', () => {
  const setPlan = agentTools.find((tool) => tool.name === 'set_plan');

  it('lets the model report step status, not just titles', () => {
    // planStepsFromArguments reads {title,status} objects, so the schema has to admit them.
    // While it only allowed strings the model could never move a step off 'pending' and the
    // live plan the user watches stayed frozen for the whole task.
    const steps = (setPlan?.parameters as { properties?: Record<string, unknown> }).properties
      ?.steps as { items?: { oneOf?: Array<Record<string, unknown>> } } | undefined;
    const shapes = steps?.items?.oneOf ?? [];
    expect(shapes.some((shape) => shape.type === 'string')).toBe(true);
    const object = shapes.find((shape) => shape.type === 'object') as
      | { properties?: { status?: { enum?: string[] } } }
      | undefined;
    expect(object?.properties?.status?.enum).toEqual([
      'pending',
      'in_progress',
      'completed',
      'skipped'
    ]);
  });

  it('tells the model when to update status, since nothing else will', () => {
    expect(setPlan?.description).toMatch(/in_progress/);
    expect(setPlan?.description).toMatch(/completed/);
  });
});

describe('the size of the catalogue the model is sent', () => {
  // Measured rather than asserted in prose. The comment above the catalogue used to carry the
  // numbers, and a stale number in a comment reads exactly like a fresh one; this holds the real
  // catalogue against a ceiling instead, so a description that grows back fails here.
  const sent = [...agentToolsFor(), COMPACT_CONTEXT_TOOL];
  const bytes = Buffer.byteLength(JSON.stringify(sent));

  it('sends every declared tool, once', () => {
    expect(agentToolsFor()).toHaveLength(agentTools.length);
    const names = sent.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('stays inside the wire budget the whole prefix is cached against', () => {
    // Raised twice, and only ever by what a whole capability cost. From 58,000 for memory_recall,
    // about two kilobytes of tool, before which the tiered memory store could be read at task start
    // and never asked a question again. Then from 59,600 for desktop zoom, about four hundred
    // bytes: the agent's still is the whole screen reduced to fit a bounded image, so a checkbox
    // arrives a few pixels across and clicking one from that is a guess - looking closely at a
    // rectangle is the largest single accuracy gain available on that surface and it is one
    // screenshot. Three tools were deleted in between and their room is already spent.
    //
    // Then lowered, for the first time, from 60,200 to 51,900. Nothing was withdrawn to do it: the
    // catalogue measured 60,077 bytes and now measures 51,751, and it still declares every tool,
    // every action and every field it declared before. The saving was scaffolding. browser_action
    // and desktop_action stated their actions as a twenty- and a ten-variant `oneOf`, in which
    // roughly two thirds of the bytes were the repeated
    // {"type":"object","additionalProperties":false,…,"properties":{"type":{"const":…}}} frame and
    // the selector and tabId definitions written out six and seventeen times; re-stated as a flat
    // property bag with a sibling `action` enum - the shape connector_action already used - they
    // cost 3.4 kB and 2.2 kB instead of 8.3 kB and 3.8 kB. connector_action's 48-field input bag
    // then gave up the per-field lengths and prose that the Zod schemas in @athanor/core re-check
    // anyway, and a handful of "because" clauses that only restated the operating contract went.
    //
    // The number moves for a capability and not for prose, which is the distinction this ceiling
    // exists to enforce - and it moves down for an encoding, which is the other half of the same
    // rule.
    //
    // Then raised from 51,900 to 52,200 for services: one `service` field on shell, 174 bytes net
    // after `timeoutSeconds` gave back the sentence a service makes untrue. `background` keeps its
    // restart caveat, scoped: a plain background process still lives in a Map and still dies with
    // the workspace runtime, which is the difference between a link the model hands the owner that
    // answers in the morning and one that does not. It
    // is a capability by the test above's own definition - a background process was capped at an
    // hour and lived in a Map, so a link the agent handed the user stopped answering by dinner, and
    // no wording anywhere could have said otherwise. The field is the only way to reach a process
    // the computer keeps running (services/workspace-runner/src/services.ts); everything the model
    // needs to know about the backoff, the crash-loop give-up and the restart record is read back
    // through `process`, not declared here, which is why it costs a sentence and not a tool.
    // Measured at 52,055 against it, so the room this leaves is 145 bytes and not a licence.
    //
    // Then raised from 52,200 to 53,870 for `ask`: 1,601 bytes, of which 1,002 are the description
    // and most of that is the list of cases in which not to call it. It is a capability by this
    // test's own definition and the clearest one in the catalogue - the operating contract has
    // always told the model to ask when a missing choice materially changes the result, and there
    // was nowhere to ask, so a genuine blocker came back as a finish with a not_applicable
    // verification and read to the owner exactly like finished work. No wording could have fixed
    // that. The description is where the bytes went on purpose: the tool's own failure mode is an
    // agent that asks instead of working, and every clause telling it when not to ask is cheaper
    // than one parked conversation the owner did not need to be interrupted by.
    // Measured at 53,722 against it.
    //
    // Then raised from 53,870 to 55,300 for `audio_read`: 1,385 bytes, nearly all of it the
    // description. It is a capability by this test's own definition and there was no wording that
    // could have substituted for it - thirty-nine tools could open a recording and not one could
    // hear it, so a voice memo, a meeting recording or a voicemail sat in Files as bytes the
    // computer could copy, rename and publish and could not read a word of. The bytes are in the
    // description because two of the things a model cannot discover without spending the owner's
    // money to find out are declared there: which containers arrive from a phone and are converted
    // rather than refused, and that a reading is bounded at ninety minutes and resumes by second
    // rather than failing on a long file. Measured at 55,107 against it.
    //
    // Then raised from 55,300 to 56,100 for `set_acceptance`'s render clause: 712 bytes, 590 of it
    // the clause and 122 the sentence on the tool that is the only place the model finds out it is
    // there. It is a capability by this test's own definition and the substitution test is the
    // sharpest it has been - every visual deliverable this product leads with was proved by being
    // bigger than four kilobytes, and a deck with text running off slide four is comfortably past
    // that, so the only witness to how the thing looked was the model that made it. No wording
    // could have fixed that: the measurement is a render the harness performs at finish
    // (services/workspace-runner/src/render-proof.ts), and a field is the only way to ask for one.
    // The bytes are in the two things a model cannot discover by trying - what is measured, and
    // that text pushed entirely off a page is not among it. Measured at 55,937 against it.
    //
    // The ceiling then held while the catalogue moved under it, which is the case it was written
    // for. Two capabilities the schema had been silent about were declared - maxBytes on the
    // connector input bag, which the connector layer already parses and whose truncation note
    // already tells the model to raise it, and a clause on coding_agent.maxTurns naming the one
    // specialist whose CLI takes a turn bound - and they were paid for first, out of two return-
    // shape enumerations that the first result reveals for free: browser_snapshot's opening
    // sentence, which also promised page links the runner has never returned, and
    // desktop_observe's. 237 bytes freed, 173 spent, measured at 55,873. The ceiling did not move
    // because no capability was added; a description that grows back still fails here.
    //
    // It held again for `code_search`'s summarised mode, and this one is worth recording because it
    // is the first entry to pay for a capability entirely out of its own duplication. Two nested
    // descriptions went - `literal`'s and `wholeWord`'s - which between them said the same two
    // things the tool's own sentence already said, once where the model chooses the tool and again
    // where it fills the field, and were charged for twice. What arrived in their place is the
    // `summary` field and two sentences of return shape: that a result spanning several files
    // collapses to one row per file with a count, and that a result past a hundred files is refused
    // outright. Both are discovery-test facts - a model cannot learn either without spending a
    // billed call to find out - and both are what the ablation behind the change is about: search
    // that returned each match with its surrounding context scored six points below search that
    // returned only `path (N matches)`. 284 bytes freed, 247 spent, measured at 55,813. Down 37,
    // and the ceiling stays where it was.
    //
    // Priced against the same headroom and declined: #36's `wait_for_previous`, a per-tool boolean
    // letting the model declare which of its calls may overlap. Measured at +2,170 bytes bare and
    // +6,926 with a sentence explaining it, against 287 of headroom - but the byte count is the
    // second reason. athanor does not batch on a guess about intent: `PARALLEL_SAFE_TOOLS` in
    // turn-bounds.ts is a three-part safety property, and its third part is that the approval
    // floor's verdict cannot move while the run is in flight. A model declaration would be inert
    // for every tool already in that set and a floor bypass for every tool outside it.
    //
    // Then lowered, for the second time, from 56,100 to 54,700, and every byte of it is an
    // encoding or a duplicate rather than a capability. 55,813 to 54,632.
    //
    // 699 of it is `schedule.spec`, which was the last five-variant `oneOf` left in this file and
    // failed the same test browser_action and desktop_action failed: about two thirds frame, with
    // `timeZone` written out three times and `localTime` twice, pattern and all. Flat property bag,
    // sibling `kind` enum, per-kind required set in the one description the five variants used to
    // state theirs in. Every kind, field, bound and pattern still declared, and `TaskScheduleSpec`
    // in @athanor/contracts - ordinary `z.object`s, so a foreign field is stripped rather than
    // fatal - is still what decides what is accepted. Driven through the real dispatch arm, which
    // was already being handed exactly this flat shape.
    //
    // 482 of it is three descriptions restating the operating contract, which arrives on the same
    // request: print_pdf's typst clause, generate_media's "no model weights, use ffmpeg", and
    // browser_snapshot's account of what an anti-bot challenge closes and for how long. The typst
    // one was worse than a duplicate - the contract's copy is gated on the box having a document
    // toolchain and this one was not, so a bare box read in one request both that it has no typst
    // and that typst is the route for a PDF that matters. What stays is the part the contract
    // cannot say: the name of the field a challenge arrives in, and that a clip cannot be made.
    // Pinned from now on by "pays once for a machine fact" below, so it cannot grow back quietly.
    //
    // Three larger moves were priced against this ceiling and are NOT here, because none of them
    // fits inside this file: conditioning the browser and desktop bags on a box that has them
    // (~11.0 kB) needs an availability probe that does not exist anywhere yet, plus the withdrawal
    // set in turn/claim.ts and the entitlement rebuild that has to agree with it; deferring
    // connector_action's 48-field input bag (~4.4 kB) is held in place by a name-level pin in
    // approval-policy.test.ts; and folding read_elements into browser_snapshot (~0.7 kB net) is
    // named by skills/web-form-filling's front matter, which skills.test.ts checks against this
    // catalogue. Each is a real saving and none of them is a description that grew.
    expect(bytes).toBeLessThan(54_700);
    // Where the bytes actually are, because it is not where it looks. connector_action is now the
    // largest entry at ~6.6 kB, and 5.0 kB of that is one `input` object declaring 48 fields - the
    // union of what twenty-four actions across mail, calendar and repositories accept. Those are
    // interface facts a model would otherwise guess at and burn a round trip on. Prose that
    // restates the system prompt is what gets trimmed here; what a call has to contain is not
    // prose, and is deliberately not where tokens are saved.
    for (const tool of sent)
      expect(Buffer.byteLength(tool.description), `${tool.name} description`).toBeLessThan(1_400);
    /*
     * And every description nested inside `parameters`, which the cap above never reached.
     *
     * The cap was written against `tool.description` alone, so the whole of a tool's prose could
     * grow anywhere below it and the ceiling above was the only thing that noticed - a whole-
     * catalogue figure that moves for forty other reasons and is raised, on the record, whenever a
     * capability lands. Measured when the walk was first added: eleven tools carry a nested
     * description of their own, forty-one nested descriptions in all, and one of them was past the
     * top-level cap - connector_action.properties.input.description at 1,741 bytes.
     *
     * That one is the per-action field map: which of the 48 fields each of the twenty-four
     * connector actions takes. It is the case the paragraph above describes and refuses to trim -
     * a model that has to guess at it burns a billed round trip finding out, and the Zod schemas
     * in @athanor/core are the only other place the answer exists, where the model cannot read it.
     * So the number here is raised rather than the text cut, deliberately and once: 1,750 is the
     * measured 1,741 with nine bytes to spare, which is a ceiling and not a licence. It is a
     * separate number from the top-level cap on purpose - a nested description that grows still
     * fails here, and the tool's own pitch is still held to 1,400.
     */
    const nested: [string, number][] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'description' && typeof value === 'string')
          nested.push([`${path}.${key}`, Buffer.byteLength(value)]);
        else walk(value, `${path}.${key}`);
      }
    };
    for (const tool of sent) walk(tool.parameters, tool.name);
    // A walk that stops finding anything is this check failing while it looks like it passed, which
    // is exactly how the top-level cap missed 1,741 bytes for as long as it did.
    expect(nested.length).toBeGreaterThan(30);
    for (const [where, size] of nested) expect(size, where).toBeLessThan(1_750);
  });

  it('has no tool whose own description says it unlocks nothing', () => {
    // tool_search ranked definitions already in the window, billed a full pass over that window to
    // do it, and said so in its own description.
    for (const tool of sent) expect(tool.description).not.toMatch(/does not unlock anything/);
    expect(sent.map((tool) => tool.name)).not.toContain('tool_search');
  });

  it('pays once for a machine fact, not once here and once in the contract', () => {
    /*
     * The ceiling above says that prose restating the system prompt is what gets trimmed. This is
     * that rule as a check rather than as a paragraph, because three descriptions were restating
     * it and only the whole-catalogue figure - which moves for forty other reasons - could see it.
     *
     * Three facts, each carried by the operating contract in the same request, each of which was
     * also being paid for down here: which binary controls where a page breaks, that this computer
     * generates no video and edits the owner's own with ffmpeg, and what an anti-bot challenge
     * closes and for how long. The contract is message 0 of every window, so the model reads them
     * either way; the catalogue copy bought nothing, and the typst one was worse than nothing - it
     * was unconditional, while the contract's is gated on the box actually having a document
     * toolchain, so a bare box was told in one request both that it has no typst and that typst is
     * the route for a PDF that matters.
     *
     * What stays in a description is the part the contract cannot say: the name of the field a
     * challenge arrives in (`botWall`), and that asking generate_media for a clip will not work.
     * The direction of the check is deliberate - it asserts the contract still carries each fact
     * before it forbids the duplicate, so deleting the original turns this red rather than green.
     */
    const paidForInTheContract: ReadonlyArray<readonly [string, RegExp]> = [
      ['typeset with typst', /\btypst\b/i],
      ['no video generation here at all', /\bffmpeg\b|model weights/i],
      ['anti-bot challenge', /until the user clears it|carry on with the rest/i]
    ];
    for (const [carried, restated] of paidForInTheContract) {
      expect(BASE_SYSTEM_PROMPT, `the contract stopped carrying "${carried}"`).toContain(carried);
      for (const tool of sent)
        expect(
          tool.description,
          `${tool.name} restates "${carried}", which the contract already sends on this request`
        ).not.toMatch(restated);
    }
  });
});

/*
 * The wire is two surfaces, not one, and the smaller of them is a security boundary.
 *
 * The ceiling above measures what the lead is sent. It is the larger number and the one the owner
 * pays on every step, but it is not the only one: `runDelegateMission` builds an isolated read-only
 * specialist and sends it a ninth of that. The two figures belong in the same file because the
 * pressure to demote a tool off the lead's wire is exactly the pressure that would blind the
 * specialist, and until this block existed nothing put them in front of the same reader.
 *
 * Measured when this block was written: lead 40 tools / 55,113 bytes (55,782 with the compaction
 * tool the loop adds), specialist 9 tools / 7,431 bytes. The specialist's surface did not change
 * when it moved out of delegate.ts - it is byte-identical, asserted below, because the array a
 * provider caches must not move for a refactor.
 */
describe('the wire surface each audience is sent', () => {
  const lead = agentToolsFor();
  const specialist = agentToolsFor('specialist');
  const specialistNames = specialist.map((tool) => tool.name);

  it('sends the specialist a strict subset of what the lead can see', () => {
    // The lead is the union by construction. If a name ever appears only on the specialist's wire,
    // the delegate path has grown a capability the lead cannot audit or perform itself, and the
    // report it gets back would be unreproducible by the agent that has to act on it.
    const leadNames = new Set(lead.map((tool) => tool.name));
    for (const name of specialistNames) expect(leadNames.has(name), name).toBe(true);
    expect(specialist.length).toBeLessThan(lead.length);
  });

  it('gives the specialist nothing the harness itself classifies as a change', () => {
    /*
     * Derived, because enumerated did not hold. The only guard on this set was four names in
     * agent-run.test.ts - shell, file_write, browser_action, finish - and `file_patch`, whose whole
     * purpose is changing a file the specialist's own system prompt tells it it cannot change, went
     * straight through with all 1,145 worker tests green. A blocklist protects the names somebody
     * thought of.
     *
     * These are the two sets the containment property actually rests on, and both are consulted at
     * runtime rather than restated here. `isMutatingToolCall` decides whether a call takes a
     * workspace checkpoint and sets `mutatedBeyondProse`; `REPEATABLE_TOOLS` decides whether it is
     * safe to replay after an interrupted turn. A read-only investigator that fails either is not
     * read-only, whatever the allowlist is called.
     */
    for (const name of specialistNames) {
      expect(isMutatingToolCall(name), `${name} is classified as a change`).toBe(false);
      expect(REPEATABLE_TOOLS.has(name), `${name} is not safe to replay`).toBe(true);
    }
    // Named as well as derived, only because these four are the ones a future edit reaches for:
    // the shell is the whole reason the specialist is a containment path and not just a cheaper
    // model, and `finish` would let a quarantined agent close the owner's task.
    for (const name of ['shell', 'process', 'file_write', 'finish'])
      expect(specialistNames).not.toContain(name);
  });

  it('still gives it a way to read the workspace and the web', () => {
    // The non-vacuity half. Every assertion above passes on an empty set, and an empty set is how
    // this test would look if the tier were ever filtered by a name that no longer exists - which
    // is how the catalogue's own nested-description walk once passed while finding nothing.
    expect(specialistNames).toContain('file_read');
    expect(specialistNames).toContain('web_search');
    expect(specialistNames).toContain('parallel_web_read');
    expect(specialist.length).toBeGreaterThan(4);
  });

  it('costs the specialist a ninth of what the lead pays, and did not move when it moved', () => {
    // The ceiling for the smaller audience, on the same terms as the one above: it moves for a
    // capability and not for prose. 7,431 measured, and the headroom is deliberately thin because
    // nine read-only tools is what this agent is.
    expect(Buffer.byteLength(JSON.stringify(specialist))).toBeLessThan(7_600);
    // Byte-identical to the array delegate.ts used to build for itself: the same nine entries in
    // the same order, so the refactor cannot have moved a cached prefix. Order is the point - core
    // set first, then declaration order, exactly as the lead's is.
    expect(specialistNames).toEqual([
      'files_list',
      'file_read',
      'session_search',
      'web_search',
      'document_read',
      'document_search',
      'code_search',
      'repo_overview',
      'parallel_web_read'
    ]);
  });

  it('keeps the four readers the specialist depends on out of any lead-side demotion', () => {
    /*
     * The record of a refusal, kept where the next person to propose it will meet it.
     *
     * `files_list`, `repo_overview`, `document_read` and `document_search` have been proposed for
     * removal from the lead's wire on the grounds that `shell` substitutes for them - about 2.8 kB.
     * It does not substitute. `shell` is in neither of the sets asserted above, so the same read
     * arriving through it becomes a change: a workspace checkpoint, `mutatedBeyondProse` set, and a
     * completion-evidence rule that now wants a check performed after it. That is the defect the
     * comment on `audio_read` in write-classification.ts records happening once already, for one
     * voice memo.
     *
     * So the assertion is not that the four are present - it is that the substitution being offered
     * is false, checked against the classifier rather than against a sentence in a design document.
     */
    for (const name of ['files_list', 'repo_overview', 'document_read', 'document_search']) {
      expect(specialistNames).toContain(name);
      expect(isMutatingToolCall(name)).toBe(false);
    }
    expect(isMutatingToolCall('shell', { executable: 'ls', args: ['-la'] })).toBe(false);
    // The half that matters: the shell the model is actually told to reach for whenever it needs a
    // pipe, a glob or a redirect. Every one of those reads is a change.
    expect(isMutatingToolCall('shell', { executable: 'bash', args: ['-lc', 'ls -la'] })).toBe(true);
    expect(REPEATABLE_TOOLS.has('shell')).toBe(false);
  });
});

describe('the catalogue as the model reads it', () => {
  it('gives every tool a distinct name and a description inside the size budget', () => {
    // Named for what it proves. It used to be called "a description that survives being read
    // alone", which it never checked: eighty-one repeated characters passed it, and both the
    // notify limit and the video kind that could not be generated passed it too.
    const names = agentTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of agentTools) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // Short enough to skim, long enough to say what the tool is for and where its edge is.
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      expect(tool.description.length, tool.name).toBeLessThan(3_000);
    }
  });

  it('states the retrieval bounds the runtime enforces rather than a second copy of them', () => {
    /*
     * A schema bound is a promise, and the only one the model can see. Both retrieval tools were
     * making promises nothing kept.
     *
     * `session_search` advertised `maximum: 50` against a `MEMORY_SESSION_SEARCH_MAX_RESULTS` of
     * 30, which is the worst shape this defect takes: the model asks for fifty, is given thirty
     * without being told, reads `conversations: 14` off the truncated set and reports fourteen to
     * the owner as the whole history (ATH-165). Its `taskId` also offered "search or browse", and
     * a call with a task and no query throws `session_search_query_empty` before `taskId` is even
     * read - there is no browse mode and there never was.
     *
     * `memory_recall` wrote both of its item bounds out as literals, under a comment at the handler
     * claiming they were applied "against the store's own ceilings rather than here, so the tool
     * schema and the retrieval agree by construction instead of by two copies of the same numbers"
     * (ATH-164). They are interpolated now, so the two cannot drift and no eighth `copiedConstants`
     * entry is needed to notice if they did.
     */
    const schema = (
      name: string
    ): { additionalProperties?: unknown; properties: Record<string, Record<string, unknown>> } =>
      agentTools.find((tool) => tool.name === name)?.parameters as never;

    const search = schema('session_search');
    expect(search.properties.maxResults?.maximum).toBe(MEMORY_SESSION_SEARCH_MAX_RESULTS);
    // No default here: the number the loop passes when the model omits this lives at the call
    // site, and a third copy could only ever drift away from it.
    expect(search.properties.maxResults).not.toHaveProperty('default');
    expect(String(search.properties.taskId?.description)).not.toMatch(/browse/);

    const recall = schema('memory_recall');
    expect(recall.properties.maxItems?.maximum).toBe(MEMORY_RECALL_ITEM_CEILING);
    expect(recall.properties.maxItems?.default).toBe(MEMORY_RECALL_MAX_ITEMS);
    // The budget is fixed and no longer pretends otherwise. `budgetTokens` was clamped between 256
    // and a 4,000 ceiling in packages/core and was never declared here - and with
    // additionalProperties false the model could not have sent it if it had tried.
    expect(recall.additionalProperties).toBe(false);
    expect(recall.properties).not.toHaveProperty('budgetTokens');
  });

  it('states code_search’s two thresholds as the numbers the arm actually applies', () => {
    /*
     * The same defect class as the two above, in the one place it could not be closed the same way.
     *
     * `session_search` and `memory_recall` interpolate their bounds out of the modules that enforce
     * them, so the catalogue and the runtime cannot drift. `code_search` cannot: `tools/repository.ts`
     * imports `agent.js`, `agent.js` imports `tools.js`, and `tools.js` is this catalogue - so an
     * import from here into the arm closes a cycle, and whether `agentTools` reads an initialised
     * constant or throws on the temporal dead zone would come down to which module the process
     * loaded first. A test importing both has no such ordering: nothing here is evaluated while
     * either module is still initialising.
     *
     * So the drift is caught here instead. The description is the only place a model can learn what
     * this tool refuses before it spends a call finding out, and a stated refusal that fires at a
     * different number than the stated one is worse than no sentence at all.
     */
    const description = agentTools.find((tool) => tool.name === 'code_search')?.description ?? '';
    expect(description).toContain(`Past ${CODE_SEARCH_FILE_CEILING} matching files`);
    /*
     * The collapse threshold is stated as "a few dozen" rather than as a figure, on purpose: it is
     * a harness bound the model has no reason to tune against, and a model that knows the exact
     * line it will not be collapsed under has been handed an incentive to sit just below it.
     * Vague prose still has to be true, though, which is all this asserts - a threshold moved to
     * two hundred makes the sentence a lie, and this is where that is noticed.
     */
    expect(description).toContain('more than a few dozen lines');
    expect(CODE_SEARCH_COLLAPSE_LINES).toBeGreaterThanOrEqual(24);
    expect(CODE_SEARCH_COLLAPSE_LINES).toBeLessThan(60);
    /*
     * And the field is declared as what it adds, never as what it turns off. A wide result collapses
     * whether `summary` is set or not, so a description promising it as a switch would be the
     * `session_search` defect again in a boolean: a bound the model believes it set.
     */
    const summary = (
      agentTools.find((tool) => tool.name === 'code_search')?.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.summary;
    expect(summary?.description).toMatch(/^Return the per-file rows even for/);
    expect(String(summary?.description)).not.toMatch(/instead of|rather than|turn off|disable/i);
  });

  it('names nothing in a description that the schemas do not declare', () => {
    // The descriptions are the only map the model has, and they cross-reference constantly:
    // "use parallel_web_read", "actions from browser_snapshot", "mode keys", "status in_progress".
    // A tool renamed or a variant removed leaves every one of those pointing at nothing, which is
    // worse than a thin description because the model believes it. So every snake_case token in
    // every description has to resolve to something actually declared - a tool name, a connector
    // action, a parameter, or a value one of the enums accepts.
    //
    // Declared is not the same as sent, and the gap between them is where the fabricated research
    // answer came from: `web_search` was declared here and withdrawn from the catalogue of every run
    // on the provider's route, so four descriptions went on pointing at a tool the model was not
    // holding. That half is asserted against the catalogue as it actually goes out, in
    // agent-run.test.ts under "the web route a run is pinned to".
    const declared = new Set<string>([
      ...agentTools.map((tool) => tool.name),
      ...Object.keys(connectorActions),
      'compact_context'
    ]);
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const entry of node) collect(entry);
        return;
      }
      const record = node as Record<string, unknown>;
      const properties = record.properties;
      if (properties && typeof properties === 'object')
        for (const key of Object.keys(properties)) declared.add(key);
      if (typeof record.const === 'string') declared.add(record.const);
      if (Array.isArray(record.enum))
        for (const value of record.enum) if (typeof value === 'string') declared.add(value);
      for (const value of Object.values(record)) collect(value);
    };
    for (const tool of agentTools) collect(tool.parameters);

    for (const tool of agentTools)
      for (const token of tool.description.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [])
        expect(
          declared.has(token),
          `${tool.name} names "${token}", which no tool, connector action, parameter or enum declares`
        ).toBe(true);
  });

  it('offers no media kind the provider cannot actually produce', () => {
    // Both media tools listed video in their kind enum and sold it in their first sentence, while
    // every route to it threw: there is no zero-retention video API, so the catalogue entry has no
    // model id at all. The model spent a call finding that out, in front of the owner.
    const kinds = (name: string): string[] =>
      (
        (agentTools.find((tool) => tool.name === name)?.parameters.properties ?? {}) as Record<
          string,
          { enum?: string[] }
        >
      ).kind?.enum ?? [];
    const offered = new Set(kinds('generate_media'));
    expect(offered.size).toBeGreaterThan(0);
    for (const kind of offered) {
      const entry = managedMediaCatalog[kind as keyof typeof managedMediaCatalog];
      expect(entry, `no catalogue entry for the offered kind ${kind}`).toBeDefined();
      expect(entry.modelId, `${kind} is offered with no reviewed model behind it`).not.toBe('');
    }
    for (const [kind, entry] of Object.entries(managedMediaCatalog))
      if (!entry.modelId) {
        expect(offered.has(kind), `${kind} has no model and is still offered`).toBe(false);
        for (const name of ['generate_media']) {
          const sentences = (agentTools.find((tool) => tool.name === name)?.description ?? '')
            .split(/(?<=[.;])\s+/)
            .filter((sentence) => new RegExp(`\\b${kind}\\b`, 'i').test(sentence));
          // It may say the kind cannot be made; it may not mention it any other way.
          for (const sentence of sentences)
            expect(sentence, `${name} mentions ${kind} without refusing it`).toMatch(
              /\bcannot\b|\bnot\b|\bno\b/i
            );
        }
      }
    // durationSeconds only ever meant a video length; nothing else on either tool used it.
    for (const name of ['generate_media'])
      expect(
        Object.keys(
          (agentTools.find((tool) => tool.name === name)?.parameters.properties ?? {}) as object
        ),
        name
      ).not.toContain('durationSeconds');
  });

  it('prices a generation itself instead of believing the number the model sent', () => {
    // estimatedCostUsd was a required parameter, and both the approval card and the tool result
    // quoted whatever arrived in it. A call carrying 0 spent the owner's money with no card.
    const generate = agentTools.find((tool) => tool.name === 'generate_media');
    expect(Object.keys((generate?.parameters.properties ?? {}) as object)).not.toContain(
      'estimatedCostUsd'
    );
    const image = { kind: 'image', prompt: 'A logo', modelId: 'x', width: 1024, height: 1024 };
    // One image is a cent and a half: below the ceiling, and no card - which is why the ceiling is
    // cumulative rather than per call.
    expect(approvalRequirement('generate_media', image)).toBeNull();
    const card = approvalRequirement('generate_media', image, 'balanced', {
      mediaCommittedUsd: 0.3
    });
    expect(card?.sideEffect).toBe('external_reversible');
    expect(card?.preview).toContain('already spent about $0.30');
    // And the model saying it is free changes nothing, because it is not asked.
    expect(
      approvalRequirement('generate_media', { ...image, estimatedCostUsd: 0 }, 'balanced', {
        mediaCommittedUsd: 0.3
      })?.sideEffect
    ).toBe('external_reversible');
  });

  it('prices the generation against the model the owner actually chose', () => {
    // The two ids in the manifest used to be the whole of the answer in both the pricer and the
    // dispatch arm, so an owner who picked a route ten times the price still read the default's
    // figure on the card they were about to approve.
    const image = { kind: 'image', prompt: 'A logo', width: 1000, height: 1000 };
    const expensive = resolvedMediaModel('image', {
      image: mediaOption({
        id: 'openrouter/studio/canvas-1',
        displayName: 'Canvas 1',
        usdPerImage: 0.4
      })
    });
    const card = approvalRequirement('generate_media', image, 'balanced', {
      mediaModel: expensive
    });
    expect(card?.preview).toContain('Canvas 1');
    expect(card?.preview).toContain('$0.400');
  });

  it('asks every time for a route whose price the provider never published', () => {
    const unpriced = resolvedMediaModel('image', {
      image: mediaOption({ id: 'openrouter/studio/quiet-1', priceSource: 'unknown' })
    });
    expect(unpriced.priceKnown).toBe(false);
    // A cumulative threshold cannot govern a number nobody stated, and comparing it against an
    // invented one is how spend approval stops meaning anything. So the card is raised on the first
    // generation rather than on the eighteenth.
    const card = approvalRequirement(
      'generate_media',
      { kind: 'image', prompt: 'A logo', width: 1000, height: 1000 },
      'balanced',
      { mediaModel: unpriced, mediaCommittedUsd: 0 }
    );
    expect(card?.sideEffect).toBe('external_reversible');
    expect(card?.preview).toContain('publishes no price');
  });

  it('speaks with the chosen route’s own voice, and with none when it names none', () => {
    // The voice was a constant belonging to one specific speech model. The moment the model became
    // the owner's choice, sending it to any other route would have asked for a voice from a
    // different model's list.
    expect(resolvedMediaModel('audio').voice).toBe('af_heart');
    expect(
      resolvedMediaModel('audio', {
        audio: mediaOption({
          id: 'openrouter/studio/speaker-1',
          modality: 'audio',
          usdPerMillionCharacters: 1
        })
      }).voice
    ).toBeUndefined();
  });

  it('will not price one modality against a route stored for the other', () => {
    // A speech route standing in for an image would be priced per million characters against a
    // request measured in pixels, and the owner would first see it on an invoice.
    const crossed = resolvedMediaModel('image', {
      image: mediaOption({ id: 'openrouter/studio/speaker-1', modality: 'audio' })
    });
    expect(crossed.modelId).toBe(managedMediaCatalog.image.modelId);
  });

  it('never describes the computer as somebody else’s', () => {
    // It is the owner's own Linux host. Hosted-service vocabulary survived here long after the
    // product it belonged to was removed, and the operating contract says the opposite one line
    // earlier - which is worse than either wording on its own.
    const prose = agentTools.map((tool) => JSON.stringify(tool)).join('\n');
    expect(prose).not.toMatch(/cloud comput|cloud desktop|cloud-workspace|cloud workspace/i);
    expect(prose).not.toMatch(/platform approval|machine hours|included active/i);
  });

  it('says where the edge is between each pair a model would otherwise confuse', () => {
    // Each of these is a real pair: two tools whose jobs overlap in one word, where a model with
    // only one of the descriptions in front of it would pick either. The arbitration clause has to
    // exist, and it has to be phrased "use <other>": that is the form a model reads as an
    // arbitration rule rather than as a claim about this tool.
    const description = (name: string): string =>
      agentTools.find((tool) => tool.name === name)?.description ?? '';
    const known = new Set(agentTools.map((tool) => tool.name));
    const clauseNaming = (tool: string, other: string): string | undefined =>
      description(tool)
        .split(/(?<=[.;])\s+/)
        .find((sentence) => new RegExp(`\\b${other}\\b`).test(sentence));

    const instead: ReadonlyArray<readonly [string, string]> = [
      ['file_read', 'document_read'],
      ['file_write', 'file_patch'],
      ['document_search', 'code_search'],
      ['document_search', 'session_search'],
      ['session_search', 'web_search'],
      // The pair a model is most likely to get wrong now: two tools with "memory" in the name over
      // two different stores - the short reviewed list already in context, and the retrieval store
      // the pack was drawn from.
      ['memory', 'memory_recall'],
      ['memory_recall', 'session_search'],
      ['memory_recall', 'document_search'],
      ['browser_snapshot', 'web_search'],
      ['browser_snapshot', 'read_elements'],
      ['web_search', 'document_search'],
      ['parallel_web_read', 'browser_action'],
      ['files_list', 'code_search'],
      ['files_list', 'repo_overview'],
      ['repo_overview', 'files_list'],
      ['file_write', 'publish_artifact'],
      ['desktop_observe', 'browser_snapshot'],
      ['desktop_action', 'browser_action'],
      ['delegate', 'coding_agent'],
      ['coding_agent', 'file_patch'],
      ['publish_preview', 'publish_site'],
      ['publish_site', 'publish_preview'],
      ['image_read', 'generate_media'],
      ['image_read', 'document_read']
    ];
    for (const [tool, other] of instead) {
      const clause = clauseNaming(tool, other);
      expect(clause, `${tool} never says when to use ${other} instead`).toBeDefined();
      // The scorer's own rule, applied here: a sentence that sends the reader to another tool is
      // dropped from this tool's score. One "use <tool>" is enough for the whole sentence, which
      // is why a single clause may go on to list three alternatives.
      const arbitrates = [...known].some(
        (name) => name !== tool && new RegExp(`\\buse\\s+${name}\\b`, 'i').test(clause ?? '')
      );
      expect(
        arbitrates,
        `${tool} points at ${other} in a sentence the scorer still counts for ${tool}: "${clause}"`
      ).toBe(true);
    }

    // The other relationship: not "instead of" but "and then". These name a step rather than an
    // alternative, so they belong in the referring tool's own score and only have to be there.
    /*
     * `['print_pdf', 'typst']` was the third pair here and it is deleted with the clause it
     * pinned, rather than kept as evidence the clause should have survived.
     *
     * What it protected - that a PDF whose pagination matters is typeset rather than captured from
     * a browser - has a better home and already occupies it: the operating contract states it, and
     * states it *gated* on this box actually having a document toolchain, pinned in both
     * directions in context.test.ts ("typeset with typst" present when provisioned, absent when
     * bare). The catalogue's copy was unconditional, so a box with no typst read in one request
     * that it has no document toolchain and that typst is the route for a PDF that matters. A pin
     * that holds an unconditional duplicate in place against a gated original is a ratchet.
     */
    const thenPairs: ReadonlyArray<readonly [string, string]> = [
      ['web_search', 'parallel_web_read'],
      ['shell', 'process']
    ];
    for (const [tool, other] of thenPairs)
      expect(clauseNaming(tool, other), `${tool} never mentions ${other}`).toBeDefined();
  });
});

describe('the search route and the notice', () => {
  const tool = (name: string) => agentTools.find((entry) => entry.name === name);

  it('offers search as one call against the runner contract, not a browsing procedure', () => {
    const search = tool('web_search');
    expect(search?.parameters.required).toEqual(['query']);
    const properties = search?.parameters.properties as Record<
      string,
      { maximum?: number; maxLength?: number; default?: number }
    >;
    // These bounds are the runner's own: query max 500, limit 1..10 with a default of 10. A tool
    // that offered more would be rejected at the route rather than trimmed.
    expect(properties.query?.maxLength).toBe(500);
    expect(properties.limit?.maximum).toBe(10);
    expect(properties.limit?.default).toBe(10);
    expect(search?.description).toMatch(/parallel_web_read/);
  });

  it('tells the notice what it is for, and what it is not for', () => {
    const notify = tool('notify');
    expect(notify?.parameters.required).toEqual(['headline']);
    expect(notify?.description).toMatch(/unattended run says nothing at all unless you call this/);
    expect(notify?.description).toMatch(/do not call it to announce that a task finished/);
  });

  it('states both limits the box enforces, in the numbers it enforces them at', () => {
    // The description promised a per-turn limit that the counter never reset, so it was really per
    // conversation and an agent went permanently silent after three notices while being told the
    // current turn had sent them. There are genuinely two bounds - this turn's three, and the
    // store's ten for the whole conversation - and the model can only read what is written here,
    // so a change to either constant has to change this sentence.
    expect(MAX_NOTICES_PER_TURN).toBe(3);
    expect(MAX_AGENT_NOTIFICATIONS_PER_TASK).toBe(10);
    const notify = tool('notify')?.description ?? '';
    expect(notify).toMatch(/three in a turn/);
    expect(notify).toMatch(/counted again from zero on the turn after they reply/);
    expect(notify).toMatch(/ten notifications in the whole conversation/);
  });
});

describe('declared action shapes', () => {
  const properties = (name: string): Record<string, Record<string, unknown>> =>
    (agentTools.find((entry) => entry.name === name)?.parameters.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
  const verbs = (name: string): string[] => (properties(name).action?.enum ?? []) as string[];
  const verbGuide = (name: string): string => {
    const described = properties(name).action?.description;
    return typeof described === 'string' ? described : '';
  };

  it('names every browser field at the top level and every verb in the enum', () => {
    // These were twenty `oneOf` variants, each repeating
    // {"type":"object","additionalProperties":false,…,"properties":{"type":{"const":…}}} and each
    // repeating the selector and tabId definitions - about five kilobytes of scaffolding on every
    // request for twenty facts. The facts are what matter and they are all still here: one typed
    // declaration per field, one enum entry per verb, and the required set per verb in the enum's
    // own description.
    expect(Object.keys(properties('browser_action'))).toEqual(
      expect.arrayContaining([
        'action',
        'url',
        'selector',
        'text',
        'mode',
        'values',
        'paths',
        'key',
        'deltaX',
        'deltaY',
        'state',
        'urlIncludes',
        'timeoutMs',
        'activate',
        'x',
        'y',
        'response',
        'promptText',
        'tabId',
        'actions',
        'purpose'
      ])
    );
    expect(verbs('browser_action')).toEqual([
      'navigate',
      'click',
      'double_click',
      'hover',
      'type',
      'select_option',
      'upload',
      'text_input',
      'press',
      'scroll',
      'wait_for',
      'back',
      'reload',
      'new_tab',
      'select_tab',
      'close_tab',
      'inspect_tab',
      'click_at',
      'dialog',
      'batch'
    ]);
    // The required set is the one thing that moved into prose, so it has to actually be there.
    for (const [verb, field] of [
      ['navigate', 'url'],
      ['click', 'selector'],
      ['type', 'text'],
      ['select_option', 'values'],
      ['upload', 'paths'],
      ['press', 'key'],
      ['scroll', 'deltaY'],
      ['click_at', 'x'],
      ['dialog', 'response'],
      ['batch', 'actions']
    ])
      expect(
        new RegExp(`\\b${verb}\\b[^.]*\\b${field}\\b`).test(verbGuide('browser_action')),
        `the browser action enum never says that ${verb} takes ${field}`
      ).toBe(true);
  });

  it('names the desktop fields the description previously only alluded to', () => {
    expect(Object.keys(properties('desktop_action'))).toEqual(
      expect.arrayContaining([
        'action',
        'nodeId',
        'actionIndex',
        'text',
        'key',
        'direction',
        'amount',
        'x',
        'y',
        'width',
        'height',
        'button',
        'clicks',
        'fromX',
        'fromY',
        'toX',
        'toY',
        'durationMs',
        'milliseconds',
        'purpose'
      ])
    );
    expect(verbs('desktop_action')).toEqual([
      'invoke',
      'focus',
      'set_text',
      'text_input',
      'zoom',
      'press',
      'scroll',
      'click_at',
      'drag',
      'wait'
    ]);
    for (const [verb, field] of [
      ['invoke', 'nodeId'],
      ['set_text', 'text'],
      ['zoom', 'height'],
      ['drag', 'toY'],
      ['wait', 'milliseconds']
    ])
      expect(
        new RegExp(`\\b${verb}\\b[^.]*\\b${field}\\b`).test(verbGuide('desktop_action')),
        `the desktop action enum never says that ${verb} takes ${field}`
      ).toBe(true);
  });

  /*
   * The two enums above are hand-written, and the runner's unions are the thing that actually
   * answers a call. Either list can be edited without the other, and the failure is silent in both
   * directions: a verb declared here and absent there is a call the model will make and the runner
   * will refuse, spent round trip and all; a verb there and absent here is a capability the model
   * can never find out it has. Nothing compared them until now.
   *
   * Held as sets, both ways, rather than derived. Deriving would make the catalogue's order follow
   * the union's, and the order of these enums is prompt-prefix bytes that a provider caches - the
   * catalogue's order is fixed for the life of a task on purpose. The two orders do differ today
   * (`click_at` sits fifth in BrowserAction and eighteenth here; the desktop lists disagree from
   * the fourth entry on), and that difference carries no meaning to a validator, which is why it is
   * left alone and named here instead of quietly normalised away.
   */
  it('declares exactly the verbs the runner unions accept, in both directions', () => {
    const unionVerbs = (union: { options: readonly unknown[] }): string[] =>
      union.options.map(
        (option) => (option as { shape: { type: { value: string } } }).shape.type.value
      );
    // A read that stops working is this comparison silently passing on two empty sets.
    expect(unionVerbs(BrowserAction).length).toBeGreaterThan(15);
    expect(unionVerbs(DesktopAction).length).toBeGreaterThan(5);
    expect(new Set(verbs('browser_action'))).toEqual(new Set(unionVerbs(BrowserAction)));
    expect(new Set(verbs('desktop_action'))).toEqual(new Set(unionVerbs(DesktopAction)));
  });

  it('hands the runner the nested action its union is discriminated on', () => {
    // The wire shape is flat and the contract is not. If this remap ever stopped happening the
    // runner would reject every call, and `purpose` - the model's sentence for the owner's card -
    // would ride along into the request, which is not what it is for.
    expect(
      surfaceActionRequest({ action: 'navigate', url: 'https://example.test', purpose: 'Read it' })
    ).toEqual({ type: 'navigate', url: 'https://example.test' });
    expect(
      surfaceActionRequest({
        action: 'batch',
        purpose: 'Fill it in',
        actions: [
          { action: 'type', selector: '#a', text: 'Ada' },
          { action: 'click', selector: '#go' }
        ]
      })
    ).toEqual({
      type: 'batch',
      actions: [
        { type: 'type', selector: '#a', text: 'Ada' },
        { type: 'click', selector: '#go' }
      ]
    });
    // Nothing descends past one level: the runner's union has no nested batch, so a model that
    // sends one gets a step the runner refuses rather than a remap that recurses on its input.
    expect(
      surfaceActionRequest({
        action: 'batch',
        actions: [{ action: 'batch', actions: [{ action: 'click', selector: '#x' }] }]
      })
    ).toEqual({ type: 'batch', actions: [{ type: 'batch' }] });
  });

  it('declares each schedule kind, including the two fields the daily brief needs', () => {
    /*
     * Re-pointed at the flat property bag that replaced the five-variant `oneOf`, and re-pointed
     * rather than deleted because what it pins is a capability rather than an encoding: every one
     * of the five kinds is still reachable, and `daily` still names the two fields that decide
     * whether "brief me at eight" can be scheduled at all. The union frame it used to read is
     * gone; the kinds and those two fields are the part that has to survive an encoding.
     *
     * The per-kind required set is prose now, so it is asserted as prose - which is the honest
     * shape of the promise, since the wire no longer carries a required list per kind and
     * `TaskScheduleSpec` in @athanor/contracts is what refuses a spec that is missing one.
     */
    const schedule = agentTools.find((tool) => tool.name === 'schedule');
    const spec = (
      schedule?.parameters.properties as Record<
        string,
        { description?: string; properties?: Record<string, { enum?: string[] }> }
      >
    ).spec;
    expect(spec?.properties?.kind?.enum).toEqual(['once', 'interval', 'daily', 'weekly', 'cron']);
    expect(spec?.description).toMatch(/daily: timeZone and localTime/);
    expect(Object.keys(spec?.properties ?? {})).toEqual(
      expect.arrayContaining([
        'runAt',
        'everyMinutes',
        'timeZone',
        'localTime',
        'weekdays',
        'expression'
      ])
    );
    expect(schedule?.description).toMatch(/time zone/i);
  });

  it('accepts every kind it declares through the schema that actually decides', () => {
    /*
     * The flat bag is a wire encoding, not a validator: what a schedule may be is
     * `TaskScheduleSpec`, and this drives one spec of every declared kind through it so a kind
     * that the catalogue offers and the contract refuses cannot ship. It is the half the byte
     * measurement above cannot see - a saving that quietly withdrew `weekly` would pass the
     * ceiling and fail here.
     */
    const specs: Record<string, Record<string, unknown>> = {
      once: { kind: 'once', runAt: '2027-03-04T09:00:00.000Z' },
      interval: { kind: 'interval', everyMinutes: 60 },
      daily: { kind: 'daily', timeZone: 'Europe/London', localTime: '08:00' },
      weekly: {
        kind: 'weekly',
        timeZone: 'Europe/London',
        localTime: '08:00',
        weekdays: [1, 2, 3, 4, 5]
      },
      cron: { kind: 'cron', timeZone: 'Europe/London', expression: '0 8 * * 1-5' }
    };
    const schedule = agentTools.find((tool) => tool.name === 'schedule');
    const declared = (
      schedule?.parameters.properties as Record<
        string,
        { properties?: { kind?: { enum?: string[] } } }
      >
    ).spec?.properties?.kind?.enum;
    expect(Object.keys(specs)).toEqual(declared);
    for (const [kind, spec] of Object.entries(specs))
      expect(TaskScheduleSpec.parse(spec), kind).toMatchObject({ kind });
    // And the flat bag's own hazard, stated rather than assumed: a field belonging to another kind
    // is stripped by the union rather than fatal, which is the property that makes one bag safe
    // where five variants used to be.
    expect(
      TaskScheduleSpec.parse({
        kind: 'daily',
        timeZone: 'Europe/London',
        localTime: '08:00',
        everyMinutes: 60
      })
    ).toEqual({ kind: 'daily', timeZone: 'Europe/London', localTime: '08:00' });
  });
});

describe('the contract each answer is written to', () => {
  it('says where the answer goes and how long the card is', () => {
    const finish = agentTools.find((tool) => tool.name === 'finish');
    const properties = finish?.parameters.properties as Record<string, { description?: string }>;
    expect(properties.summary?.description).toMatch(/streamed reply/);
    expect(properties.deliverables?.description).toMatch(/can now open/);
  });

  it('keeps memory governance on the memory tool, where it is read at the moment of use', () => {
    const memory = agentTools.find((tool) => tool.name === 'memory');
    expect(memory?.description).toMatch(/validUntil/);
    expect(memory?.description).toMatch(/never transient task state/);
  });
});
