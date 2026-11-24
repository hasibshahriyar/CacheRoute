import { describe, expect, it } from 'vitest';
import { InMemoryCircuitBreaker } from '../../src/adapters/InMemoryCircuitBreaker.js';
import type { Clock } from '../../src/ports/index.js';

class FakeClock implements Clock {
  public currentMs = 1_000_000;
  public nowMs(): number {
    return this.currentMs;
  }
  public advance(ms: number): void {
    this.currentMs += ms;
  }
}

describe('CircuitBreaker State Machine', () => {
  it('opens after 5 consecutive failures and transitions OPEN -> HALF_OPEN -> CLOSED', async () => {
    const clock = new FakeClock();
    const breaker = new InMemoryCircuitBreaker(clock);

    for (let i = 0; i < 4; i++) {
      expect(await breaker.recordFailure('groq')).toBe('CLOSED');
    }
    expect(await breaker.recordFailure('groq')).toBe('OPEN');

    // While OPEN before 30s cooldown, requests are blocked
    expect(await breaker.canExecute('groq')).toEqual({ allowed: false, state: 'OPEN' });

    // Advance 30s -> single probe transitions to HALF_OPEN
    clock.advance(30_000);
    expect(await breaker.canExecute('groq')).toEqual({ allowed: true, state: 'HALF_OPEN' });

    // Concurrent request while probe is in flight is rejected
    expect(await breaker.canExecute('groq')).toEqual({ allowed: false, state: 'HALF_OPEN' });

    // Probe succeeds -> resets to CLOSED
    expect(await breaker.recordSuccess('groq')).toBe('CLOSED');
    expect(await breaker.canExecute('groq')).toEqual({ allowed: true, state: 'CLOSED' });
  });

  it('opens when 30s sliding window has >= 10 requests and >= 50% failure rate even without 5 consecutive failures', async () => {
    const clock = new FakeClock();
    const breaker = new InMemoryCircuitBreaker(clock);

    // Alternate success and failure for 10 total requests (5 successes, 5 failures = 50% fail rate)
    for (let i = 0; i < 5; i++) {
      await breaker.recordSuccess('gemini');
      const state = await breaker.recordFailure('gemini');
      if (i < 4) {
        expect(state).toBe('CLOSED');
      } else {
        expect(state).toBe('OPEN');
      }
      clock.advance(100);
    }
  });

  it('doubles cooldown on HALF_OPEN probe failure up to 5-minute (300s) cap', async () => {
    const clock = new FakeClock();
    const breaker = new InMemoryCircuitBreaker(clock);

    // Trip breaker (1st open: 30s cooldown)
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('openrouter');
    }
    expect((await breaker.canExecute('openrouter')).allowed).toBe(false);

    // 30s later -> HALF_OPEN probe fails -> 2nd open: 60s cooldown
    clock.advance(30_000);
    expect(await breaker.canExecute('openrouter')).toEqual({ allowed: true, state: 'HALF_OPEN' });
    expect(await breaker.recordFailure('openrouter')).toBe('OPEN');

    // After 30s it should STILL be OPEN (needs 60s)
    clock.advance(30_000);
    expect(await breaker.canExecute('openrouter')).toEqual({ allowed: false, state: 'OPEN' });

    // After another 30s (total 60s), transitions to HALF_OPEN
    clock.advance(30_000);
    expect(await breaker.canExecute('openrouter')).toEqual({ allowed: true, state: 'HALF_OPEN' });
  });
});
