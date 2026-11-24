import type { CircuitBreakerState } from '../domain/types.js';
import type { CircuitBreaker, CircuitBreakerCheck, Clock } from '../ports/index.js';
import { SystemClock } from './SystemClock.js';

interface ProviderBreakerRecord {
  state: CircuitBreakerState;
  openUntilMs: number;
  consecutiveFailures: number;
  backoffLevel: number;
  probeLockUntilMs: number;
  windowEvents: Array<{ ts: number; ok: boolean }>;
}

export class InMemoryCircuitBreaker implements CircuitBreaker {
  private readonly clock: Clock;
  private readonly states = new Map<string, ProviderBreakerRecord>();

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  private getRecord(provider: string): ProviderBreakerRecord {
    let record = this.states.get(provider);
    if (!record) {
      record = {
        state: 'CLOSED',
        openUntilMs: 0,
        consecutiveFailures: 0,
        backoffLevel: 0,
        probeLockUntilMs: 0,
        windowEvents: [],
      };
      this.states.set(provider, record);
    }
    return record;
  }

  private pruneWindow(record: ProviderBreakerRecord, nowMs: number): void {
    const cutoff = nowMs - 30_000;
    record.windowEvents = record.windowEvents.filter((e) => e.ts >= cutoff);
  }

  public async getState(provider: string): Promise<CircuitBreakerState> {
    return this.getRecord(provider).state;
  }

  public async canExecute(provider: string): Promise<CircuitBreakerCheck> {
    const nowMs = this.clock.nowMs();
    const record = this.getRecord(provider);

    if (record.state === 'CLOSED') {
      return { allowed: true, state: 'CLOSED' };
    }

    if (record.state === 'OPEN') {
      if (nowMs < record.openUntilMs) {
        return { allowed: false, state: 'OPEN' };
      }
      record.state = 'HALF_OPEN';
      record.probeLockUntilMs = nowMs + 10_000;
      return { allowed: true, state: 'HALF_OPEN' };
    }

    // HALF_OPEN: allow only if the 10s probe lock has expired
    if (nowMs >= record.probeLockUntilMs) {
      record.probeLockUntilMs = nowMs + 10_000;
      return { allowed: true, state: 'HALF_OPEN' };
    }

    return { allowed: false, state: 'HALF_OPEN' };
  }

  public async recordSuccess(provider: string): Promise<CircuitBreakerState> {
    const nowMs = this.clock.nowMs();
    const record = this.getRecord(provider);
    this.pruneWindow(record, nowMs);
    record.windowEvents.push({ ts: nowMs, ok: true });
    record.state = 'CLOSED';
    record.openUntilMs = 0;
    record.consecutiveFailures = 0;
    record.backoffLevel = 0;
    record.probeLockUntilMs = 0;
    return 'CLOSED';
  }

  public async recordFailure(provider: string, retryAfterMs = 0): Promise<CircuitBreakerState> {
    const nowMs = this.clock.nowMs();
    const record = this.getRecord(provider);
    record.consecutiveFailures += 1;
    this.pruneWindow(record, nowMs);
    record.windowEvents.push({ ts: nowMs, ok: false });

    const total = record.windowEvents.length;
    const failures = record.windowEvents.filter((e) => !e.ok).length;
    const windowTrip = total >= 10 && failures / total >= 0.5;
    const consecutiveTrip = record.consecutiveFailures >= 5;
    const probeTrip = record.state === 'HALF_OPEN';

    if (probeTrip || consecutiveTrip || windowTrip) {
      const baseCooldown = 30_000 * Math.pow(2, record.backoffLevel);
      const cooldownMs = Math.min(300_000, Math.max(baseCooldown, retryAfterMs));
      record.state = 'OPEN';
      record.openUntilMs = nowMs + cooldownMs;
      record.backoffLevel = Math.min(10, record.backoffLevel + 1);
      record.probeLockUntilMs = 0;
    }

    return record.state;
  }
}
