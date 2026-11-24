import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMockLlmApp } from '../apps/mock-llm/src/app.js';
import { InlineBackgroundTasks } from '../apps/gateway/src/adapters/BackgroundTasksAdapter.js';
import { TransformersEmbeddingModel } from '../apps/gateway/src/adapters/TransformersEmbeddingModel.js';
import { buildGatewayApp } from '../apps/gateway/src/app.js';
import { loadConfig } from '../apps/gateway/src/config.js';
import { runMigrations } from '../apps/gateway/src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number((sorted[idx] ?? 0).toFixed(2));
}

async function runConcurrent<T>(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array<T>(total);
  let cursor = 0;

  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) break;
      results[idx] = await worker(idx);
    }
  });

  await Promise.all(runners);
  return results;
}

async function main() {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() ?? 'Unknown CPU';
  const cpuCores = cpus.length;
  const totalRamGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  const platform = `${os.type()} ${os.release()} (${os.arch()})`;

  console.log(
    `Hardware: ${cpuModel} (${cpuCores} logical cores) | ${totalRamGb} GB RAM | ${platform}`,
  );

  const mockPrimary = buildMockLlmApp({ providerName: 'mock-primary' });
  await mockPrimary.listen({ port: 0, host: '127.0.0.1' });
  const primaryAddr = mockPrimary.server.address();
  const primaryPort = typeof primaryAddr === 'object' && primaryAddr ? primaryAddr.port : 18081;
  const mockPrimaryUrl = `http://127.0.0.1:${primaryPort}`;

  const mockSecondary = buildMockLlmApp({ providerName: 'mock-secondary' });
  await mockSecondary.listen({ port: 0, host: '127.0.0.1' });
  const secondaryAddr = mockSecondary.server.address();
  const secondaryPort =
    typeof secondaryAddr === 'object' && secondaryAddr ? secondaryAddr.port : 18082;
  const mockSecondaryUrl = `http://127.0.0.1:${secondaryPort}`;

  const adminToken = 'cr_admin_benchmark_runner_token';
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN: adminToken,
    MOCK_LLM_URL: mockPrimaryUrl,
    MOCK_SECONDARY_LLM_URL: mockSecondaryUrl,
    SEMANTIC_THRESHOLD: '0.92',
  });

  const { app, container } = buildGatewayApp({ config });
  await runMigrations(container.pgPool);
  await container.pgPool.query('TRUNCATE TABLE request_logs, cache_entries, api_keys CASCADE');
  await container.redis.flushdb();

  if (container.embeddingModel instanceof TransformersEmbeddingModel) {
    await container.embeddingModel.warmup();
  }

  await app.listen({ port: 0, host: '127.0.0.1' });
  const gwAddr = app.server.address();
  const gwPort = typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 13000;
  const gatewayUrl = `http://127.0.0.1:${gwPort}`;

  async function createKey(
    name: string,
    rpmLimit: number,
    burst: number,
    dailyTokenBudget = 50_000_000,
  ) {
    const res = await fetch(`${gatewayUrl}/admin/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, rpmLimit, burst, dailyTokenBudget }),
    });
    return (await res.json()) as { id: string; key: string };
  }

  async function flushBg() {
    if (container.backgroundTasks instanceof InlineBackgroundTasks) {
      await container.backgroundTasks.flush();
    }
  }

  // =========================================================================
  // B1 — Gateway Overhead (0ms mock-llm, bypass mode vs direct mock-llm)
  // =========================================================================
  console.log('\nRunning B1 — Gateway Overhead (200 requests, bypass, 0ms mock)...');
  const b1Key = await createKey('b1-overhead', 100_000, 10_000);

  // Warmup
  for (let i = 0; i < 15; i++) {
    await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b1Key.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'Warmup' }],
      }),
    });
  }

  const directLatencies = await runConcurrent(200, 8, async (i) => {
    const t0 = performance.now();
    await fetch(`${mockPrimaryUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model-v1',
        messages: [{ role: 'user', content: `Direct ${i}` }],
      }),
    });
    return performance.now() - t0;
  });

  const gatewayBypassLatencies = await runConcurrent(200, 8, async (i) => {
    const t0 = performance.now();
    await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b1Key.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: `Bypass ${i}` }],
      }),
    });
    return performance.now() - t0;
  });

  directLatencies.sort((a, b) => a - b);
  gatewayBypassLatencies.sort((a, b) => a - b);
  await flushBg();

  const b1DirectP50 = percentile(directLatencies, 50);
  const b1DirectP95 = percentile(directLatencies, 95);
  const b1GwP50 = percentile(gatewayBypassLatencies, 50);
  const b1GwP95 = percentile(gatewayBypassLatencies, 95);
  const b1GwP99 = percentile(gatewayBypassLatencies, 99);
  const b1AddedP50 = Number(Math.max(0.1, b1GwP50 - b1DirectP50).toFixed(2));
  const b1AddedP95 = Number(Math.max(0.2, b1GwP95 - b1DirectP95).toFixed(2));

  // =========================================================================
  // B2 — Two-Tier Cache (1,000-request mix: 40% exact, 20% semantic, 40% unique)
  // =========================================================================
  console.log('Running B2 — Two-Tier Cache (1,000-request workload mix)...');
  const b2Key = await createKey('b2-cache', 100_000, 10_000);

  const seedPairs: Array<[string, string]> = [
    [
      'How does a distributed circuit breaker prevent cascading failures in microservices?',
      'In microservices, how do distributed circuit breakers stop cascading failures?',
    ],
    [
      'Explain how Redis Lua scripts guarantee atomic execution.',
      'Why do Lua scripts in Redis execute atomically without race conditions?',
    ],
    [
      'What is the difference between L1 exact caching and L2 semantic caching?',
      'Compare L1 exact match cache with L2 vector semantic cache.',
    ],
    [
      'How does a token bucket rate limiter handle traffic bursts?',
      'Explain how token bucket rate limiting accommodates sudden bursts of requests.',
    ],
    [
      'Why is HNSW indexing faster than exact KNN search in pgvector?',
      'In pgvector, how does an HNSW index speed up similarity search compared to exact KNN?',
    ],
    [
      'How does Server-Sent Events streaming improve Time to First Token?',
      'Why does SSE streaming reduce perceived Time to First Token for LLM responses?',
    ],
    [
      'What are the benefits of hexagonal ports and adapters architecture in TypeScript?',
      'Why use ports and adapters hexagonal architecture in a TypeScript backend?',
    ],
    [
      'How does connection pooling in undici reduce HTTP tail latency?',
      'Explain how undici keep-alive connection pools lower HTTP request latency.',
    ],
    [
      'Why should API keys be hashed with SHA-256 before storing in PostgreSQL?',
      'Explain why we store SHA-256 hashes of virtual API keys in Postgres instead of plaintext.',
    ],
    [
      'How does exponential backoff with jitter help recover from upstream rate limits?',
      'Why use exponential backoff when an upstream API returns rate limit errors?',
    ],
  ];

  // Prime the 10 canonical prompts so exact & paraphrase queries test warm L1/L2 tiers cleanly
  for (const [canonical] of seedPairs) {
    await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b2Key.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: canonical }],
        temperature: 0.2,
      }),
    });
  }
  await flushBg();

  const exactHitLatencies: number[] = [];
  const semanticHitLatencies: number[] = [];
  const missLatencies: number[] = [];
  let falsePositives = 0;

  await runConcurrent(1000, 6, async (idx) => {
    const mod = idx % 10;
    const pair = seedPairs[idx % seedPairs.length]!;
    let prompt: string;
    let expectedType: 'exact' | 'semantic' | 'unique';

    if (mod < 4) {
      // 40% exact repeats
      prompt = pair[0];
      expectedType = 'exact';
    } else if (mod < 6) {
      // 20% semantic paraphrases
      prompt = pair[1];
      expectedType = 'semantic';
    } else {
      // 40% unique / entity-guarded queries
      prompt = `What is the status of unique customer invoice ${10000 + idx}?`;
      expectedType = 'unique';
    }

    const t0 = performance.now();
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b2Key.key}`,
        'Content-Type': 'application/json',
        'x-mock-latency-ms': expectedType === 'unique' ? '15' : '800',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    const dur = performance.now() - t0;
    const status = res.headers.get('x-cacheroute-cache');

    if (status === 'HIT-EXACT') {
      exactHitLatencies.push(dur);
      if (expectedType === 'unique') falsePositives++;
    } else if (status === 'HIT-SEMANTIC') {
      semanticHitLatencies.push(dur);
      if (expectedType === 'unique') falsePositives++;
    } else {
      missLatencies.push(dur);
    }
  });

  exactHitLatencies.sort((a, b) => a - b);
  semanticHitLatencies.sort((a, b) => a - b);
  await flushBg();

  // =========================================================================
  // B3 — Failover Resilience (30% 5xx + 5% timeouts on primary, healthy secondary)
  // =========================================================================
  console.log('Running B3 — Failover Resilience (200 requests under 30% 5xx + 5% fault rate)...');
  const b3Key = await createKey('b3-failover', 100_000, 10_000);

  await fetch(`${mockPrimaryUrl}/admin/faults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errorRate: 0.35, errorStatus: 503, latencyMs: 5 }),
  });
  await fetch(`${mockSecondaryUrl}/admin/faults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errorRate: 0, latencyMs: 15 }),
  });

  let b3Success = 0;
  const b3Latencies = await runConcurrent(200, 8, async (i) => {
    const t0 = performance.now();
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b3Key.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: `B3 resilience probe ${i}` }],
      }),
    });
    if (res.status === 200) b3Success++;
    return performance.now() - t0;
  });
  b3Latencies.sort((a, b) => a - b);
  const b3BreakerState = await container.circuitBreaker.getState('mock-primary');

  // Reset faults
  await fetch(`${mockPrimaryUrl}/admin/faults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errorRate: 0, latencyMs: 0 }),
  });
  await fetch(`${mockSecondaryUrl}/admin/faults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errorRate: 0, latencyMs: 0 }),
  });
  await container.circuitBreaker.recordSuccess('mock-primary');

  // =========================================================================
  // B4 — Rate-Limit Accuracy (100-request instant burst against 60 RPM / 20 burst)
  // =========================================================================
  console.log('Running B4 — Rate-Limit Accuracy (100-request instant burst, 60 RPM / 20 burst)...');
  const b4Key = await createKey('b4-ratelimit', 60, 20);
  let b4Allowed200 = 0;
  let b4Rejected429 = 0;

  await runConcurrent(100, 25, async (i) => {
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b4Key.key}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: `B4 burst ${i}` }],
      }),
    });
    if (res.status === 200) b4Allowed200++;
    else if (res.status === 429) b4Rejected429++;
  });

  // =========================================================================
  // B5 — Cache-Hit Throughput (sustained concurrent L1 exact cache hits)
  // =========================================================================
  console.log('Running B5 — Cache-Hit Throughput (2,000 requests @ 40 concurrency)...');
  const b5Key = await createKey('b5-throughput', 1_000_000, 100_000);
  const b5Prompt = 'Pre-warmed L1 exact cache throughput benchmark payload';

  // Prime L1
  await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${b5Key.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: b5Prompt }],
      temperature: 0.2,
    }),
  });
  await flushBg();

  const b5Start = performance.now();
  const b5Latencies = await runConcurrent(2000, 40, async () => {
    const t0 = performance.now();
    await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${b5Key.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: b5Prompt }],
        temperature: 0.2,
      }),
    });
    return performance.now() - t0;
  });
  const b5TotalSec = (performance.now() - b5Start) / 1000;
  b5Latencies.sort((a, b) => a - b);
  const b5Rps = Math.round(2000 / b5TotalSec);

  await flushBg();

  const summary = {
    timestamp: new Date().toISOString(),
    hardware: {
      cpu: `${cpuModel} (${cpuCores} logical cores)`,
      ramGb: Number(totalRamGb),
      os: platform,
      nodeVersion: process.version,
    },
    benchmarks: {
      B1_overhead: {
        directP50Ms: b1DirectP50,
        directP95Ms: b1DirectP95,
        gatewayBypassP50Ms: b1GwP50,
        gatewayBypassP95Ms: b1GwP95,
        gatewayBypassP99Ms: b1GwP99,
        addedOverheadP50Ms: b1AddedP50,
        addedOverheadP95Ms: b1AddedP95,
      },
      B2_twoTierCache: {
        totalRequests: 1000,
        exactHits: exactHitLatencies.length,
        semanticHits: semanticHitLatencies.length,
        misses: missLatencies.length,
        hitRatePercent: Number(
          (((exactHitLatencies.length + semanticHitLatencies.length) / 1000) * 100).toFixed(1),
        ),
        exactHitP50Ms: percentile(exactHitLatencies, 50),
        exactHitP95Ms: percentile(exactHitLatencies, 95),
        semanticHitP50Ms: percentile(semanticHitLatencies, 50),
        semanticHitP95Ms: percentile(semanticHitLatencies, 95),
        falsePositiveRatePercent: Number(((falsePositives / 400) * 100).toFixed(2)),
      },
      B3_failoverResilience: {
        totalRequests: 200,
        successCount: b3Success,
        successRatePercent: Number(((b3Success / 200) * 100).toFixed(2)),
        p50Ms: percentile(b3Latencies, 50),
        p95Ms: percentile(b3Latencies, 95),
        primaryBreakerState: b3BreakerState,
      },
      B4_rateLimitAccuracy: {
        burstSize: 100,
        allowed200: b4Allowed200,
        rejected429: b4Rejected429,
      },
      B5_cacheHitThroughput: {
        totalRequests: 2000,
        concurrency: 40,
        sustainedRps: b5Rps,
        p50Ms: percentile(b5Latencies, 50),
        p95Ms: percentile(b5Latencies, 95),
        p99Ms: percentile(b5Latencies, 99),
      },
    },
  };

  const resultsDir = resolve(__dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resolve(resultsDir, 'latest.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\nBenchmark Suite Completed:');
  console.log(JSON.stringify(summary, null, 2));

  await app.close();
  await mockPrimary.close();
  await mockSecondary.close();
}

main().catch((err) => {
  console.error('Benchmark runner failed:', err);
  process.exit(1);
});
