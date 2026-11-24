import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Clock, TokenBudget, TokenBudgetDecision } from '../ports/index.js';
import { SystemClock } from './SystemClock.js';

export class RedisTokenBudget implements TokenBudget {
  private readonly redis: Redis;
  private readonly clock: Clock;
  private readonly logger?: FastifyBaseLogger;

  constructor(redis: Redis, clock: Clock = new SystemClock(), logger?: FastifyBaseLogger) {
    this.redis = redis;
    this.clock = clock;
    this.logger = logger;
  }

  private buildKey(keyId: string): string {
    const date = new Date(this.clock.nowMs());
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `cr:budget:${keyId}:${yyyy}${mm}${dd}`;
  }

  public async check(keyId: string, dailyBudget: number): Promise<TokenBudgetDecision> {
    const key = this.buildKey(keyId);
    try {
      const raw = await this.redis.get(key);
      const usedTokens = raw ? Number(raw) : 0;
      return {
        allowed: usedTokens < dailyBudget,
        usedTokens,
        dailyBudget,
      };
    } catch (err: unknown) {
      // Fail-open when Redis is unreachable
      this.logger?.warn({ err, keyId }, 'RedisTokenBudget.check failed; failing open');
      return {
        allowed: true,
        usedTokens: 0,
        dailyBudget,
      };
    }
  }

  public async increment(keyId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const key = this.buildKey(keyId);
    try {
      await this.redis.multi().incrby(key, tokens).expire(key, 172800).exec();
    } catch (err: unknown) {
      this.logger?.warn({ err, keyId }, 'RedisTokenBudget.increment failed');
    }
  }
}
