import { spawn } from 'node:child_process';
import { agentSearchPath } from './execution.js';
import { resolveExecutable } from './command-policy.js';

/**
 * What a document job needs, grouped by the job rather than by the package, because "you cannot
 * make a slide deck" is the sentence the agent has to be able to say — not "python3-pptx is
 * absent". Every entry names the command that would provide it, so one approval covers the gap
 * instead of the agent discovering it one failed call at a time in front of the owner.
 */
export interface ToolchainCapability {
  id: string;
  purpose: string;
  binaries: readonly string[];
  pythonModules: readonly string[];
  fonts: readonly string[];
  install: string;
}

/**
 * The one Python the document skills name. It is a virtual environment created with
 * --system-site-packages, so it sees both the distribution's python-docx, openpyxl, pandas,
 * matplotlib and Pillow and the versions athanor pins itself. Probing through it rather
 * than through `python3` is what makes "is pypdf importable" the same question the agent will ask.
 */
export const ATHANOR_PYTHON = '/usr/local/lib/athanor/python/bin/python3';

export const DOCUMENT_TOOLCHAIN: readonly ToolchainCapability[] = [
  {
    id: 'office-authoring',
    purpose: 'Write .docx, .pptx and .xlsx as real Office files rather than hand-rolled XML',
    binaries: [ATHANOR_PYTHON],
    pythonModules: ['pptx', 'docx', 'openpyxl'],
    fonts: [],
    // python-pptx is not the distribution's any more: Ubuntu packaged it up to 24.04 and stopped,
    // so it is pinned in infra/native/athanor-python-requirements.txt and installed into the one
    // interpreter above. Naming the reinstall rather than an apt line that would not work.
    install:
      'apt-get install -y python3-docx python3-openpyxl, then re-run the athanor installer to restore the pinned Python environment'
  },
  {
    id: 'office-conversion',
    purpose:
      'Turn an Office file into a PDF, or recalculate a workbook, through one command that fails when the bytes are not there instead of exiting 0',
    binaries: [
      'athanor-office-convert',
      'soffice',
      'pdftoppm',
      'pdffonts',
      'pdfinfo',
      'pdftotext',
      'pdfimages'
    ],
    pythonModules: [],
    fonts: [],
    install:
      'apt-get install -y libreoffice-writer libreoffice-impress libreoffice-calc poppler-utils'
  },
  {
    id: 'document-fonts',
    purpose:
      'Lay out Calibri and Cambria documents at the metrics they were written for, and give a typeset document and a rendered slide a face that is actually installed',
    binaries: ['fc-list'],
    pythonModules: [],
    fonts: ['Carlito', 'Caladea', 'Liberation Sans', 'Liberation Serif', 'DejaVu Sans'],
    install:
      'apt-get install -y fontconfig fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation fonts-dejavu-core fonts-noto-core'
  },
  {
    id: 'pdf-assembly',
    purpose:
      'Split, merge, rotate, stamp, encrypt, redact and structurally check a PDF. img2pdf rebuilds a rasterised page, which is what makes a redaction remove the characters rather than cover them',
    binaries: ['qpdf', 'img2pdf'],
    pythonModules: [],
    fonts: [],
    install: 'apt-get install -y qpdf img2pdf'
  },
  {
    id: 'pdf-forms',
    purpose: 'Enumerate and fill the fields of a PDF form, which is the one PDF job qpdf cannot do',
    binaries: [ATHANOR_PYTHON],
    pythonModules: ['pypdf'],
    fonts: [],
    install:
      'reinstall the pinned document Python environment, which scripts/install-native.sh creates from infra/native/athanor-python-requirements.txt'
  },
  {
    id: 'pdf-extraction',
    purpose:
      'Read text, tables and page geometry out of a PDF, and give a scanned one a text layer so it can be read at all',
    binaries: ['pdftotext', 'pdfinfo', 'athanor-pdf-tables', 'ocrmypdf', 'tesseract', 'gs'],
    pythonModules: [],
    fonts: [],
    // ghostscript arrives as a dependency of ocrmypdf, and is what compresses an oversized PDF.
    install: 'apt-get install -y poppler-utils ocrmypdf tesseract-ocr tesseract-ocr-eng'
  },
  {
    id: 'typeset-pdf',
    purpose:
      'Typeset a CV, a one-pager or a report straight to a PDF, with exact control over where the page breaks - which is what decides whether a CV is one page or two',
    binaries: ['typst'],
    pythonModules: [],
    fonts: [],
    install: 'install the pinned typst release, which scripts/install-native.sh does'
  },
  {
    id: 'data-analysis',
    purpose: 'Read, reshape and chart spreadsheet and CSV data',
    binaries: [ATHANOR_PYTHON],
    // numpy is not a fourth package: pandas and matplotlib both depend on it, so it is on every box
    // that has either. It is named because procedures import it directly, and a capability list
    // that leaves out what the work actually calls is the list that sends an agent guessing.
    pythonModules: ['pandas', 'numpy', 'matplotlib'],
    fonts: [],
    install: 'apt-get install -y python3-pandas python3-numpy python3-matplotlib'
  },
  {
    /**
     * Separate from data-analysis on purpose. Charting a column and testing whether a difference is
     * real are different jobs, and folding them together would mean a box without the statistics
     * packages reported that it could not chart either.
     *
     * The gap this closes: with pandas and matplotlib alone, a confidence interval, a significance
     * test or a seasonal forecast is arithmetic done by a language model in its own head. That is
     * the class of answer that is wrong in a way nobody notices - a plausible p-value, a sound-
     * looking interval - and it is handed to the owner as a finding about their own data.
     *
     * Two packages and no more. scipy carries the distributions and the tests; statsmodels carries
     * the models that state their own uncertainty - regression with standard errors, seasonal
     * decomposition, exponential smoothing. Both come from the distribution, signed and security
     * supported, and statsmodels pulls scipy in anyway, so the pair costs one download. Nothing
     * here needs a machine-learning stack: scikit-learn would add a few hundred megabytes to
     * answer questions nobody asks of a household spreadsheet, and a deep-learning runtime would
     * be gigabytes on a computer whose contract says no model weights run locally.
     */
    id: 'statistics',
    purpose:
      'Answer a question about data with a stated confidence rather than arithmetic done in a model’s head - a confidence interval, a significance test, a regression, a seasonal decomposition or a forecast',
    binaries: [ATHANOR_PYTHON],
    pythonModules: ['scipy', 'statsmodels'],
    fonts: [],
    install: 'apt-get install -y python3-scipy python3-statsmodels'
  },
  {
    id: 'image-work',
    purpose: 'Crop, resize, composite and convert images, and render diagrams',
    binaries: [ATHANOR_PYTHON, 'magick', 'dot'],
    pythonModules: ['PIL'],
    fonts: [],
    install: 'apt-get install -y imagemagick graphviz python3-pil'
  },
  {
    id: 'media',
    // Reading a recording depends on this one and on nothing else installed here: audio_read cuts
    // and re-encodes the window locally before anything leaves the computer, so a box without
    // ffmpeg cannot listen to a voice memo at all, however the transcription itself is reached.
    purpose: 'Inspect and transcode audio and video, and prepare a recording to be read',
    binaries: ['ffmpeg', 'ffprobe'],
    pythonModules: [],
    fonts: [],
    install: 'apt-get install -y ffmpeg'
  }
];

