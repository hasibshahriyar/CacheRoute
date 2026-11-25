import type {
  ApiKeyContext,
  CachedCompletionRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  CircuitBreakerState,
} from '../domain/types.js';

export interface Clock {
  nowMs(): number;
}

export interface BackgroundTasks {
  run(task: () => Promise<void>): void;
}

export interface EmbeddingModel {
  embed(text: string): Promise<number[]>;
  isReady(): boolean;
}

export interface ExactCacheStore {
  get(
    tenantId: string,
    namespace: number,
    exactKey: string,
  ): Promise<CachedCompletionRecord | null>;
  set(
    tenantId: string,
    namespace: number,
    exactKey: string,
    record: CachedCompletionRecord,
    ttlSeconds: number,
  ): Promise<void>;
}

export interface SemanticSearchMatch {
  record: CachedCompletionRecord;
  similarity: number;
}

export interface SemanticCacheInsertParams {
  tenantId: string;
  namespace: number;
  modelAlias: string;
  scopeHash: string;
  exactKey: string;
  promptText: string;
  embedding: number[];
  record: CachedCompletionRecord;
  ttlSeconds: number;
}

export interface SemanticCacheStore {
  search(params: {
    tenantId: string;
    namespace: number;
    modelAlias: string;
    scopeHash: string;
    embedding: number[];
    threshold: number;
  }): Promise<SemanticSearchMatch | null>;
  insert(params: SemanticCacheInsertParams): Promise<void>;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(keyId: string, rpmLimit: number, burst: number): Promise<RateLimitDecision>;
}

export interface TokenBudgetDecision {
  allowed: boolean;
  usedTokens: number;
  dailyBudget: number;
}

export interface TokenBudget {
  check(keyId: string, dailyBudget: number): Promise<TokenBudgetDecision>;
  increment(keyId: string, tokens: number): Promise<void>;
}

export interface CircuitBreakerCheck {
  allowed: boolean;
  state: CircuitBreakerState;
}

export interface CircuitBreaker {
  canExecute(provider: string): Promise<CircuitBreakerCheck>;
  recordSuccess(provider: string): Promise<CircuitBreakerState>;
  recordFailure(provider: string, retryAfterMs?: number): Promise<CircuitBreakerState>;
  getState(provider: string): Promise<CircuitBreakerState>;
}

export interface CreateApiKeyInput {
  name: string;
  rpmLimit?: number;
  burst?: number;
  dailyTokenBudget?: number;
  semanticCacheEnabled?: boolean;
}

export interface CreatedApiKeyResult {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  rpmLimit: number;
  burst: number;
  dailyTokenBudget: number;
  cacheNamespace: number;
  semanticCacheEnabled: boolean;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  rpmLimit: number;
  burst: number;
  dailyTokenBudget: number;
  cacheNamespace: number;
  semanticCacheEnabled: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeyRepository {
  findByPlaintextKey(plaintextKey: string): Promise<ApiKeyContext | null>;
  createKey(input: CreateApiKeyInput): Promise<CreatedApiKeyResult>;
  listKeys(): Promise<ApiKeySummary[]>;
  revokeKey(id: string): Promise<boolean>;
  incrementCacheNamespace(id: string): Promise<number | null>;
}

export interface RecentRequestLogItem {
  id: number;
  requestId: string;
  modelAlias: string;
  provider: string;
  upstreamModel: string | null;
  stream: boolean;
  cacheStatus: string;
  similarity: number | null;
  statusCode: number;
  errorCode: string | null;
  attempts: number;
  latencyMs: number;
  ttftMs: number | null;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
}

export interface RequestLogSink {
  write(entry: RequestLogEntry): Promise<void>;
  getStats(window: '1h' | '24h' | '7d' | '30d'): Promise<AdminStatsSummary>;
  getRecentLogs(limit?: number): Promise<RecentRequestLogItem[]>;
}
export interface RequestLogEntry {
  requestId: string;
  tenantId: string | null;
  modelAlias: string;
  provider: string;
  upstreamModel: string | null;
  stream: boolean;
  cacheStatus: string;
  similarity: number | null;
  statusCode: number;
  errorCode: string | null;
  attempts: number;
  latencyMs: number;
  ttftMs: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface AdminStatsSummary {
  window: '1h' | '24h' | '7d' | '30d';
  totalRequests: number;
  cache: {
    exactHits: number;
    semanticHits: number;
    misses: number;
    bypass: number;
    hitRate: number;
  };
  latencyMs: {
    p50: number;
    p95: number;
  };
  tokensSavedEstimate: number;
  providers: Record<string, { requests: number; errors: number }>;
}

export interface UpstreamCompletionResult {
  provider: string;
  upstreamModel: string;
  response: ChatCompletionResponse;
}

export interface UpstreamStreamResult {
  provider: string;
  upstreamModel: string;
  ttftMs: number;
  stream: ReadableStream<Uint8Array>;
}

export interface LlmProvider {
  readonly name: string;
  readonly upstreamModel: string;
  complete(
    request: ChatCompletionRequest,
    forwardHeaders?: Record<string, string>,
  ): Promise<UpstreamCompletionResult>;
  stream(
    request: ChatCompletionRequest,
    forwardHeaders?: Record<string, string>,
  ): Promise<UpstreamStreamResult>;
}
