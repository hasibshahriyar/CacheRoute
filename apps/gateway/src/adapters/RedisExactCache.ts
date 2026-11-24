import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { CacheKeyBuilder } from '../domain/CacheKeyBuilder.js';
import type { CachedCompletionRecord } from '../domain/types.js';
import type { ExactCacheStore } from '../ports/index.js';

export class RedisExactCache implements ExactCacheStore {
  private readonly redis: Redis;
  private readonly keyBuilder: CacheKeyBuilder;
  private readonly logger?: FastifyBaseLogger;

  constructor(redis: Redis, keyBuilder = new CacheKeyBuilder(), logger?: FastifyBaseLogger) {
    this.redis = redis;
    this.keyBuilder = keyBuilder;
    this.logger = logger;
  }

  public async get(
    tenantId: string,
    namespace: number,
    exactKey: string,
  ): Promise<CachedCompletionRecord | null> {
    const key = this.keyBuilder.buildRedisCacheKey(tenantId, namespace, exactKey);
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as CachedCompletionRecord;
    } catch (err: unknown) {
      this.logger?.warn({ err, key }, 'RedisExactCache.get failed; degrading to L1 miss');
      return null;
    }
  }

  public async set(
    tenantId: string,
    namespace: number,
    exactKey: string,
    record: CachedCompletionRecord,
    ttlSeconds: number,
  ): Promise<void> {
    const key = this.keyBuilder.buildRedisCacheKey(tenantId, namespace, exactKey);
    try {
      await this.redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
    } catch (err: unknown) {
      this.logger?.warn({ err, key }, 'RedisExactCache.set failed');
    }
  }
}
