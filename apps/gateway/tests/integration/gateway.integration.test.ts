import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockLlmApp } from '../../../mock-llm/src/app.js';
import { InlineBackgroundTasks } from '../../src/adapters/BackgroundTasksAdapter.js';
import { buildGatewayApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { GatewayContainer } from '../../src/container.js';
import { runMigrations } from '../../src/db/migrate.js';

describe('CacheRoute End-to-End Integration Suite', () => {
  let mockPrimary: FastifyInstance;
  let mockSecondary: FastifyInstance;
  let gatewayApp: FastifyInstance;
  let container: GatewayContainer;
  let gatewayBaseUrl: string;
  const adminToken = process.env.ADMIN_TOKEN ?? 'cr_admin_test_token';

  beforeAll(async () => {
    mockPrimary = buildMockLlmApp({ providerName: 'mock-primary' });
    await mockPrimary.listen({ port: 0, host: '127.0.0.1' });
    const primaryAddr = mockPrimary.server.address();
    const primaryPort = typeof primaryAddr === 'object' && primaryAddr ? primaryAddr.port : 18081;

    mockSecondary = buildMockLlmApp({ providerName: 'mock-secondary' });
    await mockSecondary.listen({ port: 0, host: '127.0.0.1' });
    const secondaryAddr = mockSecondary.server.address();
    const secondaryPort =
      typeof secondaryAddr === 'object' && secondaryAddr ? secondaryAddr.port : 18082;

    const config = loadConfig({
      NODE_ENV: 'test',
      ADMIN_TOKEN: adminToken,
      MOCK_LLM_URL: `http://127.0.0.1:${primaryPort}`,
      MOCK_SECONDARY_LLM_URL: `http://127.0.0.1:${secondaryPort}`,
      SEMANTIC_THRESHOLD: '0.88',
    });

    const built = buildGatewayApp({ config });
    gatewayApp = built.app;
    container = built.container;

    await runMigrations(container.pgPool);
    await container.pgPool.query('TRUNCATE TABLE request_logs, cache_entries, api_keys CASCADE');
    await container.redis.flushdb();

    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    const gwAddr = gatewayApp.server.address();
    const gwPort = typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 13000;
    gatewayBaseUrl = `http://127.0.0.1:${gwPort}`;
  }, 120_000);

  afterAll(async () => {
    await gatewayApp?.close();
    await mockPrimary?.close();
    await mockSecondary?.close();
  });

  async function flushBg(): Promise<void> {
    if (container.backgroundTasks instanceof InlineBackgroundTasks) {
      await container.backgroundTasks.flush();
    }
  }

  async function createTenantKey(
    name: string,
    opts: {
      rpmLimit?: number;
      burst?: number;
      dailyTokenBudget?: number;
      semanticCacheEnabled?: boolean;
    } = {},
  ): Promise<{ id: string; key: string }> {
    const res = await fetch(`${gatewayBaseUrl}/admin/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, ...opts }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; key: string };
  }

  it('passes Phase 0 spike endpoints (/healthz, /debug/embed, /debug/stream, /readyz, /metrics)', async () => {
    const health = await fetch(`${gatewayBaseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const embedRes = await fetch(`${gatewayBaseUrl}/debug/embed`);
    expect(embedRes.status).toBe(200);
    const embedData = (await embedRes.json()) as { dimensions: number; ready: boolean };
    expect(embedData.dimensions).toBe(384);
    expect(embedData.ready).toBe(true);

    const ready = await fetch(`${gatewayBaseUrl}/readyz`);
    expect(ready.status).toBe(200);

    const streamRes = await fetch(`${gatewayBaseUrl}/debug/stream`);
    expect(streamRes.status).toBe(200);
    const streamText = await streamRes.text();
    expect(streamText).toContain('data: [DONE]');

    const metricsRes = await fetch(`${gatewayBaseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    expect(await metricsRes.text()).toContain('cacheroute_requests_total');
  }, 60_000);

  it('works seamlessly with the official OpenAI TypeScript SDK (models + non-stream + stream)', async () => {
    const tenant = await createTenantKey('openai-sdk-tenant');
    const client = new OpenAI({
      apiKey: tenant.key,
      baseURL: `${gatewayBaseUrl}/v1`,
    });

    const models = await client.models.list();
    expect(models.data.some((m) => m.id === 'mock')).toBe(true);

    const completion = await client.chat.completions.create({
      model: 'mock',
      messages: [{ role: 'user', content: 'Hello from official OpenAI SDK!' }],
    });
    expect(completion.choices[0]?.message.content).toContain('mock-primary');

    const stream = await client.chat.completions.create({
      model: 'mock',
      messages: [{ role: 'user', content: 'Stream this response via OpenAI SDK' }],
      stream: true,
    });
    let streamedText = '';
    for await (const chunk of stream) {
      streamedText += chunk.choices[0]?.delta?.content ?? '';
    }
    expect(streamedText).toContain('Stream this response via OpenAI SDK');
    await flushBg();
  });

  it('delivers L1 exact cache hits, L2 semantic cache hits, Entity Guard protection, and namespace invalidation', async () => {
    const tenant = await createTenantKey('cache-tier-tenant');
    const prompt1 =
      'How do distributed circuit breakers prevent cascading failures in microservices?';
    const paraphrasePrompt =
      'In microservices, how does a distributed circuit breaker stop cascading failures?';

    // 1. First request -> MISS
    const res1 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: prompt1 }],
        temperature: 0.2,
      }),
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-cacheroute-cache')).toBe('MISS');
    expect(res1.headers.get('x-cacheroute-provider')).toBe('mock-primary');
    await flushBg();

    // 2. Identical request -> HIT-EXACT (L1 Redis)
    const res2 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: prompt1 }],
        temperature: 0.2,
      }),
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cacheroute-cache')).toBe('HIT-EXACT');
    expect(res2.headers.get('x-cacheroute-provider')).toBe('cache');
    expect(res2.headers.get('x-cacheroute-attempts')).toBe('0');

    // 3. Paraphrased request -> HIT-SEMANTIC (L2 pgvector)
    const res3 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: paraphrasePrompt }],
        temperature: 0.2,
      }),
    });
    expect(res3.status).toBe(200);
    expect(res3.headers.get('x-cacheroute-cache')).toBe('HIT-SEMANTIC');
    expect(Number(res3.headers.get('x-cacheroute-similarity'))).toBeGreaterThanOrEqual(0.88);
    await flushBg();

    // 4. Entity Guard trap: order 1421 vs order 1422 must NEVER semantic-hit each other
    const order1 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'What is the shipping status of order 1421?' }],
        temperature: 0.2,
      }),
    });
    expect(order1.headers.get('x-cacheroute-cache')).toBe('MISS');
    await flushBg();

    const order2 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'What is the shipping status of order 1422?' }],
        temperature: 0.2,
      }),
    });
    expect(order2.headers.get('x-cacheroute-cache')).toBe('MISS');
    await flushBg();

    // 5. Namespace invalidation: DELETE /admin/cache?keyId=... invalidates both L1 & L2
    const invRes = await fetch(`${gatewayBaseUrl}/admin/cache?keyId=${tenant.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(invRes.status).toBe(200);

    const resAfterInvalidate = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: prompt1 }],
        temperature: 0.2,
      }),
    });
    expect(resAfterInvalidate.headers.get('x-cacheroute-cache')).toBe('MISS');
    await flushBg();
  });

  it('enforces strict Cross-Tenant Isolation (zero cross-tenant L1 or L2 leakage)', async () => {
    const tenantA = await createTenantKey('tenant-a');
    const tenantB = await createTenantKey('tenant-b');
    const sharedPrompt = 'Explain Docker container isolation in one sentence.';

    const resA = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantA.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: sharedPrompt }],
      }),
    });
    expect(resA.headers.get('x-cacheroute-cache')).toBe('MISS');
    await flushBg();

    // Tenant A gets HIT-EXACT
    const resA2 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantA.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: sharedPrompt }],
      }),
    });
    expect(resA2.headers.get('x-cacheroute-cache')).toBe('HIT-EXACT');

    // Tenant B sending the exact same prompt MUST get MISS
    const resB = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantB.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: sharedPrompt }],
      }),
    });
    expect(resB.headers.get('x-cacheroute-cache')).toBe('MISS');
    await flushBg();
  });

  it('replays cached responses as synthetic SSE chunks when stream: true hits L1/L2 cache', async () => {
    const tenant = await createTenantKey('sse-replay-tenant');
    const prompt = 'Explain synthetic SSE cache replay.';

    // 1. Stream MISS tees and writes to cache
    const missRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });
    expect(missRes.status).toBe(200);
    expect(missRes.headers.get('x-cacheroute-cache')).toBe('MISS');
    const missText = await missRes.text();
    expect(missText).toContain('data: [DONE]');
    await flushBg();

    // 2. Second stream request gets HIT-EXACT synthetic SSE replay
    const hitRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });
    expect(hitRes.status).toBe(200);
    expect(hitRes.headers.get('x-cacheroute-cache')).toBe('HIT-EXACT');
    expect(hitRes.headers.get('x-cacheroute-provider')).toBe('cache');
    const hitText = await hitRes.text();
    expect(hitText).toContain('chat.completion.chunk');
    expect(hitText).toContain('data: [DONE]');
    await flushBg();
  });

  it('fails over from mock-primary to mock-secondary on 500/429 and opens circuit breaker after 5 failures', async () => {
    const tenant = await createTenantKey('failover-tenant', { rpmLimit: 600, burst: 100 });

    // Configure mock-primary to return 503 errors 100% of the time
    const primaryAddr = mockPrimary.server.address();
    const primaryPort = typeof primaryAddr === 'object' && primaryAddr ? primaryAddr.port : 18081;
    await fetch(`http://127.0.0.1:${primaryPort}/admin/faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorRate: 1.0, errorStatus: 503 }),
    });

    // Send 5 requests: each fails on mock-primary and succeeds on mock-secondary (attempts = 2)
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenant.key}`,
          'Content-Type': 'application/json',
          'x-cacheroute-cache': 'bypass',
        },
        body: JSON.stringify({
          model: 'mock',
          messages: [{ role: 'user', content: `Failover probe ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-cacheroute-provider')).toBe('mock-secondary');
      expect(res.headers.get('x-cacheroute-attempts')).toBe('2');
    }

    // 6th request: mock-primary breaker is now OPEN, so gateway skips mock-primary in 0ms (attempts = 1)
    const res6 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'Breaker open fast-path probe' }],
      }),
    });
    expect(res6.status).toBe(200);
    expect(res6.headers.get('x-cacheroute-provider')).toBe('mock-secondary');
    expect(res6.headers.get('x-cacheroute-attempts')).toBe('1');

    // Reset mock-primary faults and breaker state
    await fetch(`http://127.0.0.1:${primaryPort}/admin/faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorRate: 0, errorStatus: 500 }),
    });
    await container.circuitBreaker.recordSuccess('mock-primary');
    await flushBg();
  });

  it('enforces token-bucket burst limits (429 + Retry-After) and daily token budgets', async () => {
    const burstTenant = await createTenantKey('burst-tenant', {
      rpmLimit: 6,
      burst: 3,
      dailyTokenBudget: 100000,
    });

    for (let i = 0; i < 3; i++) {
      const okRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${burstTenant.key}`,
          'Content-Type': 'application/json',
          'x-cacheroute-cache': 'bypass',
        },
        body: JSON.stringify({
          model: 'mock',
          messages: [{ role: 'user', content: `Burst ${i}` }],
        }),
      });
      expect(okRes.status).toBe(200);
    }

    const throttledRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${burstTenant.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'Burst overflow' }],
      }),
    });
    expect(throttledRes.status).toBe(429);
    expect(throttledRes.headers.get('retry-after')).toBeTruthy();
    const errBody = (await throttledRes.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('rate_limit_exceeded');

    // Daily token budget test
    const budgetTenant = await createTenantKey('budget-tenant', {
      rpmLimit: 600,
      burst: 50,
      dailyTokenBudget: 10,
    });
    const firstBudgetReq = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${budgetTenant.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'Consume initial 10+ token budget' }],
      }),
    });
    expect(firstBudgetReq.status).toBe(200);
    await flushBg();

    const secondBudgetReq = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${budgetTenant.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'Should exceed daily token budget' }],
      }),
    });
    expect(secondBudgetReq.status).toBe(429);
    const budgetErr = (await secondBudgetReq.json()) as { error: { code: string } };
    expect(budgetErr.error.code).toBe('token_budget_exceeded');
  });

  it('aggregates request_logs accurately via GET /admin/stats?window=24h', async () => {
    await flushBg();
    const statsRes = await fetch(`${gatewayBaseUrl}/admin/stats?window=24h`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as {
      totalRequests: number;
      cache: { exactHits: number; semanticHits: number; misses: number };
    };
    expect(stats.totalRequests).toBeGreaterThan(5);
    expect(stats.cache.exactHits).toBeGreaterThanOrEqual(2);
    expect(stats.cache.semanticHits).toBeGreaterThanOrEqual(1);
  });

  it('degrades gracefully (fail-open rate limiter & in-memory breaker) when Redis is unreachable', async () => {
    const tenant = await createTenantKey('redis-degraded-tenant');

    // Spin up a separate gateway instance pointed at an unreachable Redis port
    const primaryAddr = mockPrimary.server.address();
    const primaryPort = typeof primaryAddr === 'object' && primaryAddr ? primaryAddr.port : 18081;
    const degradedConfig = loadConfig({
      NODE_ENV: 'test',
      ADMIN_TOKEN: adminToken,
      REDIS_URL: 'redis://127.0.0.1:6399',
      MOCK_LLM_URL: `http://127.0.0.1:${primaryPort}`,
      MOCK_SECONDARY_LLM_URL: `http://127.0.0.1:${primaryPort}`,
    });

    const degradedGateway = buildGatewayApp({ config: degradedConfig });
    await degradedGateway.app.listen({ port: 0, host: '127.0.0.1' });
    const dgAddr = degradedGateway.app.server.address();
    const dgPort = typeof dgAddr === 'object' && dgAddr ? dgAddr.port : 13001;

    try {
      const res = await fetch(`http://127.0.0.1:${dgPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenant.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mock',
          messages: [{ role: 'user', content: 'Request during Redis outage should fail-open' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-cacheroute-provider')).toBe('mock-primary');
    } finally {
      await degradedGateway.app.close();
    }
  });
});
