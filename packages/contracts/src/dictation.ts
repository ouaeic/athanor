import type { MediaPriceLine } from './media.js';

export const DICTATION_MAX_BYTES = 14_000_000;
export const DICTATION_MAX_SECONDS = 300;
export const DICTATION_MAX_COST_USD = 100;
export const AUDIO_RECEIPT_REFERENCE_MAX_LENGTH = 256;

export interface DictationOptions {
  available: boolean;
  reason: string | null;
  routeId: string | null;
  routeProof: string | null;
  modelId: string | null;
  displayName: string | null;
  provider: string | null;
  privacyRoutes: Array<'provider_zdr' | 'external'>;
  defaultPrivacyRoute: 'provider_zdr' | 'external';
  requiresExternalConsent: boolean;
  requiresMaxCostUsd: boolean;
  pricing: MediaPriceLine[];
  usdPerMinute: number | null;
  reservationUsd: number | null;
  maxDurationSeconds: number;
  maxBytes: number;
}

export interface DictationReceipt {
  id: string;
  modelId: string | null;
  providerRef: string | null;
  state: 'reserved' | 'settled' | 'released';
  quantitySeconds: number;
  reservationUsd: number;
  costUsd: number | null;
  createdAt: string;
}
