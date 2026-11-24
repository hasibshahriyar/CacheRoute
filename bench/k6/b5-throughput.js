import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 30,
  duration: '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<100'],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://gateway:3000';
const API_KEY = __ENV.API_KEY || '';

export default function () {
  const res = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: 'Pre-warmed L1 cache throughput probe' }],
      temperature: 0.2,
    }),
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
    'is HIT-EXACT': (r) => r.headers['X-Cacheroute-Cache'] === 'HIT-EXACT',
  });
}
