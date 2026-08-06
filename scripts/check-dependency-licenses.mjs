import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const store = join(process.cwd(), 'node_modules', '.pnpm');
if (!existsSync(store)) throw new Error('Install dependencies before running the license gate');

const allowedIdentifiers = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
  'WTFPL'
]);
const banned = /(?:UNLICENSED|UNKNOWN|SEE LICENSE|NON[- ]?COMMERCIAL|CC-BY-NC|BUSL|SSPL)/i;
const found = new Map();

const inspectPackage = (manifestPath) => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.name || !manifest.version) return;
  const license = typeof manifest.license === 'string' ? manifest.license.trim() : '';
  found.set(`${manifest.name}@${manifest.version}`, {
    name: manifest.name,
    version: manifest.version,
    license
  });
};

for (const entry of readdirSync(store)) {
  const modules = join(store, entry, 'node_modules');
  if (!existsSync(modules)) continue;
  for (const name of readdirSync(modules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      const scope = join(modules, name);
      for (const child of readdirSync(scope)) {
        const manifest = join(scope, child, 'package.json');
        if (existsSync(manifest)) inspectPackage(manifest);
      }
    } else {
      const manifest = join(modules, name, 'package.json');
      if (existsSync(manifest)) inspectPackage(manifest);
    }
  }
}

const failures = [];
for (const dependency of found.values()) {
  if (!dependency.license || banned.test(dependency.license)) {
    failures.push(`${dependency.name}@${dependency.version}: ${dependency.license || 'missing'}`);
    continue;
  }
  const identifiers =
    dependency.license.match(/CC0-1\.0|[A-Za-z]+(?:-[A-Za-z0-9.]+)+|0BSD|ISC|MIT|WTFPL/g) ?? [];
  if (!identifiers.length || identifiers.some((identifier) => !allowedIdentifiers.has(identifier)))
    failures.push(`${dependency.name}@${dependency.version}: ${dependency.license}`);
}

if (failures.length) {
  throw new Error(`Dependency license review required:\n${failures.sort().join('\n')}`);
}
process.stdout.write(
  `Dependency license gate passed for ${found.size} installed package releases.\n`
);
