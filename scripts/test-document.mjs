import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'athanor-document-'));
// The formats a real person's folders fill up with, kept in their own directory so the counts the
// first folder asserts stay the counts it was written for.
const shelf = await mkdtemp(path.join(os.tmpdir(), 'athanor-shelf-'));
const executable = path.resolve('scripts/athanor-document');

const runIn = (cwd, environment, ...args) =>
  spawnSync('/usr/bin/python3', [executable, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...environment }
  });
const run = (...args) => runIn(root, {}, ...args);

const crc32 = (data) => {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};

/**
 * A zip written by hand, because both an .epub and a .docx are one and neither test may depend on
 * a library that only the provisioned computer has. Stored entries only: what is being proven is
 * the reading order and the extraction, not inflate.
 */
const writeZip = async (file, members) => {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, body] of Object.entries(members)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(body, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(header, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(file, Buffer.concat([...parts, central, end]));
};

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

  // A folder of real documents will always contain something no parser can open, and the
  // extractors reach into third-party libraries that raise their own exception types. One such
  // file must cost the owner that file and nothing else - never the whole search.
  await writeFile(path.join(root, 'broken.xlsx'), 'this is not a workbook');
  const withBroken = run('search', '--path', '.', '--query', 'bioinformatics server');
  assert.equal(withBroken.status, 0, withBroken.stderr);
  const brokenPayload = JSON.parse(withBroken.stdout);
  assert.equal(brokenPayload.results[0].path, 'notes.txt');
  assert.equal(brokenPayload.filesConsidered, 5);
  assert.equal(brokenPayload.filesSkipped, 1);

  const empty = run('search', '--path', '.', '--query', '!!!');
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /at least one word/);

  const escape = run('read', '--path', '../outside.txt');
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /inside the current workspace/);

  // The shelf: the formats that accumulate in a real person's folders. Every one of these used to
  // be absent from every answer, because the extension was not in SUPPORTED and the walk never
  // stopped at the file at all.
  await writeZip(path.join(shelf, 'field-guide.epub'), {
    'META-INF/container.xml':
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    // The spine names the chapters in reading order and the file names contradict it, which is
    // what an e-book converted from anything actually looks like. A percent-encoded href is the
    // other half: it is a URL, not a member name.
    'OEBPS/content.opf':
      '<package><manifest><item id="two" href="aa-part0002.xhtml"/>' +
      '<item id="one" href="zz%20chapter%20one.xhtml"/></manifest>' +
      '<spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    'OEBPS/zz chapter one.xhtml':
      '<html><body><h1>Chapter One</h1><p>The keeper counted herring.</p></body></html>',
    'OEBPS/aa-part0002.xhtml': '<html><body><p>Chapter two weighs the catch.</p></body></html>'
  });
  await writeFile(
    path.join(shelf, 'renewal.eml'),
    [
      'From: =?utf-8?q?Jos=C3=A9_Ram=C3=ADrez?= <jose@example.org>',
      'To: owner@example.org',
      'Subject: Lease renewal',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'The herring quota survives=20until March.',
      ''
    ].join('\n')
  );
  // Compound-binary bytes, which is all a .msg is here: it is refused by name rather than decoded
  // into rubbish, and the refusal has to reach the owner rather than the file being passed over.
  await writeFile(path.join(shelf, 'archived.msg'), Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  // The mail parser accepts anything - hand it a zip and it returns a message with no headers whose
  // body is the whole file decoded with replacements. That is the same mojibake .msg is refused
  // for, so it has to be refused the same way rather than indexed as prose.
  await writeZip(path.join(shelf, 'not-really.eml'), { 'a.txt': 'herring' });

  const book = runIn(shelf, {}, 'read', '--path', 'field-guide.epub');
  assert.equal(book.status, 0, book.stderr);
  const bookText = JSON.parse(book.stdout).text;
  assert.match(bookText, /Chapter One/);
  assert.ok(
    bookText.indexOf('keeper counted herring') < bookText.indexOf('weighs the catch'),
    'the book was read in file order rather than in the order its spine declares'
  );

  const mail = runIn(shelf, {}, 'read', '--path', 'renewal.eml');
  assert.equal(mail.status, 0, mail.stderr);
  const mailPayload = JSON.parse(mail.stdout);
  assert.match(mailPayload.text, /From: José Ramírez/);
  assert.match(mailPayload.text, /Subject: Lease renewal/);
  assert.match(mailPayload.text, /The herring quota survives until March\./);

  const outlook = runIn(shelf, {}, 'read', '--path', 'archived.msg');
  assert.notEqual(outlook.status, 0);
  assert.match(outlook.stderr, /compound binary/);
  assert.match(outlook.stderr, /\.eml/);

  const notMail = runIn(shelf, {}, 'read', '--path', 'not-really.eml');
  assert.notEqual(notMail.status, 0, 'a zip named .eml was decoded into text rather than refused');
  assert.match(notMail.stderr, /none of the headers/);

  const shelfSearch = runIn(shelf, {}, 'search', '--path', '.', '--query', 'herring');
  assert.equal(shelfSearch.status, 0, shelfSearch.stderr);
  const shelfPayload = JSON.parse(shelfSearch.stdout);
  assert.deepEqual([...new Set(shelfPayload.results.map((result) => result.path))].sort(), [
    'field-guide.epub',
    'renewal.eml'
  ]);
  // The honesty half. A file that could not be read is named with the reason, and the answer
  // carries the sentence that stops "nothing matched" being reported as the whole truth.
  assert.equal(shelfPayload.filesUnread, 2);
  assert.deepEqual(shelfPayload.unread.map((entry) => entry.path).sort(), [
    'archived.msg',
    'not-really.eml'
  ]);
  assert.match(
    shelfPayload.unread.find((entry) => entry.path === 'archived.msg').reason,
    /compound binary/
  );
  assert.match(shelfPayload.note, /could not be read as text/);

  // A pre-2007 Office file is read by converting it first. The converter is driven through a stub
  // here, so what is proven is this reader's half - that a .doc is offered to it at all, and that
  // the modern file it writes is extracted - without a 400 MB office suite in the loop.
  await writeZip(path.join(shelf, 'converted.docx'), {
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>' +
      'The 2009 minutes record a herring quota.</w:t></w:r></w:p></w:body></w:document>'
  });
  const converter = path.join(shelf, 'stub-convert');
  await writeFile(
    converter,
    [
      '#!/bin/sh',
      'case "$2" in',
      '  *.docx) cp "$ATHANOR_STUB_DOCX" "$2" ;;',
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n')
  );
  await chmod(converter, 0o755);
  await writeFile(path.join(shelf, 'minutes.doc'), Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const legacy = runIn(
    shelf,
    { ATHANOR_OFFICE_CONVERT: converter, ATHANOR_STUB_DOCX: path.join(shelf, 'converted.docx') },
    'read',
    '--path',
    'minutes.doc'
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(JSON.parse(legacy.stdout).text, /2009 minutes record a herring quota/);

  // No converter is not the same as a corrupt file, and the difference is the only thing the owner
  // can act on: one of them is a package they can install.
  const unconverted = runIn(
    shelf,
    { ATHANOR_OFFICE_CONVERT: path.join(shelf, 'no-such-converter') },
    'read',
    '--path',
    'minutes.doc'
  );
  assert.notEqual(unconverted.status, 0);
  assert.match(unconverted.stderr, /libreoffice-writer/);

  // A scanned PDF says so, rather than ranking below everything and letting an empty result set
  // stand for "the clause is not in these contracts". Only runs where poppler is installed at the
  // path this reader names, which is every provisioned computer and few developer machines.
  if (existsSync('/usr/bin/pdftotext') && existsSync('/usr/bin/pdfinfo')) {
    // Three pages carrying one stamped line each and nothing else - what a scanner that burns in a
    // header produces. Deliberately not an empty PDF: a few characters is the case a plain
    // "did it produce any text at all" test would call readable and hand back as an empty search.
    const pages = 3;
    const kids = Array.from({ length: pages }, (unused, index) => `${index + 3} 0 R`).join(' ');
    await writeFile(
      path.join(shelf, 'scanned-lease.pdf'),
      [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj`,
        ...Array.from(
          { length: pages },
          (unused, index) =>
            `${index + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
            '/Resources<</Font<</F1 20 0 R>>>>/Contents 10 0 R>>endobj'
        ),
        '10 0 obj<</Length 46>>stream',
        'BT /F1 12 Tf 72 720 Td (Exhibit A) Tj ET',
        'endstream',
        'endobj',
        '20 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
        `trailer<</Root 1 0 R/Size ${pages + 3}>>`,
        '%%EOF',
        ''
      ].join('\n')
    );
    const scan = runIn(shelf, {}, 'read', '--path', 'scanned-lease.pdf');
    assert.equal(scan.status, 0, scan.stderr);
    const scanPayload = JSON.parse(scan.stdout);
    assert.ok(scanPayload.characters > 0 && scanPayload.characters < 64);
    assert.match(scanPayload.note, /almost nothing in this PDF is text/);
    assert.match(scanPayload.note, /ocrmypdf/);
    const clause = runIn(shelf, {}, 'search', '--path', '.', '--query', 'termination clause');
    const clausePayload = JSON.parse(clause.stdout);
    assert.ok(
      clausePayload.unread.some((entry) => entry.path === 'scanned-lease.pdf'),
      'a scanned PDF was passed over in silence'
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(shelf, { recursive: true, force: true });
}

console.log('Document extraction and private search checks passed.');
