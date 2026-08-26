/**
 * The message box, rendered.
 *
 * It is the control every session starts in, and its worst failures have all been failures of
 * state rather than of wording: a box that goes dead while the agent is working, a Stop that turns
 * back into Send the moment you type a correction, a row that grows a third line under the owner's
 * thumb. `renderToStaticMarkup` costs no dependency and no DOM, and none of those need one — they
 * are all visible in the markup of the first paint.
 *
 * What is one tap behind the `+` or the context chip is not in this markup, because a closed
 * portal renders nothing. Those lists are decided by `composerMenuItems`, `modelSheetGroups` and
 * `privacyLine` and are exercised in composer-state.test.ts instead.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from './Composer.js';
import type { ModelChoice } from './composer-state.js';
import type { ModelRelease } from './types.js';

const model = (id: string, patch: Partial<ModelRelease> = {}): ModelRelease =>
  ({
    id,
    displayName: id.split('/').pop(),
    availability: 'available',
    ...patch
  }) as ModelRelease;

const render = (
  patch: Partial<Parameters<typeof Composer>[0]> = {},
  choice: ModelChoice = { automatic: true, preference: 'balanced' }
): string =>
  renderToStaticMarkup(
    <Composer
      prompt=""
      onPrompt={() => undefined}
      attachments={[]}
      onRemoveAttachment={() => undefined}
      onUploadFiles={() => undefined}
      workspaceAvailable
      taskOpen={false}
      taskLive={false}
      busy={false}
      canSend={false}
      onSend={() => undefined}
      onStop={() => undefined}
      recording={false}
      onToggleRecording={() => undefined}
      onSchedule={() => undefined}
      securityMode="balanced"
      onSecurityMode={() => undefined}
      providerConfigured
      enforceZeroDataRetention
      onOpenAiSettings={() => undefined}
      models={[model('openrouter/z-ai/glm-5.2')]}
      unavailableModels={[]}
      modelChoice={choice}
      onModelChoice={() => undefined}
      capUsd=""
      onCapUsd={() => undefined}
      {...patch}
    />
  );

describe('the box every session starts in', () => {
  /*
   * The one rule the composer has never been allowed to break: a reply in flight must not take the
   * keyboard away. Disabling this box was what made a slow answer feel like a frozen application.
   */
  it('stays typeable while the agent is working', () => {
    const markup = render({ taskLive: true, busy: true });
    expect(markup).toContain('<textarea');
    expect(markup).not.toMatch(/<textarea[^>]*disabled/);
    expect(markup).toContain('Add a follow-up');
  });

  /*
   * And typeable while the computer is still coming up, which is the state a new owner arrives in.
   *
   * This box used to be disabled whenever the workspace was missing — so the first screen of the
   * product could not be typed into, and the block that explains that state is only drawn once
   * there is something to send, which meant it could never be drawn from the state it was written
   * for. Waiting is a fine thing to ask of somebody; being stuck is not.
   */
  it('stays typeable while there is no computer yet, and says so', () => {
    const markup = render({ workspaceAvailable: false });
    expect(markup).not.toMatch(/<textarea[^>]*disabled/);
    expect(markup).toContain('The agent computer is unavailable');
  });

  /*
   * Stop and Send are two controls, not one control in two moods: Stop used to appear only while
   * the composer was empty, so typing a correction silently took it away.
   */
  it('offers Stop and Send at the same time while a turn is running', () => {
    const markup = render({ taskLive: true, canSend: true });
    expect(markup).toContain('aria-label="Stop the agent"');
    expect(markup).toContain('aria-label="Queue follow-up"');
  });

  it('offers no Stop when nothing is running, and calls the send a send', () => {
    const markup = render({ canSend: true });
    expect(markup).not.toContain('aria-label="Stop the agent"');
    expect(markup).toContain('aria-label="Send message"');
  });

  it('holds the send inert until there is something to send', () => {
    expect(render({ canSend: false })).toMatch(/aria-label="Send message"[^>]*disabled/);
    expect(render({ canSend: true })).not.toMatch(/aria-label="Send message"[^>]*disabled/);
  });

  it('says what the recording control will do next rather than what it is', () => {
    expect(render({ recording: false })).toContain('aria-label="Record a voice note"');
    expect(render({ recording: true })).toContain('aria-label="Stop voice recording"');
  });
});

describe('two rows at every width', () => {
  /*
   * The budget, stated as a test so it cannot drift back. At 375x812 this row was 176px at rest
   * and 291px with the box full — six icon buttons, two full-width selects that wrapped onto a
   * second and sometimes a third line, and a permanent disclaimer. Nothing here may be permanent
   * that is not used every turn.
   */
  it('puts no picker and no disclaimer on the row itself', () => {
    const markup = render();
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('composer-foot');
    expect(markup.split('composer-row')).toHaveLength(2);
  });

  it('carries one opener for everything that is not typing, voice or sending', () => {
    const markup = render();
    expect(markup).toContain('aria-haspopup="menu"');
    // Attach, photo and schedule are behind it, so none of them is on the row.
    expect(markup).not.toContain('aria-label="Attach files"');
    expect(markup).not.toContain('aria-label="Schedule this work"');
    // Voice is not: it is the one input a phone is better at than a laptop.
    expect(markup).toContain('aria-label="Record a voice note"');
  });

  it('keeps the send cluster beside the tools rather than under them', () => {
    const markup = render({ taskLive: true, canSend: true });
    for (const label of ['Stop the agent', 'Correct the running task now', 'Queue follow-up'])
      expect(markup).toContain(`aria-label="${label}"`);
  });
});

describe('the chip that says how this turn is answered', () => {
  it('says the mode alone while athanor is choosing the model each turn', () => {
    const markup = render({ securityMode: 'review' }, { automatic: true, preference: 'best' });
    expect(markup).toContain('Ask first');
    expect(markup).not.toContain('glm-5.2');
  });

  it('names the model once the owner has pinned one', () => {
    const markup = render({}, { automatic: false, modelId: 'openrouter/z-ai/glm-5.2' });
    expect(markup).toContain('Balanced · glm-5.2');
  });

  it('names the way in when there is no provider, and marks it as the owner move', () => {
    const markup = render({ providerConfigured: false });
    expect(markup).toContain('Connect AI');
    expect(markup).toContain('needs-provider');
  });

  it('opens a sheet rather than a menu, and nothing is open on first paint', () => {
    const markup = render();
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Private AI routes only');
  });
});

describe('choosing what answers', () => {
  it('offers correcting a running task as its own control, not a mood of Send', () => {
    // Queueing and correcting are different intentions. A single Send that decided between them
    // from the fact that the agent happened to be busy would be wrong half the time, in whichever
    // direction it guessed - the same argument that made Stop its own button rather than a state
    // of Send.
    const live = render({ taskLive: true, canSend: true, prompt: 'use Postgres instead' });
    expect(live).toContain('aria-label="Correct the running task now"');
    expect(live).toContain('aria-label="Queue follow-up"');
    expect(live).toContain('aria-label="Stop the agent"');

    // And none of it appears when there is nothing running to steer.
    const idle = render({ taskLive: false, canSend: true, prompt: 'start something' });
    expect(idle).not.toContain('Correct the running task now');
    expect(idle).toContain('aria-label="Send message"');
  });
});
