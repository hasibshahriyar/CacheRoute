import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { CachedCompletionRecord, ChatCompletionResponse } from '../domain/types.js';
import type {
  SemanticCacheInsertParams,
  SemanticCacheStore,
  SemanticSearchMatch,
} from '../ports/index.js';

export class PgVectorSemanticCache implements SemanticCacheStore {
  private readonly pool: pg.Pool;
  private readonly logger?: FastifyBaseLogger;

  constructor(pool: pg.Pool, logger?: FastifyBaseLogger) {
    this.pool = pool;
    this.logger = logger;
  }

  public async search(params: {
    tenantId: string;
    namespace: number;
    modelAlias: string;
    scopeHash: string;
    embedding: number[];
    threshold: number;
  }): Promise<SemanticSearchMatch | null> {
    const vectorLiteral = `[${params.embedding.join(',')}]`;
    let client: pg.PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL hnsw.ef_search = 100');
      try {
        await client.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
      } catch {
        // Fallback silently if pgvector < 0.8 on older server
      }

      const result = await client.query<{
        id: number;
        response: ChatCompletionResponse;
        prompt_tokens: number;
        completion_tokens: number;
        created_at: Date;
        similarity: number;
      }>(
        `
        SELECT
          id,
          response,
          prompt_tokens,
          completion_tokens,
          created_at,
          (1 - (embedding <=> $1::vector)) AS similarity
        FROM cache_entries
        WHERE tenant_id = $2::uuid
          AND namespace = $3
          AND model_alias = $4
          AND scope_hash = $5
          AND expires_at > NOW()
          AND (1 - (embedding <=> $1::vector)) >= $6
        ORDER BY embedding <=> $1::vector ASC
        LIMIT 1
        `,
        [
          vectorLiteral,
          params.tenantId,
          params.namespace,
          params.modelAlias,
          params.scopeHash,
          params.threshold,
        ],
      );

      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) return null;

      // Best-effort hit_count increment
      void this.pool
        .query('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = $1', [row.id])
        .catch(() => undefined);

      const record: CachedCompletionRecord = {
        response: row.response,
        promptTokens: Number(row.prompt_tokens),
        completionTokens: Number(row.completion_tokens),
        createdAtMs: new Date(row.created_at).getTime(),
      };

      return {
        record,
        similarity: Number(row.similarity),
      };
    } catch (err: unknown) {
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      this.logger?.warn({ err }, 'PgVectorSemanticCache.search failed; degrading to L2 miss');
      return null;
    } finally {
      client?.release();
    }
  }

  public async insert(params: SemanticCacheInsertParams): Promise<void> {
    const vectorLiteral = `[${params.embedding.join(',')}]`;
    try {
      await this.pool.query(
        `
        INSERT INTO cache_entries (
          tenant_id,
          namespace,
          model_alias,
          scope_hash,
          exact_key,
          prompt_text,
          embedding,
          response,
          prompt_tokens,
          completion_tokens,
          expires_at
        )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7::vector,
          $8::jsonb,
          $9,
          $10,
          NOW() + ($11::int * INTERVAL '1 second')
        )
        ON CONFLICT (tenant_id, namespace, exact_key)
        DO UPDATE SET
          response = EXCLUDED.response,
          embedding = EXCLUDED.embedding,
          prompt_tokens = EXCLUDED.prompt_tokens,
          completion_tokens = EXCLUDED.completion_tokens,
          expires_at = EXCLUDED.expires_at
        `,
        [
          params.tenantId,
          params.namespace,
          params.modelAlias,
          params.scopeHash,
          params.exactKey,
          params.promptText,
          vectorLiteral,
          JSON.stringify(params.record.response),
          params.record.promptTokens,
          params.record.completionTokens,
          params.ttlSeconds,
        ],
      );
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'PgVectorSemanticCache.insert failed');
    }
  }
}
