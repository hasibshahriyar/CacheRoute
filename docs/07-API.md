# 07 — API Reference

## In Plain Words

CacheRoute exposes an OpenAI-compatible chat API so your existing code or the official OpenAI SDK works simply by changing `baseURL` and `apiKey`. It also exposes health endpoints, Prometheus `/metrics`, and admin endpoints to manage keys and view stats.

---

## 1. Public Inference & Health Endpoints

### 1.1 `POST /v1/chat/completions`
Auth: `Authorization: Bearer cr_live_<32 random>`

Optional control header:
- `x-cacheroute-cache: bypass` — skips both L1/L2 cache reads and cache writeback.
- `x-request-id: <uuid>` — propagated across logs and returned in response headers.

**Request Body (JSON):**
```json
{
  "model": "cr-fast",
  "messages": [
    { "role": "system", "content": "Answer concisely." },
    { "role": "user", "content": "Explain Redis Lua scripts in one sentence." }
  ],
  "temperature": 0.2,
  "stream": false
}
```

**Response (`200 OK`, non-streaming):**
- Headers:
  - `x-request-id: 9b2c1a...`
  - `x-cacheroute-cache: MISS` *(or `HIT-EXACT`, `HIT-SEMANTIC`, `BYPASS`)*
  - `x-cacheroute-provider: groq` *(or `cache`, `gemini`, `openrouter`, `mock-primary`)*
  - `x-cacheroute-attempts: 1`
  - `x-cacheroute-latency-ms: 342`
  - `x-cacheroute-similarity: 0.9612` *(present only on `HIT-SEMANTIC`)*
  - `x-ratelimit-limit-requests: 60`
  - `x-ratelimit-remaining-requests: 19`
  - `x-ratelimit-reset-requests: 1`

```json
{
  "id": "chatcmpl-cr-9b2c1a",
  "object": "chat.completion",
  "created": 1795550000,
  "model": "cr-fast",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Redis Lua scripts execute multiple commands atomically inside Redis's single-threaded event loop without race conditions."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 19,
    "total_tokens": 43
  }
}
```

**Response (`200 OK`, `stream: true`):**
`Content-Type: text/event-stream` emitting standard OpenAI `chat.completion.chunk` frames terminated by `data: [DONE]\n\n`.

---

### 1.2 `GET /v1/models`
Auth: `Authorization: Bearer cr_live_<32 random>`

Lists available model aliases (`cr-fast`, `cr-smart`, plus `mock` locally).

```json
{
  "object": "list",
  "data": [
    { "id": "cr-fast", "object": "model", "owned_by": "cacheroute" },
    { "id": "cr-smart", "object": "model", "owned_by": "cacheroute" }
  ]
}
```

---

### 1.3 Health & Metrics Endpoints
- `GET /healthz` → `200 { "status": "ok" }` (liveness check).
- `GET /readyz` → verifies Redis `PING`, Postgres `SELECT 1`, and singleton ONNX embedder readiness (`200` ready / `503` degraded).
- `GET /metrics` → Prometheus exposition format (`text/plain; version=0.0.4`) scraped by Prometheus locally.

---

## 2. Admin Endpoints

All `/admin/*` endpoints require `Authorization: Bearer $ADMIN_TOKEN`.

### 2.1 `POST /admin/keys`
Creates a virtual tenant key. **The plaintext `cr_live_*` key is returned once and never stored.**

```json
// Request
{
  "name": "public-demo",
  "rpmLimit": 10,
  "burst": 5,
  "dailyTokenBudget": 20000,
  "semanticCacheEnabled": true
}

// Response (201 Created)
{
  "id": "c7b8a1d0-...",
  "name": "public-demo",
  "key": "cr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "keyPrefix": "cr_live_xxxx",
  "rpmLimit": 10,
  "burst": 5,
  "dailyTokenBudget": 20000,
  "cacheNamespace": 1
}
```

### 2.2 `DELETE /admin/keys/:id`
Sets `revoked_at = NOW()` in Postgres and evicts `cr:key:{sha256}` from Redis. Returns `200 { "revoked": true, "id": "..." }`.

### 2.3 `GET /admin/stats?window=24h`
Aggregates `request_logs` over `1h`, `24h`, `7d`, or `30d`:

```json
{
  "window": "24h",
  "totalRequests": 1420,
  "cache": {
    "exactHits": 580,
    "semanticHits": 240,
    "misses": 520,
    "bypass": 80,
    "hitRate": 0.6119
  },
  "latencyMs": {
    "p50": 14,
    "p95": 480
  },
  "tokensSavedEstimate": 94300,
  "providers": {
    "cache": { "requests": 820, "errors": 0 },
    "groq": { "requests": 560, "errors": 4 },
    "gemini": { "requests": 40, "errors": 0 }
  }
}
```

### 2.4 `DELETE /admin/cache?keyId=<uuid>`
Increments `cache_namespace` for the specified key (`namespace + 1`) and invalidates the Redis key cache (`cr:key:{sha256}`). Returns `200 { "keyId": "...", "newNamespace": 2 }`.

---

## 3. OpenAI Error Envelope

Every error (`400`, `401`, `429`, `503`) uses the standard OpenAI schema:

```json
{
  "error": {
    "message": "Rate limit exceeded for virtual key.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```

---

## 4. Client Usage Examples

### 4.1 `curl`

```bash
curl -sS https://your-cacheroute.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer cr_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cr-fast",
    "messages": [{"role": "user", "content": "What is a circuit breaker in microservices?"}],
    "temperature": 0.2
  }'
```

### 4.2 Official OpenAI TypeScript SDK (`openai`)

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.CACHEROUTE_API_KEY, // cr_live_...
  baseURL: 'https://your-cacheroute.vercel.app/v1',
});

const completion = await client.chat.completions.create({
  model: 'cr-fast',
  messages: [{ role: 'user', content: 'What is a circuit breaker in microservices?' }],
});

console.log(completion.choices[0]?.message.content);
```
