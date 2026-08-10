import { describe, expect, it } from 'vitest';
import {
  composerContextLabel,
  composerMenuItems,
  composerPlaceholder,
  composerSubmission,
  hasSomethingToSend,
  modelChoiceFromValue,
  modelSelectValue,
  modelSheetGroups,
  privacyLine,
  sendBlock,
  sendsOnKey,
  type SendBlock,
  type SheetModel
} from './composer-state.js';
import type { Attachment } from './attachments.js';

const attachment = (patch: Partial<Attachment> = {}): Attachment => ({
  id: 'a1',
  name: 'notes.pdf',
  sizeBytes: 10,
  mimeType: 'application/pdf',
  path: 'workspace/uploads/a1-notes.pdf',
  status: 'ready',
  progress: 1,
  ...patch
});

const block: SendBlock = {
  code: 'provider_missing',
  message: 'Connect an AI provider to send this.',
  actionLabel: 'Connect a provider'
};

const ready = {
  workspaceAvailable: true,
  providerConfigured: true,
  enforceZeroDataRetention: true,
  availableModelCount: 3,
  modelId: 'openai/gpt-5'
};

describe('sendBlock', () => {
  it('does not block a configured composer', () => {
    expect(sendBlock(ready)).toBeUndefined();
  });

  it('names the provider as the fix on a first run', () => {
    const block = sendBlock({
      ...ready,
      providerConfigured: false,
      availableModelCount: 0,
      modelId: ''
    });
    expect(block?.code).toBe('provider_missing');
    expect(block?.actionLabel).toBe('Connect a provider');
  });

  it('distinguishes a zero-retention wall from an empty catalogue', () => {
    expect(
      sendBlock({ ...ready, availableModelCount: 0, modelId: '', enforceZeroDataRetention: true })
        ?.code
    ).toBe('private_route_unavailable');
    expect(
      sendBlock({ ...ready, availableModelCount: 0, modelId: '', enforceZeroDataRetention: false })
        ?.code
    ).toBe('model_unavailable');
  });

  it('blocks on a missing model even when models exist', () => {
    expect(sendBlock({ ...ready, modelId: '' })?.code).toBe('model_unavailable');
  });

  it('reports the computer before anything downstream of it', () => {
    const block = sendBlock({ ...ready, workspaceAvailable: false, providerConfigured: false });
    expect(block?.code).toBe('workspace_unavailable');
  });

  it('always carries a repair action', () => {
    const blocks = [
      sendBlock({ ...ready, workspaceAvailable: false }),
      sendBlock({ ...ready, providerConfigured: false }),
      sendBlock({ ...ready, availableModelCount: 0, modelId: '' }),
      sendBlock({ ...ready, modelId: '' })
    ];
    for (const block of blocks) {
      expect(block?.actionLabel.length).toBeGreaterThan(0);
      expect(block?.message.length).toBeGreaterThan(0);
    }
  });
});

