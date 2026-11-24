import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10,
  iterations: 200,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<25'],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://gateway:3000';
const API_KEY = __ENV.API_KEY || '';

export default function () {
  const payload = JSON.stringify({
    model: 'mock',
    messages: [{ role: 'user', content: 'B1 gateway overhead benchmark probe' }],
    stream: false,
  });

  const res = http.post(`${GATEWAY_URL}/v1/chat/completions`, payload, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'x-cacheroute-cache': 'bypass',
      'x-mock-latency-ms': '0',
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'cache header is BYPASS': (r) => r.headers['X-Cacheroute-Cache'] === 'BYPASS',
  });
}
