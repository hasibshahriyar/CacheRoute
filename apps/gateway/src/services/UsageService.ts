import type { RequestLogEntry, RequestLogSink, TokenBudget } from '../ports/index.js';
import type { MetricsRegistry } from './MetricsRegistry.js';

export class UsageService {
  private readonly requestLogSink: RequestLogSink;
  private readonly tokenBudget: TokenBudget;
  private readonly metrics: MetricsRegistry;

  constructor(params: {
    requestLogSink: RequestLogSink;
    tokenBudget: TokenBudget;
    metrics: MetricsRegistry;
  }) {
    this.requestLogSink = params.requestLogSink;
    this.tokenBudget = params.tokenBudget;
    this.metrics = params.metrics;
  }

  public recordMetricsSync(entry: RequestLogEntry): void {
    this.metrics.requestsTotal.inc({
      model_alias: entry.modelAlias,
      provider: entry.provider,
      cache_status: entry.cacheStatus,
      status_code: String(entry.statusCode),
      stream: String(entry.stream),
    });

    this.metrics.requestDurationMs.observe(
      {
        model_alias: entry.modelAlias,
        cache_status: entry.cacheStatus,
      },
      entry.latencyMs,
    );

    const totalTokens = entry.promptTokens + entry.completionTokens;
    if (totalTokens > 0) {
      if (entry.cacheStatus === 'HIT-EXACT') {
        this.metrics.tokensSavedTotal.inc({ type: 'exact' }, totalTokens);
      } else if (entry.cacheStatus === 'HIT-SEMANTIC') {
        this.metrics.tokensSavedTotal.inc({ type: 'semantic' }, totalTokens);
      }
    }
  }

  public async persistAsync(entry: RequestLogEntry): Promise<void> {
    const totalTokens = entry.promptTokens + entry.completionTokens;
    if (
      entry.tenantId &&
      totalTokens > 0 &&
      (entry.cacheStatus === 'MISS' || entry.cacheStatus === 'BYPASS')
    ) {
      await this.tokenBudget.increment(entry.tenantId, totalTokens);
    }
    await this.requestLogSink.write(entry);
  }
}
