import { describe, expect, it } from 'vitest';
import { TaskPresentation, type TaskEvent, type WorkspacePreview } from '@athanor/contracts';
import {
  buildTaskPresentation,
  deliveryFilePath,
  taskSourceFiles,
  type PresentationInput
} from './task-presentation.js';

const taskId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const now = '2026-09-06T12:00:00.000Z';
const event = (
  sequence: number,
  kind: TaskEvent['kind'],
  payload: unknown,
  summary = 'Observed'
): TaskEvent => ({
  id: `event-${sequence}`,
  taskId,
  sequence,
  kind,
  payload,
  summary,
  createdAt: now
});
const preview: WorkspacePreview = {
  id: 'preview-1',
  workspaceId,
  label: 'Maze game',
  port: 8080,
  visibility: 'private',
  status: 'active',
  url: 'https://garden.test/__athanor/preview/real/',
  expiresAt: null,
  lastAccessedAt: null,
  createdAt: now,
  updatedAt: now
};
const input = (over: Partial<PresentationInput> = {}): PresentationInput => ({
  taskId,
  workspaceId,
  taskStatus: 'completed',
  events: [],
  plan: null,
  artifacts: [],
  previews: [],
  previewAvailability: new Map(),
  files: new Map(),
  ...over
});

describe('task results are concrete owner-accessible outputs', () => {
  it('includes recorded supporting files in a source bundle even when completion names only its entry page', () => {
    const events = [
      event(1, 'tool_started', {
        tool: 'file_write',
        toolCallId: 'style',
        arguments: { path: 'app/styles.css' }
      }),
      event(2, 'tool_result', { toolCallId: 'style', result: { path: 'app/styles.css' } }),
      event(3, 'completed', { deliverables: ['app/index.html'] })
    ];
    expect([...taskSourceFiles(events).keys()]).toEqual([
      'workspace/app/index.html',
      'workspace/app/styles.css'
    ]);
    expect([
      ...taskSourceFiles([event(4, 'completed', { summary: 'A short answer' })]).keys()
    ]).toEqual([]);
  });

  it('treats time-expired active previews as unavailable even when a cached port observation passed', () => {
    const result = buildTaskPresentation(
      input({
        events: [event(1, 'preview', { previewId: preview.id })],
        previews: [{ ...preview, expiresAt: '2000-01-01T00:00:00.000Z' }],
        previewAvailability: new Map([[preview.id, 'ready']])
      })
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: 'unavailable', url: null, accessPath: null });
  });
  it('restores a historical app preview and source download without replaying the agent', () => {
    const events = [
      event(129, 'preview', { previewId: preview.id, url: 'https://untrusted.test/not-used' }),
      event(158, 'completed', {
        deliverables: ['pacman-clone/index.html', 'https://untrusted.test/fake']
      })
    ];
    const result = buildTaskPresentation(
      input({
        events,
        previews: [preview],
        previewAvailability: new Map([[preview.id, 'ready']]),
        files: new Map([
          ['workspace/pacman-clone/index.html', { status: 'ready', sizeBytes: 21_000 }]
        ])
      })
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      kind: 'preview',
      url: preview.url,
      accessPath: '/v1/previews/preview-1/access',
      evidenceEventIds: ['event-129']
    });
    expect(result.results[1]).toMatchObject({
      kind: 'file',
      path: 'workspace/pacman-clone/index.html',
      downloadUrl: `/v1/workspaces/${workspaceId}/download?path=workspace%2Fpacman-clone%2Findex.html`,
      sizeBytes: 21_000
    });
    expect(JSON.stringify(result)).not.toContain('untrusted.test');
    expect(TaskPresentation.safeParse(result).success).toBe(true);
  });

  it('does not borrow another task preview, file event or artifact', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          { ...event(1, 'preview', { previewId: preview.id }), taskId: 'other' },
          { ...event(2, 'completed', { deliverables: ['other.txt'] }), taskId: 'other' }
        ],
        previews: [preview],
        previewAvailability: new Map([[preview.id, 'ready']]),
        artifacts: [
          {
            id: 'other',
            workspaceId,
            taskId: 'other',
            name: 'Other task',
            mimeType: 'text/plain',
            sizeBytes: 1,
            version: 1,
            sha256: 'abc',
            createdAt: now
          }
        ]
      })
    );
    expect(result.results).toEqual([]);
  });

  it.each(['revoked', 'expired'] as const)(
    'never offers an Open action for a %s preview',
    (status) => {
      const result = buildTaskPresentation(
        input({
          events: [event(1, 'preview', { previewId: preview.id })],
          previews: [{ ...preview, status }],
          previewAvailability: new Map([[preview.id, 'ready']])
        })
      );
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        status: 'unavailable',
        url: null,
        accessPath: null
      });
    }
  );

  it('distinguishes missing files from unchecked files that remain privately downloadable', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'preview', { previewId: preview.id }),
          event(2, 'completed', { deliverables: ['missing.csv', 'unknown.csv'] })
        ],
        previews: [preview],
        previewAvailability: new Map([[preview.id, 'unavailable']]),
        files: new Map([['workspace/missing.csv', { status: 'unavailable' }]])
      })
    );
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => [r.status, r.url, r.downloadUrl])).toEqual([
      ['unavailable', null, null],
      ['unavailable', null, null],
      ['unknown', null, `/v1/workspaces/${workspaceId}/download?path=workspace%2Funknown.csv`]
    ]);
  });

  it.each([
    '/etc/passwd',
    '../private.key',
    'workspace/../private.key',
    'workspace//file',
    'https://evil.test/file',
    'javascript:alert(1)',
    'workspace/a\\b',
    'workspace/a?b',
    'workspace/a\u0000b',
    ''
  ])('rejects unsafe delivery path %j', (value) => {
    expect(deliveryFilePath(value)).toBeNull();
  });
});

