# 09 — Testing & Benchmark Suite

## In Plain Words

We never guess whether CacheRoute is fast or resilient — we prove it automatically. Unit and integration tests verify correctness on every commit in GitHub Actions, while five reproducible local benchmarks (`B1`–`B5`) measure exact gateway overhead, cache speedup, failover survival, rate-limit precision, and peak throughput against `mock-llm`.

---

## 1. Golden Rule: Never Load-Test Production

- **All load tests (`B1`–`B5`) run strictly locally** inside Docker Compose against `apps/mock-llm`.
- **Never** run `k6` or burst scripts against Vercel, Neon, Upstash, Groq, Gemini, or OpenRouter (doing so exhausts free quotas and risks account suspension).
- Every published benchmark run **must record exact hardware specs** (`CPU model`, `RAM`, `OS`, `Docker version`).

---

## 2. Test Pyramid & CI Pipeline

### 2.1 Unit Tests (`apps/gateway/tests/unit/`, Vitest)
- `CacheKeyBuilder`: canonical JSON key sorting invariance & SHA-256 stability.
- `CacheabilityPolicy` & `EntityGuard`: tool calls, `n > 1`, temperature `> 0.7`, `> 2000` char limit, 3+ digit numbers, emails, URLs.
- `CircuitBreaker` logic: `CLOSED → OPEN` (30s window `>= 10` reqs `>= 50%` fail OR `5` consecutive), exponential backoff (`30s` → `5m`), `HALF_OPEN` probe lock.
- `GatewayError` mapper: OpenAI error format & HTTP status codes (`400`, `401`, `429`, `503`).

### 2.2 Integration Tests (`apps/gateway/tests/integration/`, Vitest)
Runs against real `pgvector/pgvector:pg17` + `redis:7-alpine` + `apps/mock-llm`:
- End-to-end L1 exact hit, L2 semantic hit, miss + writeback, and `DELETE /admin/cache` namespace invalidation.
- **Cross-Tenant Isolation Test:** Tenant A caches prompt `"Explain Docker"`; Tenant B sends the identical prompt and **must** record `MISS` (zero cross-tenant leakage).
- Failover test: `mock-primary` returns `500`/`429` → gateway fails over cleanly to `mock-secondary` and opens breaker.
- SSE streaming miss + synthetic SSE cache hit replay (`data: [DONE]`).

### 2.3 GitHub Actions CI (`.github/workflows/ci.yml`)
Four checks on every push / PR:
1. `lint` (`eslint` + `prettier --check`)
2. `typecheck` (`tsc --noEmit`)
3. `unit` (`vitest run tests/unit`)
4. `integration` (spins up `pgvector/pgvector:pg17` and `redis:7` service containers + `mock-llm`)

---

## 3. `apps/mock-llm` Specification

A lightweight Fastify server mimicking `/v1/chat/completions` for both JSON and SSE streaming with deterministic output derived from a hash of the prompt.

**Fault Injection Controls** (via environment defaults or per-request `x-mock-*` headers):

| Parameter / Header | Type | Behavior |
| :--- | :--- | :--- |
| `x-mock-latency-ms` | `int` | Artificial delay before sending JSON response |
| `x-mock-ttft-ms` | `int` | Delay before emitting first SSE chunk |
| `x-mock-inter-chunk-ms` | `int` | Delay between SSE tokens |
| `x-mock-error-rate` | `0.0–1.0` | Probability of returning an HTTP error |
| `x-mock-error-status` | `429\|500\|503` | HTTP status code when injecting an error |
| `x-mock-timeout-rate` | `0.0–1.0` | Probability of hanging longer than gateway TTFT timeout (`> 20s`) |
| `x-mock-retry-after` | `int` | `Retry-After` header seconds on `429` |

---

## 4. Threshold Calibration (`bench/datasets/paraphrase-pairs.jsonl`)

- Contains `~200` labeled prompt pairs: `~100` valid semantic paraphrases and `~100` dissimilar / entity-swap traps (e.g., *"Restart nginx on port 8080"* vs *"Restart nginx on port 9090"*).
- Calibration script (`npx tsx bench/datasets/calibrate.ts`) evaluates `Xenova/all-MiniLM-L6-v2` (`q8`) cosine similarity across thresholds `0.85`–`0.98`, prints Precision/Recall/FPR, and selects the lowest threshold achieving **`FPR <= 1%`**.

---

## 5. Benchmark Suite (`B1`–`B5`)

Executed locally via Docker `grafana/k6` (`bench/k6/*.js`) for HTTP scenarios and `npx tsx bench/ttft/ttft.ts` for streaming TTFT measurements.

| ID | Scenario & Setup | Target / Pass Criteria |
| :--- | :--- | :--- |
| **B1 — Gateway Overhead** | `mock-llm` at `0 ms` latency. Compare direct `k6 → mock-llm` vs `k6 → gateway (x-cacheroute-cache: bypass) → mock-llm`. | Added gateway overhead `p95 < 15 ms` |
| **B2 — Two-Tier Cache** | `mock-llm` at `800 ms`. Replay `1,000`-request dataset (`40%` exact repeats, `20%` paraphrases, `40%` unique). | Exact hit `p95 < 10 ms`; Semantic hit `p95 < 60 ms`; FP `<= 1%` |
| **B3 — Failover & Breaker** | `mock-primary` injects `30%` `5xx` + `5%` timeouts; `mock-secondary` healthy at `50 ms`. | Client success rate `>= 99.9%`; capture breaker `OPEN`/`HALF_OPEN` transitions |
| **B4 — Rate-Limit Accuracy** | Fresh bucket (`60` rpm, `20` burst). Fire instant `100`-request burst. | Exactly `20` `200 OK` + `80` `429` responses (with `Retry-After`) |
| **B5 — Cache-Hit Throughput** | Ramp virtual users against pre-warmed L1 exact cache. | Record maximum sustained RPS while `p95 < 100 ms` |

### Measured Results *(Phase 6 Verified)*

- **Hardware:** `CPU: AMD Ryzen 7 7700 8-Core Processor (16 logical cores) | RAM: 15.1 GB | OS: Windows 11 (x64, build 26300) | Node.js v24.7.0 | Docker 29.4.3`

| Benchmark | Metric | Target | Measured |
| :--- | :--- | :--- | :--- |
| **B1** | Added `p50` / `p95` / `p99` overhead | `p95 < 15 ms` | **`p50 = 8.60 ms` / `p95 = 14.92 ms`** |
| **B2** | Hit rate / Exact `p95` / Semantic `p95` / FP | `p95 < 10 ms` / `< 60 ms` / `<= 1%` | **`59.4%` hit rate / Exact `p95 = 7.08 ms` / Semantic `p95 = 15.25 ms` / FP `0.00%`** |
| **B3** | Success rate / `p95` under faults | `>= 99.9%` | **`100.00%` (`200/200`) / `p95 = 33.52 ms`** |
| **B4** | Allowed vs `429` on 100-req burst | `20` ok / `80` `429` | **`20` `200 OK` / `80` `429 Too Many Requests`** |
| **B5** | Peak RPS under `p95 < 100 ms` | Max RPS | **`3,526 RPS` (`p50 = 10.71 ms`, `p95 = 19.19 ms`, `p99 = 22.35 ms`)** |
| **TTFT** | Streaming SSE replay TTFT | Near-instant TTFT | **Exact `p95 = 4.34 ms` / Semantic `p95 = 9.77 ms` (vs `389.11 ms` miss)** |
