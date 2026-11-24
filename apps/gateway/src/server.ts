import type { IncomingMessage, ServerResponse } from 'node:http';
import { TransformersEmbeddingModel } from './adapters/TransformersEmbeddingModel.js';
import { buildGatewayApp } from './app.js';
import { runMigrations } from './db/migrate.js';

let vercelAppPromise: Promise<ReturnType<typeof buildGatewayApp>['app']> | null = null;

async function getVercelReadyApp() {
  if (!vercelAppPromise) {
    vercelAppPromise = (async () => {
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
  return vercelAppPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getVercelReadyApp();
  await new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    app.server.emit('request', req, res);
  });
}

async function main() {
  const { app, container } = buildGatewayApp();
  const port = container.config.env.PORT;

  try {
    await runMigrations(container.pgPool);
    app.log.info('Database migrations verified');
  } catch (err: unknown) {
    app.log.warn({ err }, 'Database migration check skipped or failed at startup');
  }

  if (container.embeddingModel instanceof TransformersEmbeddingModel) {
    container.embeddingModel.warmup().catch((err: unknown) => {
      app.log.warn({ err }, 'Background ONNX embedder warmup warning');
    });
  }

  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`CacheRoute gateway listening on http://0.0.0.0:${port}`);
}

if (!process.env.VERCEL) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
