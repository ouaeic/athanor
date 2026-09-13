import { describe, expect, it } from 'vitest';
import { completionChecks } from './completion-checks';

describe('completion evidence coverage', () => {
  it('does not turn a model verification status or cited result into an executed check', () => {
    expect(completionChecks({ status: 'verified' }).label).toBe('Completion recorded');
    const result = completionChecks({
      status: 'verified',
      evidence: [{ claim: 'The source was inspected', source: 'tool_result', toolCallId: 'read-1' }]
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.checks).toHaveLength(0);
    expect(result.label).toBe('Evidence recorded');
  });

  it('counts only recorded executable check results', () => {
    const result = completionChecks({
      evidence: [
        { claim: 'Source read', source: 'tool_result' },
        { claim: 'python3 verify.py: exit 0', source: 'acceptance_check' },
        { claim: 'report.csv exists', source: 'published_artifact' },
        { claim: '', source: 'acceptance_check' },
        null
      ]
    });
    expect(result.evidence).toHaveLength(3);
    expect(result.checks).toHaveLength(1);
    expect(result.label).toBe('1 check passed');
  });
});
