#!/usr/bin/env node
/**
 * The gate over the parts of this repository that TypeScript never compiles and vitest never runs.
 *
 * Three classes of thing used to be able to rot silently. A shell or Python script that ships to an
 * owner's box - `athanor-ddns` refreshing a hostname from a systemd timer, `athanor-certificate`
 * renewing TLS - is never parsed by anything in a normal build, so a syntax error in one reaches an
 * installation and fails at three in the morning rather than in CI. The skill library is read by the
 * model rather than by a compiler, so a malformed sidecar or a description that never says when the
 * skill does not apply is only discovered by an agent halfway through a job. And `.env.example` is
 * copied to `.env` by every developer following the README, so a value left behind there overrides
 * the default the code declares: it shipped `TASK_MAX_STEPS=60` for a while after the shared
 * declaration had moved to 120, which is the exact number that change existed to eliminate.
 *
 * Everything here is discovered rather than listed. A new script is covered the moment it has a
 * shebang, because a gate with a hand-maintained list of files is a gate the next file escapes.
 *
 * Usage: node scripts/check-repository.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const failures = [];
const fail = (message) => failures.push(message);
const say = (message) => process.stdout.write(`${message}\n`);
const read = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

// --- what ships to a box ----------------------------------------------------------------------

/** Files that are executed on an owner's server, wherever they live in the tree. */
const shippedFiles = () => {
  const found = ['install.sh'];
  for (const directory of ['scripts', 'infra/native']) {
    for (const entry of readdirSync(path.join(repositoryRoot, directory)).sort()) {
      const relativePath = `${directory}/${entry}`;
      if (statSync(path.join(repositoryRoot, relativePath)).isFile()) found.push(relativePath);
    }
  }
  return found;
};

/**
 * What interpreter a file is for, taken from the file itself. A systemd unit, an Nginx include and
 * a requirements list have no shebang and are not programs, so they are simply not classified.
 */
