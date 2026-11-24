import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildGatewayApp } from '../src/app.js';

let appPromise: Promise<ReturnType<typeof buildGatewayApp>['app']> | null = null;

async function getReadyApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const { app } = buildGatewayApp();
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
