import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'athanor-document-'));
const executable = path.resolve('scripts/athanor-document');

const run = (...args) =>
  spawnSync('/usr/bin/python3', [executable, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000
  });

try {
  await writeFile(
    path.join(root, 'notes.txt'),
    'Athanor keeps the computer persistent.\n\nBioinformatics results stay on the server.\n'
  );
  await writeFile(
    path.join(root, 'report.html'),
    '<h1>Report</h1><p>Alpha beta finding</p><script>secret noise</script>'
  );
  await writeFile(path.join(root, 'table.csv'), 'sample,value\ncontrol,7\n');
  await writeFile(
    path.join(root, 'generic.txt'),
    `${'server status '.repeat(100)}\nNo scientific analysis appears here.\n`
  );

  const read = run('read', '--path', 'report.html');
  assert.equal(read.status, 0, read.stderr);
  const readPayload = JSON.parse(read.stdout);
  assert.match(readPayload.text, /Alpha beta finding/);
  assert.doesNotMatch(readPayload.text, /secret noise/);

  const search = run('search', '--path', '.', '--query', 'bioinformatics server');
  assert.equal(search.status, 0, search.stderr);
  const searchPayload = JSON.parse(search.stdout);
  assert.equal(searchPayload.results[0].path, 'notes.txt');
  assert.match(searchPayload.results[0].excerpt, /Bioinformatics/);
  assert.match(searchPayload.method, /BM25/);
  assert.equal(searchPayload.filesConsidered, 4);

  const empty = run('search', '--path', '.', '--query', '!!!');
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /at least one word/);

  const escape = run('read', '--path', '../outside.txt');
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /inside the current workspace/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Document extraction and private search checks passed.');
