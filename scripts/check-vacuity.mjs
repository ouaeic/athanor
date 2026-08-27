#!/usr/bin/env node
/**
 * The loop-vacuity check: a test whose every assertion can be skipped by an empty collection.
 *
 *   node scripts/check-vacuity.mjs            fail on any test not on the ledger below
 *   node scripts/check-vacuity.mjs --list     print every finding, ledger included
 *
 * ── What it looks for, and why that shape and not another ──────────────────────────────────────
 *
 * One signature, and it is always the same one: every `expect` in the test body sits inside a loop
 * over a collection the test did not write down, and nothing outside the loop says the collection
 * has anything in it. Empty the collection and the body never runs, the test passes in 0 ms, and
 * the report says green. Twenty-four of these were confirmed by mutation in this repository - among
 * them a command-injection guard that passes on an empty table of image types, a regression test
 * for a defect that handed the model unreadable file paths, and an AGPL compliance claim that
 * cannot fail. Emptying `connectorCatalog`, every connectable service the product offers, broke one
 * test out of 249 in `packages/core`.
 *
 * The class regenerates on every wave, because a loop-only assertion is the cheapest way to write a
 * test that can never fail, and it looks exactly like a thorough one. So the fix is a check rather
 * than twenty-four edits: the edits are Wave 1F's, and without this they would come back.
 *
 * The repository had already written the cure once, in `skills.test.ts`, and never generalised it:
 *
 *     // A regex that stopped matching would pass this silently, which is the failure the check
 *     // exists to prevent wearing the costume of a pass.
 *     expect(checked).toBeGreaterThan(0);
 *
 * That is exactly what this looks for - one assertion the empty case still has to answer for.
 *
 * ── What is deliberately not flagged ───────────────────────────────────────────────────────────
 *
 * A loop over an array or object literal written in the test itself. That collection cannot be
 * emptied by a change to the product; emptying it is editing the test's own data, which is a
 * different act and a visible one. Flagging those would bury the real findings under table-driven
 * tests, and a check whose output nobody reads is a check that has stopped running.
 *
 * `expect.assertions(n)` and `expect.hasAssertions()` also clear a test, because they are the
 * assertion the empty case fails: vitest fails the test when the count is not met.
 *
 * ── Why an AST and not a regex ─────────────────────────────────────────────────────────────────
 *
 * Because the two cases that matter are exactly the ones a regex confuses. `skills.test.ts:373`
 * asserts inside a `for…of`; twenty lines below, another test asserts on a count after its loop.
 * They are the same characters in a different tree. TypeScript is already a dependency of this
 * repository and parsing 206 test files with it costs about a second.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The tests known to have this shape when the check was written, each with the reason it is still
 * standing.
 *
 * A ledger and not a suppression list: an entry that STOPS being vacuous fails this check too, so
 * the list cannot rot into a place where things are quietly parked. It is meant to reach zero, and
 * the only way to remove an entry is to give the test an assertion the empty case has to answer.
 *
 * Keyed by `<file>::<test name>` rather than by line, because a line number moves when somebody
 * edits the file above it and a ledger that goes stale on an unrelated edit is a ledger people
 * delete. The names are the ones vitest prints.
 */
