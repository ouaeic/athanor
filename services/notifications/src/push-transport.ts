import webpush from 'web-push';
import { notificationPayload } from './payload.js';
import { pushLifetime } from './policy.js';
import type { Transport } from './transport.js';

/**
 * Web Push, as one transport among two. The VAPID details are registered once on the library by
 * `index.ts` before this is ever called, which is why nothing here takes a key.
 */
export const createPushTransport = (): Transport => ({
  kind: 'push',
  send: async (row, subject) => {
    if (row.transport !== 'push') throw new Error('The push transport was handed a non-push row');
    // Bounded. A push endpoint is a third party's server on the far side of the internet, and
    // without a timeout one that accepts the connection and then says nothing holds this loop -
    // and therefore every other device's notification behind it - until the socket gives up on
    // its own, which can be minutes.
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(notificationPayload(subject)),
      {
        // How long the push service keeps trying, and how hard, decided by kind in `policy.ts`
        // beside the horizon that chose the number. This was a flat ten minutes for every kind,
        // which put the shortest life on the wire on the one notification that means the agent
        // has stopped until a person answers.
        ...pushLifetime(row.kind),
        timeout: 10_000
      }
    );
    return {};
  }
});
