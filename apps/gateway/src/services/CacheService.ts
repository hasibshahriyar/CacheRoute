import type { FastifyBaseLogger } from 'fastify';
import { CacheKeyBuilder } from '../domain/CacheKeyBuilder.js';
import { CacheabilityPolicy, type CacheabilityDecision } from '../domain/CacheabilityPolicy.js';
import type {
  ApiKeyContext,
  CachedCompletionRecord,
  CacheStatus,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../domain/types.js';
import type { EmbeddingModel, ExactCacheStore, SemanticCacheStore } from '../ports/index.js';

export interface CacheLookupResult {
  status: CacheStatus;
  record?: CachedCompletionRecord;
  similarity?: number;
  exactKey: string;
  scopeHash: string;
  embedding?: number[];
}

export class CacheService {
  private readonly exactCache: ExactCacheStore;
  private readonly semanticCache: SemanticCacheStore;
  private readonly embeddingModel: EmbeddingModel;
  private readonly keyBuilder: CacheKeyBuilder;
  private readonly policy: CacheabilityPolicy;
  private readonly threshold: number;
  private readonly ttlSeconds: number;
  private readonly logger?: FastifyBaseLogger;

  constructor(params: {
    exactCache: ExactCacheStore;
    semanticCache: SemanticCacheStore;
    embeddingModel: EmbeddingModel;
    keyBuilder?: CacheKeyBuilder;
    policy?: CacheabilityPolicy;
    threshold: number;
    ttlSeconds: number;
    logger?: FastifyBaseLogger;
  }) {
    this.exactCache = params.exactCache;
    this.semanticCache = params.semanticCache;
    this.embeddingModel = params.embeddingModel;
    this.keyBuilder = params.keyBuilder ?? new CacheKeyBuilder();
    this.policy = params.policy ?? new CacheabilityPolicy();
    this.threshold = params.threshold;
    this.ttlSeconds = params.ttlSeconds;
    this.logger = params.logger;
  }

  public async lookup(
    request: ChatCompletionRequest,
    keyContext: ApiKeyContext,
    decision: CacheabilityDecision,
  ): Promise<CacheLookupResult> {
    const exactKey = this.keyBuilder.buildExactKey(request, keyContext.cacheNamespace);
    const scopeHash = this.keyBuilder.buildScopeHash(request);

    if (!decision.exactEligible) {
      return {
        status: 'BYPASS',
        exactKey,
        scopeHash,
      };
    }

    // Stage 6: L1 Exact Lookup
    const exactRecord = await this.exactCache.get(
      keyContext.id,
      keyContext.cacheNamespace,
      exactKey,
    );
    if (exactRecord) {
      return {
        status: 'HIT-EXACT',
        record: exactRecord,
        exactKey,
        scopeHash,
      };
    }

    // Stage 7: L2 Semantic Lookup
    if (!decision.semanticEligible) {
      return {
        status: 'MISS',
        exactKey,
        scopeHash,
      };
    }

    const lastMessage = request.messages[request.messages.length - 1]?.content ?? '';
    let embedding: number[] | undefined;
    try {
      embedding = await this.embeddingModel.embed(lastMessage);
      const semanticMatch = await this.semanticCache.search({
        tenantId: keyContext.id,
        namespace: keyContext.cacheNamespace,
        modelAlias: request.model,
        scopeHash,
        embedding,
        threshold: this.threshold,
      });

      if (semanticMatch) {
        return {
          status: 'HIT-SEMANTIC',
          record: semanticMatch.record,
          similarity: semanticMatch.similarity,
          exactKey,
          scopeHash,
          embedding,
        };
      }
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'Semantic cache lookup failed; continuing as MISS');
    }

    return {
      status: 'MISS',
      exactKey,
      scopeHash,
      embedding,
    };
  }

  public async store(params: {
    request: ChatCompletionRequest;
    keyContext: ApiKeyContext;
    decision: CacheabilityDecision;
    exactKey: string;
    scopeHash: string;
    embedding?: number[];
    response: ChatCompletionResponse;
    statusCode: number;
  }): Promise<void> {
    if (!params.decision.exactEligible) return;
    if (!this.policy.isResponseCacheable(params.statusCode, params.response)) return;

    const promptTokens = params.response.usage?.prompt_tokens ?? 0;
    const completionTokens = params.response.usage?.completion_tokens ?? 0;

    const record: CachedCompletionRecord = {
      response: params.response,
      promptTokens,
      completionTokens,
      createdAtMs: Date.now(),
    };

    await this.exactCache.set(
      params.keyContext.id,
      params.keyContext.cacheNamespace,
      params.exactKey,
      record,
      this.ttlSeconds,
    );

    if (!params.decision.semanticEligible) return;

    try {
      const lastMessage =
        params.request.messages[params.request.messages.length - 1]?.content ?? '';
      const embedding = params.embedding ?? (await this.embeddingModel.embed(lastMessage));
      await this.semanticCache.insert({
        tenantId: params.keyContext.id,
        namespace: params.keyContext.cacheNamespace,
        modelAlias: params.request.model,
        scopeHash: params.scopeHash,
        exactKey: params.exactKey,
        promptText: lastMessage,
        embedding,
        record,
        ttlSeconds: this.ttlSeconds,
      });
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'Failed to write semantic cache entry');
    }
  }
}
