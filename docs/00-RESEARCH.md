# 00 — Research & Market Landscape

## In Plain Words

Before designing CacheRoute, we studied existing AI gateways, semantic cache papers/libraries, vector databases, and free cloud hosting limits. This document summarizes what exists, where existing tools fall short for our use case, and the exact technical constraints that shaped CacheRoute.

---

## 1. Existing LLM Gateways & How CacheRoute Differs

| Tool | Strength | Limitation / Gap for Our Goals |
| :--- | :--- | :--- |
| **LiteLLM** | Self-hosted Python proxy supporting 100+ providers, virtual keys, fallbacks, Redis semantic cache | Heavy Python runtime; abstract magic hides low-level HTTP/SSE mechanics; overkill for showcasing tight TS systems engineering |
| **Portkey** | Enterprise gateway with observability, guardrails, semantic cache, and fallback routing | Commercial SaaS / external proxy hop adds latency and hides infrastructure implementation |
| **Helicone** | Strong LLM request logging, cost tracking, caching, and analytics dashboard | Primarily focused on observability proxy rather than custom distributed breaker + entity-guarded semantic cache internals |
| **Cloudflare AI Gateway** | Edge-native caching, rate limiting, and fallback routing | Managed Cloudflare product; basic exact caching without custom local ONNX semantic + entity guard pipeline |
| **Vercel AI Gateway** | Managed multi-provider access with zero data retention and fallback support on Vercel | Managed platform product; building CacheRoute ourselves proves we can engineer the gateway internals (Lua breakers, HNSW, SSE tee) from scratch |
| **GPTCache** | Pioneered two-stage LLM semantic caching concepts and similarity evaluation | Python library with mixed maintenance; often lacks strict multi-tenant scoping and entity-swap protection out of the box |

**How CacheRoute Differs:**
1. **Self-hosted & Transparent:** Pure TypeScript + Fastify 5 OOP codebase where every layer (Lua token bucket, Redis breaker state machine, HNSW query, SSE stream tee) is explicit, testable, and readable.
2. **Safety-First Semantic Caching:** Combines L1 Redis exact match with L2 `pgvector` HNSW, strict multi-tenant + context-hash scoping (`scope_hash`), an **Entity Guard** (prevents *"order 1421"* vs *"order 1422"* false positives), and empirical threshold calibration.
3. **Measured Resilience:** Ships with a deterministic fault-injecting `mock-llm` and reproducible `k6` + TTFT benchmark suite proving overhead, failover rate, and cache speedup locally.

---

## 2. Semantic Caching Findings & Design Rules

1. **Two-Tier Lookup Beats Vector-Only Lookup:** Checking a deterministic SHA-256 exact key in Redis first avoids embedding compute (~10–30 ms CPU) and eliminates false-positive risk on identical prompts.
2. **Similarity Thresholds Do Not Transfer Across Embedding Models:** A cosine similarity score of `0.92` on `Xenova/all-MiniLM-L6-v2` does not equal `0.92` on OpenAI `text-embedding-3-small`. Therefore:
   - CacheRoute locks **one embedding model** (`Xenova/all-MiniLM-L6-v2`, quantized `q8`, `384` dimensions) across local Docker, CI, and production.
   - The `0.92` default threshold is verified and tuned using our labeled `bench/datasets/paraphrase-pairs.jsonl` calibration dataset targeting `<= 1%` false positives.
3. **Why Entity Guard Is Mandatory:** Vector embeddings treat numbers, emails, and URLs as minor perturbations. Without an Entity Guard, *"Where is my order 1421?"* and *"Where is my order 1422?"* can score `~0.98` cosine similarity and leak wrong answers.
4. **Why Context Scoping (`scope_hash`) Is Mandatory:** Embedding only the final user turn fails if earlier turns or system prompts differ. Computing `scope_hash` over `{system prompt, prior messages, generation params}` and filtering SQL by `(tenant_id, namespace, model_alias, scope_hash)` guarantees zero cross-tenant or cross-context pollution.

---

## 3. Why `pgvector` (L2) + Redis (L1/State) Instead of Redis Vector Search

While Redis Stack / RedisVL supports RediSearch HNSW vector indexes natively, **Upstash Redis (free serverless tier used via Vercel Marketplace) does not support RediSearch vector commands (`FT.CREATE` / `FT.SEARCH`)**.

Using **PostgreSQL (`pgvector` HNSW)** for L2 semantic search and **Redis (`ioredis`)** for L1 exact caching, rate limiting, token budgets, and circuit breaker state solves this cleanly:
- **Zero Vendor Lock-in:** Both `pgvector/pgvector:pg17` (Docker/CI) and Neon Postgres (production) support `pgvector >= 0.8` HNSW indexes and `hnsw.iterative_scan = relaxed_order` (ensuring pre-filtered `WHERE tenant_id = ...` HNSW queries still return valid matches).
- **ACID Multi-Tenant Isolation:** Relational foreign keys and composite `WHERE` filters enforce tenant boundaries cleanly.
- **Fast L1 + Atomic Control Plane:** Redis handles sub-millisecond exact hits and atomic Lua scripts without wasting precious Upstash memory (256 MB limit) on 384-dim float vectors.

---

## 4. Free-Tier Platform Limits *(as researched Nov 2026 — re-verify before deployment)*

| Platform / Service | Free-Tier Limits | Key Operational Caveat |
| :--- | :--- | :--- |
| **Groq** | ~30 RPM / ~1,000 RPD / ~6–8K TPM (varies by model) | Strict TPM/RPD ceilings; automated benchmark traffic must never hit Groq |
| **Google Gemini (AI Studio)** | Per-model RPM/RPD limits via OpenAI-compat endpoint | Free-tier prompts may be used by Google to improve products (never send sensitive data) |
| **OpenRouter (`:free`)** | 20 RPM / 50 RPD (`1,000` RPD after `$10` lifetime credit) | Strict daily cap; used as 3rd-tier failover backup |
| **Upstash Redis** | ~500K commands/month, 256 MB storage | Keep key payloads compact; do not store vectors or run polling loops |
| **Neon Postgres** | ~0.5 GB storage; compute auto-suspends after ~5 min idle | First query after idle experiences cold wake-up latency (~0.5–2s) |
| **Vercel (Hobby)** | Fluid Compute Node.js runtime: `300s` max duration, 2 GB / 1 vCPU, 4.5 MB req/res body cap (streaming exempt), 250 MB standard bundle (5 GB large-function beta) | Must pass Phase 0 spike to verify `@huggingface/transformers` + `onnxruntime-node` bundle & cold start |

---

## 5. References

- LiteLLM Docs: https://docs.litellm.ai
- Portkey Docs: https://portkey.ai/docs
- Helicone Docs: https://docs.helicone.ai
- Cloudflare AI Gateway Docs: https://developers.cloudflare.com/ai-gateway
- GPTCache Repository: https://github.com/zilliztech/GPTCache
- pgvector Repository: https://github.com/pgvector/pgvector
- Hugging Face Transformers.js Docs: https://huggingface.co/docs/transformers.js
- Groq Rate Limits: https://console.groq.com/docs/rate-limits
- Google Gemini API Rate Limits: https://ai.google.dev/gemini-api/docs/rate-limits
- OpenRouter Rate Limits: https://openrouter.ai/docs/api-reference/limits
- Upstash Redis Pricing & Limits: https://upstash.com/pricing/redis
- Neon Pricing & Limits: https://neon.com/pricing
- Vercel Functions Limitations: https://vercel.com/docs/functions/limitations
- Grafana k6 Docs: https://grafana.com/docs/k6
