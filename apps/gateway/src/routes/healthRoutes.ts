import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { GatewayConfig } from '../config.js';
import type { CircuitBreaker, EmbeddingModel, RequestLogSink } from '../ports/index.js';
import type { MetricsRegistry } from '../services/MetricsRegistry.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: {
    redis: Redis;
    pgPool: pg.Pool;
    embeddingModel: EmbeddingModel;
    metrics: MetricsRegistry;
    requestLogSink: RequestLogSink;
    circuitBreaker: CircuitBreaker;
    config: GatewayConfig;
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
      providersConfigured: {
        groq: Boolean(process.env.GROQ_API_KEY?.trim()),
        gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
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

  app.get('/v1/telemetry', async (request) => {
    const query = (request.query ?? {}) as { window?: string; limit?: string };
    const win =
      query.window === '1h' ||
      query.window === '24h' ||
      query.window === '7d' ||
      query.window === '30d'
        ? query.window
        : '24h';
    const limit = Math.min(50, Math.max(5, Number(query.limit ?? 30) || 30));

    const [stats, recentLogs] = await Promise.all([
      deps.requestLogSink.getStats(win).catch(() => ({
        window: win,
        totalRequests: 0,
        cache: { exactHits: 0, semanticHits: 0, misses: 0, bypass: 0, hitRate: 0 },
        latencyMs: { p50: 0, p95: 0 },
        tokensSavedEstimate: 0,
        providers: {},
      })),
      deps.requestLogSink.getRecentLogs(limit).catch(() => []),
    ]);

    const providerNames = new Set<string>(['groq', 'gemini', 'openrouter']);
    const routesSummary: Record<string, Array<{ provider: string; upstreamModel: string }>> = {};
    for (const [alias, chain] of Object.entries(deps.config.routes)) {
      routesSummary[alias] = chain.map((ep) => {
        providerNames.add(ep.provider);
        return {
          provider: ep.provider,
          upstreamModel: ep.upstreamModel,
        };
      });
    }

    const circuitBreakers: Record<string, string> = {};
    await Promise.all(
      Array.from(providerNames).map(async (provider) => {
        circuitBreakers[provider] = await deps.circuitBreaker
          .getState(provider)
          .catch(() => 'CLOSED');
      }),
    );

    return {
      stats,
      recentLogs,
      circuitBreakers,
      routes: routesSummary,
      config: {
        semanticThreshold: deps.config.env.SEMANTIC_THRESHOLD,
        cacheTtlSeconds: deps.config.env.CACHE_TTL_SECONDS,
        embeddingModel: 'Xenova/all-MiniLM-L6-v2 (q8, 384d)',
        region: process.env.VERCEL_REGION ?? 'local',
      },
    };
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
