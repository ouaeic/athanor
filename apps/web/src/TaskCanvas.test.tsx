import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskPresentation } from '@athanor/contracts';
import { TaskOutputs, TaskProgress } from './TaskCanvas';
import WorkTrace from './WorkTrace';

const presentation: TaskPresentation = {
  version: 1,
  taskId: 'recorded-task',
  eventCursor: 4,
  results: [
    {
      id: 'preview-1',
      kind: 'preview',
      title: 'Maze game',
      status: 'ready',
      url: null,
      downloadUrl: null,
      accessPath: '/v1/previews/owned/access',
      evidenceEventIds: ['published']
    },
    {
      id: 'file-1',
      kind: 'file',
      title: 'index.html',
      status: 'ready',
      url: null,
      downloadUrl: '/v1/workspaces/owned/file?path=workspace%2Fmaze%2Findex.html',
      accessPath: null,
      evidenceEventIds: ['written']
    }
  ],
  progress: {
    kind: 'build',
    phases: [
      { id: 'build', title: 'Build the game', status: 'completed' },
      { id: 'check', title: 'Verify play', status: 'in_progress' }
    ],
    current: {
      title: 'Checking keyboard input',
      eventId: 'check',
      startedAt: '2026-09-06T00:00:00Z'
    },
    metrics: [{ key: 'files', label: 'Files changed', value: 1 }],
    milestones: [],
    updatedAt: null
  }
};

describe('usable task delivery and recorded progress', () => {
  it('serves the scoped archive address and distinguishes a manifest that has not been counted', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          sourceBundle: {
            downloadUrl: '/v1/tasks/recorded-task/bundle',
            scope: 'declared_directories',
            directories: ['workspace/maze'],
            fileCount: null
          }
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('href="/v1/tasks/recorded-task/bundle"');
    expect(html).toContain('Project files');
    expect(html).not.toContain('0 recorded output files');
  });
  it('makes the latest recorded action legible in the work trace without inventing work', () => {
    const milestones = ['Edited maze.ts', 'Checked keyboard controls'].map((title, index) => ({
      id: `event-${index}`,
      sequence: index + 1,
      kind: index ? ('check' as const) : ('change' as const),
      title,
      status: 'passed' as const,
      createdAt: '2026-09-06T00:00:00Z'
    }));
    const html = renderToStaticMarkup(
      <WorkTrace progress={{ ...presentation.progress, milestones }} onEvidence={() => undefined} />
    );
    expect(html).toContain('Checked keyboard controls</strong>');
    expect(html).toContain('latest 2 actions');
    expect(html).toContain('Inspect');
    expect(
      renderToStaticMarkup(
        <WorkTrace progress={presentation.progress} onEvidence={() => undefined} />
      )
    ).toBe('');
  });
  it('puts browser and source actions on the result, while the private iframe awaits its owner grant', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs presentation={presentation} onArtifact={() => undefined} />
    );
    expect(html).toContain('Open app');
    expect(html).toContain('download="index.html"');
    expect(html).toContain('workspace%2Fmaze%2Findex.html');
    expect(html).not.toContain('garden-result-map');
    expect(html).toContain('Opening the live app');
  });
  it('does not offer opening an unavailable preview or downloading an unavailable file', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          results: presentation.results.map((item) => ({ ...item, status: 'unavailable' }))
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).not.toContain('Open app');
    expect(html).not.toContain('download=');
  });
  it('keeps a source download accessible when its availability probe is pending', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          results: presentation.results.map((item) => ({ ...item, status: 'unknown' }))
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('download="index.html"');
    expect(html).not.toContain('Open app');
  });
  it('exposes all previews rather than silently dropping later outputs', () => {
    const second = { ...presentation.results[0]!, id: 'preview-2', title: 'Second deliverable' };
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{ ...presentation, results: [...presentation.results, second] }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('Task previews');
    expect(html).toContain('Second deliverable');
  });
  it('labels the plan denominator and current tool observation, without inventing objective completion', () => {
    const html = renderToStaticMarkup(
      <TaskProgress
        presentation={presentation}
        onEvidence={() => undefined}
        onPlan={() => undefined}
      />
    );
    expect(html).toContain('Plan: 1 of 2 steps completed');
    expect(html).toContain('Checking keyboard input');
    expect(html).not.toContain('garden-metrics');
    expect(html).not.toContain('50% complete');
  });
});
