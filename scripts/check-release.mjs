import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

function cargoVersion(source) {
  const packageSection = source.match(/^\[package\]\s*([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
  return packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

const [
  rootPackage,
  desktopPackage,
  tauriConfig,
  cargoManifest,
  installerSource,
  sshInstallerSource,
  webInstallerSource,
  readmeSource,
  deploymentSource
] = await Promise.all([
  readJson('package.json'),
  readJson('apps/desktop/package.json'),
  readJson('apps/desktop/src-tauri/tauri.conf.json'),
  readFile(new URL('apps/desktop/src-tauri/Cargo.toml', root), 'utf8'),
  readFile(new URL('install.sh', root)),
  readFile(new URL('apps/desktop/src-tauri/src/ssh_install.rs', root), 'utf8'),
  readFile(new URL('apps/web/src/ServerInstall.tsx', root), 'utf8'),
  readFile(new URL('README.md', root), 'utf8'),
  readFile(new URL('docs/DEPLOYMENT.md', root), 'utf8')
]);

const versions = new Map([
  ['package.json', rootPackage.version],
  ['apps/desktop/package.json', desktopPackage.version],
  ['apps/desktop/src-tauri/tauri.conf.json', tauriConfig.version],
  ['apps/desktop/src-tauri/Cargo.toml', cargoVersion(cargoManifest)]
]);
const expectedVersion = rootPackage.version;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (typeof expectedVersion !== 'string' || !semver.test(expectedVersion)) {
  throw new Error(`package.json has an invalid release version: ${String(expectedVersion)}`);
}

const mismatches = [...versions].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  throw new Error(
    `Release versions must match ${expectedVersion}: ${mismatches
      .map(([path, version]) => `${path}=${String(version)}`)
      .join(', ')}`
  );
}

const installerHash = createHash('sha256').update(installerSource).digest('hex');
if (!sshInstallerSource.includes(`"${installerHash}"`)) {
  throw new Error(
    'The native SSH installer checksum does not match install.sh; review the bootstrap change and update INSTALL_BOOTSTRAP_SHA256'
  );
}
if (!sshInstallerSource.includes('concat!("v", env!("CARGO_PKG_VERSION"))')) {
  throw new Error('The native SSH installer must pin to the compiled package version');
}
if (
  !sshInstallerSource.includes('env!("ATHANOR_SOURCE_COMMIT")') ||
  !sshInstallerSource.includes("ATHANOR_EXPECTED_COMMIT='{SOURCE_COMMIT}'") ||
  !installerSource.includes('ATHANOR_EXPECTED_COMMIT') ||
  !installerSource.includes('installed_commit')
) {
  throw new Error('The native SSH installer must pin the downloaded source to its compiled commit');
}
if (!webInstallerSource.includes(`v${expectedVersion}`)) {
  throw new Error(
    `apps/web/src/ServerInstall.tsx does not pin the browser installer to v${expectedVersion}`
  );
}
/**
 * Every published install path must point at the same namespace the maintainer controls. A
 * `curl … | sh` command aimed anywhere else hands whoever owns that namespace root on every
 * installation, so a stale or mistyped owner is a release-blocking supply-chain defect.
 */
const PUBLIC_NAMESPACE = 'ouaeic/athanor';
const foreignNamespaces = [
  ['install.sh', installerSource],
  ['README.md', readmeSource],
  ['docs/DEPLOYMENT.md', deploymentSource],
  ['apps/web/src/ServerInstall.tsx', webInstallerSource]
].flatMap(([path, source]) =>
  // install.sh is read as a Buffer so it can be hashed above; match against its text form.
  [
    ...String(source).matchAll(
      /github(?:usercontent)?\.com\/([\w.-]+\/[\w.-]+?)(?:\.git|\/|["'\s])/g
    )
  ]
    .map((match) => match[1].replace(/\.git$/, ''))
    .filter((owner) => owner !== PUBLIC_NAMESPACE)
    .map((owner) => `${path} -> ${owner}`)
);
if (foreignNamespaces.length) {
  throw new Error(
    `Install paths must reference ${PUBLIC_NAMESPACE}. Found: ${foreignNamespaces.join(', ')}`
  );
}

// A published install command must be pinned to the release tag, never a branch.
for (const [path, source] of [
  ['README.md', readmeSource],
  ['docs/DEPLOYMENT.md', deploymentSource]
]) {
  if (!source.includes('install.sh |')) continue;
  if (
    !source.includes(`/v${expectedVersion}/install.sh`) ||
    !source.includes(`ATHANOR_REF=v${expectedVersion}`)
  ) {
    throw new Error(`${path} does not pin the public installer to v${expectedVersion}`);
  }
}

const releaseTag = process.env.ATHANOR_RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (releaseTag && releaseTag !== `v${expectedVersion}`) {
  throw new Error(`Release tag ${releaseTag} does not match v${expectedVersion}`);
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${expectedVersion}\n`, {
    encoding: 'utf8'
  });
}

console.log(`Verified athanor release version v${expectedVersion}`);
