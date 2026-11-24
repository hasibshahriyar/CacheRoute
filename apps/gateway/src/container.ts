import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { CachedApiKeyRepository, PgApiKeyRepository } from './adapters/ApiKeyRepositoryAdapter.js';
import { InlineBackgroundTasks, VercelBackgroundTasks } from './adapters/BackgroundTasksAdapter.js';
import { InMemoryCircuitBreaker } from './adapters/InMemoryCircuitBreaker.js';
import { OpenAICompatibleProvider } from './adapters/OpenAICompatibleProvider.js';
import { PgRequestLogSink } from './adapters/PgRequestLogSink.js';
import { PgVectorSemanticCache } from './adapters/PgVectorSemanticCache.js';
import { RedisCircuitBreaker } from './adapters/RedisCircuitBreaker.js';
import { RedisExactCache } from './adapters/RedisExactCache.js';
import { RedisTokenBucketLimiter } from './adapters/RedisTokenBucketLimiter.js';
import { RedisTokenBudget } from './adapters/RedisTokenBudget.js';
import { SystemClock } from './adapters/SystemClock.js';
import { TransformersEmbeddingModel } from './adapters/TransformersEmbeddingModel.js';
import { loadConfig, type GatewayConfig } from './config.js';
import { CacheabilityPolicy } from './domain/CacheabilityPolicy.js';
import { CacheKeyBuilder } from './domain/CacheKeyBuilder.js';
import { EntityGuard } from './domain/EntityGuard.js';
import type {
  ApiKeyRepository,
  BackgroundTasks,
  CircuitBreaker,
  Clock,
  EmbeddingModel,
  ExactCacheStore,
  LlmProvider,
  RateLimiter,
  RequestLogSink,
  SemanticCacheStore,
  TokenBudget,
} from './ports/index.js';
import { CacheService } from './services/CacheService.js';
import { ChatCompletionService } from './services/ChatCompletionService.js';
import { MetricsRegistry } from './services/MetricsRegistry.js';
import { ProviderRouter } from './services/ProviderRouter.js';
import { UsageService } from './services/UsageService.js';

export interface GatewayContainer {
  config: GatewayConfig;
  redis: Redis;
  pgPool: pg.Pool;
  clock: Clock;
  backgroundTasks: BackgroundTasks;
  embeddingModel: EmbeddingModel;
  exactCache: ExactCacheStore;
  semanticCache: SemanticCacheStore;
  rateLimiter: RateLimiter;
  tokenBudget: TokenBudget;
  circuitBreaker: CircuitBreaker;
  apiKeyRepository: ApiKeyRepository;
  requestLogSink: RequestLogSink;
  metrics: MetricsRegistry;
  cacheService: CacheService;
  providerRouter: ProviderRouter;
  usageService: UsageService;
  chatCompletionService: ChatCompletionService;
  close: () => Promise<void>;
}

export interface ContainerOverrides {
  config?: GatewayConfig;
  redis?: Redis;
  pgPool?: pg.Pool;
  clock?: Clock;
  backgroundTasks?: BackgroundTasks;
  embeddingModel?: EmbeddingModel;
  exactCache?: ExactCacheStore;
  semanticCache?: SemanticCacheStore;
  rateLimiter?: RateLimiter;
  tokenBudget?: TokenBudget;
  circuitBreaker?: CircuitBreaker;
  apiKeyRepository?: ApiKeyRepository;
  requestLogSink?: RequestLogSink;
  metrics?: MetricsRegistry;
  routes?: Map<string, LlmProvider[]>;
  logger?: FastifyBaseLogger;
}

export function createContainer(overrides: ContainerOverrides = {}): GatewayContainer {
  const config = overrides.config ?? loadConfig();
  const logger = overrides.logger;
  const clock = overrides.clock ?? new SystemClock();

  const redis =
    overrides.redis ??
    new Redis(config.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      commandTimeout: 500,
      lazyConnect: true,
      enableOfflineQueue: true,
    });

  // Prevent unhandled Redis error crashes in degraded mode
  redis.on('error', (err) => {
    logger?.warn({ err: err.message }, 'Redis connection error event');
  });

  const pgPool =
    overrides.pgPool ??
    new pg.Pool({
      connectionString: config.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
    });

  pgPool.on('error', (err) => {
    logger?.warn({ err: err.message }, 'Postgres pool error event');
  });

  const isVercel = Boolean(process.env.VERCEL);
  const backgroundTasks =
    overrides.backgroundTasks ??
    (isVercel ? new VercelBackgroundTasks(logger) : new InlineBackgroundTasks(logger));

  const embeddingModel = overrides.embeddingModel ?? new TransformersEmbeddingModel();
  const keyBuilder = new CacheKeyBuilder();
  const entityGuard = new EntityGuard();
  const policy = new CacheabilityPolicy(entityGuard);

  const exactCache = overrides.exactCache ?? new RedisExactCache(redis, keyBuilder, logger);
  const semanticCache = overrides.semanticCache ?? new PgVectorSemanticCache(pgPool, logger);
  const rateLimiter = overrides.rateLimiter ?? new RedisTokenBucketLimiter(redis, clock, logger);
  const tokenBudget = overrides.tokenBudget ?? new RedisTokenBudget(redis, clock, logger);
  const inMemoryBreaker = new InMemoryCircuitBreaker(clock);
  const circuitBreaker =
    overrides.circuitBreaker ?? new RedisCircuitBreaker(redis, clock, inMemoryBreaker, logger);

  const pgApiKeyRepo = new PgApiKeyRepository(pgPool);
  const apiKeyRepository =
    overrides.apiKeyRepository ?? new CachedApiKeyRepository(pgApiKeyRepo, redis, 60, logger);

  const requestLogSink = overrides.requestLogSink ?? new PgRequestLogSink(pgPool, logger);
  const metrics = overrides.metrics ?? new MetricsRegistry(config.env.NODE_ENV !== 'test');

  const routeMap =
    overrides.routes ??
    new Map<string, LlmProvider[]>(
      Object.entries(config.routes).map(([alias, endpoints]) => [
        alias,
        endpoints.map((ep) => new OpenAICompatibleProvider(ep)),
      ]),
    );

  const cacheService = new CacheService({
    exactCache,
    semanticCache,
    embeddingModel,
    keyBuilder,
    policy,
    threshold: config.env.SEMANTIC_THRESHOLD,
    ttlSeconds: config.env.CACHE_TTL_SECONDS,
    logger,
  });

  const providerRouter = new ProviderRouter({
    routes: routeMap,
    circuitBreaker,
    metrics,
    logger,
  });

  const usageService = new UsageService({
    requestLogSink,
    tokenBudget,
    metrics,
  });

  const chatCompletionService = new ChatCompletionService({
    cacheService,
    providerRouter,
    usageService,
    backgroundTasks,
    policy,
  });

  const close = async () => {
    if (backgroundTasks instanceof InlineBackgroundTasks) {
      await backgroundTasks.flush();
    }
    await redis.quit().catch(() => redis.disconnect());
    await pgPool.end().catch(() => undefined);
  };

  return {
    config,
    redis,
    pgPool,
    clock,
    backgroundTasks,
    embeddingModel,
    exactCache,
    semanticCache,
    rateLimiter,
    tokenBudget,
    circuitBreaker,
    apiKeyRepository,
    requestLogSink,
    metrics,
    cacheService,
    providerRouter,
    usageService,
    chatCompletionService,
    close,
  };
}
