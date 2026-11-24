import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { CircuitBreakerState } from '../domain/types.js';

const STATE_TO_NUM: Record<CircuitBreakerState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

export class MetricsRegistry {
  public readonly registry: Registry;
  public readonly requestsTotal: Counter<
    'model_alias' | 'provider' | 'cache_status' | 'status_code' | 'stream'
  >;
  public readonly requestDurationMs: Histogram<'model_alias' | 'cache_status'>;
  public readonly upstreamAttemptsTotal: Counter<'provider' | 'status'>;
  public readonly circuitBreakerState: Gauge<'provider'>;
  public readonly tokensSavedTotal: Counter<'type'>;

  constructor(enableDefaultMetrics = true) {
    this.registry = new Registry();
    if (enableDefaultMetrics) {
      collectDefaultMetrics({ register: this.registry, prefix: 'cacheroute_' });
    }

    this.requestsTotal = new Counter({
      name: 'cacheroute_requests_total',
      help: 'Total chat completion requests processed by CacheRoute',
      labelNames: ['model_alias', 'provider', 'cache_status', 'status_code', 'stream'],
      registers: [this.registry],
    });

    this.requestDurationMs = new Histogram({
      name: 'cacheroute_request_duration_ms',
      help: 'Gateway request processing latency in milliseconds',
      labelNames: ['model_alias', 'cache_status'],
      buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
      registers: [this.registry],
    });

    this.upstreamAttemptsTotal = new Counter({
      name: 'cacheroute_upstream_attempts_total',
      help: 'Total upstream provider execution attempts',
      labelNames: ['provider', 'status'],
      registers: [this.registry],
    });

    this.circuitBreakerState = new Gauge({
      name: 'cacheroute_circuit_breaker_state',
      help: 'Circuit breaker state per provider (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.tokensSavedTotal = new Counter({
      name: 'cacheroute_tokens_saved_total',
      help: 'Estimated tokens saved via L1 exact and L2 semantic cache hits',
      labelNames: ['type'],
      registers: [this.registry],
    });
  }

  public setBreakerState(provider: string, state: CircuitBreakerState): void {
    this.circuitBreakerState.set({ provider }, STATE_TO_NUM[state] ?? 0);
  }
}
