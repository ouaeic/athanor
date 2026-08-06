import { buildServer } from './server.js';
import { loadConfig } from './config.js';
import { createLogger, errorFields, installProcessGuards } from './log.js';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, service: 'api' });
installProcessGuards(logger);

const { app, previewApp } = await buildServer(config, { logger });

const shutdown = async () => {
  logger.info('api.stopping');
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await previewApp.listen({
    host: config.PREVIEW_GATEWAY_HOST,
    port: config.PREVIEW_GATEWAY_PORT
  });
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info('api.listening', { port: config.API_PORT, driver: config.DATABASE_DRIVER });
} catch (error) {
  // A refused bind otherwise leaves the unit dead with nothing but a stack trace, and a port
  // already in use is the failure a first install is most likely to hit.
  logger.error('api.listen_failed', { port: config.API_PORT, ...errorFields(error) });
  process.exit(1);
}
