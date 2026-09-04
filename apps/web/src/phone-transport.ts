/**
 * The phone transport as this client sees it: a bot on a messaging service, paired to one phone.
 *
 * Kept out of `api.ts` and `notification-settings.ts` on purpose. Both are in the first paint of
 * every screen, and the settings page that draws these controls is loaded on demand - so this is
 * where a kilobyte of parsing and six calls belong, behind the same dynamic import.
 */
import { ApiFailure } from './api-failure.js';
import { mutation, request } from './api.js';
/**
 * The phone transport as the server describes it: a bot on a messaging service, paired to one
 * phone. Never the token and never the sender id - the server does not serve either, and this
 * shape has no field to put them in.
 */
export interface NotificationDestination {
  kind: 'telegram';
  botUsername: string | null;
  paired: boolean;
  verifiedAt: string | null;
  disabledAt: string | null;
  /** Title and link only. The default, because the service in between can read what it carries. */
  redact: boolean;
  /** A pairing link has been made and no phone has opened it yet. */
  pairingPending: boolean;
  pairingExpiresAt: string | null;
}

/** What comes back once, when a bot is added or a new link is asked for. */
export interface PairingOffer {
  botUsername: string;
  pairingUrl: string;
  expiresAt: string;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Reads the destinations the box actually sent. A kind this client does not know is dropped
 * rather than drawn as a broken row, so a box that grows a second transport does not break the
 * first one's controls.
 */
export const destinationsFromResponse = (payload: unknown): NotificationDestination[] => {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry): NotificationDestination[] => {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (row.kind !== 'telegram') return [];
    return [
      {
        kind: 'telegram',
        botUsername: text(row.botUsername),
        paired: row.paired === true,
        verifiedAt: text(row.verifiedAt),
        disabledAt: text(row.disabledAt),
        redact: row.redact !== false,
        pairingPending: row.pairingPending === true,
        pairingExpiresAt: text(row.pairingExpiresAt)
      }
    ];
  });
};

export const pairingOfferFromResponse = (payload: unknown): PairingOffer | null => {
  const body = (payload ?? {}) as Record<string, unknown>;
  const botUsername = text(body.botUsername);
  const pairingUrl = text(body.pairingUrl);
  const expiresAt = text(body.expiresAt);
  return botUsername && pairingUrl && expiresAt ? { botUsername, pairingUrl, expiresAt } : null;
};

/** A bot token: the bot's numeric id, a colon, then the secret. Checked before it is sent. */
const BOT_TOKEN = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;

export const botTokenProblem = (draft: string): string | null => {
  const value = draft.trim();
  if (!value) return 'Paste the token BotFather gave you.';
  if (!BOT_TOKEN.test(value))
    return 'That does not look like a bot token: it is a number, a colon, then about 35 letters and digits.';
  return null;
};

/** One sentence saying where the phone transport stands, for the heading of its block. */
export const phoneStatusLine = (destination: NotificationDestination | null): string => {
  if (!destination) return 'No phone is paired yet.';
  const bot = destination.botUsername ? `@${destination.botUsername}` : 'your bot';
  if (destination.disabledAt) return `Paired to ${bot}, and switched off.`;
  if (destination.paired) return `Paired to ${bot}. Approvals and questions reach your phone.`;
  if (destination.pairingPending) return `Waiting for your phone to open the link for ${bot}.`;
  return `${bot} is set up, but no phone is paired to it. Make a new link.`;
};

const telegram = '/v1/notifications/destinations/telegram';

const offerOrThrow = (payload: unknown): PairingOffer => {
  const offer = pairingOfferFromResponse(payload);
  if (!offer) throw new Error('The server did not return a pairing link');
  return offer;
};

export const phoneApi = {
  /**
   * Null on a box with no route for it, like the notification settings, so an older server shows
   * no block rather than one whose buttons all fail.
   */
  destinations: async (): Promise<NotificationDestination[] | null> => {
    try {
      return destinationsFromResponse(await request<unknown>('/v1/notifications/destinations'));
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 404) return null;
      throw cause;
    }
  },
  /** The pairing link comes back once, here, and is never served again. */
  create: async (botToken: string): Promise<PairingOffer> =>
    offerOrThrow(await request<unknown>(telegram, mutation('POST', { botToken }))),
  remintPairing: async (): Promise<PairingOffer> =>
    offerOrThrow(await request<unknown>(`${telegram}/pairing`, mutation('POST', {}))),
  update: async (body: {
    redact?: boolean;
    disabled?: boolean;
  }): Promise<NotificationDestination | null> =>
    destinationsFromResponse([await request<unknown>(telegram, mutation('PATCH', body))])[0] ??
    null,
  remove: () => request<{ removed: boolean }>(telegram, mutation('DELETE', {})),
  test: () => request<{ sent: boolean }>(`${telegram}/test`, mutation('POST', {}))
};
