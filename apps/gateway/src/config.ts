import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://cacheroute:cacheroute@localhost:5432/cacheroute'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ADMIN_TOKEN: z.string().min(8).default('cr_admin_dev_secret_token_change_in_prod'),
  GROQ_API_KEY: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  OPENROUTER_API_KEY: z.string().optional().default(''),
  MOCK_LLM_URL: z.string().optional().default('http://localhost:8081'),
  MOCK_SECONDARY_LLM_URL: z.string().optional().default('http://localhost:8082'),
  SEMANTIC_THRESHOLD: z.coerce.number().min(0.5).max(1.0).default(0.92),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppEnv = z.infer<typeof envSchema>;

export interface ProviderEndpointConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  upstreamModel: string;
}

export interface GatewayConfig {
  env: AppEnv;
  routes: Record<string, ProviderEndpointConfig[]>;
}

export function loadConfig(
  overrides: Partial<Record<string, string | undefined>> = {},
): GatewayConfig {
  const merged = { ...process.env, ...overrides };
  if (!merged.DATABASE_URL) {
    merged.DATABASE_URL =
      merged.POSTGRES_URL || merged.POSTGRES_PRISMA_URL || merged.DATABASE_URL_UNPOOLED;
  }
  if (!merged.REDIS_URL) {
    merged.REDIS_URL =
      merged.KV_URL || merged.UPSTASH_REDIS_URL || merged.STORAGE_URL || merged.REDIS_TLS_URL;
  }
  const env = envSchema.parse(merged);

  const routes: Record<string, ProviderEndpointConfig[]> = {
    'cr-fast': [
      {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY,
        upstreamModel: 'llama-3.1-8b-instant',
      },
      {
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: env.GEMINI_API_KEY,
        upstreamModel: 'gemini-2.5-flash-lite',
      },
      {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY,
        upstreamModel: 'meta-llama/llama-3.1-8b-instruct:free',
      },
    ],
    'cr-smart': [
      {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY,
        upstreamModel: 'llama-3.3-70b-versatile',
      },
      {
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: env.GEMINI_API_KEY,
        upstreamModel: 'gemini-2.5-flash',
      },
      {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY,
        upstreamModel: 'meta-llama/llama-3.3-70b-instruct:free',
      },
    ],
  };

  if (env.NODE_ENV !== 'production' || Boolean(merged.MOCK_LLM_URL)) {
    const primaryUrl = env.MOCK_LLM_URL || 'http://localhost:8081';
    const secondaryUrl = env.MOCK_SECONDARY_LLM_URL || primaryUrl;
    routes.mock = [
      {
        provider: 'mock-primary',
        baseUrl: `${primaryUrl.replace(/\/$/, '')}/v1`,
        apiKey: 'mock-key-primary',
        upstreamModel: 'mock-model-v1',
      },
      {
        provider: 'mock-secondary',
        baseUrl: `${secondaryUrl.replace(/\/$/, '')}/v1`,
        apiKey: 'mock-key-secondary',
        upstreamModel: 'mock-model-v1',
      },
    ];
  }

  return { env, routes };
}
