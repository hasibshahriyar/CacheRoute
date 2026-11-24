import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { EmbeddingModel } from '../ports/index.js';
import type { MetricsRegistry } from '../services/MetricsRegistry.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: {
    redis: Redis;
    pgPool: pg.Pool;
    embeddingModel: EmbeddingModel;
    metrics: MetricsRegistry;
  },
): void {
  app.get('/', async () => ({
    service: 'CacheRoute LLM Gateway',
    status: 'ok',
    version: '1.0.0',
    endpoints: {
      chatCompletions: 'POST /v1/chat/completions',
      models: 'GET /v1/models',
      health: 'GET /healthz',
      ready: 'GET /readyz',
      metrics: 'GET /metrics',
      adminKeys: 'POST /admin/keys',
      adminStats: 'GET /admin/stats?window=24h',
    },
    docs: 'https://github.com/hasibshahriyar/CacheRoute',
  }));

  app.get('/healthz', async () => ({
    status: 'ok',
  }));

  app.get('/readyz', async (_request, reply) => {
    let redisOk = false;
    let pgOk = false;
    let redisError: string | undefined;
    let pgError: string | undefined;

    try {
      const pong = await deps.redis.ping();
      redisOk = pong === 'PONG';
    } catch (err: unknown) {
      redisOk = false;
      redisError = err instanceof Error ? err.message : 'redis_error';
    }

    try {
      await deps.pgPool.query('SELECT 1');
      pgOk = true;
    } catch (err: unknown) {
      pgOk = false;
      pgError = err instanceof Error ? err.message : 'postgres_error';
    }

    const embedderReady = deps.embeddingModel.isReady();
    const allOk = redisOk && pgOk;

    reply.code(allOk ? 200 : 503);
    return {
      status: allOk ? 'ready' : 'degraded',
      checks: {
        redis: redisOk,
        postgres: pgOk,
        embedderLoaded: embedderReady,
      },
      ...(allOk
        ? {}
        : {
            diagnostics: {
              redisError,
              pgError,
              envConfigured: {
                database: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL),
                redis: Boolean(
                  process.env.REDIS_URL ||
                  process.env.KV_URL ||
                  process.env.UPSTASH_REDIS_URL ||
                  process.env.STORAGE_URL,
                ),
              },
            },
          }),
    };
  });

  app.get('/metrics', async (_request, reply) => {
    const output = await deps.metrics.registry.metrics();
    reply.header('Content-Type', deps.metrics.registry.contentType);
    return reply.send(output);
  });

  // Phase 0 Deployment Spike diagnostic endpoints
  app.get('/debug/embed', async () => {
    const started = Date.now();
    const vector = await deps.embeddingModel.embed('CacheRoute Phase 0 ONNX embedding spike test');
    const durationMs = Date.now() - started;
    return {
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
      dimensions: vector.length,
      durationMs,
      ready: deps.embeddingModel.isReady(),
      sample: vector.slice(0, 5),
    };
  });

  app.get('/debug/stream', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    for (let i = 1; i <= 10; i++) {
      reply.raw.write(`data: ${JSON.stringify({ chunk: i, timestamp: Date.now() })}\n\n`);
      await new Promise((r) => setTimeout(r, 10));
    }
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });
}
