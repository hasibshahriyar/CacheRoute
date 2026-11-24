# 01 — Product Specification

## In Plain Words

This document defines exactly what CacheRoute will do in v1, what we are intentionally leaving out so the project stays focused and shippable, and the measurable speed and reliability targets it must hit.

---

## 1. Problem Statement

Applications calling LLM APIs directly face four recurring production failures:
1. **Redundant Latency & Cost:** Identical or paraphrased prompts repeatedly pay full upstream inference latency (`500 ms – 3+ s`) and consume scarce token quotas.
2. **Single-Provider Fragility:** Free and paid LLM endpoints regularly return `429 Rate Limit`, `502/503` errors, or stall mid-connection. Without failover and circuit breakers, downstream apps fail or waste time retrying dead endpoints.
3. **Lack of Per-Tenant Controls:** Sharing a single provider API key across demos or apps leaves no way to enforce per-key RPM limits or daily token budgets.
4. **Zero Visibility:** Without structured logs and metrics, teams cannot measure cache hit rates, p95 latency, Time to First Token (TTFT), or upstream error rates.

---

## 2. Goals

1. Provide a drop-in **OpenAI-compatible API** (`POST /v1/chat/completions`, `GET /v1/models`) usable with the official OpenAI SDK (`baseURL`) or `curl`.
2. Cut repeat and paraphrased prompt latency via **two-tier caching** (L1 Redis exact match + L2 `pgvector` semantic match) while keeping false positives `<= 1%`.
3. Deliver **high availability** across heterogeneous providers (Groq → Gemini → OpenRouter) using ordered failover and Redis-coordinated circuit breakers.
4. Enforce **per-key governance** via virtual API keys (`cr_live_*`), atomic Redis token-bucket rate limits, and daily token budgets.
5. Provide **clear observability** locally (Prometheus `/metrics` + Grafana) and in production (Postgres `request_logs` + `GET /admin/stats` + response diagnostic headers).
6. Prove every claim with **reproducible local benchmarks** (`B1`–`B5`) against a fault-injecting `mock-llm`.

---

## 3. Non-Goals (Out of Scope for v1)

- **No billing or payment processing** (Stripe/invoicing is not part of the gateway).
- **No web dashboard UI in v1** (custom Next.js frontend is deferred to Phase 7; v1 uses Grafana locally and `GET /admin/stats` in production).
- **No caching of tool-calling / function-calling responses** (`tools`, `functions`, `tool_choice`, or `logprobs` bypass the cache by policy).
- **No model fine-tuning or custom model training.**
- **No non-chat OpenAI endpoints** (images, audio transcription, assistants, or batch APIs are out of scope).

---

## 4. Target Personas

1. **Application Developer:** Wants to point an existing OpenAI SDK client at CacheRoute by changing only `baseURL` and `apiKey`, gaining caching and automatic failover with zero code rewrite.
2. **Platform / Backend Engineer (Admin):** Creates/revokes virtual tenant keys, sets RPM and daily token limits, invalidates tenant caches, and inspects hit rates and latency percentiles via `/admin/stats` or Grafana.
3. **Technical Reviewer / Recruiter:** Evaluates system design, OOP architecture, failure handling, test coverage, and reproducible benchmark results.

---

## 5. Functional Requirements

| ID | Requirement |
| :--- | :--- |
| **FR-1** | **OpenAI Chat Completions:** Accept `POST /v1/chat/completions` for both `stream: false` (JSON) and `stream: true` (SSE `text/event-stream`), returning OpenAI-formatted payloads and errors. |
| **FR-2** | **Model Alias Discovery:** Expose `GET /v1/models` returning configured aliases (`cr-fast`, `cr-smart`, and `mock` in local/test). |
| **FR-3** | **Virtual API Key Auth:** Authenticate `Authorization: Bearer cr_live_<32 random>` via SHA-256 lookup (cached 60s in Redis) and enforce `revoked_at IS NULL`. |
| **FR-4** | **Token-Bucket Rate Limiting:** Enforce per-key `rpm_limit` (`60` default) and `burst` (`20` default) atomically in Redis, emitting `x-ratelimit-*` headers and `429` + `Retry-After` on exhaustion. |
| **FR-5** | **Daily Token Budgets:** Enforce per-key `daily_token_budget` (`200,000` default) via Redis counters (`48h` TTL) incremented post-response with actual usage. |
| **FR-6** | **Cacheability & Entity Guard:** Bypass cache when `x-cacheroute-cache: bypass`, `n > 1`, tools/logprobs are present, or last role is not `user`; bypass semantic cache if `temperature > 0.7`, message `> 2000` chars, disabled on key, or Entity Guard detects 3+ digit numbers, emails, or URLs. |
| **FR-7** | **L1 Exact Cache:** Lookup and store canonical request SHA-256 keys in Redis (`24h` TTL). |
| **FR-8** | **L2 Semantic Cache:** Embed only the last user message (`Xenova/all-MiniLM-L6-v2` q8, `384` dims) and query `pgvector` HNSW scoped by `(tenant_id, namespace, model_alias, scope_hash)` with threshold `0.92` (`24h` TTL). |
| **FR-9** | **SSE Cache Replay & Stream Tee:** Replay cached responses as synthetic ~20-char `chat.completion.chunk` SSE events ending with `data: [DONE]`; tee live upstream SSE streams to both client and cache accumulator while injecting `stream_options.include_usage=true`. |
| **FR-10** | **Multi-Provider Failover & Circuit Breakers:** Attempt up to 3 providers along the alias route without retrying the same provider; manage `CLOSED` / `OPEN` / `HALF_OPEN` state atomically in Redis. |
| **FR-11** | **Admin API:** Provide `ADMIN_TOKEN`-protected endpoints to create keys (`POST /admin/keys`), revoke keys (`DELETE /admin/keys/:id`), query aggregated stats (`GET /admin/stats?window=24h`), and invalidate cache namespaces (`DELETE /admin/cache?keyId=`). |
| **FR-12** | **Health & Observability:** Provide `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus), `x-cacheroute-*` response headers, and asynchronous `request_logs` persistence. |

---

## 6. Non-Functional Requirements (Targets)

| ID | Target | Scope |
| :--- | :--- | :--- |
| **NFR-1** | Added gateway overhead on `bypass` `p95 < 15 ms` | Local benchmark (`B1`, 0ms mock) |
| **NFR-2** | L1 exact cache hit latency `p95 < 10 ms` | Local benchmark (`B2`) |
| **NFR-3** | L2 semantic cache hit latency `p95 < 60 ms` | Local benchmark (`B2`) |
| **NFR-4** | Semantic cache false-positive rate `<= 1%` | Calibrated on `paraphrase-pairs.jsonl` |
| **NFR-5** | Client success rate `>= 99.9%` under 30% 5xx + 5% timeout primary faults | Local benchmark (`B3`) |
| **NFR-6** | Zero cross-tenant or cross-context cache hits | Verified by automated integration tests |
| **NFR-7** | Strict TypeScript + ESM + zero unverified runtime errors | Enforced in GitHub Actions CI |

---

## 7. Portfolio Success Criteria

- Clean, self-contained repository with architectural docs, ADRs, unit + integration tests, CI pipeline, and Docker Compose setup.
- Passing **Phase 0 deployment spike** on Vercel + Neon + Upstash before core implementation begins.
- Verified `B1`–`B5` benchmark table published in `README.md` with exact hardware specs and reproducible scripts.
- Deployed live demo protected by a dedicated demo key (`10` rpm, `20,000` tokens/day, `cr-fast` only).