describe('task progress is a deterministic reading of actual work', () => {
  it('preserves observed steps on reconnect and never equates elapsed work with percent complete', () => {
    const events = [
      event(1, 'tool_started', {
        toolCallId: 'write',
        tool: 'file_write',
        arguments: { path: 'app.js' }
      }),
      event(2, 'tool_result', { toolCallId: 'write', result: { path: 'app.js' } }),
      event(3, 'tool_started', {
        toolCallId: 'test',
        tool: 'shell',
        arguments: { executable: 'node', args: ['--test'] }
      }),
      event(4, 'tool_result', {
        toolCallId: 'test',
        result: { exitCode: 1, stderr: 'assertion failed' }
      }),
      event(5, 'tool_started', {
        toolCallId: 'read',
        tool: 'file_read',
        arguments: { path: 'app.js' }
      })
    ];
    const expected = buildTaskPresentation(input({ events, taskStatus: 'running' }));
    const replay = buildTaskPresentation(
      input({ events: [...[...events].reverse(), events[1]!], taskStatus: 'running' })
    );
    expect(replay).toEqual(expected);
    expect(expected.progress.current).toMatchObject({ eventId: 'event-5' });
    expect(expected.progress.metrics).toEqual([
      { key: 'files', label: 'Files changed', value: 1 },
      { key: 'commands', label: 'Commands run', value: 1 }
    ]);
    expect(expected.progress.milestones).toHaveLength(2);
    expect(expected.progress.milestones[1]).toMatchObject({
      kind: 'check',
      status: 'failed',
      detail: 'node --test'
    });
    expect(JSON.stringify(expected)).not.toMatch(/percent|100%/);
  });

  it('does not count rejected or skipped tool operations as work', () => {
    const events = [
      event(1, 'tool_started', {
        toolCallId: 'write',
        tool: 'file_write',
        arguments: { path: 'app.js' }
      }),
      event(2, 'tool_result', { toolCallId: 'write', result: { skipped: true, reason: 'Denied' } })
    ];
    const result = buildTaskPresentation(input({ events }));
    expect(result.progress.metrics).toEqual([]);
    expect(result.progress.milestones).toEqual([]);
    expect(result.progress.current).toBeNull();
  });

  it('counts source addresses in returned evidence rather than a requested limit', () => {
    const events = [
      event(1, 'tool_started', {
        toolCallId: 'search',
        tool: 'web_search',
        arguments: { limit: 100 }
      }),
      event(2, 'tool_result', {
        toolCallId: 'search',
        result: {
          results: [
            { url: 'https://source.test/a' },
            { url: 'https://source.test/a' },
            { url: 'javascript:bad' }
          ]
        }
      })
    ];
    const result = buildTaskPresentation(input({ events }));
    expect(result.progress.kind).toBe('research');
    expect(result.progress.metrics).toEqual([{ key: 'sources', label: 'Sources found', value: 1 }]);
  });
});

describe('observed source fallback and active progress', () => {
  it('offers a successfully written file when a completion declares no output', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'tool_started', {
            toolCallId: 'write',
            tool: 'file_write',
            arguments: { path: 'report.csv' }
          }),
          event(2, 'tool_result', {
            toolCallId: 'write',
            result: { path: 'report.csv', bytes: 20 }
          }),
          event(3, 'completed', { deliverables: [] })
        ],
        files: new Map([['workspace/report.csv', { status: 'ready' }]])
      })
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      path: 'workspace/report.csv',
      evidenceEventIds: ['event-2'],
      status: 'ready'
    });
  });
  it('does not pretend a failed tool is still working', () => {
    const result = buildTaskPresentation(
      input({
        taskStatus: 'running',
        events: [
          event(1, 'tool_started', {
            toolCallId: 'write',
            tool: 'file_write',
            arguments: { path: 'report.csv' }
          }),
          event(2, 'error', { toolCallId: 'write' }, 'Write failed')
        ]
      })
    );
    expect(result.progress.current).toBeNull();
    expect(result.progress.milestones).toHaveLength(1);
    expect(result.progress.milestones[0]).toMatchObject({ status: 'failed' });
  });
});
