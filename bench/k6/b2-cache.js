import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const exactLatency = new Trend('cacheroute_exact_hit_ms');
const semanticLatency = new Trend('cacheroute_semantic_hit_ms');
const missLatency = new Trend('cacheroute_miss_ms');

export const options = {
  vus: 5,
  iterations: 250,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    cacheroute_exact_hit_ms: ['p(95)<10'],
    cacheroute_semantic_hit_ms: ['p(95)<60'],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://gateway:3000';
const API_KEY = __ENV.API_KEY || '';

export default function () {
  const iter = __ITER;
  const mod = iter % 5;
  let prompt = `Unique question about backend architecture pattern number ${iter}`;
  if (mod === 0 || mod === 1) {
    prompt = 'How does a distributed circuit breaker prevent cascading failures in microservices?';
  } else if (mod === 2) {
    prompt = 'In microservices, how do distributed circuit breakers stop cascading failures?';
  }

  const res = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'x-mock-latency-ms': '800',
      },
    },
  );

  const cacheStatus = res.headers['X-Cacheroute-Cache'];
  if (cacheStatus === 'HIT-EXACT') exactLatency.add(res.timings.duration);
  else if (cacheStatus === 'HIT-SEMANTIC') semanticLatency.add(res.timings.duration);
  else missLatency.add(res.timings.duration);

  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
