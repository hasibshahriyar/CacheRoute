import { buildMockLlmApp } from '../../apps/mock-llm/src/app.js';
import { buildGatewayApp } from '../../apps/gateway/src/app.js';
import { loadConfig } from '../../apps/gateway/src/config.js';
import { runMigrations } from '../../apps/gateway/src/db/migrate.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number((sorted[idx] ?? 0).toFixed(2));
}

async function measureStreamTtft(
  url: string,
  apiKey: string,
  prompt: string,
  ttftDelayMs: number,
): Promise<{ ttftMs: number; cacheStatus: string }> {
  const started = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-mock-ttft-ms': String(ttftDelayMs),
    },
    body: JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      stream: true,
    }),
  });

  const reader = res.body!.getReader();
  await reader.read();
  const ttftMs = performance.now() - started;
  // Drain remaining chunks
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
  return {
    ttftMs,
    cacheStatus: res.headers.get('x-cacheroute-cache') ?? 'UNKNOWN',
  };
}

async function main() {
  const mock = buildMockLlmApp({ providerName: 'mock-primary' });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const mockAddr = mock.server.address();
  const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 18081;

  const adminToken = 'cr_admin_ttft_bench_token';
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN: adminToken,
    MOCK_LLM_URL: `http://127.0.0.1:${mockPort}`,
    MOCK_SECONDARY_LLM_URL: `http://127.0.0.1:${mockPort}`,
  });

  const { app, container } = buildGatewayApp({ config });
  await runMigrations(container.pgPool);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const gwAddr = app.server.address();
  const gwPort = typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 13000;
  const baseUrl = `http://127.0.0.1:${gwPort}`;

  const keyRes = await fetch(`${baseUrl}/admin/keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'ttft-bench', rpmLimit: 60000, burst: 5000 }),
  });
  const { key } = (await keyRes.json()) as { key: string };

  const missSamples: number[] = [];
  const exactSamples: number[] = [];
  const semanticSamples: number[] = [];

  const basePrompt =
    'How does a distributed circuit breaker prevent cascading failures in microservices?';
  const paraphrasePrompt =
    'In microservices, how do distributed circuit breakers stop cascading failures?';

  // First call primes L1 + L2 cache (upstream TTFT = 250ms)
  const first = await measureStreamTtft(baseUrl, key, basePrompt, 250);
  missSamples.push(first.ttftMs);

  for (let i = 0; i < 25; i++) {
    const exact = await measureStreamTtft(baseUrl, key, basePrompt, 250);
    exactSamples.push(exact.ttftMs);

    const sem = await measureStreamTtft(baseUrl, key, paraphrasePrompt, 250);
    semanticSamples.push(sem.ttftMs);
  }

  exactSamples.sort((a, b) => a - b);
  semanticSamples.sort((a, b) => a - b);

  console.log(
    JSON.stringify(
      {
        upstreamMissTtftMs: Number((missSamples[0] ?? 0).toFixed(2)),
        exactHitTtftMs: {
          p50: percentile(exactSamples, 50),
          p95: percentile(exactSamples, 95),
        },
        semanticHitTtftMs: {
          p50: percentile(semanticSamples, 50),
          p95: percentile(semanticSamples, 95),
        },
      },
      null,
      2,
    ),
  );

  await app.close();
  await mock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
