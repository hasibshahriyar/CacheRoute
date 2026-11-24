import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildGatewayApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

let appPromise: Promise<ReturnType<typeof buildGatewayApp>['app']> | null = null;

async function getReadyApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const { app, container } = buildGatewayApp();
      if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
        await runMigrations(container.pgPool).catch((err: unknown) => {
          app.log.warn({ err }, 'Startup migration skipped or deferred');
        });
      }
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getReadyApp();
  app.server.emit('request', req, res);
}