export interface ToolchainCapabilityReport {
  id: string;
  purpose: string;
  ready: boolean;
  missingBinaries: string[];
  missingPythonModules: string[];
  missingFonts: string[];
  /** Only present when something is missing; a ready capability has nothing to install. */
  install?: string;
}

export interface ToolchainReport {
  capabilities: ToolchainCapabilityReport[];
  ready: string[];
  missing: string[];
  summary: string;
}

/** Present binaries and modules are the inputs; what is missing per capability is the answer. */
export const reportToolchain = (
  capabilities: readonly ToolchainCapability[],
  available: { binaries: Set<string>; pythonModules: Set<string>; fonts: Set<string> }
): ToolchainCapabilityReport[] =>
  capabilities.map((capability) => {
    const missingBinaries = capability.binaries.filter((name) => !available.binaries.has(name));
    const missingPythonModules = capability.pythonModules.filter(
      (name) => !available.pythonModules.has(name)
    );
    const missingFonts = capability.fonts.filter(
      (name) => !available.fonts.has(name.toLowerCase())
    );
    const ready =
      missingBinaries.length === 0 &&
      missingPythonModules.length === 0 &&
      missingFonts.length === 0;
    return {
      id: capability.id,
      purpose: capability.purpose,
      ready,
      missingBinaries,
      missingPythonModules,
      missingFonts,
      ...(ready ? {} : { install: capability.install })
    };
  });

