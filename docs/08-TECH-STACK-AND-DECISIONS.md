# 08 — Tech Stack & Architecture Decision Records (ADRs)

## In Plain Words

This document records *why* we chose each library and cloud service for CacheRoute, and what alternatives we rejected. Having clear Architecture Decision Records (ADRs) ensures we stay consistent during coding and explains engineering trade-offs clearly to reviewers.

---

## 1. Tech Stack Summary

| Area | Choice | Why |
| :--- | :--- | :--- |
| **Runtime** | Node.js 24 LTS (ESM, strict TS) | Current LTS with native `fetch`/`undici`, strong Fluid Compute support on Vercel |
| **Web Framework** | Fastify 5 + `fastify-type-provider-zod` | Minimal proxy/SSE overhead, schema validation, built-in `pino` structured logging |
| **Validation & Config** | Zod | Single source of truth for request schemas and startup environment config |
| **HTTP Client** | Node `fetch` / `undici` Agent | Explicit connection pooling, keep-alive, and fine-grained `3s` connect / `20s` TTFT timeouts |
| **Redis Client** | `ioredis` | Native TLS support for Upstash, Lua `SCRIPT LOAD` / `EVALSHA`, reliable pipelining |
| **Postgres & Vectors** | Drizzle ORM + `pg` + `pgvector` | Type-safe SQL migrations & queries with clean raw SQL support for `pgvector` HNSW operators |
| **Embeddings** | `@huggingface/transformers` (`Xenova/all-MiniLM-L6-v2` q8) | Zero external API latency/cost, deterministic `384`-dim embeddings everywhere |
| **Observability** | `pino`, `prom-client`, Prometheus, Grafana | Structured JSON logs, local `/metrics` scraping, plus Postgres `request_logs` for Vercel |
| **Testing & Benchmarks** | Vitest, `tsx`, `mock-llm`, Docker `grafana/k6`, GitHub Actions | Fast TS unit/integration testing and reproducible load tests |

---

## 2. Architecture Decision Records

### ADR-001: Plain Fastify 5 over NestJS
- **Context:** A reverse-proxy gateway spending most of its time streaming SSE chunks and hashing payloads needs minimal framework overhead.
- **Decision:** Use plain Fastify 5 with explicit OOP ports/adapters classes rather than `@nestjs/platform-fastify`.
- **Consequences:** Lower per-request CPU overhead, direct control over `reply.raw` / Web `ReadableStream` SSE piping without RxJS/`@Res({ passthrough: true })` workarounds, smaller Vercel bundle.
- **Rejected:** NestJS (adds DI/interceptor overhead and complicates raw SSE streaming).

### ADR-002: TypeScript on Node.js 24 LTS
- **Context:** Needs strong typing, rich async streaming primitives, and clean Vercel Fluid Compute deployment.
- **Decision:** Use TypeScript strict mode (ESM) on Node.js 24 LTS.
- **Consequences:** Native `undici`, fast builds via `tsx`/TS compiler, matches full-stack TypeScript portfolio.
- **Rejected:** Python/FastAPI (strong for ML training, heavier cold starts on Vercel compared to Node.js 24).

### ADR-003: Vercel (Fluid Compute) + Neon + Upstash Redis
- **Context:** User already knows Vercel and Neon, wants `$0`/month hosting, and needs managed Postgres + Redis.
- **Decision:** Host `apps/gateway` on Vercel Hobby (Fluid Compute, `iad1`), Postgres on Neon (`aws-us-east-1`), and Redis on Upstash (`us-east-1` via Vercel Marketplace).
- **Consequences:** Zero server maintenance, `300s` Fluid Compute function ceiling, regional proximity to US-hosted LLM APIs. Subject to Phase 0 spike verification (`R1`).
- **Rejected:** Oracle Cloud VPS + Dokploy (higher ops setup friction for the user right now); Render/Koyeb free tiers (sleep after idle).

### ADR-004: Local ONNX Embeddings — One Model Everywhere
- **Context:** External embedding APIs add network latency (`100–300 ms`), rate limits, and privacy issues; thresholds break if different models run in dev vs prod.
- **Decision:** Run `@huggingface/transformers` (`Xenova/all-MiniLM-L6-v2`, `q8`, `384` dims) locally in every environment.
- **Consequences:** Consistent `0.92` calibrated threshold across local, CI, and prod; no external embedding API quota needed. Increases gateway bundle size (verified in Phase 0 spike).
- **Rejected:** OpenAI/Gemini/OpenRouter embeddings APIs (adds latency, rate limits, and model-drift risk).

### ADR-005: `pgvector` HNSW for L2 Semantic Cache + Redis for L1/State
- **Context:** Upstash Redis free tier does not support RediSearch vector commands (`FT.CREATE` / `FT.SEARCH`).
- **Decision:** Store L2 embeddings in Postgres (`pgvector` HNSW + `iterative_scan`) and keep L1 exact cache, token buckets, budgets, and circuit breakers in Redis.
- **Consequences:** Works identically in Docker `pgvector:pg17` and Neon; preserves Upstash's `256 MB` RAM limit; enables strict relational tenant filtering.
- **Rejected:** Redis Stack vector search (incompatible with Upstash free tier).

### ADR-006: Drizzle ORM (`drizzle-orm` + `pg`)
- **Context:** Need type-safe Postgres schema/migrations without heavy binary query engines on Vercel.
- **Decision:** Use Drizzle ORM with `pg` driver and `drizzle-kit`.
- **Consequences:** Tiny bundle footprint, clean SQL visibility, trivial raw SQL fragments for `1 - (embedding <=> $1)` cosine queries.
- **Rejected:** Prisma (larger binary engine footprint inside Vercel bundle alongside ONNX Runtime).

### ADR-007: Manual Constructor-Injection Composition Root (`container.ts`)
- **Context:** Want clean OOP separation and unit-testable ports without heavy decorator magic.
- **Decision:** Define interfaces in `ports/`, classes in `adapters/`, and wire dependencies manually in `container.ts`.
- **Consequences:** Compile-time checked dependency graph, zero runtime reflection, trivial test mocking.
- **Rejected:** InversifyJS / tsyringe / NestJS DI containers.

### ADR-008: Run All Benchmarks Locally Against `mock-llm`
- **Context:** Free tiers (Groq, Gemini, OpenRouter, Upstash, Neon) impose strict RPM/RPD caps and network jitter.
- **Decision:** Run `B1`–`B5` strictly in local Docker Compose against `apps/mock-llm`, recording CPU, RAM, and OS.
- **Consequences:** Deterministic, repeatable numbers without burning free-tier quotas or tripping upstream bans.
- **Rejected:** Load-testing production Vercel/Groq endpoints.

### ADR-009: Two-App npm Workspace (`apps/gateway` + `apps/mock-llm`), No Shared Package
- **Context:** Monorepo shared packages often cause build/transpile friction when deploying a single app folder to Vercel.
- **Decision:** Keep two clean standalone workspace apps (`apps/gateway` and `apps/mock-llm`) with zero `packages/shared` dependency.
- **Consequences:** Vercel builds `apps/gateway` directly via Root Directory setting with zero monorepo bundler quirks.
- **Rejected:** Turborepo + `packages/shared` internal library.
