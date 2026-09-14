import { z } from 'zod';

const entries = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          [...value].every((character) => {
            const code = character.codePointAt(0) ?? 0;
            return (
              code >= 32 &&
              !(code >= 127 && code <= 159) &&
              !(code >= 8234 && code <= 8238) &&
              !(code >= 8294 && code <= 8297)
            );
          }),
        'Permission labels must not contain control characters'
      )
  )
  .max(12);
export const TaskApprovalScope = z
  .object({
    tool: z.enum(['shell', 'parallel_web_read', 'file_write', 'file_patch', 'code_diagnostics']),
    permissions: z
      .array(z.enum(['network', 'commands', 'files', 'install', 'analysis']))
      .min(1)
      .max(5),
    programs: entries,
    origins: entries,
    directories: entries
  })
  .strict();
export type TaskApprovalScope = z.infer<typeof TaskApprovalScope>;

export const canonicalApprovalScope = (scope: TaskApprovalScope): string =>
  JSON.stringify({
    tool: scope.tool,
    permissions: [...new Set(scope.permissions)].sort(),
    programs: [...new Set(scope.programs)].sort(),
    origins: [...new Set(scope.origins)].sort(),
    directories: [...new Set(scope.directories)].sort()
  });

export const describeApprovalScope = (scope: TaskApprovalScope): string =>
  [
    scope.permissions.includes('network')
      ? scope.tool === 'shell'
        ? 'Network commands'
        : 'Web reads'
      : '',
    scope.permissions.includes('commands') ? 'Local commands' : '',
    scope.permissions.includes('install') ? 'Install or update software' : '',
    scope.permissions.includes('files')
      ? scope.tool === 'file_patch'
        ? 'Apply file patches'
        : 'Create or replace files'
      : '',
    scope.permissions.includes('analysis') ? 'Code analysis' : '',
    scope.programs.length ? `using ${scope.programs.join(', ')}` : '',
    scope.origins.length ? `referencing ${scope.origins.join(', ')}` : '',
    scope.directories.length ? `in ${scope.directories.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join(' · ');

export const TaskApprovalOffer = z
  .object({
    scope: TaskApprovalScope,
    turn: z.number().int().nonnegative(),
    securityMode: z.enum(['review', 'balanced', 'autonomous'])
  })
  .strict();
export type TaskApprovalOffer = z.infer<typeof TaskApprovalOffer>;
