import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const ok200 = new Counter('cacheroute_200_count');
const throttled429 = new Counter('cacheroute_429_count');

export const options = {
  vus: 20,
  iterations: 100,
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://gateway:3000';
const API_KEY = __ENV.API_KEY || '';

export default function () {
  const res = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: 'B4 rate limit burst check' }],
    }),
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
    },
  );

  if (res.status === 200) ok200.add(1);
  if (res.status === 429) throttled429.add(1);

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}
