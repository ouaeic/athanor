import { useState } from 'react';
import { Button, Field } from '../ui.js';
import { ResourceState, Section, useResource } from '../management.js';
import { date } from '../model.js';

interface ToolUsage {
  window: { start: string; end: string; days: number };
  tasksScanned: number;
  windowTruncated: boolean;
  truncatedTasks: string[];
  unreadableCalls: number;
  turns: number;
  minimumTurns: number;
  decidable: boolean;
  unseenToolUpper95: number;
  tools: Array<{ tool: string; turns: number; shareOfTurns: number; upper95: number }>;
}

export function ToolUsageSettings() {
  const [days, setDays] = useState('7');
  const [requested, setRequested] = useState<string | null>(null);
  const report = useResource<ToolUsage>(
    requested ? `/v1/usage/tool-opens?days=${requested}` : null
  );
  return (
    <Section
      title="Tool activity"
      description="See which tools your work used across recent turns."
    >
      <div className="row">
        <Field label="Look back">
          <select value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="7">A week</option>
            <option value="30">A month</option>
            <option value="90">Three months</option>
          </select>
        </Field>
        <Button
          busy={report.loading}
          onClick={() => {
            if (requested === days) report.refresh();
            else setRequested(days);
          }}
        >
          Load activity
        </Button>
      </div>
      <ResourceState resource={report} />
      {report.value && (
        <div className="stack management-filter">
          <p>
            {report.value.turns.toLocaleString()} turns across{' '}
            {report.value.tasksScanned.toLocaleString()} work items ·{' '}
            {date(report.value.window.start)} to {date(report.value.window.end)}
          </p>
          {(report.value.windowTruncated ||
            report.value.truncatedTasks.length > 0 ||
            report.value.unreadableCalls > 0) && (
            <p className="management-note">
              This report is partial.{' '}
              {report.value.windowTruncated && 'The oldest work was outside the scan limit. '}
              {report.value.truncatedTasks.length > 0 &&
                `${report.value.truncatedTasks.length} work items reached the event limit. `}
              {report.value.unreadableCalls > 0 &&
                `${report.value.unreadableCalls} tool calls could not be read.`}
            </p>
          )}
          {!report.value.decidable ? (
            <p className="muted">
              There is not enough activity to estimate tool usage reliably. The report needs{' '}
              {report.value.minimumTurns} turns.
            </p>
          ) : (
            <div className="management-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Turns used</th>
                    <th>Share of turns</th>
                    <th>Upper estimate · 95%</th>
                  </tr>
                </thead>
                <tbody>
                  {report.value.tools.map((tool) => (
                    <tr key={tool.tool}>
                      <td>{tool.tool.replaceAll('_', ' ')}</td>
                      <td>{tool.turns.toLocaleString()}</td>
                      <td>{(tool.shareOfTurns * 100).toFixed(1)}%</td>
                      <td>{(tool.upper95 * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">
                Tools absent from this list were not observed. Their upper estimate is{' '}
                {(report.value.unseenToolUpper95 * 100).toFixed(1)}% of turns.
              </p>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