const LEDGER = new Set([
  // Wave 1F owns the repairs. Three of these certify a safety or compliance property and are to
  // be guarded rather than deleted - the command-injection guard in `images.test.ts`, the ATH-116
  // regression in `skills.test.ts`, and the AGPL claim in `license-manifest.test.ts` - because
  // the code they cover is load-bearing and only the test is broken. The rest may go either way:
  // give it a count after the loop, or delete it with the behaviour it was pinning.
  'apps/api/src/contract.test.ts::an identifier that cannot name a record is a 404, not a server fault',
  'apps/web/src/DecisionsLog.test.tsx::says what an empty list means, in each list’s own words',
  'apps/web/src/api-token-scopes.test.ts::never labels a scope with its own enum value',
  'apps/web/src/approval-copy.test.ts::agrees with the contract it copies, case for case',
  'apps/web/src/composer-state.test.ts::always carries a repair action',
  'apps/web/src/composer-strip.test.ts::shows each condition on its own',
  'apps/web/src/task-status.test.ts::never calls a status both finished and live',
  'apps/web/src/task-status.test.ts::only offers resume for a conversation the agent still has',
  'apps/worker/src/agent-run.test.ts::sends a request with no rule byte in it when nothing fired',
  'apps/worker/src/approval-policy.test.ts::never answers a tainted call more weakly than the same call on a clean turn',
  'apps/worker/src/connector-origin-totality.test.ts::gives every kind the table’s word on the live path',
  'apps/worker/src/context.test.ts::re-marks the same index for several consecutive steps so the prefix is already cached',
  'apps/worker/src/context.test.ts::crosses both recency boundaries, which is the only reason it measures anything',
  'apps/worker/src/context.test.ts::shares three quarters of each request with the request before it',
  'apps/worker/src/context.test.ts::moves the older-result floor a handful of times over sixty steps',
  'apps/worker/src/context.test.ts::diverges from the previous request at the recency boundary, and further back only when the floor moved',
  'apps/worker/src/context.test.ts::places the cache edge ahead of where this request stopped matching the last one, because a retrospective edge measures worse',
  'apps/worker/src/context.test.ts::never reaches the automatic compaction trigger, because the trigger reads the squeezed size',
  'apps/worker/src/context.test.ts::bills fewer full-price bytes per step than the head it replaced, in bytes rather than in a share',
  'apps/worker/src/memory-runtime.test.ts::never emits a chunk over the byte cap, including multi-byte text',
  'apps/worker/src/rules/rules.test.ts::puts no rule text into the operating contract or the tool catalogue',
  'apps/worker/src/skills.test.ts::writes descriptions that say when to use and when not to',
  'apps/worker/src/skills.test.ts::keeps every body inside the review-readable budget',
  'apps/worker/src/skills.test.ts::declares a verification contract and a bounded capability grant for every skill',
  'apps/worker/src/skills.test.ts::names only tools that exist, in both places a skill declares them',
  'apps/worker/src/skills.test.ts::advertises no file to the model that the model has no tool able to open',
  'apps/worker/src/skills.test.ts::states one version, in both places a skill declares it',
  'apps/worker/src/tool-catalogue.test.ts::names nothing in a description that the schemas do not declare',
  'apps/worker/src/tool-catalogue.test.ts::says where the edge is between each pair a model would otherwise confuse',
  'packages/contracts/src/web-tools.test.ts::serialises byte-identically on repeated calls for the same facts',
  'packages/contracts/src/web-tools.test.ts::puts nothing on the wire but the two fields the provider reads',
  'packages/core/src/connectors.test.ts::names every kind the catalogue can offer, explicitly',
  'packages/data/src/memory-eval.test.ts::asks every session probe in words the transcript does not use',
  'packages/model-gateway/src/license-manifest.test.ts::records the upstream revision each reading was made against',
  'services/workspace-runner/src/browser.test.ts::refuses to drive the agent anywhere but the public web',
  'services/workspace-runner/src/command-policy.test.ts::catches escalation smuggled through a wrapper',
  'services/workspace-runner/src/desktop.test.ts::applies the same command policy a shell command gets, which it used to skip entirely',
  'services/workspace-runner/src/document-toolchain.test.ts::routes every Python capability through the one pinned interpreter',
  'services/workspace-runner/src/document-toolchain.test.ts::proves each measurement can fail, wherever the job ran',
  'services/workspace-runner/src/document-toolchain.test.ts::names what it could not exercise instead of implying it did',
  'services/workspace-runner/src/execution.test.ts::refuses a package operation the approved helper cannot perform, and says so once',
  'services/workspace-runner/src/execution.test.ts::rejects escalation spelled with a path or hidden behind a wrapper',
  'services/workspace-runner/src/execution.test.ts::refuses a command that names a privileged helper directly',
  'services/workspace-runner/src/images.test.ts::turns every picture it can name into one a model takes',
  'services/workspace-runner/src/images.test.ts::never puts the file in the argument list',
  'services/workspace-runner/src/images.test.ts::leaves no picture a model accepts without a pass that strips it',
  'services/workspace-runner/src/processes.test.ts::refuses a background command that names a privileged helper directly',
  'services/workspace-runner/src/terminal-renewal.test.ts::refuses one minted for another owner, workspace, role or scope',
  'services/workspace-runner/src/toolchain-host.test.ts::is a command line this host will actually accept, per family',
  'services/workspace-runner/src/toolchain-host.test.ts::names no package manager in a sentence meant for every host',
  'services/workspace-runner/src/toolchain-host.test.ts::gives every capability a way out of being missing, resolved or not'
]);

const files = spawnSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
  cwd: root,
  encoding: 'utf8'
});
if (files.status !== 0) {
  process.stderr.write('check-vacuity: git ls-files failed; this must run inside the checkout.\n');
  process.exit(2);
}

/** `it`, `test`, and the modified forms - `it.only` hides a vacuous test just as well. */
const isTestOpener = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const target = node.expression;
  const name = ts.isPropertyAccessExpression(target) ? target.expression : target;
  return ts.isIdentifier(name) && (name.text === 'it' || name.text === 'test');
};

