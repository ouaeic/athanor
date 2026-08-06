import { execFileSync } from 'node:child_process';

const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'CDLA-Permissive-2.0',
  'ISC',
  'LLVM-exception',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Unicode-3.0',
  'Unlicense',
  'Zlib'
]);

const licenseIsAllowed = (expression) => {
  if (!expression) return false;
  const normalized = expression.replaceAll('/', ' OR ');
  const tokenPattern = /\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9.+-]+/g;
  const tokens = normalized.match(tokenPattern) ?? [];
  if (normalized.replace(tokenPattern, '').trim() || tokens.length === 0) return false;
  let position = 0;

  const primary = () => {
    const token = tokens[position++];
    if (token === '(') {
      const result = orExpression();
      if (tokens[position++] !== ')') throw new Error('unbalanced expression');
      return result;
    }
    if (!token || [')', 'AND', 'OR', 'WITH'].includes(token)) throw new Error('invalid expression');
    return allowed.has(token);
  };
  const andExpression = () => {
    let result = primary();
    while (['AND', 'WITH'].includes(tokens[position])) {
      position += 1;
      const right = primary();
      result = result && right;
    }
    return result;
  };
  const orExpression = () => {
    let result = andExpression();
    while (tokens[position] === 'OR') {
      position += 1;
      const right = andExpression();
      result = result || right;
    }
    return result;
  };

  try {
    const result = orExpression();
    return result && position === tokens.length;
  } catch {
    return false;
  }
};

if (
  !licenseIsAllowed('(MIT OR Apache-2.0) AND Unicode-3.0') ||
  !licenseIsAllowed('MIT OR LGPL-2.1-or-later') ||
  licenseIsAllowed('MIT AND LicenseRef-Proprietary') ||
  licenseIsAllowed('LGPL-3.0-only')
) {
  throw new Error('Rust license-expression evaluator failed closed-checks');
}

const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--manifest-path',
      'apps/desktop/src-tauri/Cargo.toml',
      '--format-version',
      '1',
      '--locked'
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
);
const workspace = new Set(metadata.workspace_members);
const dependencies = metadata.packages.filter((release) => !workspace.has(release.id));
const failures = dependencies
  .filter((release) => !licenseIsAllowed(release.license))
  .map((release) => `${release.name}@${release.version}: ${release.license || 'missing'}`)
  .sort();

if (failures.length) {
  throw new Error(`Rust dependency license review required:\n${failures.join('\n')}`);
}
process.stdout.write(
  `Rust dependency license gate passed for ${dependencies.length} crate releases.\n`
);
