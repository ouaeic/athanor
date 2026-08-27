/**
 * The tables, the pre-registration, and the baseline gate.
 *
 * The decision rules are printed ABOVE the numbers and are fixed before the run, for the reason
 * `evals/arms` gives about itself: a rule chosen after seeing the table is not a rule. They are
 * short enough to read in full every time, and the one that matters most is the last one - a
 * saving in output characters is not a reason to ship a dialect the model has to learn, and this
 * rig cannot measure the learning cost at all.
 */
import { EDIT_FORMAT_SPEC } from '../../apps/worker/src/edit/prompt.js';
import { agentToolsFor } from '../../apps/worker/src/tool-catalogue.js';
import type { ModelTool } from '../../packages/model-gateway/src/protocol.js';
import { behaved, type Measurement, type Row } from './measure.js';

export interface Baseline {
  readonly rows: Record<string, { replace: number; lines: number; behaved: string }>;
  readonly totals: { replace: number; lines: number; tasks: number };
}

/**
 * The entry that would carry the format, if it shipped.
 *
 * One string argument, because the whole patch is one string - which is also the reason a nested
 * description would be wasted here: there is exactly one field and the tool's own description is
 * already about what goes in it.
 */
export const CANDIDATE_ENTRY: ModelTool = {
  name: 'file_edit',
  description: EDIT_FORMAT_SPEC,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['patch'],
    properties: { patch: { type: 'string' } }
  }
};

/** The provider's own serialisation, so JSON escaping of the spec's newlines is counted too. */
const onTheWire = (tools: readonly ModelTool[]): string =>
  JSON.stringify(tools.map((tool) => ({ type: 'function', function: tool })));

/**
 * What the resident block would actually grow by, measured against the real catalogue.
 *
 * Not the spec's length. A description crosses the wire JSON-escaped, and this spec is forty lines
 * of it: every newline is two characters there, not one. Measuring the difference between the
 * catalogue with the entry and without it is the only number that cannot be wrong about that.
 */
export const residentCost = (): number => {
  const shipped = agentToolsFor();
  return (
    Buffer.byteLength(onTheWire([...shipped, CANDIDATE_ENTRY])) -
    Buffer.byteLength(onTheWire(shipped))
  );
};

/**
 * What `file_patch` costs today, because the honest comparison is a replacement and not an addition.
 *
 * Shipping both would be two ways to do one thing, which athanor does not do. If the format ships
 * it ships instead, and the number that matters is the difference.
 */
export const incumbentEntryCost = (): number => {
  const shipped = agentToolsFor();
  const without = shipped.filter((tool) => tool.name !== 'file_patch');
  if (without.length === shipped.length)
    throw new Error('file_patch is no longer on the catalogue; this rig is measuring nothing.');
  return Buffer.byteLength(onTheWire(shipped)) - Buffer.byteLength(onTheWire(without));
};

export const renderQuestions = (): string =>
  [
    '',
    '  THE QUESTION, fixed before the run',
    '',
    '  Does addressing an edit by line number cost fewer output characters than quoting the text,',
    '  FOR THE SAME LANDED EDIT? Not "is it nicer". A cheaper encoding that lands a wrong edit, or',
    '  that has to be retried, is not cheaper.',
    '',
    '  THE DECISION RULES, fixed before the run',
    '',
    '  1. A task counts only where both formats did what the task wanted - landed correctly, or',
    '     refused where refusing was right. A row where one format got it wrong is a correctness',
    '     finding, never a saving.',
    '  2. The headline number is the total over those tasks, not the mean of the per-task ratios.',
    '     A mean of ratios lets one tiny edit with a large percentage swing the answer.',
    '  3. The read-side cost of numbering is reported separately and never netted off in silence.',
    '  4. This rig runs no model. It cannot say whether a model emits the dialect correctly, and',
    '     the study it came from reports that several models miscount anchors badly enough to be',
    '     excluded. Nothing here is evidence about that, and a ruling that ignores it is wrong.',
    ''
  ].join('\n');

const pad = (value: string | number, width: number): string => String(value).padStart(width);

export const renderTable = (measurement: Measurement): string => {
  const out: string[] = [
    '',
    `  file_patch is modelled as: ${measurement.incumbent}`,
    '',
    '  OUTPUT CHARACTERS THE MODEL MUST EMIT, per edit',
    '',
    '  task                      quote  by-line   delta      quote / by-line',
    '  ------------------------------------------------------------------------'
  ];
  for (const row of measurement.rows) {
    const delta = row.replace.chars ? 1 - row.lines.chars / row.replace.chars : 0;
    const flagQuote = behaved(row.replace, row.desired) ? ' ' : '!';
    const flagLines = behaved(row.lines, row.desired) ? ' ' : '!';
    out.push(
      `  ${row.id.padEnd(24)}${pad(row.replace.chars, 6)}${flagQuote}${pad(row.lines.chars, 7)}${flagLines}` +
        `${pad(`${(delta * 100).toFixed(0)}%`, 8)}   ${row.replace.landed ? 'landed' : (row.replace.refusal ?? 'refused')} / ${row.lines.landed ? 'landed' : (row.lines.refusal ?? 'refused')}`
    );
  }

  const counted = measurement.rows.filter(
    (row) => behaved(row.replace, row.desired) && behaved(row.lines, row.desired)
  );
  const quoteTotal = counted.reduce((sum, row) => sum + row.replace.chars, 0);
  const lineTotal = counted.reduce((sum, row) => sum + row.lines.chars, 0);
  out.push(
    '  ------------------------------------------------------------------------',
    `  ${`counted (${counted.length}/${measurement.rows.length} tasks)`.padEnd(24)}${pad(quoteTotal, 6)} ${pad(lineTotal, 7)} ${pad(`${((1 - lineTotal / quoteTotal) * 100).toFixed(0)}%`, 8)}`,
    '',
    '  ! marks a format that did not do what the task wanted; those rows are excluded from the total.',
    ''
  );

  const disagreements = measurement.rows.filter(
    (row) => behaved(row.replace, row.desired) !== behaved(row.lines, row.desired)
  );
  if (disagreements.length) {
    out.push('  WHERE THE TWO FORMATS DISAGREED', '');
    for (const row of disagreements) {
      out.push(
        `  ${row.id}: ${row.what}`,
        `    quote:   ${row.replace.landed ? 'landed' : `refused (${row.replace.refusal ?? '?'})`}`,
        `    by-line: ${row.lines.landed ? 'landed' : `refused (${row.lines.refusal ?? '?'})`}`,
        ...(row.note ? [`    ${row.note}`] : []),
        ''
      );
    }
  }

  return out.join('\n');
};