/** The array-method loops, which are loops in every way that matters here. */
const ITERATING_METHODS = new Set([
  'forEach',
  'map',
  'filter',
  'flatMap',
  'some',
  'every',
  'find',
  'findIndex',
  'reduce',
  'sort'
]);

/**
 * Whether the thing being iterated is written down in the test.
 *
 * A literal cannot be emptied by a change to the product, so a loop over one is not this defect.
 * `Object.keys({...})`, `Object.entries({...})` and `[...].map(...)` chains resolve to the literal
 * at their root, which is why this walks left rather than testing the immediate expression.
 */
const iteratesALiteral = (expression) => {
  let node = expression;
  for (;;) {
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return true;
    if (ts.isCallExpression(node)) {
      node = node.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
      node = node.expression;
      continue;
    }
    return false;
  }
};

/**
 * The loop, if this node is one, together with what it iterates.
 *
 * `for (;;)` and `while` are counted with no collection: a hand-rolled loop whose bound is a length
 * is the same defect wearing different syntax, and there is nothing to call a literal.
 */
const loopOf = (node) => {
  if (ts.isForOfStatement(node) || ts.isForInStatement(node))
    return { literal: iteratesALiteral(node.expression) };
  if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node))
    return { literal: false };
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ITERATING_METHODS.has(node.expression.name.text)
  )
    return { literal: iteratesALiteral(node.expression.expression) };
  return null;
};

const findings = [];

for (const relative of files.stdout.split('\n').filter(Boolean)) {
  const absolute = path.join(root, relative);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const inspect = (node) => {
    if (isTestOpener(node)) {
      const [title, body] = node.arguments;
      if (body) {
        let assertions = 0;
        let outsideALoop = 0;
        let cleared = false;
        // Depth of enclosing loops that iterate something the test did not write down. A literal
        // loop deliberately contributes nothing, so an assertion inside one still counts as an
        // assertion the empty case has to answer.
        const walk = (child, depth) => {
          if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
            const target = child.expression.expression;
            if (
              ts.isIdentifier(target) &&
              target.text === 'expect' &&
              (child.expression.name.text === 'assertions' ||
                child.expression.name.text === 'hasAssertions')
            )
              cleared = true;
          }
          if (
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === 'expect'
          ) {
            assertions += 1;
            if (depth === 0) outsideALoop += 1;
          }
          const loop = loopOf(child);
          const next = loop && !loop.literal ? depth + 1 : depth;
          ts.forEachChild(child, (grandchild) => walk(grandchild, next));
        };
        ts.forEachChild(body, (child) => walk(child, 0));
        if (assertions > 0 && outsideALoop === 0 && !cleared) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const name =
            title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
              ? title.text
              : '<computed name>';
          findings.push({ file: relative, line: line + 1, name });
        }
      }
    }
    ts.forEachChild(node, inspect);
  };
  ts.forEachChild(source, inspect);
}

const key = (finding) => `${finding.file}::${finding.name}`;
const unledgered = findings.filter((finding) => !LEDGER.has(key(finding)));
const found = new Set(findings.map(key));
const repaired = [...LEDGER].filter((entry) => !found.has(entry));

if (process.argv.includes('--list'))
  for (const finding of findings)
    process.stdout.write(
      `${LEDGER.has(key(finding)) ? 'ledger' : 'NEW   '} ${finding.file}:${finding.line}  ${finding.name}\n`
    );

if (unledgered.length) {
  process.stderr.write(
    `\n${unledgered.length} test${unledgered.length === 1 ? '' : 's'} can be satisfied by an empty collection:\n\n`
  );
  for (const finding of unledgered)
    process.stderr.write(`  ${finding.file}:${finding.line}\n    ${finding.name}\n`);
  process.stderr.write(
    '\nEvery assertion in each of these sits inside a loop over a collection the test did not write\n' +
      'down. Empty that collection and the test passes in no time at all, having checked nothing.\n' +
      'Give it one assertion the empty case has to answer - a count after the loop, or a length\n' +
      'before it - or delete the test with the behaviour it was pinning.\n'
  );
}

if (repaired.length) {
  process.stderr.write(
    `\n${repaired.length} ledger entr${repaired.length === 1 ? 'y is' : 'ies are'} no longer vacuous, or no longer exist${repaired.length === 1 ? 's' : ''}:\n\n`
  );
  for (const entry of repaired) process.stderr.write(`  ${entry}\n`);
  process.stderr.write(
    '\nGood news, and it has to be recorded: delete these lines from LEDGER in this file. A ledger\n' +
      'that keeps entries after they are fixed is a list nobody trusts, and then a list nobody reads.\n'
  );
}

if (unledgered.length || repaired.length) process.exit(1);
process.stdout.write(
  `check-vacuity: ${findings.length} known loop-only test${findings.length === 1 ? '' : 's'}, none new.\n`
);
