import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePathMappings } from './release-build-env.mjs';

const desktopDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));

const nativeArtifactKinds = new Map([
  ['athanor-desktop', 'desktop'],
  ['athanor-desktop.exe', 'desktop'],
  ['libathanor_desktop_lib.so', 'android'],
  ['libathanor_desktop_lib.a', 'ios']
]);

async function findReleaseExecutables(root) {
  const matches = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        const kind = nativeArtifactKinds.get(entry.name);
        if (kind && path.split(/[\\/]/).includes('release')) {
          matches.push({ kind, path });
        }
      }
    }
  }
  await visit(root);
  return matches;
}

export async function checkNativeBinaries(
  targetRoot,
  environment = process.env,
  expectedKind = 'desktop'
) {
  const artifacts = await findReleaseExecutables(targetRoot);
  const matching = artifacts.filter(({ kind }) => kind === expectedKind);
  if (matching.length === 0) {
    throw new Error(`No ${expectedKind} native release artifact found below ${targetRoot}`);
  }

  const exactPrefixes = releasePathMappings(environment).map(({ source }) => source);
  const genericHomePatterns = [
    /\/Users\/[^/\0]+\/(?:\.cargo|\.rustup|Documents)\//,
    /\/home\/[^/\0]+\/(?:\.cargo|\.rustup|work)\//,
    /[A-Za-z]:\\Users\\[^\\\0]+\\(?:\.cargo|\.rustup|source|work)\\/i
  ];

  for (const { path } of matching) {
    const details = await stat(path);
    if (details.size > 300 * 1024 * 1024) {
      throw new Error(`Refusing to scan unexpectedly large native artifact: ${path}`);
    }
    const bytes = await readFile(path);
    const text = bytes.toString('latin1');
    const leakedPrefix = exactPrefixes.find((prefix) => text.includes(prefix));
    const leakedPattern = genericHomePatterns.find((pattern) => pattern.test(text));
    if (leakedPrefix || leakedPattern) {
      throw new Error(
        `Native release artifact contains a build-machine path (${leakedPrefix ?? leakedPattern}): ${path}`
      );
    }
  }

  console.log(
    `Verified ${matching.length} ${expectedKind} native release artifact(s): no build-machine home paths`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configuredRoot =
    process.argv[2] ??
    process.env.CARGO_TARGET_DIR ??
    resolve(desktopDirectory, 'src-tauri', 'target');
  await checkNativeBinaries(resolve(configuredRoot), process.env, process.argv[3] ?? 'desktop');
}
