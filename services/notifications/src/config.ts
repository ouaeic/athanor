import { z } from 'zod';

const Config = z.object({
  DATABASE_DRIVER: z.enum(['pglite', 'postgres']).default('postgres'),
  DATABASE_URL: z.string().default('postgres://athanor:athanor@localhost:5432/athanor'),
  PGLITE_PATH: z.string().default('.athanor/postgres'),
  /*
   * Web Push is optional: athanor works without it, the API already reports the feature as
   * disabled when no key is present, and the client hides the control. These are therefore
   * optional here too. A service that refuses to start over absent optional configuration does
   * not fail safe - it crash-loops under systemd, turns one disabled feature into a permanently
   * failing unit, and buries the real reason in a restart counter.
   */
  PUSH_VAPID_SUBJECT: z
    .string()
    .refine(
      (value) => value.startsWith('mailto:') || value.startsWith('https://'),
      'VAPID subject must be a mailto: or HTTPS URL'
    )
    .optional(),
  PUSH_VAPID_PUBLIC_KEY: z.string().min(80).max(100).optional(),
  PUSH_VAPID_PRIVATE_KEY: z.string().min(40).max(100).optional(),
  NOTIFICATION_POLL_MS: z.coerce.number().int().min(250).default(2000),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100)
});

/**
 * Where the health and metrics endpoint listens. Not configurable, and deliberately so.
 *
 * Nginx is the only public listener on this box, and binding 0.0.0.0 here once published a health
 * and metrics endpoint straight onto the internet. The port is fixed for the same reason the host
 * is: `athanor doctor` probes it and the runner is told it as a port a published preview may never
 * take, both as literals, so a setting that moved it could only make those two wrong.
 */
export const NOTIFICATION_HEALTH_HOST = '127.0.0.1';
export const NOTIFICATION_HEALTH_PORT = 4203;

export type NotificationConfig = z.infer<typeof Config>;
export const loadConfig = (): NotificationConfig => Config.parse(process.env);

/** Delivery needs all three; any missing one means the feature is simply off. */
export const pushConfigured = (
  config: NotificationConfig
): config is NotificationConfig & {
  PUSH_VAPID_SUBJECT: string;
  PUSH_VAPID_PUBLIC_KEY: string;
  PUSH_VAPID_PRIVATE_KEY: string;
} =>
  Boolean(
    config.PUSH_VAPID_SUBJECT && config.PUSH_VAPID_PUBLIC_KEY && config.PUSH_VAPID_PRIVATE_KEY
  );
