import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_TOOLCHAIN,
  parseFontFamilies,
  parseImportableModules,
  probeBinaries,
  reportToolchain,
  summariseToolchain,
  toolchainReport,
  type ToolchainCapability
} from './toolchain.js';

const deck: ToolchainCapability = {
  id: 'office-authoring',
  purpose: 'Write .docx, .pptx and .xlsx as real Office files',
  binaries: ['python3'],
  pythonModules: ['pptx', 'docx'],
  fonts: [],
  install: 'apt-get install -y python3-pptx python3-docx'
};

const fonts: ToolchainCapability = {
  id: 'document-fonts',
  purpose: 'Lay out Calibri and Cambria documents at the right metrics',
  binaries: ['fc-list'],
  pythonModules: [],
  fonts: ['Carlito', 'Caladea'],
  install: 'apt-get install -y fonts-crosextra-carlito fonts-crosextra-caladea'
};

const nothing = { binaries: new Set<string>(), pythonModules: new Set<string>(), fonts: new Set<string>() };

describe('document toolchain report', () => {
  it('names what is missing and the command that would provide it', () => {
    const [report] = reportToolchain([deck], {
      ...nothing,
      binaries: new Set(['python3'])
    });
    expect(report).toMatchObject({
      id: 'office-authoring',
      ready: false,
      missingBinaries: [],
      missingPythonModules: ['pptx', 'docx'],
      install: 'apt-get install -y python3-pptx python3-docx'
    });
  });

  it('reports a capability as ready only when every part of it is there', () => {
    const ready = reportToolchain([deck], {
      ...nothing,
      binaries: new Set(['python3']),
      pythonModules: new Set(['pptx', 'docx'])
    })[0];
    expect(ready).toMatchObject({ ready: true, missingPythonModules: [] });
    // Nothing to install, so nothing is suggested.
    expect(ready?.install).toBe(undefined);
  });

  it('checks fonts by family, which is how a document actually finds them', () => {
    const [report] = reportToolchain([fonts], {
      ...nothing,
      binaries: new Set(['fc-list']),
      fonts: new Set(['carlito', 'dejavu sans'])
    });
    expect(report).toMatchObject({ ready: false, missingFonts: ['Caladea'] });
  });

  it('leads with what works, then says what to ask for', () => {
    const summary = summariseToolchain(
      reportToolchain([deck, fonts], {
        ...nothing,
        binaries: new Set(['python3', 'fc-list']),
        pythonModules: new Set(['pptx', 'docx'])
      })
    );
    expect(summary).toContain('Available on this computer: office-authoring.');
    expect(summary).toContain('Not installed: document-fonts');
    expect(summary).toContain('fonts-crosextra-caladea');
    expect(summary).toContain('do not follow a procedure that depends on one of these');
  });

  it('says so plainly when the box has none of it', () => {
    expect(summariseToolchain(reportToolchain([deck], nothing))).toContain(
      'No document toolchain is installed on this computer.'
    );
  });

  it('covers every job the built-in document skills prescribe', () => {
    const ids = DOCUMENT_TOOLCHAIN.map((capability) => capability.id);
    expect(ids).toContain('office-authoring');
    expect(ids).toContain('office-conversion');
    expect(ids).toContain('typeset-pdf');
    expect(ids).toContain('data-analysis');
    expect(ids).toContain('image-work');
    // Every capability has to name a way out of being missing, or the report is only a complaint.
    for (const capability of DOCUMENT_TOOLCHAIN) expect(capability.install.length).toBeGreaterThan(0);
  });
});

describe('probe parsing', () => {
  it('reads fontconfig families, including the alias list on one line', () => {
    const families = parseFontFamilies('Carlito\nCaladea,Cambria\nDejaVu Sans\n');
    expect(families.has('carlito')).toBe(true);
    expect(families.has('cambria')).toBe(true);
    expect(families.has('dejavu sans')).toBe(true);
  });

  it('accepts only modules that were asked about', () => {
    const modules = parseImportableModules('pptx\nsys\ndocx\n', ['pptx', 'docx', 'openpyxl']);
    expect([...modules]).toEqual(['pptx', 'docx']);
  });
});

describe('binary probing', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'athanor-toolchain-'));
    await mkdir(path.join(root, 'workspace'), { recursive: true });
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('resolves a binary exactly as an agent command would', async () => {
    // /bin/sh is on the agent's own search path on every host this runs on.
    const found = await probeBinaries(root, ['sh', 'athanor-not-a-real-binary']);
    expect(found.has('sh')).toBe(true);
    expect(found.has('athanor-not-a-real-binary')).toBe(false);
  });

  it('does not count a file the agent could not execute', async () => {
    const tools = path.join(root, 'workspace', '.athanor', 'tools', 'node_modules', '.bin');
    await mkdir(tools, { recursive: true });
    await writeFile(path.join(tools, 'typst'), '#!/bin/sh\n');
    await chmod(path.join(tools, 'typst'), 0o644);
    expect((await probeBinaries(root, ['typst'])).has('typst')).toBe(false);
    await chmod(path.join(tools, 'typst'), 0o755);
    expect((await probeBinaries(root, ['typst'])).has('typst')).toBe(true);
  });

  // Given longer than the probe's own PROBE_TIMEOUT_MS ceiling, because this one asks the real host
  // rather than a fixture: it starts an interpreter and looks for seven modules, which under a
  // machine running the whole suite in parallel is comfortably slower than vitest's default five
  // seconds. A test that fails only when the machine is busy is a test nobody can trust.
  it('answers for the real host without pretending anything is there', async () => {
    const report = await toolchainReport(root);
    expect(report.capabilities).toHaveLength(DOCUMENT_TOOLCHAIN.length);
    expect(report.ready.length + report.missing.length).toBe(DOCUMENT_TOOLCHAIN.length);
    expect(report.summary.length).toBeGreaterThan(0);
    for (const capability of report.capabilities)
      expect(capability.ready).toBe(
        capability.missingBinaries.length === 0 &&
          capability.missingPythonModules.length === 0 &&
          capability.missingFonts.length === 0
      );
  }, 20_000);
});
