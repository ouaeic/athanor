import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNativeBinaries } from './check-native-binary.mjs';
import { withReleaseRustFlags } from './release-build-env.mjs';
import { verifyMacApplication } from './verify-macos-artifact.mjs';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const environment = withReleaseRustFlags(process.env);
if (
  process.platform === 'darwin' &&
  !environment.APPLE_SIGNING_IDENTITY &&
  !environment.APPLE_CERTIFICATE
) {
  // Tauri does not sign a complete .app bundle unless an identity is configured.
  // A local ad-hoc identity keeps developer builds launchable and ensures DMGs
  // contain a sealed app. Protected release builds provide the real identity.
  environment.APPLE_SIGNING_IDENTITY = '-';
}
const tauriCli = resolve(desktopDirectory, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const argumentsForTauri = [tauriCli, 'build', ...process.argv.slice(2)];

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, argumentsForTauri, {
    cwd: desktopDirectory,
    env: environment,
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`Tauri build terminated by ${signal}`));
    else resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) process.exit(exitCode);

const targetRoot = resolve(
  environment.CARGO_TARGET_DIR ?? resolve(desktopDirectory, 'src-tauri', 'target')
);
await checkNativeBinaries(targetRoot, environment);

if (process.platform === 'darwin') {
  const applications = [];
  async function findApplications(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        applications.push({ path, modified: (await stat(path)).mtimeMs });
      } else if (entry.isDirectory()) {
        await findApplications(path);
      }
    }
  }
  await findApplications(targetRoot);
  applications.sort((left, right) => right.modified - left.modified);
  if (applications.length === 0) {
    throw new Error(`No macOS application bundle found below ${targetRoot}`);
  }
  await verifyMacApplication(applications[0].path);
}
