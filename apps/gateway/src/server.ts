import { TransformersEmbeddingModel } from './adapters/TransformersEmbeddingModel.js';
import { buildGatewayApp } from './app.js';
import { runMigrations } from './db/migrate.js';

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

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
