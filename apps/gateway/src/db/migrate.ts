import pg from 'pg';

export const SCHEMA_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  rpm_limit integer NOT NULL DEFAULT 60,
  burst integer NOT NULL DEFAULT 20,
  daily_token_budget integer NOT NULL DEFAULT 200000,
  cache_namespace integer NOT NULL DEFAULT 1,
  semantic_cache_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  namespace integer NOT NULL,
  model_alias text NOT NULL,
  scope_hash char(64) NOT NULL,
  exact_key char(64) NOT NULL,
  prompt_text text NOT NULL,
  embedding vector(384) NOT NULL,
  response jsonb NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  hit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_entries_unique_exact
  ON cache_entries (tenant_id, namespace, exact_key);

CREATE INDEX IF NOT EXISTS idx_cache_entries_scope_lookup
  ON cache_entries (tenant_id, namespace, model_alias, scope_hash, expires_at);

CREATE INDEX IF NOT EXISTS idx_cache_entries_hnsw_embedding
  ON cache_entries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS request_logs (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL,
  tenant_id uuid NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  model_alias text NOT NULL,
  provider text NOT NULL,
  upstream_model text NULL,
  stream boolean NOT NULL DEFAULT false,
  cache_status text NOT NULL,
  similarity real NULL,
  status_code integer NOT NULL,
  error_code text NULL,
  attempts integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL,
  ttft_ms integer NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at
  ON request_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_request_logs_tenant_created_at
  ON request_logs (tenant_id, created_at);
`;

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_DDL);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://cacheroute:cacheroute@localhost:5432/cacheroute';
  const pool = new pg.Pool({ connectionString });
  runMigrations(pool)
    .then(async () => {
      console.log('Migrations applied successfully.');
      await pool.end();
    })
    .catch(async (err: unknown) => {
      console.error('Migration failed:', err);
      await pool.end();
      process.exit(1);
    });
}
