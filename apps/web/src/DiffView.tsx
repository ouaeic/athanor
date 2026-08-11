import { useMemo, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { buildFileDiff, diffStat, type FileDiff as FileDiffModel } from './diff.js';

function DiffBody({ diff }: { diff: FileDiffModel }) {
  if (diff.unchanged) return <p className="diff-empty">This edit leaves the file unchanged.</p>;
  return (
    <div className="diff-body">
      {diff.coarse && (
        <p className="diff-empty">
          The change is too large to align line by line, so it is shown as a full rewrite.
        </p>
      )}
      {diff.hunks.map((hunk) => (
        <table className="diff-hunk" key={hunk.header}>
          <tbody>
            <tr className="diff-hunk-header">
              <td colSpan={3}>{hunk.header}</td>
            </tr>
            {hunk.lines.map((line, index) => (
              <tr className={`diff-line ${line.kind}`} key={`${hunk.header}-${index}`}>
                <td className="diff-gutter">{line.before ?? ''}</td>
                <td className="diff-gutter">{line.after ?? ''}</td>
                <td className="diff-text">
                  <span aria-hidden="true" className="diff-sign">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                  </span>
                  {/* The glyph is hidden from assistive technology because it reads as punctuation,
                      which left added and removed lines sounding identical - the one distinction a
                      diff exists to make. Said in words instead, for that reader only. */}
                  {line.kind !== 'context' && (
                    <span className="sr-only">{line.kind === 'add' ? 'added ' : 'removed '}</span>
                  )}
                  {line.text || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

/**
 * The exact change, rendered from the same arguments the approval is bound to. An approval whose
 * only description is a sentence is an approval granted on trust rather than on evidence.
 */
export function DiffView({
  path,
  before,
  after,
  defaultOpen = true
}: {
  path: string;
  before: string | undefined;
  after: string;
  defaultOpen?: boolean;
}) {
  const diff = useMemo(() => buildFileDiff(path, before, after), [path, before, after]);
  /*
   * The rows are built when the disclosure is opened, not when it is drawn closed.
   *
   * `<details>` hides its children, it does not stop them being rendered, and this component is now
   * reached from every file write in a work log rather than from one approval card at a time. A
   * turn that created three 500-line files put fifteen hundred table rows into the document the
   * instant the log was expanded, all of them behind a triangle nobody had clicked. The summary
   * line still needs the diff itself, which is cheap — the alignment is trimmed and capped in
   * `diffLines` — so only the body waits.
   */
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="file-diff"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <FileDiff />
        <span className="file-diff-path">{path}</span>
        <span className="file-diff-stat">
          {diff.created ? 'new file · ' : ''}
          {diffStat(diff)}
        </span>
      </summary>
      {open && <DiffBody diff={diff} />}
    </details>
  );
}
