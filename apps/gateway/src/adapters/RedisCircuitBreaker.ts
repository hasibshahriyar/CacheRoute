import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { CircuitBreakerState } from '../domain/types.js';
import type { CircuitBreaker, CircuitBreakerCheck, Clock } from '../ports/index.js';
import { InMemoryCircuitBreaker } from './InMemoryCircuitBreaker.js';
import { SystemClock } from './SystemClock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_BREAKER_LUA = readFileSync(resolve(__dirname, '../lua/circuit_breaker.lua'), 'utf8');

export class RedisCircuitBreaker implements CircuitBreaker {
  private readonly redis: Redis;
  private readonly clock: Clock;
  private readonly fallback: InMemoryCircuitBreaker;
  private readonly logger?: FastifyBaseLogger;
  private scriptSha: string | null = null;

  constructor(
    redis: Redis,
    clock: Clock = new SystemClock(),
    fallback = new InMemoryCircuitBreaker(clock),
    logger?: FastifyBaseLogger,
  ) {
    this.redis = redis;
    this.clock = clock;
    this.fallback = fallback;
    this.logger = logger;
  }

  private async runLua(
    provider: string,
    action: 'can_execute' | 'record_success' | 'record_failure' | 'get_state',
    retryAfterMs = 0,
  ): Promise<[number, CircuitBreakerState, string]> {
    const stateKey = `cr:cb:${provider}`;
    const probeKey = `cr:cb:${provider}:probe`;
    const nowMs = String(this.clock.nowMs());
    const retryStr = String(retryAfterMs);

    if (!this.scriptSha) {
      this.scriptSha = (await this.redis.script('LOAD', CIRCUIT_BREAKER_LUA)) as string;
    }

    try {
      return (await this.redis.evalsha(
        this.scriptSha,
        2,
        stateKey,
        probeKey,
        action,
        nowMs,
        retryStr,
      )) as [number, CircuitBreakerState, string];
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        this.scriptSha = (await this.redis.script('LOAD', CIRCUIT_BREAKER_LUA)) as string;
        return (await this.redis.evalsha(
          this.scriptSha,
          2,
          stateKey,
          probeKey,
          action,
          nowMs,
          retryStr,
        )) as [number, CircuitBreakerState, string];
      }
      throw err;
    }
  }

  public async canExecute(provider: string): Promise<CircuitBreakerCheck> {
    try {
      const [allowedNum, state] = await this.runLua(provider, 'can_execute');
      return {
        allowed: Number(allowedNum) === 1,
        state,
      };
    } catch (err: unknown) {
      this.logger?.warn({ err, provider }, 'RedisCircuitBreaker failed; falling back to in-memory');
      return this.fallback.canExecute(provider);
    }
  }

  public async recordSuccess(provider: string): Promise<CircuitBreakerState> {
    try {
      const [, state] = await this.runLua(provider, 'record_success');
      await this.fallback.recordSuccess(provider);
      return state;
    } catch (err: unknown) {
      this.logger?.warn({ err, provider }, 'RedisCircuitBreaker.recordSuccess fallback');
      return this.fallback.recordSuccess(provider);
    }
  }

  public async recordFailure(provider: string, retryAfterMs = 0): Promise<CircuitBreakerState> {
    try {
      const [, state] = await this.runLua(provider, 'record_failure', retryAfterMs);
      await this.fallback.recordFailure(provider, retryAfterMs);
      return state;
    } catch (err: unknown) {
      this.logger?.warn({ err, provider }, 'RedisCircuitBreaker.recordFailure fallback');
      return this.fallback.recordFailure(provider, retryAfterMs);
    }
  }

  public async getState(provider: string): Promise<CircuitBreakerState> {
    try {
      const [, state] = await this.runLua(provider, 'get_state');
      return state;
    } catch {
      return this.fallback.getState(provider);
    }
  }
}
