import { data, text } from './model';

/** Only acceptance_check is written by the execution harness rather than proposed by the model. */
export function completionChecks(verification: unknown) {
  const record = data(verification);
  const evidence = (Array.isArray(record.evidence) ? record.evidence : [])
    .map(data)
    .filter((item) => text(item.claim).trim());
  const checks = evidence.filter((item) => item.source === 'acceptance_check');
  return {
    evidence,
    checks,
    label: checks.length
      ? `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`
      : evidence.length
        ? 'Evidence recorded'
        : 'Completion recorded'
  };
}

export function evidenceSource(source: unknown): string {
  switch (source) {
    case 'acceptance_check':
      return 'Executed check';
    case 'tool_result':
      return 'Cited tool result';
    case 'published_artifact':
      return 'Published file';
    case 'user_visible_result':
      return 'Visible result';
    default:
      return 'Recorded evidence';
  }
}
