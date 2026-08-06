import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { sha256 } from '@athanor/core';
import type { DataStore, UserRecord } from '@athanor/data';

export const SESSION_COOKIE = 'athanor_session';
export const HOST_SESSION_COOKIE = '__Host-athanor_session';
export const sessionCookieName = (secure: boolean): string =>
  secure ? HOST_SESSION_COOKIE : SESSION_COOKIE;

/**
 * A device that keeps being used is never signed out, full stop.
 *
 * 400 days because that is the ceiling browsers enforce on cookie expiry (Chrome 104 and the
 * followers capped it there); asking for longer is silently clamped to the same date, so this is
 * "as long as a browser will hold it" rather than an arbitrary policy. The window slides on use —
 * see `getSession`, which pushes the expiry back out to a full term once a session is past its
 * halfway point — so opening the app even once a year leaves it permanently signed in.
 *
 * The security boundary here is possession of the device, not the age of the cookie: this is one
 * person's own computer, and a device that should no longer have access gets revoked from Settings,
 * which kills its session immediately. A short window would not have added protection, only the
 * sign-in screen the owner explicitly does not want.
 */
export const SESSION_LIFETIME_SECONDS = 400 * 24 * 60 * 60;

/**
 * `lax` rather than `strict`. Under `strict` the browser withholds the cookie on any inbound
 * top-level navigation, so following a push notification, a shared task link, or the PWA's own
 * launch URL lands on a signed-out page even though the session is perfectly valid — the exact
 * symptom of "it makes me log in every time". CSRF is not what `strict` was buying here: mutating
 * requests are already gated on an Origin check, and `lax` still withholds the cookie from
 * cross-site POSTs.
 */
const SAME_SITE = 'lax' as const;

const setSessionCookie = (
  reply: FastifyReply,
  token: string,
  secure: boolean,
  expiresAt: Date
): void => {
  reply.setCookie(sessionCookieName(secure), token, {
    httpOnly: true,
    secure,
    sameSite: SAME_SITE,
    path: '/',
    expires: expiresAt
  });
};

export const createSession = async (
  store: DataStore,
  reply: FastifyReply,
  userId: string,
  secure: boolean,
  deviceLabel = 'Unknown device',
  steppedUp = false
): Promise<void> => {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000);
  await store.createSession(userId, sha256(token), expiresAt, undefined, deviceLabel, steppedUp);
  setSessionCookie(reply, token, secure, expiresAt);
};

/**
 * Resolves the session and, when the store slid its expiry, re-issues the cookie so the browser's
 * copy does not lapse while the server-side session is still good.
 */
export const sessionUser = async (
  store: DataStore,
  token?: string,
  reply?: FastifyReply,
  secure = true
): Promise<UserRecord | null> => {
  if (!token) return null;
  const resolved = await store.getSession(sha256(token), SESSION_LIFETIME_SECONDS);
  if (!resolved) return null;
  if (resolved.renewedExpiresAt && reply)
    setSessionCookie(reply, token, secure, resolved.renewedExpiresAt);
  return resolved.user;
};

export const destroySession = async (
  store: DataStore,
  reply: FastifyReply,
  token: string | undefined,
  secure: boolean
): Promise<void> => {
  if (token) await store.deleteSession(sha256(token));
  reply.clearCookie(sessionCookieName(secure), {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax'
  });
};
