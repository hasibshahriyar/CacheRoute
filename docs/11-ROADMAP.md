# 11 — Roadmap & Risk Register

## In Plain Words

We build CacheRoute in small, testable phases. **Phase 0** tests Vercel deployment immediately so nothing breaks halfway through. Each phase produces working, tested functionality with a clear Definition of Done.

---

## 1. Implementation Roadmap

| Phase | Scope & Tasks | Key Deliverables | Definition of Done | Est. |
| :---: | :--- | :--- | :--- | :---: |
| **0** | Monorepo workspace (`apps/gateway`, `apps/mock-llm`), Docker Compose skeleton, & **Vercel Deployment Spike** | Working `npm` workspace + deployed spike passing all 4 exit criteria | `/healthz`, `/debug/embed` (`384` dims, `<150ms` warm, `<5s` cold), 10-chunk SSE stream, Neon + Upstash connectivity all verified on Vercel | 1–2 days |
| **1** | `apps/mock-llm` (JSON + SSE + fault headers), core Fastify proxy, `api_keys` Drizzle schema, virtual key auth + `60s` Redis cache, OpenAI error mapping | Working OpenAI-compatible proxy (`POST /v1/chat/completions`, `GET /v1/models`, `/admin/keys`) | `curl` and official `openai` SDK work against gateway for both JSON & SSE; unit + auth tests pass | 2 days |
| **2** | `ProviderRouter`, model aliases (`cr-fast`, `cr-smart`, `mock`), `undici` timeouts (`3s`/`20s`/`30s`/`120s`), `circuit_breaker.lua`, `InMemoryCircuitBreaker` fallback | Multi-provider failover & distributed circuit breakers | Unit tests for breaker state transitions + integration test proving failover on primary `500`/`429`/timeout | 2 days |
| **3** | `token_bucket.lua` (`EVALSHA` + `NOSCRIPT`), `RedisTokenBudget` (`48h` TTL), OpenAI `x-ratelimit-*` headers, Redis fail-open degraded mode | Per-key RPM + daily token budget governance | `B4` burst test passes exact `429` count; fail-open test passes when Redis disconnects | 1 day |
| **4** | `CacheKeyBuilder`, `CacheabilityPolicy`, `EntityGuard`, `RedisExactCache` (L1), `TransformersEmbeddingModel` + `PgVectorSemanticCache` (L2 HNSW), SSE replay & tee, `DELETE /admin/cache`, `paraphrase-pairs.jsonl` calibration | Two-tier exact + semantic cache with calibrated threshold | Calibration script achieves `FPR <= 1%`; cross-tenant isolation test proves zero leaks; SSE hits replay cleanly | 3 days |
| **5** | Pino structured logs, `prom-client` `/metrics`, Prometheus + provisioned Grafana dashboard, `request_logs` via `waitUntil`, `GET /admin/stats?window=24h` | Full local + production observability | Grafana shows hit rate, latency, breaker state; `/admin/stats` returns accurate aggregates from Postgres | 1–2 days |
| **6** | Run local `B1`–`B5` (`k6` + `bench/ttft/ttft.ts`), GitHub Actions CI, update `README.md` with measured tables + hardware specs, deploy to Vercel, add CacheRoute to portfolio | Production release + verified benchmark proof | CI green (lint, typecheck, unit, integration); all `B1`–`B5` targets met; live demo key active | 2 days |
| **7** *(Later)* | Optional custom Next.js observability UI; separate `HookRelay` distributed webhook engine | Web UI + next portfolio project | Built only after v1 CacheRoute is shipped & benchmarked | Future |

---

## 2. Risk Register

| ID | Risk | Impact | Mitigation | Early Check |
| :--- | :--- | :--- | :--- | :--- |
| **R1** *(Top)* | `@huggingface/transformers` / `onnxruntime-node` fails or exceeds bundle/cold-start limits on Vercel | Blocks L2 semantic caching in prod | Deploy via `Dockerfile.vercel` container Function or enable `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` (Fallback A). If both fail, stop & re-plan — never silently swap models | **Phase 0 Spike Gate** before writing any feature |
| **R2** | Free-tier model IDs (`llama-3.1-8b-instant`, `gemini-2.5-flash-lite`, etc.) or RPM/RPD limits change | Upstream `404` / `429` on live demo | Model aliases are config-driven (`config.ts`); re-verify live model IDs before Phase 2 & keep 3-provider failover chain | Verify `GET /models` against Groq, Gemini, OpenRouter before Phase 2 |
| **R3** | Neon free compute auto-suspends after `~5 min` idle | First post-idle query sees `0.5–2s` cold wake-up | L1 Redis handles exact hits with zero Neon wake-up; `cr:key` 60s cache avoids auth wake-up on hot paths; document clearly in `README.md` | Observe cold wake-up in Phase 0 Neon check |
| **R4** | Semantic cache returns false positive on entity/number variations | Wrong answer served to user (`>1%` FPR) | Strict `EntityGuard` (3+ digits, emails, URLs), `scope_hash` isolation, `temp <= 0.7`, and empirical calibration on `paraphrase-pairs.jsonl` | Run `calibrate.ts` + Entity Guard unit tests in Phase 4 |
| **R5** | Upstash Redis hits `~500K` free monthly command quota | Rate limiting degrades to fail-open | Store auth keys for `60s`, keep compact payloads, never store vectors in Redis, **never run load tests against prod** | Monitor Upstash dashboard & enforce local-only benchmarks |
