import {
  bigserial,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(384)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
  },
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  keyHash: char('key_hash', { length: 64 }).notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  rpmLimit: integer('rpm_limit').notNull().default(60),
  burst: integer('burst').notNull().default(20),
  dailyTokenBudget: integer('daily_token_budget').notNull().default(200000),
  cacheNamespace: integer('cache_namespace').notNull().default(1),
  semanticCacheEnabled: boolean('semantic_cache_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const cacheEntries = pgTable(
  'cache_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    namespace: integer('namespace').notNull(),
    modelAlias: text('model_alias').notNull(),
    scopeHash: char('scope_hash', { length: 64 }).notNull(),
    exactKey: char('exact_key', { length: 64 }).notNull(),
    promptText: text('prompt_text').notNull(),
    embedding: vector384('embedding').notNull(),
    response: jsonb('response').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('idx_cache_entries_unique_exact').on(
      table.tenantId,
      table.namespace,
      table.exactKey,
    ),
    index('idx_cache_entries_scope_lookup').on(
      table.tenantId,
      table.namespace,
      table.modelAlias,
      table.scopeHash,
      table.expiresAt,
    ),
  ],
);

export const requestLogs = pgTable(
  'request_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestId: uuid('request_id').notNull(),
    tenantId: uuid('tenant_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    modelAlias: text('model_alias').notNull(),
    provider: text('provider').notNull(),
    upstreamModel: text('upstream_model'),
    stream: boolean('stream').notNull().default(false),
    cacheStatus: text('cache_status').notNull(),
    similarity: real('similarity'),
    statusCode: integer('status_code').notNull(),
    errorCode: text('error_code'),
    attempts: integer('attempts').notNull().default(0),
    latencyMs: integer('latency_ms').notNull(),
    ttftMs: integer('ttft_ms'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_request_logs_created_at').on(table.createdAt),
    index('idx_request_logs_tenant_created_at').on(table.tenantId, table.createdAt),
  ],
);
