import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { GatewayError } from '../domain/GatewayError.js';
import type { ApiKeyContext } from '../domain/types.js';
import type {
  ApiKeyRepository,
  ApiKeySummary,
  CreateApiKeyInput,
  CreatedApiKeyResult,
} from '../ports/index.js';

export function hashApiKey(plaintextKey: string): string {
  return createHash('sha256').update(plaintextKey).digest('hex');
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  rpm_limit: number;
  burst: number;
  daily_token_budget: number;
  cache_namespace: number;
  semantic_cache_enabled: boolean;
  revoked_at: Date | null;
}

function rowToContext(row: ApiKeyRow): ApiKeyContext {
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash.trim(),
    keyPrefix: row.key_prefix,
    rpmLimit: Number(row.rpm_limit),
    burst: Number(row.burst),
    dailyTokenBudget: Number(row.daily_token_budget),
    cacheNamespace: Number(row.cache_namespace),
    semanticCacheEnabled: Boolean(row.semantic_cache_enabled),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

export class PgApiKeyRepository implements ApiKeyRepository {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  public async findByPlaintextKey(plaintextKey: string): Promise<ApiKeyContext | null> {
    const keyHash = hashApiKey(plaintextKey);
    const result = await this.pool.query<ApiKeyRow>(
      `
      SELECT
        id, name, key_hash, key_prefix, rpm_limit, burst,
        daily_token_budget, cache_namespace, semantic_cache_enabled, revoked_at
      FROM api_keys
      WHERE key_hash = $1
      LIMIT 1
      `,
      [keyHash],
    );
    const row = result.rows[0];
    return row ? rowToContext(row) : null;
  }

  public async createKey(input: CreateApiKeyInput): Promise<CreatedApiKeyResult> {
    const randomPart = randomBytes(16).toString('hex');
    const plaintextKey = `cr_live_${randomPart}`;
    const keyHash = hashApiKey(plaintextKey);
    const keyPrefix = plaintextKey.slice(0, 12);

    const rpmLimit = input.rpmLimit ?? 60;
    const burst = input.burst ?? 20;
    const dailyTokenBudget = input.dailyTokenBudget ?? 200000;
    const semanticCacheEnabled = input.semanticCacheEnabled ?? true;

    const result = await this.pool.query<ApiKeyRow>(
      `
      INSERT INTO api_keys (
        name, key_hash, key_prefix, rpm_limit, burst, daily_token_budget, semantic_cache_enabled
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id, name, key_hash, key_prefix, rpm_limit, burst,
        daily_token_budget, cache_namespace, semantic_cache_enabled, revoked_at
      `,
      [input.name, keyHash, keyPrefix, rpmLimit, burst, dailyTokenBudget, semanticCacheEnabled],
    );

    const row = result.rows[0]!;
    return {
      id: row.id,
      name: row.name,
      key: plaintextKey,
      keyPrefix: row.key_prefix,
      rpmLimit: Number(row.rpm_limit),
      burst: Number(row.burst),
      dailyTokenBudget: Number(row.daily_token_budget),
      cacheNamespace: Number(row.cache_namespace),
      semanticCacheEnabled: Boolean(row.semantic_cache_enabled),
    };
  }

  public async listKeys(): Promise<ApiKeySummary[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      key_prefix: string;
      rpm_limit: number;
      burst: number;
      daily_token_budget: number;
      cache_namespace: number;
      semantic_cache_enabled: boolean;
      created_at: Date;
      revoked_at: Date | null;
    }>(
      `
      SELECT
        id, name, key_prefix, rpm_limit, burst,
        daily_token_budget, cache_namespace, semantic_cache_enabled,
        created_at, revoked_at
      FROM api_keys
      ORDER BY created_at DESC
      LIMIT 50
      `,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      rpmLimit: Number(row.rpm_limit),
      burst: Number(row.burst),
      dailyTokenBudget: Number(row.daily_token_budget),
      cacheNamespace: Number(row.cache_namespace),
      semanticCacheEnabled: Boolean(row.semantic_cache_enabled),
      createdAt: new Date(row.created_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    }));
  }

  public async revokeKey(id: string): Promise<boolean> {
    const result = await this.pool.query<{ key_hash: string }>(
      `
      UPDATE api_keys
      SET revoked_at = NOW()
      WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING key_hash
      `,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async getKeyHashById(id: string): Promise<string | null> {
    const result = await this.pool.query<{ key_hash: string }>(
      'SELECT key_hash FROM api_keys WHERE id = $1::uuid LIMIT 1',
      [id],
    );
    return result.rows[0]?.key_hash.trim() ?? null;
  }

  public async incrementCacheNamespace(id: string): Promise<number | null> {
    const result = await this.pool.query<{ cache_namespace: number }>(
      `
      UPDATE api_keys
      SET cache_namespace = cache_namespace + 1
      WHERE id = $1::uuid
      RETURNING cache_namespace
      `,
      [id],
    );
    const row = result.rows[0];
    return row ? Number(row.cache_namespace) : null;
  }
}

export class CachedApiKeyRepository implements ApiKeyRepository {
  private readonly inner: PgApiKeyRepository;
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly logger?: FastifyBaseLogger;

  constructor(
    inner: PgApiKeyRepository,
    redis: Redis,
    ttlSeconds = 60,
    logger?: FastifyBaseLogger,
  ) {
    this.inner = inner;
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.logger = logger;
  }

  private redisKey(keyHash: string): string {
    return `cr:key:${keyHash}`;
  }

  public async findByPlaintextKey(plaintextKey: string): Promise<ApiKeyContext | null> {
    const keyHash = hashApiKey(plaintextKey);
    const cacheKey = this.redisKey(keyHash);

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as ApiKeyContext & { revokedAt: string | null };
        return {
          ...parsed,
          revokedAt: parsed.revokedAt ? new Date(parsed.revokedAt) : null,
        };
      }
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'CachedApiKeyRepository Redis lookup failed; falling back to DB');
    }

    let dbRecord: ApiKeyContext | null;
    try {
      dbRecord = await this.inner.findByPlaintextKey(plaintextKey);
    } catch (err: unknown) {
      this.logger?.error({ err }, 'Postgres auth lookup failed while key not cached');
      throw GatewayError.authBackendUnavailable();
    }

    if (dbRecord && !dbRecord.revokedAt) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(dbRecord), 'EX', this.ttlSeconds);
      } catch {
        // Ignore Redis write error
      }
    }

    return dbRecord;
  }

  public async createKey(input: CreateApiKeyInput): Promise<CreatedApiKeyResult> {
    return this.inner.createKey(input);
  }

  public async listKeys(): Promise<ApiKeySummary[]> {
    return this.inner.listKeys();
  }

  public async revokeKey(id: string): Promise<boolean> {
    const keyHash = await this.inner.getKeyHashById(id);
    const revoked = await this.inner.revokeKey(id);
    if (keyHash) {
      await this.redis.del(this.redisKey(keyHash)).catch(() => undefined);
    }
    return revoked;
  }

  public async incrementCacheNamespace(id: string): Promise<number | null> {
    const keyHash = await this.inner.getKeyHashById(id);
    const nextNs = await this.inner.incrementCacheNamespace(id);
    if (keyHash) {
      await this.redis.del(this.redisKey(keyHash)).catch(() => undefined);
    }
    return nextNs;
  }
}
