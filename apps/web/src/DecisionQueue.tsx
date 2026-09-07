import { useId, useState } from 'react';
import { ShieldCheck, ArrowUpRight } from 'lucide-react';
import type { Task } from '@athanor/contracts';
import type { Decision } from './model';
import { data, text, date } from './model';
import { post, ApiError } from './client';
import { stepUp } from './auth';
import { Button, ErrorNotice } from './ui';
import { APPROVAL_NOTE_MAX_CHARS, approvalToolPhrases } from './approval-copy';
export function DecisionCard({
  decision,
  onResolved,
  taskTitle,
  onOpenTask,
  onComputer
}: {
  decision: Decision;
  onResolved: () => void;
  taskTitle?: string;
  onOpenTask?: (id: string) => void;
  onComputer?: (tool: 'browser' | 'desktop') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const noteHintId = useId();
  const preview = data(decision.preview);
  const args = data(preview.arguments ?? preview.args ?? preview.input);
  const tool = text(preview.tool, text(preview.toolName, text(preview.name)));
  const command = text(preview.command, text(args.command));
  const description = text(
    preview.reason,
    text(
      preview.description,
      text(preview.explanation, text(preview.summary, text(preview.preview)))
    )
  );
  const privateInput =
    ['secure_input', 'type_secure'].includes(text(args.action)) ||
    decision.action === 'secure_input_handoff' ||
    /^Secure (browser|desktop) input required$/.test(decision.action);
  const [inputFinished, setInputFinished] = useState(false);
  const expired = Date.parse(decision.expiresAt) <= Date.now();
  async function resolve(action: 'approve' | 'deny') {
    const body = action === 'deny' && note.trim() ? { note: note.trim() } : {};
    setBusy(true);
    setError(null);
    try {
      try {
        await post(`/v1/approvals/${decision.id}/${action}`, body);
      } catch (err) {
        if (
          !(err instanceof ApiError) ||
          !['step_up_required', 'recent_authentication_required'].includes(err.code)
        )
          throw err;
        await stepUp();
        await post(`/v1/approvals/${decision.id}/${action}`, body);
      }
      onResolved();
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === 'approval_unavailable') onResolved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="decision-card">
      <div className="eyebrow">
        <ShieldCheck size={14} aria-hidden="true" />
        Your approval
      </div>
      {taskTitle && onOpenTask && (
        <button className="text-button" onClick={() => onOpenTask(decision.taskId)}>
          {taskTitle}
          <ArrowUpRight size={14} />
        </button>
      )}
      <h3>{approvalToolPhrases[tool] ?? decision.action}</h3>
      {description && <p>{description}</p>}
      <dl className="facts">
        <div>
          <dt>Action</dt>
          <dd>{decision.action}</dd>
        </div>
        {decision.origin && (
          <div>
            <dt>Destination</dt>
            <dd>{decision.origin}</dd>
          </div>
        )}
        <div>
          <dt>Reach</dt>
          <dd>{decision.sideEffect.replaceAll('_', ' ')}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{date(decision.expiresAt)}</dd>
        </div>
      </dl>
      {command && (
        <pre className="command-preview">
          <code>{command}</code>
        </pre>
      )}
      <details>
        <summary>Inspect full action</summary>
        <pre>
          {typeof decision.preview === 'string'
            ? decision.preview
            : JSON.stringify(decision.preview, null, 2)}
        </pre>
      </details>
      {privateInput && (
        <div className="stack">
          <p>
            Open the computer, take control, and use Private input to enter the value. End private
            input before continuing.
          </p>
          {onComputer && (
            <Button onClick={() => onComputer(tool === 'desktop_action' ? 'desktop' : 'browser')}>
              Open private input
            </Button>
          )}
          {!onComputer && onOpenTask && (
            <Button onClick={() => onOpenTask(decision.taskId)}>
              Open work to enter privately
            </Button>
          )}
          <label className="row">
            <input
              type="checkbox"
              checked={inputFinished}
              onChange={(event) => setInputFinished(event.target.checked)}
            />
            I have finished entering the value privately.
          </label>
        </div>
      )}
      <details className="decision-note">
        <summary>Add a reason for denying</summary>
        <label className="field">
          <span>Reason for denying (optional)</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={APPROVAL_NOTE_MAX_CHARS}
            rows={3}
            disabled={busy || expired}
            aria-describedby={noteHintId}
            placeholder="Explain what should change before the agent continues."
          />
        </label>
        <small id={noteHintId}>
          Sent only if you deny. Uses this task’s existing allowance. {note.length}/
          {APPROVAL_NOTE_MAX_CHARS}
        </small>
      </details>
      <ErrorNotice error={error} />
      <div className="row decision-actions">
        <Button
          className="primary"
          busy={busy}
          disabled={expired || (privateInput && !inputFinished)}
          onClick={() => resolve('approve')}
        >
          {expired ? 'Expired' : privateInput ? 'Continue after private input' : 'Approve once'}
        </Button>
        <Button disabled={busy || expired} onClick={() => resolve('deny')}>
          Deny
        </Button>
      </div>
      <small>This approval applies to the action shown here.</small>
    </article>
  );
}
export default function DecisionQueue({
  decisions,
  tasks,
  onResolved,
  onOpenTask
}: {
  decisions: Decision[];
  tasks: Task[];
  onResolved: () => void;
  onOpenTask: (id: string) => void;
}) {
  return (
    <section className="decision-grid">
      {decisions.map((decision) => (
        <DecisionCard
          key={decision.id}
          decision={decision}
          taskTitle={tasks.find((task) => task.id === decision.taskId)?.title ?? 'Open work'}
          onResolved={onResolved}
          onOpenTask={onOpenTask}
        />
      ))}
    </section>
  );
}