export const renderReadSide = (measurement: Measurement): string => {
  const seen = new Map<string, Row>();
  for (const row of measurement.rows)
    if (!seen.has(`${row.read.plain}`)) seen.set(`${row.read.plain}`, row);
  const rows = [...seen.values()];
  const plain = rows.reduce((sum, row) => sum + row.read.plain, 0);
  const numbered = rows.reduce((sum, row) => sum + row.read.numbered, 0);
  return [
    '',
    '  THE READ SIDE, which is input and is paid whether or not an edit follows',
    '',
    ...rows.map(
      (row) =>
        `  ${row.id.padEnd(24)}${pad(row.read.plain, 7)} plain  ${pad(row.read.numbered, 7)} numbered  ${pad(`+${(((row.read.numbered - row.read.plain) / row.read.plain) * 100).toFixed(1)}%`, 8)}`
    ),
    `  ${'the distinct reads'.padEnd(24)}${pad(plain, 7)} plain  ${pad(numbered, 7)} numbered  ${pad(`+${(((numbered - plain) / plain) * 100).toFixed(1)}%`, 8)}`,
    '',
    `  Numbering also forces the runner's bounded line reader to walk to the end of the file to`,
    '  compute a whole-file tag, where today it stops as soon as the window is full.',
    ''
  ].join('\n');
};

export const renderResidency = (measurement: Measurement): string => {
  const counted = measurement.rows.filter(
    (row) => behaved(row.replace, row.desired) && behaved(row.lines, row.desired)
  );
  const saved =
    counted.reduce((sum, row) => sum + row.replace.chars - row.lines.chars, 0) / counted.length;
  return [
    '',
    '  WHAT SHIPPING IT WOULD COST, and what it would take back',
    '',
    `  model-facing spec, as written    ${pad(Buffer.byteLength(EDIT_FORMAT_SPEC), 7)} bytes`,
    `  the same spec, JSON-escaped on the wire, with the name and the schema around it:`,
    `  resident, on every request       ${pad(residentCost(), 7)} bytes`,
    `  the file_patch entry it replaces ${pad(-incumbentEntryCost(), 7)} bytes`,
    `  net on the catalogue             ${pad(residentCost() - incumbentEntryCost(), 7)} bytes`,
    '',
    `  saved per landed edit            ${pad(Math.round(saved), 7)} characters (mean over the counted tasks)`,
    '',
    `  Resident bytes are input and are the same on every request. Saved characters are output and`,
    '  are per edit. They are not the same currency and this rig does not convert them: what the',
    '  conversion is depends on the provider, on whether the prefix is cached, and on how many edits',
    '  a turn contains. The ruling is where that gets weighed.',
    ''
  ].join('\n');
};

export const baselineFrom = (measurement: Measurement): Baseline => {
  const rows: Baseline['rows'] = {};
  for (const row of measurement.rows)
    rows[row.id] = {
      replace: row.replace.chars,
      lines: row.lines.chars,
      behaved: `${behaved(row.replace, row.desired) ? 'q' : '-'}${behaved(row.lines, row.desired) ? 'l' : '-'}`
    };
  const counted = measurement.rows.filter(
    (row) => behaved(row.replace, row.desired) && behaved(row.lines, row.desired)
  );
  return {
    rows,
    totals: {
      replace: counted.reduce((sum, row) => sum + row.replace.chars, 0),
      lines: counted.reduce((sum, row) => sum + row.lines.chars, 0),
      tasks: counted.length
    }
  };
};

/** Every difference from the committed baseline, so `--ci` fails loudly and specifically. */
export const check = (measurement: Measurement, baseline: Baseline): string[] => {
  const now = baselineFrom(measurement);
  const problems: string[] = [];
  for (const [id, was] of Object.entries(baseline.rows)) {
    const is = now.rows[id];
    if (!is) {
      problems.push(`${id}: in the baseline and gone from the corpus`);
      continue;
    }
    if (is.replace !== was.replace)
      problems.push(`${id}: quote encoding ${was.replace} -> ${is.replace} characters`);
    if (is.lines !== was.lines)
      problems.push(`${id}: by-line encoding ${was.lines} -> ${is.lines} characters`);
    if (is.behaved !== was.behaved) problems.push(`${id}: outcome ${was.behaved} -> ${is.behaved}`);
  }
  for (const id of Object.keys(now.rows))
    if (!baseline.rows[id]) problems.push(`${id}: new task, not in the baseline`);
  return problems;
};
