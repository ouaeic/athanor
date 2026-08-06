export interface ModelLicenseReview {
  providerModelId: string;
  upstreamModelUrl: string;
  licenseUrl: string;
  license: 'MIT' | 'Apache-2.0';
  upstreamRevision: string;
  commercialUseUnderModelLicense: true;
  reviewedAt: string;
  reviewExpiresAt: string;
}

const reviews: ModelLicenseReview[] = [
  {
    providerModelId: 'deepseek/deepseek-v4-flash',
    upstreamModelUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash',
    licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/LICENSE',
    license: 'MIT',
    upstreamRevision: 'openrouter-model-id-reviewed-2026-07-23',
    commercialUseUnderModelLicense: true,
    reviewedAt: '2026-07-23T00:00:00.000Z',
    reviewExpiresAt: '2026-10-21T00:00:00.000Z'
  },
  {
    providerModelId: 'z-ai/glm-5.2',
    upstreamModelUrl: 'https://huggingface.co/zai-org/GLM-5.2',
    licenseUrl: 'https://huggingface.co/zai-org/GLM-5.2/blob/main/LICENSE',
    license: 'MIT',
    upstreamRevision: 'openrouter-model-id-reviewed-2026-07-23',
    commercialUseUnderModelLicense: true,
    reviewedAt: '2026-07-23T00:00:00.000Z',
    reviewExpiresAt: '2026-10-21T00:00:00.000Z'
  },
  {
    providerModelId: 'qwen/qwen3.6-35b-a3b',
    upstreamModelUrl: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/LICENSE',
    license: 'Apache-2.0',
    upstreamRevision: 'openrouter-model-id-reviewed-2026-07-23',
    commercialUseUnderModelLicense: true,
    reviewedAt: '2026-07-23T00:00:00.000Z',
    reviewExpiresAt: '2026-10-21T00:00:00.000Z'
  },
  {
    providerModelId: 'openai/gpt-oss-120b',
    upstreamModelUrl: 'https://huggingface.co/openai/gpt-oss-120b',
    licenseUrl:
      'https://huggingface.co/openai/gpt-oss-120b/blob/607fd515f16a4d340663a949dbfc20a4be5806b8/LICENSE',
    license: 'Apache-2.0',
    upstreamRevision: '607fd515f16a4d340663a949dbfc20a4be5806b8',
    commercialUseUnderModelLicense: true,
    reviewedAt: '2026-07-23T00:00:00.000Z',
    reviewExpiresAt: '2026-10-21T00:00:00.000Z'
  },
  {
    providerModelId: 'black-forest-labs/flux.2-klein-4b',
    upstreamModelUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B',
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE',
    license: 'Apache-2.0',
    upstreamRevision: 'openrouter-model-id-reviewed-2026-07-23',
    commercialUseUnderModelLicense: true,
    reviewedAt: '2026-07-23T00:00:00.000Z',
    reviewExpiresAt: '2026-10-21T00:00:00.000Z'
  },
  {
    providerModelId: 'hexgrad/kokoro-82m',
    upstreamModelUrl: 'https://huggingface.co/hexgrad/Kokoro-82M',
    licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE',
    license: 'Apache-2.0',
    upstreamRevision: '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4',
    commercialUseUnderModelLicense: true,
    reviewedAt: '2026-07-23T00:00:00.000Z',
    reviewExpiresAt: '2026-10-21T00:00:00.000Z'
  }
];

export const modelLicenseManifest = new Map(
  reviews.map((review) => [review.providerModelId, Object.freeze(review)])
);

export const currentCommercialLicenseReview = (
  providerModelId: string,
  declaredLicense: string,
  now = new Date()
): ModelLicenseReview | undefined => {
  const review = modelLicenseManifest.get(providerModelId);
  if (
    !review ||
    review.license !== declaredLicense ||
    !review.commercialUseUnderModelLicense ||
    new Date(review.reviewedAt).getTime() > now.getTime() ||
    new Date(review.reviewExpiresAt).getTime() <= now.getTime()
  )
    return undefined;
  return review;
};

export const managedMediaModels = {
  image: {
    modelId: 'black-forest-labs/flux.2-klein-4b',
    displayName: 'FLUX.2 Klein 4B',
    license: 'Apache-2.0',
    baseUsdPerImage: 0.014
  },
  audio: {
    modelId: 'hexgrad/kokoro-82m',
    displayName: 'Kokoro 82M',
    license: 'Apache-2.0',
    usdPerMillionCharacters: 0.62,
    defaultVoice: 'af_heart'
  }
} as const;
