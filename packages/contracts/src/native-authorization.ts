import { z } from 'zod';

export const NativeAuthorizationPurpose = z.enum(['sign_in', 'step_up']);
export type NativeAuthorizationPurpose = z.infer<typeof NativeAuthorizationPurpose>;
export const NativeAuthorizationStart = z
  .object({
    purpose: NativeAuthorizationPurpose,
    nativeOrigin: z.string().url().max(100),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    devicePublicKey: z.string().regex(/^[A-Za-z0-9_-]{80,256}$/)
  })
  .strict();
export type NativeAuthorizationStart = z.infer<typeof NativeAuthorizationStart>;
export const NativeAuthorization = z.object({
  id: z.string().uuid(),
  purpose: NativeAuthorizationPurpose,
  deviceLabel: z.string().max(120),
  userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
  serverOrigin: z.string().url(),
  expiresAt: z.string().datetime(),
  status: z.enum(['pending', 'approved', 'denied', 'consumed', 'expired'])
});
export type NativeAuthorization = z.infer<typeof NativeAuthorization>;
export const NativeAuthorizationProof = z
  .object({
    id: z.string().uuid(),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    nativeOrigin: z.string().url().max(100),
    action: z.enum(['redeem', 'cancel'])
  })
  .strict();
export type NativeAuthorizationProof = z.infer<typeof NativeAuthorizationProof>;

/** Fixed audience and field order bind a device signature to one action on one server. */
export function nativeAuthorizationMessage(input: {
  id: string;
  serverOrigin: string;
  nativeOrigin: string;
  purpose: NativeAuthorizationPurpose;
  challenge: string;
  action: 'redeem' | 'cancel';
}): string {
  return [
    'garden-native-authorization-v1',
    input.serverOrigin,
    input.id,
    input.nativeOrigin,
    input.purpose,
    input.challenge,
    input.action
  ].join('\n');
}
