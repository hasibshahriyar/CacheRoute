import type { FastifyBaseLogger } from 'fastify';
import { UpstreamProviderError } from '../adapters/OpenAICompatibleProvider.js';
import { GatewayError } from '../domain/GatewayError.js';
import type { ChatCompletionRequest } from '../domain/types.js';
import type {
  CircuitBreaker,
  LlmProvider,
  UpstreamCompletionResult,
  UpstreamStreamResult,
} from '../ports/index.js';
import type { MetricsRegistry } from './MetricsRegistry.js';

export interface RoutedCompletionResult extends UpstreamCompletionResult {
  attempts: number;
}

export interface RoutedStreamResult extends UpstreamStreamResult {
  attempts: number;
}

export class ProviderRouter {
  private readonly routes: Map<string, LlmProvider[]>;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly metrics: MetricsRegistry;
  private readonly logger?: FastifyBaseLogger;

  constructor(params: {
    routes: Map<string, LlmProvider[]>;
    circuitBreaker: CircuitBreaker;
    metrics: MetricsRegistry;
    logger?: FastifyBaseLogger;
  }) {
    this.routes = params.routes;
    this.circuitBreaker = params.circuitBreaker;
    this.metrics = params.metrics;
    this.logger = params.logger;
  }

  public getSupportedModels(): string[] {
    return Array.from(this.routes.keys());
  }

  public resolveRoute(modelAlias: string): LlmProvider[] {
    const chain = this.routes.get(modelAlias);
    if (!chain || chain.length === 0) {
      throw GatewayError.modelNotFound(modelAlias);
    }
    return chain.slice(0, 3);
  }

  public async complete(
    request: ChatCompletionRequest,
    forwardHeaders?: Record<string, string>,
  ): Promise<RoutedCompletionResult> {
    const chain = this.resolveRoute(request.model);
    let attempts = 0;
    const errors: string[] = [];

    for (const provider of chain) {
      const check = await this.circuitBreaker.canExecute(provider.name);
      this.metrics.setBreakerState(provider.name, check.state);
      if (!check.allowed) {
        errors.push(`${provider.name}:circuit_${check.state}`);
        continue;
      }

      attempts += 1;
      try {
        const result = await provider.complete(request, forwardHeaders);
        const newState = await this.circuitBreaker.recordSuccess(provider.name);
        this.metrics.setBreakerState(provider.name, newState);
        this.metrics.upstreamAttemptsTotal.inc({ provider: provider.name, status: 'success' });
        return {
          ...result,
          attempts,
        };
      } catch (err: unknown) {
        this.metrics.upstreamAttemptsTotal.inc({ provider: provider.name, status: 'error' });

        if (err instanceof UpstreamProviderError) {
          if (err.isCriticalAuthAlert) {
            this.logger?.error(
              { provider: provider.name, statusCode: err.statusCode },
              'CRITICAL: Upstream LLM provider authentication failed (401/403)',
            );
          }

          if (err.countsAsBreakerFailure) {
            const newState = await this.circuitBreaker.recordFailure(
              provider.name,
              err.retryAfterMs,
            );
            this.metrics.setBreakerState(provider.name, newState);
          }

          if (!err.isFailoverEligible) {
            throw GatewayError.upstreamClientError(err.statusCode, err.message);
          }

          errors.push(`${provider.name}:${err.statusCode}`);
          continue;
        }

        const newState = await this.circuitBreaker.recordFailure(provider.name);
        this.metrics.setBreakerState(provider.name, newState);
        errors.push(`${provider.name}:error`);
      }
    }

    throw GatewayError.allProvidersFailed(errors.join(', '));
  }

  public async stream(
    request: ChatCompletionRequest,
    forwardHeaders?: Record<string, string>,
  ): Promise<RoutedStreamResult> {
    const chain = this.resolveRoute(request.model);
    let attempts = 0;
    const errors: string[] = [];

    for (const provider of chain) {
      const check = await this.circuitBreaker.canExecute(provider.name);
      this.metrics.setBreakerState(provider.name, check.state);
      if (!check.allowed) {
        errors.push(`${provider.name}:circuit_${check.state}`);
        continue;
      }

      attempts += 1;
      try {
        const result = await provider.stream(request, forwardHeaders);
        const newState = await this.circuitBreaker.recordSuccess(provider.name);
        this.metrics.setBreakerState(provider.name, newState);
        this.metrics.upstreamAttemptsTotal.inc({ provider: provider.name, status: 'success' });
        return {
          ...result,
          attempts,
        };
      } catch (err: unknown) {
        this.metrics.upstreamAttemptsTotal.inc({ provider: provider.name, status: 'error' });

        if (err instanceof UpstreamProviderError) {
          if (err.isCriticalAuthAlert) {
            this.logger?.error(
              { provider: provider.name, statusCode: err.statusCode },
              'CRITICAL: Upstream LLM provider authentication failed (401/403)',
            );
          }

          if (err.countsAsBreakerFailure) {
            const newState = await this.circuitBreaker.recordFailure(
              provider.name,
              err.retryAfterMs,
            );
            this.metrics.setBreakerState(provider.name, newState);
          }

          if (!err.isFailoverEligible) {
            throw GatewayError.upstreamClientError(err.statusCode, err.message);
          }

          errors.push(`${provider.name}:${err.statusCode}`);
          continue;
        }

        const newState = await this.circuitBreaker.recordFailure(provider.name);
        this.metrics.setBreakerState(provider.name, newState);
        errors.push(`${provider.name}:error`);
      }
    }

    throw GatewayError.allProvidersFailed(errors.join(', '));
  }
}
