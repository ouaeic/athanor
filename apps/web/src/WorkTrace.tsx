import type { TaskMilestone, TaskPresentation } from '@athanor/contracts';
import { useState } from 'react';
import { Button } from './ui';

const labels: Record<TaskMilestone['kind'], string> = {
  change: 'Files',
  source: 'Sources',
  check: 'Checks',
  result: 'Results',
  approval: 'Decisions',
  process: 'Processes',
  checkpoint: 'Recovery'
};

/** The trace plots recorded order and action kinds, never an estimate of objective completion. */
export default function WorkTrace({
  progress,
  onEvidence
}: {
  progress: TaskPresentation['progress'];
  onEvidence: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const milestones = progress.milestones.slice(-6);
  const selected = milestones.find((item) => item.id === selectedId) ?? milestones.at(-1);
  const kinds = [...new Set(milestones.map((item) => item.kind))];
  if (milestones.length < 2) return null;
  const points = milestones.map((item, index) => ({
    x: ((index + 0.5) / milestones.length) * 1000,
    y: ((kinds.indexOf(item.kind) + 0.5) / kinds.length) * 180
  }));
  const path = points
    .map((point, index) => {
      const prior = points[index - 1];
      if (!prior) return `M ${point.x},${point.y}`;
      const middle = (prior.x + point.x) / 2;
      return `C ${middle},${prior.y} ${middle},${point.y} ${point.x},${point.y}`;
    })
    .join(' ');
  return (
    <figure className="garden-work-trace">
      <figcaption>
        <span className="eyebrow">
          {progress.kind === 'research'
            ? 'Following the evidence'
            : progress.kind === 'analysis'
              ? 'Inside the analysis'
              : progress.kind === 'build'
                ? 'From idea to working result'
                : 'Your work taking shape'}
        </span>
        <small>Recorded order · latest {milestones.length} actions</small>
      </figcaption>
      <div
        className="garden-trace-grid"
        style={{
          gridTemplateColumns: `65px repeat(${milestones.length}, minmax(30px, 1fr))`,
          gridTemplateRows: `repeat(${kinds.length}, 44px)`
        }}
      >
        {kinds.map((kind, index) => (
          <span
            key={kind}
            className="garden-trace-label"
            style={{ gridColumn: 1, gridRow: index + 1 }}
          >
            {labels[kind]}
          </span>
        ))}
        <svg
          className="garden-trace-line"
          viewBox="0 0 1000 180"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ gridColumn: '2 / -1', gridRow: '1 / -1' }}
        >
          <path d={path} />
        </svg>
        {milestones.map((item, index) => (
          <button
            key={item.id}
            className={`garden-trace-point ${item.status}`}
            style={{ gridColumn: index + 2, gridRow: kinds.indexOf(item.kind) + 1 }}
            onClick={() => setSelectedId(item.id)}
            aria-pressed={selected?.id === item.id}
            aria-label={`${labels[item.kind]}: ${item.title}`}
            title={item.title}
          >
            <span />
            <small>{index + 1}</small>
          </button>
        ))}
      </div>
      {selected && (
        <div className="garden-trace-detail">
          <div>
            <small>
              {labels[selected.kind]} · {selected.status}
            </small>
            <strong>{selected.title}</strong>
            {selected.detail && <p>{selected.detail}</p>}
          </div>
          <Button onClick={() => onEvidence(selected.id)}>Inspect</Button>
        </div>
      )}
    </figure>
  );
}