/**
 * One line the agent can be shown before it commits to a plan. It deliberately leads with what
 * works: an agent told only what is broken picks a worse route than one told which route is open.
 */
export const summariseToolchain = (reports: readonly ToolchainCapabilityReport[]): string => {
  const ready = reports.filter((report) => report.ready);
  const missing = reports.filter((report) => !report.ready);
  const parts: string[] = [];
  parts.push(
    ready.length
      ? `Available on this computer: ${ready.map((report) => report.id).join(', ')}.`
      : 'No document toolchain is installed on this computer.'
  );
  if (missing.length)
    parts.push(
      `Not installed: ${missing
        .map((report) => `${report.id} (needs ${report.install})`)
        .join(
          '; '
        )}. Ask before installing, and do not follow a procedure that depends on one of these until it is there.`
    );
  return parts.join(' ');
};

/** Font family names fontconfig reports, lowercased, from `fc-list --format=%{family}\n`. */
export const parseFontFamilies = (output: string): Set<string> => {
  const families = new Set<string>();
  for (const line of output.split('\n'))
    for (const family of line.split(','))
      if (family.trim()) families.add(family.trim().toLowerCase());
  return families;
};

/** Modules the probe reported as importable, one per line, ignoring anything else python said. */
export const parseImportableModules = (output: string, requested: readonly string[]): Set<string> =>
  new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => requested.includes(line))
  );

const PROBE_TIMEOUT_MS = 8_000;

const runProbe = async (
  executable: string,
  args: string[],
  stdin?: string
): Promise<string | null> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : null);
    });
    child.stdin?.end(stdin ?? '');
  });

/**
 * Resolved the same way an agent command would resolve it: same PATH, same symlink following.
 * Anything else would report a binary the agent then cannot run, which is the failure this
 * whole module exists to remove.
 */
export const probeBinaries = async (
  root: string,
  names: readonly string[]
): Promise<Set<string>> => {
  const searchPath = agentSearchPath(root);
  const found = new Set<string>();
  await Promise.all(
    [...new Set(names)].map(async (name) => {
      if (await resolveExecutable(name, searchPath, root)) found.add(name);
    })
  );
  return found;
};

const IMPORT_PROBE = `import importlib.util, sys
for name in sys.argv[1:]:
    try:
        if importlib.util.find_spec(name) is not None:
            print(name)
    except Exception:
        pass
`;

/**
 * Asked of the pinned interpreter and no other. A module that only the distribution's `python3`
 * can import is a module no vetted procedure may use, so reporting it as present would put the
 * agent back to guessing which python to run.
 */
export const probePythonModules = async (
  root: string,
  modules: readonly string[]
): Promise<Set<string>> => {
  const wanted = [...new Set(modules)];
  if (!wanted.length) return new Set();
  const python = await resolveExecutable(ATHANOR_PYTHON, agentSearchPath(root), root);
  if (!python) return new Set();
  const output = await runProbe(python, ['-c', IMPORT_PROBE, ...wanted]);
  return output === null ? new Set() : parseImportableModules(output, wanted);
};

export const probeFonts = async (root: string, fonts: readonly string[]): Promise<Set<string>> => {
  if (!fonts.length) return new Set();
  const listing = await resolveExecutable('fc-list', agentSearchPath(root), root);
  if (!listing) return new Set();
  const output = await runProbe(listing, ['--format=%{family}\\n']);
  return output === null ? new Set() : parseFontFamilies(output);
};

/**
 * The whole picture, probed fresh. It is deliberately not cached: the agent's first move after
 * reading it may be to install what is missing, and a cached answer would then tell it the
 * package it just installed is still absent.
 */
export const toolchainReport = async (root: string): Promise<ToolchainReport> => {
  const [binaries, pythonModules, fonts] = await Promise.all([
    probeBinaries(
      root,
      DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.binaries)
    ),
    probePythonModules(
      root,
      DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.pythonModules)
    ),
    probeFonts(
      root,
      DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.fonts)
    )
  ]);
  const capabilities = reportToolchain(DOCUMENT_TOOLCHAIN, { binaries, pythonModules, fonts });
  return {
    capabilities,
    ready: capabilities.filter((report) => report.ready).map((report) => report.id),
    missing: capabilities.filter((report) => !report.ready).map((report) => report.id),
    summary: summariseToolchain(capabilities)
  };
};