const interpreter = (relativePath) => {
  const firstLine = read(relativePath).split('\n', 1)[0] ?? '';
  if (/^#!.*\bpython3?\b/.test(firstLine)) return 'python';
  if (/^#!.*\b(?:sh|bash|dash)\b/.test(firstLine)) return 'shell';
  if (relativePath.endsWith('.mjs')) return 'node';
  return null;
};

const shipped = shippedFiles();
const byInterpreter = { shell: [], python: [], node: [] };
for (const relativePath of shipped) {
  const kind = interpreter(relativePath);
  if (kind) byInterpreter[kind].push(relativePath);
}
if (byInterpreter.shell.length < 15 || byInterpreter.python.length < 5)
  fail(
    `only ${byInterpreter.shell.length} shell and ${byInterpreter.python.length} Python scripts were found; discovery is broken rather than the tree being that small`
  );

for (const relativePath of byInterpreter.shell) {
  const parsed = spawnSync('/bin/sh', ['-n', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (parsed.status !== 0)
    fail(`${relativePath} is not valid POSIX shell: ${parsed.stderr.trim()}`);
}

if (byInterpreter.python.length > 0) {
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import ast,pathlib,sys\nfor name in sys.argv[1:]:\n    ast.parse(pathlib.Path(name).read_text(), filename=name)\n',
      ...byInterpreter.python
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  if (parsed.status !== 0) fail(`a shipped Python script does not parse: ${parsed.stderr.trim()}`);
}

for (const relativePath of byInterpreter.node) {
  const parsed = spawnSync(process.execPath, ['--check', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (parsed.status !== 0) fail(`${relativePath} does not parse: ${parsed.stderr.trim()}`);
}

/**
 * shellcheck catches what `sh -n` cannot: an unquoted expansion, a `local` that is not POSIX, a
 * test that always succeeds. It is required in CI and optional on a developer's machine, because
 * refusing to run the rest of this file over a missing analyser would only teach people to skip it.
 */
const shellcheck = spawnSync('shellcheck', ['-S', 'warning', ...byInterpreter.shell], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (shellcheck.error?.code === 'ENOENT') {
  if (process.env.GITHUB_ACTIONS) fail('shellcheck is not installed on this CI runner');
  else say('  shellcheck is not installed here, so the shell scripts were only parsed');
} else if (shellcheck.status !== 0) {
  fail(`shellcheck reported problems:\n${shellcheck.stdout.trim()}`);
}

say(
  `Shipped programs: ${byInterpreter.shell.length} shell, ${byInterpreter.python.length} Python, ${byInterpreter.node.length} Node parse.`
);

// --- the skill library ------------------------------------------------------------------------

const skills = spawnSync('/bin/sh', ['scripts/athanor-skill-check', 'skills'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (skills.status !== 0)
  fail(`the skill library does not lint:\n${(skills.stderr || skills.stdout).trim()}`);
say(`Skill library: ${(skills.stdout || '').trim() || 'checked'}`);

// --- the ImageMagick 6 compatibility command ----------------------------------------------------

/**
 * The one place in athanor that knows ImageMagick has two spellings, exercised against stand-ins
 * for the ImageMagick 6 binaries. If this dispatched wrongly, `magick identify x.png` would become
 * `convert identify x.png` on every Debian 12 and Ubuntu 24.04 box and the failure would surface
 * inside a skill, in front of the owner.
 */
if (existsSync('/usr/bin/magick')) {
  say('  this host has ImageMagick 7, so the compatibility command was not exercised');
} else {
  const stubs = mkdtempSync(path.join(tmpdir(), 'athanor-magick-'));
  for (const tool of ['convert', 'identify']) {
    writeFileSync(path.join(stubs, tool), `#!/bin/sh\nprintf '${tool} %s' "$*"\n`, { mode: 0o755 });
  }
  const dispatch = (args) =>
    spawnSync('/bin/sh', ['scripts/athanor-magick', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: `${stubs}:/usr/bin:/bin` }
    }).stdout;
  const expectations = [
    [['in.png', '-resize', '1200x', 'out.jpg'], 'convert in.png -resize 1200x out.jpg'],
    [['identify', '-format', '%wx%h', 'in.png'], 'identify -format %wx%h in.png'],
    [['convert', 'in.png', 'out.png'], 'convert in.png out.png'],
    [['-version'], 'convert -version']
  ];
  for (const [args, expected] of expectations) {
    const actual = dispatch(args);
    if (actual !== expected)
      fail(`scripts/athanor-magick turned \`magick ${args.join(' ')}\` into \`${actual}\``);
  }
  rmSync(stubs, { recursive: true, force: true });
  say(`ImageMagick compatibility: ${expectations.length} dispatches match ImageMagick 7.`);
}

// --- .env.example against the schemas that read it ----------------------------------------------

/**
 * Comments are removed a line at a time rather than by matching `//` anywhere, because a default
 * value in these files is often a URL and `postgres://…` would otherwise lose everything after the
 * scheme. Every comment in every config schema is on its own line, which is what makes this safe.
 */
const withoutComments = (source) => {
  const lines = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    lines.push(line);
  }
  return lines.join('\n');
};

/**
 * The text written against each key of a schema object, keyed by the environment variable.
 *
 * Only text that is actually a declaration counts, and the first one wins. Both rules are there for
 * the same file: services/notifications/src/config.ts declares `PUSH_VAPID_SUBJECT` in its schema
 * and then names it again at the same indentation inside a type predicate at the bottom, where the
 * value is the word `string`. Taking the last match would read the type instead of the rule.
 */
const declarations = (source) => {
  const found = new Map();
  let key = null;
  let collected = [];
  const finish = () => {
    const text = collected.join('\n').trim().replace(/,$/, '');
    const isDeclaration = /^(?:z[\s.]|sharedEnv\.|[a-z][A-Za-z0-9_]*$)/.test(text);
    if (key && isDeclaration && !found.has(key)) found.set(key, text);
    key = null;
    collected = [];
  };
  for (const line of withoutComments(source).split('\n')) {
    const start = /^ {2}([A-Z][A-Z0-9_]*):(.*)$/.exec(line);
    if (start) {
      finish();
      key = start[1];
      collected = [start[2]];
    } else if (key) {
      if (/^ {2}\S/.test(line) || /^\}/.test(line)) finish();
      else collected.push(line);
    }
  }
  finish();
  return found;
};

/** The argument of `.default(...)`, read with the parentheses balanced and quotes respected. */
const defaultArgument = (declaration) => {
  const marker = declaration.indexOf('.default(');
  if (marker < 0) return null;
  let depth = 0;
  let quote = null;
  for (let index = marker + '.default'.length; index < declaration.length; index += 1) {
    const character = declaration[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0)
        return declaration
          .slice(marker + '.default('.length, index)
          .trim()
          .replace(/,$/, '');
    }
  }
  return null;
};

/**
 * The default as an operator would have to write it in a file. A computed default - a process id, a
 * template literal - has no such spelling, so it is reported as not comparable rather than guessed
 * at, and this check says nothing about that key.
 */
const literalValue = (argument) => {
  if (argument === null) return null;
  const quoted = /^(['"])([^'"]*)\1$/.exec(argument);
  if (quoted) return quoted[2];
  if (/^-?\d[\d_]*$/.test(argument)) return String(Number(argument.replaceAll('_', '')));
  return null;
};

/**
 * Every file that parses an environment into a zod schema. Most units keep theirs in `config.ts`;
 * the model registry is one loop with no exported surface and declares its schema inline, so
 * `index.ts` is read too when it holds one. A key declared in a file this misses would be reported
 * as configuring nothing, which is the failure mode to avoid.
 */
const schemaPaths = () => {
  const found = ['packages/contracts/src/env.ts'];
  for (const group of ['apps', 'packages', 'services']) {
    for (const entry of readdirSync(path.join(repositoryRoot, group)).sort()) {
      for (const name of ['config.ts', 'index.ts']) {
        const candidate = `${group}/${entry}/src/${name}`;
        let source;
        try {
          source = read(candidate);
        } catch {
          continue; // A unit without that file declares no environment key in it.
        }
        if (source.includes('z.object({')) found.push(candidate);
      }
    }
  }
  return found;
};

const schemaSources = new Map(schemaPaths().map((file) => [file, read(file)]));
const shared = declarations(schemaSources.get('packages/contracts/src/env.ts'));

/** Resolves `sharedEnv.KEY` and a same-file alias such as `bool` down to the zod call itself. */
const resolveDeclaration = (declaration, source) => {
  const sharedReference = /^sharedEnv\.([A-Z][A-Z0-9_]*)$/.exec(declaration);
  if (sharedReference) return shared.get(sharedReference[1]) ?? declaration;
  const alias = /^[a-z][A-Za-z0-9_]*$/.exec(declaration);
  if (alias) {
    const assignment = new RegExp(`^const ${declaration} =([\\s\\S]*?);$`, 'm').exec(
      withoutComments(source)
    );
    if (assignment) return assignment[1].trim();
  }
  return declaration;
};

const declaredDefaults = new Map();
const declaredAnywhere = new Set();
for (const [file, source] of schemaSources) {
  for (const [key, declaration] of declarations(source)) {
    const resolved = resolveDeclaration(declaration, source);
    // An upper-case key that is not a zod declaration is some other object that happens to sit at
    // the same indentation, not a setting an operator can write into an environment file.
    if (!/^z[\s.]/.test(resolved)) continue;
    declaredAnywhere.add(key);
    const value = literalValue(defaultArgument(resolved));
    if (value === null) continue;
    // The shared declaration is the one an operator's control.env is read against by more than one
    // process, so where a single process deliberately differs, shared still decides.
    if (file === 'packages/contracts/src/env.ts' || !declaredDefaults.has(key))
      declaredDefaults.set(key, { value, file });
  }
}

/**
 * Where `.env.example` deliberately sets something other than what the code defaults to. An entry
 * is a statement that someone looked; anything not listed here has to match, and an entry that no
 * longer describes a real difference fails too, so this cannot become a place to park drift.
 */
const recordedDivergences = [
  {
    key: 'ALLOW_INSECURE_DEV_AUTH',
    because:
      'A checkout has no HTTPS origin, so a browser will not create a passkey against it and there would be no way in at all. apps/api/src/config.ts refuses to start with this on in any mode but development, which is what keeps it a development-only value rather than a setting someone can leave on.'
  }
];

const exampleValues = new Map();
for (const line of read('.env.example').split('\n')) {
  const entry = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (entry) exampleValues.set(entry[1], entry[2]);
}
if (exampleValues.size < 40) fail('.env.example was not parsed; the format has changed');

for (const [key, value] of exampleValues) {
  if (!declaredAnywhere.has(key)) {
    fail(
      `.env.example sets ${key}, which no config schema declares, so an operator who changes it gets silence`
    );
    continue;
  }
  const declared = declaredDefaults.get(key);
  const divergence = recordedDivergences.find((entry) => entry.key === key);
  if (!declared) continue;
  if (value === declared.value) {
    if (divergence)
      fail(
        `.env.example now agrees with ${declared.file} about ${key}; remove the recorded divergence`
      );
    continue;
  }
  if (!divergence)
    fail(
      `.env.example sets ${key}=${value}, but ${declared.file} declares ${declared.value}. A checkout copies this file over the default, so either match it or record why it differs in scripts/check-repository.mjs`
    );
}
for (const entry of recordedDivergences) {
  if (!exampleValues.has(entry.key))
    fail(`a divergence is recorded for ${entry.key}, which .env.example no longer sets`);
  if (entry.because.length < 80) fail(`the reason recorded for ${entry.key} explains nothing`);
}

say(
  `Configuration example: ${exampleValues.size} keys, ${declaredDefaults.size} comparable defaults across ${schemaSources.size} schemas.`
);

/**
 * Nothing this project publishes judges anybody else's software.
 *
 * The rule is absolute and it is easy to break by accident, because weighing the alternatives is
 * exactly what an honest design note does - and a design note in a tracked file is published the
 * moment the repository is, and cloned onto every owner's machine by the installer. Working notes
 * that make those comparisons are untracked for that reason; this is what stops the next one being
 * committed. Naming a product is fine - a dependency, a format, a protocol. Naming one next to a
 * judgment about it is not.
 */
// The names themselves live in an untracked file. Writing them here would have put a list of other
// people's products into the repository that exists to never discuss them - the rule applies to
// this file too. `scripts/guarded-product-names.txt` is one term per line and is gitignored, so it
// stays on the machine of whoever publishes. Without it this one rule cannot run, and says so
// rather than passing quietly.
const guardTermsPath = path.join(repositoryRoot, 'scripts/guarded-product-names.txt');
const guardTerms = existsSync(guardTermsPath)
  ? readFileSync(guardTermsPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  : [];
const NAMED_PRODUCTS = guardTerms.length
  ? new RegExp(String.raw`\b(${guardTerms.join('|')})\b`, 'i')
  : null;
const COMPARATIVE =
  /\b(better|worse|faster|slower|superior|inferior|unmaintained|abandoned|best[- ]in[- ]class|most mature|state of the art|beats|outperforms|parity|versus|vs\.?|inadequate|poor|blocky|bloated|clunky|kinder|safer|smarter|cleaner|nicer|saner|wiser|heavier|lighter|leaner)\b/i;

// Everything the repository tracks, not only the scripts it ships: a design note in docs/ is
// published exactly as surely as a README, and the installer clones the whole checkout onto the
// owner's machine.
//
// Source files are read too, and not as an afterthought. This rule used to cover prose only, and a
// comment in services/relay/src/config.ts sat for months naming another project and calling this
// project's timeout kinder than theirs. A judgment in a `//` comment is published exactly as surely
// as one in a README - more so, since the whole checkout lands on every owner's machine.
const publishedText = spawnSync(
  'git',
  [
    'ls-files',
    '-z',
    '*.md',
    '*.mdx',
    '*.txt',
    '*.html',
    '*.ts',
    '*.tsx',
    '*.mjs',
    '*.js',
    '*.css',
    '*.sh',
    '*.py',
    '*.sql',
    '*.conf',
    '*.service'
  ],
  {
    cwd: repositoryRoot,
    encoding: 'utf8'
  }
)
  .stdout.split('\0')
  .filter(Boolean);
if (NAMED_PRODUCTS) {
  for (const relativePath of publishedText) {
    const lines = read(relativePath).split('\n');
    for (const [index, line] of lines.entries()) {
      if (NAMED_PRODUCTS.test(line) && COMPARATIVE.test(line))
        fail(
          `${relativePath}:${index + 1} weighs a named product against something - published text never does that`
        );
    }
  }
  say(
    `Published text: ${publishedText.length} files carry no comparison with anybody else's software.`
  );
} else {
  say(
    `Published text: ${publishedText.length} files unchecked - scripts/guarded-product-names.txt is absent, so the comparison rule did not run.`
  );
}

/**
 * The host table has to name every family in every row, and cover what the install actually needs.
 *
 * The same package names lived in three places before this - the installer, the runner's toolchain
 * probe and `athanor doctor` - and widening past Debian would have made it twelve. One table is only
 * an improvement while it stays complete, and a row that quietly loses a column is a host that
 * installs and then cannot make a document.
 */
const hostTable = read('scripts/athanor-host.sh')
  .split('\n')
  .slice(
    read('scripts/athanor-host.sh').split('\n').findIndex((line) => line.startsWith('capability\t')),
    read('scripts/athanor-host.sh').split('\n').findIndex((line) => line === 'TABLE')
  )
  .filter(Boolean);
const [tableHeader, ...tableRows] = hostTable;
const families = (tableHeader ?? '').split('\t').slice(1);
if (families.length < 4) fail('the host package table names fewer than four families');
for (const row of tableRows) {
  const cells = row.split('\t');
  if (cells.length !== families.length + 1)
    fail(`host table row "${cells[0]}" has ${cells.length - 1} entries for ${families.length} families`);
  if (cells.slice(1).every((cell) => cell === '-'))
    fail(`host table row "${cells[0]}" names no package on any family, so nothing can provide it`);
}
// Every family must be able to install the things a document job cannot run without. These are the
// capabilities whose absence is not a degraded install but a broken one.
const LOAD_BEARING = ['python', 'postgres-server', 'nginx', 'git', 'curl', 'openssl', 'xvfb'];
for (const capability of LOAD_BEARING) {
  const row = tableRows.find((line) => line.split('\t')[0] === capability);
  if (!row) fail(`the host table has no row for ${capability}, which every host needs`);
  else
    row
      .split('\t')
      .slice(1)
      .forEach((cell, index) => {
        if (cell === '-') fail(`${families[index]} has no package for ${capability}`);
      });
}
say(`Host packages: ${tableRows.length} capabilities across ${families.join(', ')}.`);

/*
 * There are two ways a box reaches a new release - `install.sh` on top of an existing tree, and
 * `athanor update` from the auto-update timer - and both run with no terminal attached. Two things
 * have to be true on each, and both were once true on only one: a release that removes a workspace
 * package makes pnpm want to rebuild the modules directory and stop to ask, which with nothing to
 * answer it aborts the upgrade; and systemd stops wanting a withdrawn unit without ever stopping
 * the copy already running, which then holds its port until a reboot. A fix applied to one path and
 * not the other reads as done and leaves the unattended half broken, which is exactly what
 * happened, so the two are checked against each other rather than by eye.
 */
const upgradePaths = [
  { file: 'scripts/install-native.sh', name: 'the installer' },
  { file: 'scripts/athanor', name: '`athanor update`' }
];
for (const { file, name } of upgradePaths) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const [index, line] of source.split('\n').entries()) {
    if (!/(?:^|[\s;(])pnpm\s+(?:install|-r\s+build|-r\s+run)/.test(line)) continue;
    if (!/\bCI=true\b/.test(line))
      fail(
        `${file}:${index + 1} runs pnpm without CI=true, so ${name} aborts with no terminal when a release drops a workspace package`
      );
  }
  if (!/systemctl\s+stop/.test(source) || !source.includes('list-units'))
    fail(`${file} never stops a unit a release has withdrawn, so ${name} leaves it running`);
}
say(`Upgrade paths: ${upgradePaths.length} carry the non-interactive and withdrawn-unit handling.`);

/**
 * The install command the app prints has to name a revision that exists.
 *
 * It pins a tag so a new box lands on a known release rather than on whatever `main` is in the
 * middle of, and the box's own guarded update path moves it forward from there. Nothing offline can
 * prove a tag exists on the remote - but it can prove the repository agrees with itself, which is
 * the half that actually went wrong: the string said v0.1.0 while no tag had ever been cut, so the
 * one command a new owner is handed answered 404. Cutting a release is now "bump the version, tag
 * it", and never "remember to edit a string in a React component".
 */
const declaredVersion = JSON.parse(read('package.json')).version;
const installUi = read('apps/web/src/ServerInstall.tsx');
const pinnedRefs = [...installUi.matchAll(/\/(?:v)?(\d+\.\d+\.\d+)\/|ATHANOR_REF=v(\d+\.\d+\.\d+)/g)]
  .map((match) => match[1] ?? match[2])
  .filter(Boolean);
if (!pinnedRefs.length) fail('apps/web/src/ServerInstall.tsx pins no revision for the installer');
for (const pinned of pinnedRefs)
  if (pinned !== declaredVersion)
    fail(
      `apps/web/src/ServerInstall.tsx offers v${pinned} while package.json says ${declaredVersion}; the printed command would fetch a revision this checkout is not`
    );
say(`Install command: pins v${declaredVersion}, which is what this checkout calls itself.`);

/**
 * One Node version, agreed on by the three things that have an opinion.
 *
 * `engines` said >=20.20.0 while the installer provisions 24, CI runs 24, and the pinned pnpm
 * refuses to start below 22.13 - so somebody on the version this repository blessed could not run
 * `pnpm install` at all, and what they got was `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, which
 * says nothing about Node being too old. The installer's number is the real one, because it is the
 * one that has to be true on somebody else's server.
 */
const installerNodeMajor = Number(
  /^node_required_major=(\d+)/m.exec(read('scripts/install-native.sh'))?.[1]
);
const declaredNodeMajor = Number(
  /^>=(\d+)/.exec(JSON.parse(read('package.json')).engines?.node ?? '')?.[1]
);
if (!installerNodeMajor) fail('scripts/install-native.sh no longer states node_required_major');
else if (declaredNodeMajor !== installerNodeMajor)
  fail(
    `package.json engines.node allows Node ${declaredNodeMajor} while the installer requires ${installerNodeMajor}; a contributor on the lower one cannot run this repository`
  );
else say(`Node version: engines and the installer both require ${installerNodeMajor}.`);

if (failures.length > 0) {
  process.stderr.write(`\n${failures.map((message) => `- ${message}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  say('Repository checks passed.');
}
