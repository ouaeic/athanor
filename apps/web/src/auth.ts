import { isNativeClient, post } from './client.js';
import type {
  startAuthentication as browserAuthentication,
  startRegistration as browserRegistration
} from '@simplewebauthn/browser';

type AuthenticationOptions = Parameters<typeof browserAuthentication>[0]['optionsJSON'];
type RegistrationOptions = Parameters<typeof browserRegistration>[0]['optionsJSON'];
interface Ceremony<T> {
  challengeId: string;
  options: T;
}
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}
export interface AuthResult {
  user: AuthUser;
  recoveryCode?: string;
}

const nativeContext = (): { nativeOrigin?: string } =>
  isNativeClient() && typeof window !== 'undefined' ? { nativeOrigin: window.location.origin } : {};

export async function signIn(username?: string): Promise<AuthResult> {
  const ceremony = await post<Ceremony<AuthenticationOptions>>('/v1/auth/login/options', {
    ...(username ? { username } : {}),
    ...nativeContext()
  });
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const response = await startAuthentication({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/login/verify', { challengeId: ceremony.challengeId, response });
}

export async function register(input: {
  displayName: string;
  pairingCode: string;
  username?: string;
}): Promise<AuthResult> {
  const ceremony = await post<Ceremony<RegistrationOptions>>('/v1/auth/register/options', {
    ...input,
    ...nativeContext()
  });
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/register/verify', {
    ...input,
    challengeId: ceremony.challengeId,
    response
  });
}

let pendingStepUp: Promise<void> | undefined;

/** Concurrent sensitive actions share one ceremony; the server decides whether one is needed. */
export function stepUp(): Promise<void> {
  if (pendingStepUp) return pendingStepUp;
  pendingStepUp = (async () => {
    const ceremony = await post<Ceremony<AuthenticationOptions> | { verified: true }>(
      '/v1/auth/step-up/options',
      nativeContext()
    );
    if ('verified' in ceremony && ceremony.verified) return;
    if (!('options' in ceremony)) throw new Error('The server returned no passkey challenge');
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const response = await startAuthentication({ optionsJSON: ceremony.options });
    await post('/v1/auth/step-up/verify', { challengeId: ceremony.challengeId, response });
  })().finally(() => {
    pendingStepUp = undefined;
  });
  return pendingStepUp;
}

export async function enroll(token: string, deviceLabel?: string): Promise<AuthResult> {
  const ceremony = await post<Ceremony<RegistrationOptions>>('/v1/auth/enroll/options', {
    token,
    ...nativeContext()
  });
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/enroll/verify', {
    token,
    ...(deviceLabel ? { deviceLabel } : {}),
    challengeId: ceremony.challengeId,
    response
  });
}

export async function recover(recoveryCode: string, username = ''): Promise<AuthResult> {
  const ceremony = await post<Ceremony<RegistrationOptions>>('/v1/auth/recover/options', {
    username,
    recoveryCode,
    ...nativeContext()
  });
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/recover/verify', {
    recoveryCode,
    challengeId: ceremony.challengeId,
    response
  });
}

export async function addPasskey(): Promise<unknown> {
  await stepUp();
  const ceremony = await post<Ceremony<RegistrationOptions>>(
    '/v1/auth/passkeys/options',
    nativeContext()
  );
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post('/v1/auth/passkeys/verify', { challengeId: ceremony.challengeId, response });
}

export const devSignIn = (displayName = 'Local User'): Promise<AuthResult> =>
  post<AuthResult>('/v1/auth/dev', { displayName });
export const signOut = (): Promise<{ ok: boolean }> => post('/v1/auth/logout');
