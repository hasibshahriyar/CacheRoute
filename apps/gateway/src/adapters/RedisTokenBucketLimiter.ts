import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Clock, RateLimitDecision, RateLimiter } from '../ports/index.js';
import { SystemClock } from './SystemClock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_BUCKET_LUA = readFileSync(resolve(__dirname, '../lua/token_bucket.lua'), 'utf8');

export class RedisTokenBucketLimiter implements RateLimiter {
  private readonly redis: Redis;
  private readonly clock: Clock;
  private readonly logger?: FastifyBaseLogger;
  private scriptSha: string | null = null;

  constructor(redis: Redis, clock: Clock = new SystemClock(), logger?: FastifyBaseLogger) {
    this.redis = redis;
    this.clock = clock;
    this.logger = logger;
  }

  private async evalTokenBucket(
    key: string,
    capacity: number,
    refillPerSec: number,
    cost: number,
    nowSec: number,
  ): Promise<[number, string]> {
    const args = [String(capacity), String(refillPerSec), String(cost), String(nowSec)];
    if (!this.scriptSha) {
      this.scriptSha = (await this.redis.script('LOAD', TOKEN_BUCKET_LUA)) as string;
    }
    try {
      return (await this.redis.evalsha(this.scriptSha, 1, key, ...args)) as [number, string];
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        this.scriptSha = (await this.redis.script('LOAD', TOKEN_BUCKET_LUA)) as string;
        return (await this.redis.evalsha(this.scriptSha, 1, key, ...args)) as [number, string];
      }
      throw err;
    }
  }

  public async consume(keyId: string, rpmLimit: number, burst: number): Promise<RateLimitDecision> {
    const refillPerSec = rpmLimit / 60;
    const nowSec = this.clock.nowMs() / 1000;
    const redisKey = `cr:rl:${keyId}`;

    try {
      const [allowedNum, tokensStr] = await this.evalTokenBucket(
        redisKey,
        burst,
        refillPerSec,
        1,
        nowSec,
      );
      const allowed = Number(allowedNum) === 1;
      const tokens = Number(tokensStr);
      const remaining = Math.max(0, Math.floor(tokens));
      const neededForNext = allowed ? Math.max(0, burst - tokens) : Math.max(0, 1 - tokens);
      const resetSeconds = Math.max(1, Math.ceil(neededForNext / Math.max(0.001, refillPerSec)));
      const retryAfterSeconds = allowed
        ? 0
        : Math.max(1, Math.ceil((1 - tokens) / Math.max(0.001, refillPerSec)));

      return {
        allowed,
        limit: rpmLimit,
        remaining,
        resetSeconds,
        retryAfterSeconds,
      };
    } catch (err: unknown) {
      // Fail-open when Redis is unreachable
      this.logger?.warn({ err, keyId }, 'RedisTokenBucketLimiter failed; failing open');
      return {
        allowed: true,
        limit: rpmLimit,
        remaining: burst,
        resetSeconds: 1,
        retryAfterSeconds: 0,
      };
    }
  }
}
