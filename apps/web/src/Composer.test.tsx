/**
 * The message box, rendered.
 *
 * It is the control every session starts in, and its worst failures have all been failures of
 * state rather than of wording: a box that goes dead while the agent is working, a Stop that turns
 * back into Send the moment you type a correction, a model picker offering a model that cannot
 * answer. `renderToStaticMarkup` costs no dependency and no DOM, and none of those need one — they
 * are all visible in the markup of the first paint.
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

  it('goes inert only when there is no computer to send to, and says which it is', () => {
    const markup = render({ workspaceAvailable: false });
    expect(markup).toMatch(/<textarea[^>]*disabled/);
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

  it('leaves the folder import out entirely unless the client can do it', () => {
    expect(render()).not.toContain('Import a local folder');
    expect(render({ onImportFolder: () => undefined })).toContain('Import a local folder');
  });

  it('says what the recording control will do next rather than what it is', () => {
    expect(render({ recording: false })).toContain('aria-label="Record a voice note"');
    expect(render({ recording: true })).toContain('aria-label="Stop voice recording"');
  });
});

describe('choosing what answers', () => {
  it('offers the way in when no provider is connected, and no model picker', () => {
    const markup = render({ providerConfigured: false });
    expect(markup).toContain('Connect AI');
    expect(markup).not.toContain('aria-label="Model"');
  });

  it('selects the automatic ranking without pinning a model named after it', () => {
    const markup = render({}, { automatic: true, preference: 'best' });
    expect(markup).toContain('value="auto:best" selected');
  });

  it('selects a pinned model by its own identifier', () => {
    const markup = render({}, { automatic: false, modelId: 'openrouter/z-ai/glm-5.2' });
    expect(markup).toContain('value="openrouter/z-ai/glm-5.2" selected');
  });

  /* An option that cannot answer is shown disabled with the reason, not silently dropped. */
  it('says why a model is unavailable, in the terms this box is configured with', () => {
    const priv = render({
      enforceZeroDataRetention: true,
      unavailableModels: [model('openrouter/other/model-x', { availability: 'unavailable' })]
    });
    expect(priv).toContain('no verified private route');
    expect(priv).toContain('private route unavailable');

    const open = render({
      enforceZeroDataRetention: false,
      unavailableModels: [model('openrouter/other/model-x', { availability: 'unavailable' })]
    });
    expect(open).toContain('Currently unavailable');
    expect(open).toContain('provider unavailable');
  });

  it('names a licence review as a licence review either way', () => {
    expect(
      render({ unavailableModels: [model('openrouter/other/model-y', { availability: 'review' })] })
    ).toContain('licence review required');
  });

  it('refuses the automatic options when the provider is offering nothing', () => {
    const markup = render({ models: [] });
    expect(markup).toContain('No model available');
    expect(markup).toMatch(/value="auto:fast"[^>]*disabled/);
  });

  /* The one fact in the footer that changes between installs, and the control that changes it. */
  it('states where inference goes, and states the other answer honestly', () => {
    expect(render({ enforceZeroDataRetention: true })).toContain('Private AI routes only');
    expect(render({ enforceZeroDataRetention: false })).toContain('Provider data policy applies');
  });

  /*
   * A search query leaving the box is the second half of the same fact, and it belongs on the same
   * control rather than beside it — one line, one place to change both.
   */
  it('says on the same control when a search would leave this computer', () => {
    const markup = render({
      enforceZeroDataRetention: false,
      webSearchNote: 'Web searches go to your provider',
      webSearchDisclosure: "Web searches are answered by your model provider's search service."
    });
    expect(markup).toContain('Provider data policy applies · Web searches go to your provider');
    expect(markup).toContain('search service');
    expect(markup.split('composer-privacy')).toHaveLength(2);
  });

  it('adds nothing to the footer when searches run here, which is the default', () => {
    const markup = render({ enforceZeroDataRetention: true });
    expect(markup).toContain('Private AI routes only');
    expect(markup).not.toContain('Web searches');
  });
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
