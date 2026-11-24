import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 8,
  iterations: 200,
  thresholds: {
    http_req_failed: ['rate<0.001'],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://gateway:3000';
const API_KEY = __ENV.API_KEY || '';

export default function () {
  const res = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: `B3 failover probe ${__VU}-${__ITER}` }],
    }),
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'x-cacheroute-cache': 'bypass',
      },
    },
  );

  check(res, {
    'client received 200 OK despite primary faults': (r) => r.status === 200,
  });
}
