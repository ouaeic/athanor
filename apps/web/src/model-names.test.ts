import { describe, expect, it } from 'vitest';
import { modelDisplayName, modelTail, type NamedModel } from './model-names.js';

const models: NamedModel[] = [
  {
    id: 'openrouter/z-ai/glm-5.2',
    providerModelId: 'z-ai/glm-5.2',
    displayName: 'GLM-5.2'
  },
  {
    id: 'openrouter/deepseek/deepseek-v4-flash',
    providerModelId: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash'
  }
];

describe('naming the model that answered', () => {
  /*
   * The transcript reads the id off the provider's own response, which is the id athanor sent it
   * rather than the catalogue's. Both name one model and the owner only ever chose one name.
   */
  it('answers with the picker’s words for either id of the same model', () => {
    expect(modelDisplayName(models, 'z-ai/glm-5.2')).toBe('GLM-5.2');
    expect(modelDisplayName(models, 'openrouter/z-ai/glm-5.2')).toBe('GLM-5.2');
  });

  it('matches on the tail when a provider answers with a prefix of its own', () => {
    expect(modelDisplayName(models, 'bedrock/deepseek/deepseek-v4-flash')).toBe(
      'DeepSeek V4 Flash'
    );
  });

  it('shows the part a person recognises for a model this box has never listed', () => {
    expect(modelDisplayName(models, 'someone/experimental-1')).toBe('experimental-1');
    expect(modelDisplayName([], 'z-ai/glm-5.2')).toBe('glm-5.2');
  });

  it('says nothing at all rather than something empty', () => {
    expect(modelDisplayName(models, '   ')).toBe('');
  });

  it('leaves an unqualified id alone', () => {
    expect(modelTail('gpt-oss-120b')).toBe('gpt-oss-120b');
  });
});
