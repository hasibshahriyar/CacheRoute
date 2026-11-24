import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AdminStatsSummary, RequestLogEntry, RequestLogSink } from '../ports/index.js';

const WINDOW_INTERVALS: Record<'1h' | '24h' | '7d' | '30d', string> = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export class PgRequestLogSink implements RequestLogSink {
  private readonly pool: pg.Pool;
  private readonly logger?: FastifyBaseLogger;

  constructor(pool: pg.Pool, logger?: FastifyBaseLogger) {
    this.pool = pool;
    this.logger = logger;
  }

  public async write(entry: RequestLogEntry): Promise<void> {
    try {
      await this.pool.query(
        `
        INSERT INTO request_logs (
          request_id,
          tenant_id,
          model_alias,
          provider,
          upstream_model,
          stream,
          cache_status,
          similarity,
          status_code,
          error_code,
          attempts,
          latency_ms,
          ttft_ms,
          prompt_tokens,
          completion_tokens
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `,
        [
          entry.requestId,
          entry.tenantId,
          entry.modelAlias,
          entry.provider,
          entry.upstreamModel,
          entry.stream,
          entry.cacheStatus,
          entry.similarity,
          entry.statusCode,
          entry.errorCode,
          entry.attempts,
          entry.latencyMs,
          entry.ttftMs,
          entry.promptTokens,
          entry.completionTokens,
        ],
      );
    } catch (err: unknown) {
      this.logger?.warn({ err, requestId: entry.requestId }, 'PgRequestLogSink.write failed');
    }
  }

  public async getStats(window: '1h' | '24h' | '7d' | '30d'): Promise<AdminStatsSummary> {
    const interval = WINDOW_INTERVALS[window] ?? '24 hours';

    const aggResult = await this.pool.query<{
      total_requests: string;
      exact_hits: string;
      semantic_hits: string;
      misses: string;
      bypass: string;
      p50_latency: number | null;
      p95_latency: number | null;
      tokens_saved: string;
    }>(
      `
      SELECT
        COUNT(*) AS total_requests,
        COUNT(*) FILTER (WHERE cache_status = 'HIT-EXACT') AS exact_hits,
        COUNT(*) FILTER (WHERE cache_status = 'HIT-SEMANTIC') AS semantic_hits,
        COUNT(*) FILTER (WHERE cache_status = 'MISS') AS misses,
        COUNT(*) FILTER (WHERE cache_status = 'BYPASS') AS bypass,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency,
        COALESCE(
          SUM(prompt_tokens + completion_tokens)
            FILTER (WHERE cache_status IN ('HIT-EXACT', 'HIT-SEMANTIC')),
          0
        ) AS tokens_saved
      FROM request_logs
      WHERE created_at >= NOW() - $1::interval
      `,
      [interval],
    );

    const providerResult = await this.pool.query<{
      provider: string;
      requests: string;
      errors: string;
    }>(
      `
      SELECT
        provider,
        COUNT(*) AS requests,
        COUNT(*) FILTER (WHERE status_code >= 400) AS errors
      FROM request_logs
      WHERE created_at >= NOW() - $1::interval
      GROUP BY provider
      `,
      [interval],
    );

    const row = aggResult.rows[0];
    const totalRequests = Number(row?.total_requests ?? 0);
    const exactHits = Number(row?.exact_hits ?? 0);
    const semanticHits = Number(row?.semantic_hits ?? 0);
    const misses = Number(row?.misses ?? 0);
    const bypass = Number(row?.bypass ?? 0);
    const eligibleCount = exactHits + semanticHits + misses;
    const hitRate =
      eligibleCount > 0 ? Number(((exactHits + semanticHits) / eligibleCount).toFixed(4)) : 0;

    const providers: Record<string, { requests: number; errors: number }> = {};
    for (const pRow of providerResult.rows) {
      providers[pRow.provider] = {
        requests: Number(pRow.requests),
        errors: Number(pRow.errors),
      };
    }

    return {
      window,
      totalRequests,
      cache: {
        exactHits,
        semanticHits,
        misses,
        bypass,
        hitRate,
      },
      latencyMs: {
        p50: Math.round(Number(row?.p50_latency ?? 0)),
        p95: Math.round(Number(row?.p95_latency ?? 0)),
      },
      tokensSavedEstimate: Number(row?.tokens_saved ?? 0),
      providers,
    };
  }
}