describe('what a keystroke in the message box does', () => {
  it('sends on Enter and starts a new line on Shift+Enter', () => {
    const key = (patch: Partial<Parameters<typeof sendsOnKey>[0]>) =>
      sendsOnKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, ...patch });
    expect(key({})).toBe(true);
    expect(key({ shiftKey: true })).toBe(false);
  });

  /* ⌘Enter is what people arriving from an editor reach for; holding a modifier must never be the
     thing that swallows a message. */
  it('sends on ⌘Enter and Ctrl+Enter, even with Shift held', () => {
    expect(sendsOnKey({ key: 'Enter', shiftKey: true, metaKey: true, ctrlKey: false })).toBe(true);
    expect(sendsOnKey({ key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: true })).toBe(true);
  });

  it('ignores every other key', () => {
    expect(sendsOnKey({ key: 'a', shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
    expect(sendsOnKey({ key: 'Escape', shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      false
    );
  });
});

describe('what the send button has to work with', () => {
  it('counts a message with nothing but files: "look at this" is often the whole request', () => {
    expect(hasSomethingToSend('', [attachment()])).toBe(true);
    expect(hasSomethingToSend('   ', [])).toBe(false);
    expect(hasSomethingToSend('go', [])).toBe(true);
  });

  it('does not count a file that has not finished uploading', () => {
    expect(hasSomethingToSend('', [attachment({ status: 'uploading', path: '' })])).toBe(false);
    expect(hasSomethingToSend('', [attachment({ status: 'failed' })])).toBe(false);
  });
});

describe('what pressing send actually does', () => {
  const submission = (patch: Partial<Parameters<typeof composerSubmission>[0]> = {}) =>
    composerSubmission({
      prompt: 'Summarise this',
      attachments: [],
      block: undefined,
      busy: false,
      ...patch
    });

  it('attaches the uploaded paths behind the message rather than inside the sentence', () => {
    const result = submission({ attachments: [attachment()] });
    expect(result).toMatchObject({ kind: 'send' });
    if (result.kind !== 'send') return;
    expect(result.text).toBe('Summarise this\n\nAttached files:\n- workspace/uploads/a1-notes.pdf');
    expect(result.attachments).toHaveLength(1);
  });

  it('absorbs the keystroke when there is nothing to send or a send is in flight', () => {
    expect(submission({ prompt: '  ' }).kind).toBe('nothing');
    expect(submission({ busy: true }).kind).toBe('nothing');
  });

  /* An upload in flight clears on its own in seconds; a configuration problem does not. Reporting
     the one that heals itself first keeps the owner from opening Settings for nothing. */
  it('reports an upload still running before anything that needs repairing', () => {
    const result = submission({
      attachments: [attachment({ status: 'uploading', path: '' })],
      block
    });
    expect(result).toMatchObject({ kind: 'wait' });
  });

  it('never silently discards a keystroke that cannot be sent', () => {
    const result = submission({ block });
    expect(result).toMatchObject({ kind: 'blocked', block });
  });

  it('sends the files alone when the box is empty but the tray is not', () => {
    const result = submission({ prompt: '', attachments: [attachment()] });
    expect(result).toMatchObject({ kind: 'send' });
    if (result.kind !== 'send') return;
    expect(result.text).toBe('Attached files:\n- workspace/uploads/a1-notes.pdf');
  });

  it('leaves a failed upload out of the message instead of sending a path with no file', () => {
    const result = submission({
      attachments: [attachment(), attachment({ id: 'a2', status: 'failed', path: 'x' })]
    });
    expect(result).toMatchObject({ kind: 'send' });
    if (result.kind !== 'send') return;
    expect(result.text).not.toContain('x');
    expect(result.attachments).toHaveLength(1);
  });
});

describe('what the empty message box invites', () => {
  it('says the follow-up runs next while the agent is still working', () => {
    expect(
      composerPlaceholder({ workspaceAvailable: true, taskOpen: true, taskLive: true })
    ).toContain('run next');
  });

  it('distinguishes a new conversation from continuing one', () => {
    expect(composerPlaceholder({ workspaceAvailable: true, taskOpen: true, taskLive: false })).toBe(
      'Follow up on this conversation…'
    );
    expect(
      composerPlaceholder({ workspaceAvailable: true, taskOpen: false, taskLive: false })
    ).toBe('Ask athanor to do anything…');
  });

  it('says the computer is unavailable before anything else, because nothing can be sent', () => {
    expect(composerPlaceholder({ workspaceAvailable: false, taskOpen: true, taskLive: true })).toBe(
      'The agent computer is unavailable…'
    );
  });
});

describe('one picker holding two kinds of answer', () => {
  it('round-trips a ranking and a pinned model without confusing them', () => {
    for (const preference of ['fast', 'balanced', 'best'] as const) {
      const value = modelSelectValue({ automatic: true, preference });
      expect(modelChoiceFromValue(value)).toEqual({ automatic: true, preference });
    }
    const pinned = { automatic: false, modelId: 'openrouter/z-ai/glm-5.2' } as const;
    expect(modelChoiceFromValue(modelSelectValue(pinned))).toEqual(pinned);
  });

  /*
   * A mis-parse here is silent and permanent: the conversation is pinned to a model whose name is
   * the encoding, and every later request asks the provider for "auto:best".
   */
  it('never turns an automatic option into a model called after the encoding', () => {
    expect(modelChoiceFromValue('auto:best')).toEqual({ automatic: true, preference: 'best' });
    expect(modelChoiceFromValue('auto:something-else')).toEqual({
      automatic: true,
      preference: 'balanced'
    });
  });

  it('treats a model id that merely contains the word auto as the model it is', () => {
    expect(modelChoiceFromValue('openrouter/vendor/automatic-1')).toEqual({
      automatic: false,
      modelId: 'openrouter/vendor/automatic-1'
    });
  });
});

const catalogueModel = (id: string, availability = 'available'): SheetModel => ({
  id,
  displayName: id.split('/').pop() ?? id,
  availability
});

describe('the one chip that replaced two selects and a footer', () => {
  const chip = (patch: Partial<Parameters<typeof composerContextLabel>[0]> = {}) =>
    composerContextLabel({
      providerConfigured: true,
      securityMode: 'balanced',
      modelChoice: { automatic: true, preference: 'balanced' },
      models: [{ id: 'openrouter/z-ai/glm-5.2', displayName: 'GLM 5.2' }],
      ...patch
    });

  it('names the way in before anything else, because nothing can be answered yet', () => {
    expect(chip({ providerConfigured: false, securityMode: 'autonomous' })).toBe('Connect AI');
  });

  /* Naming a model under automatic routing would be a promise the router does not make: it picks
     per turn, so the chip would be stale the moment it was read. */
  it('says the mode alone while athanor is choosing the model each turn', () => {
    expect(chip()).toBe('Balanced');
    expect(chip({ securityMode: 'review' })).toBe('Ask first');
    expect(chip({ securityMode: 'autonomous' })).toBe('Autonomous');
  });

  it('adds the model only once the owner has pinned one', () => {
    expect(chip({ modelChoice: { automatic: false, modelId: 'openrouter/z-ai/glm-5.2' } })).toBe(
      'Balanced · GLM 5.2'
    );
  });

  /* A pin the catalogue has never heard of still resolves to its tail; only an empty pin leaves
     nothing to say, and "Balanced · " reads as a bug rather than as less information. */
  it('falls back to the tail of an unknown id, and to the mode alone when there is no id', () => {
    expect(chip({ modelChoice: { automatic: false, modelId: 'someone/else/model-q' } })).toBe(
      'Balanced · model-q'
    );
    expect(chip({ modelChoice: { automatic: false, modelId: '' } })).toBe('Balanced');
  });
});

describe('the model list inside the sheet', () => {
  const groups = (patch: Partial<Parameters<typeof modelSheetGroups>[0]> = {}) =>
    modelSheetGroups({
      models: [catalogueModel('openrouter/z-ai/glm-5.2')],
      unavailableModels: [],
      enforceZeroDataRetention: true,
      ...patch
    });

  it('offers the ranking and the specific models as two separate answers', () => {
    const result = groups();
    expect(result.map((group) => group.label)).toEqual(['Automatic', 'Choose a specific model']);
    expect(result[0]?.options.map((option) => option.value)).toEqual([
      'auto:balanced',
      'auto:fast',
      'auto:best'
    ]);
    expect(result[1]?.options[0]).toMatchObject({
      value: 'openrouter/z-ai/glm-5.2',
      disabled: false
    });
  });

  it('refuses the automatic options, and the whole list, when nothing can answer', () => {
    const result = groups({ models: [] });
    expect(result).toHaveLength(1);
    expect(result[0]?.options[0]?.label).toBe('No model available');
    expect(result[0]?.options.every((option) => option.disabled)).toBe(true);
  });

  /* A model that cannot answer is listed disabled with the reason, not silently dropped: dropping
     it is what makes an owner think athanor has lost their model. */
  it('says why a model is unavailable, in the terms this box is configured with', () => {
    const priv = groups({
      unavailableModels: [catalogueModel('openrouter/other/model-x', 'unavailable')],
      enforceZeroDataRetention: true
    });
    expect(priv[2]?.label).toBe('Unavailable · no verified private route');
    expect(priv[2]?.options[0]).toMatchObject({
      note: 'private route unavailable',
      disabled: true
    });

    const open = groups({
      unavailableModels: [catalogueModel('openrouter/other/model-x', 'unavailable')],
      enforceZeroDataRetention: false
    });
    expect(open[2]?.label).toBe('Currently unavailable');
    expect(open[2]?.options[0]?.note).toBe('provider unavailable');
  });

  it('names a licence review as a licence review either way', () => {
    for (const enforceZeroDataRetention of [true, false])
      expect(
        groups({
          unavailableModels: [catalogueModel('openrouter/other/model-y', 'review')],
          enforceZeroDataRetention
        })[2]?.options[0]?.note
      ).toBe('licence review required');
  });

  it('never offers an unavailable model as something that could be picked', () => {
    const result = groups({
      unavailableModels: [catalogueModel('openrouter/other/model-x', 'unavailable')]
    });
    expect(result[2]?.options.every((option) => option.disabled)).toBe(true);
  });
});

describe('where inference goes, said once, inside the sheet that changes it', () => {
  it('states where it goes, and states the other answer honestly', () => {
    expect(privacyLine({ enforceZeroDataRetention: true })).toBe('Private AI routes only');
    expect(privacyLine({ enforceZeroDataRetention: false })).toBe('Provider data policy applies');
  });

  /* A search leaving the box is the second half of the same fact, so it lands on the same line
     rather than beside it: one sentence, one place to change both. */
  it('adds where a search goes only when a query would leave this computer', () => {
    expect(
      privacyLine({
        enforceZeroDataRetention: false,
        webSearchNote: 'Web searches go to your provider'
      })
    ).toBe('Provider data policy applies · Web searches go to your provider');
    expect(privacyLine({ enforceZeroDataRetention: true, webSearchNote: '' })).toBe(
      'Private AI routes only'
    );
  });
});

describe('what the one + offers', () => {
  const items = (patch: Partial<Parameters<typeof composerMenuItems>[0]> = {}) =>
    composerMenuItems({
      workspaceAvailable: true,
      busy: false,
      canImportFolder: false,
      ...patch
    });

  it('holds attach, photo and schedule, and never voice', () => {
    expect(items().map((item) => item.action)).toEqual(['attach', 'photo', 'schedule']);
  });

  it('leaves the folder import out entirely unless the client can do it', () => {
    expect(items().some((item) => item.action === 'folder')).toBe(false);
    expect(items({ canImportFolder: true }).at(-1)).toMatchObject({
      action: 'folder',
      label: 'Import a local folder'
    });
  });

  /* Attaching survives the computer being down: the upload is this server's business, and a file
     put on the draft now is one the owner does not have to find again once the box is back. */
  it('keeps attaching available with no computer, and holds the rest back', () => {
    const down = items({ workspaceAvailable: false });
    expect(down.find((item) => item.action === 'attach')?.disabled).toBe(false);
    expect(down.find((item) => item.action === 'photo')?.disabled).toBe(true);
    expect(down.find((item) => item.action === 'schedule')?.disabled).toBe(true);
  });

  it('holds the camera back while a send is in flight', () => {
    expect(items({ busy: true }).find((item) => item.action === 'photo')?.disabled).toBe(true);
  });
});
