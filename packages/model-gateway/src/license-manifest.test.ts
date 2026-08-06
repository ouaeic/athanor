import { describe, expect, it } from 'vitest';
import { seedModels } from './catalog.js';
import {
  currentCommercialLicenseReview,
  managedMediaModels,
  modelLicenseManifest
} from './license-manifest.js';

describe('independent model-license manifest', () => {
  it('covers every chat and media route with a current official review', () => {
    const at = new Date('2026-07-23T00:00:00.000Z');
    for (const model of seedModels(at)) {
      expect(
        currentCommercialLicenseReview(model.providerModelId, model.license, at)
      ).toBeDefined();
    }
    for (const media of Object.values(managedMediaModels)) {
      expect(currentCommercialLicenseReview(media.modelId, media.license, at)).toBeDefined();
    }
  });

  it('does not contain non-commercial media licenses', () => {
    expect(modelLicenseManifest.has('mistralai/voxtral-mini-tts')).toBe(false);
    expect(
      [...modelLicenseManifest.values()].every(
        (entry) =>
          entry.commercialUseUnderModelLicense && entry.license !== ('CC-BY-NC-4.0' as never)
      )
    ).toBe(true);
  });
});
