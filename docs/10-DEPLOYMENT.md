# 10 — Deployment & Setup Guide

## In Plain Words

Everything runs in two clean setups:
1. **On your PC (Docker Compose):** Runs Postgres, Redis, `mock-llm`, CacheRoute, Prometheus, and Grafana together in one command for fast development and speed benchmarks.
2. **Live on the Internet (\$0/month):** Runs CacheRoute on **Vercel**, the database on **Neon**, and Redis on **Upstash** (added with one click inside Vercel), all pinned to **US East** so they sit close to the AI providers.

Before writing application code, **Phase 0 runs a quick "Deployment Spike"** on Vercel to prove the AI embedding model works cleanly inside Vercel Functions so we never hit a surprise halfway through the project.

---

## 1. Prerequisites Checklist

Before starting implementation, confirm you have:
- [x] **Docker Desktop** installed locally (verified: Docker 29.4.3 + Compose v5.1.4).
- [x] **Vercel Account** (`hasibshahriyar`).
- [x] **Neon Account** (with a Postgres project in **`aws-us-east-1`** and `pgvector` enabled).
- [ ] **Upstash Redis** provisioned via **Vercel Marketplace** in **`us-east-1`**.
- [ ] **3 Free LLM API Keys:**
  - **Groq:** https://console.groq.com
  - **Google AI Studio (Gemini):** https://aistudio.google.com
  - **OpenRouter:** https://openrouter.ai
- [ ] **Admin Secret:** Generate a strong random string for `ADMIN_TOKEN` (e.g., `openssl rand -hex 32`).

---

## 2. Phase 0 Deployment Spike Gate (Mandatory First Build)

**Why this gate exists:** `@huggingface/transformers` + `onnxruntime-node` includes native binaries. Before building features, we deploy a tiny Fastify spike (`apps/gateway`) to Vercel and verify **all four exit criteria**:

1. `GET /healthz` returns `200 OK`.
2. `GET /debug/embed` loads `Xenova/all-MiniLM-L6-v2` (`q8`) and returns a `384`-dimension array (`cold < 5s`, `warm < 150 ms`).
3. `GET /debug/stream` streams `10` progressive SSE chunks without buffering.
4. Gateway connects to Neon (`CREATE EXTENSION IF NOT EXISTS vector; SELECT 1`) and Upstash (`PING`, `EVAL`).

**Fallback Plan (Fallback A):**
If standard Node.js Vercel bundling struggles with native ONNX binaries or exceeds the `250 MB` standard limit, deploy the exact same gateway via `apps/gateway/Dockerfile.vercel` (Vercel Container Function, or opt into `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` up to `5 GB`). If Fallback A also fails, **stop and re-plan** — never silently swap to a different embedding model.

---

## 3. Environment Variables

| Variable | Required | Default | Notes |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Yes | `development` | `production` on Vercel |
| `PORT` | Local | `3000` | Used by Fastify locally / Docker |
| `DATABASE_URL` | Yes | — | Neon pooled connection string (`?sslmode=require`) or local Docker PG |
| `REDIS_URL` | Yes | — | Upstash `rediss://...` TLS URL or local `redis://redis:6379` |
| `ADMIN_TOKEN` | Yes | — | Secret bearer token for `/admin/*` endpoints |
| `GROQ_API_KEY` | Prod | — | Primary route (`cr-fast`, `cr-smart`) |
| `GEMINI_API_KEY` | Prod | — | 1st failover route |
| `OPENROUTER_API_KEY` | Prod | — | 2nd failover route (`:free` models) |
| `MOCK_LLM_URL` | Local | `http://mock-llm:8081` | Only set locally / in CI (never in production) |
| `SEMANTIC_THRESHOLD` | No | `0.92` | Cosine similarity cutoff (calibrated in Phase 4) |
| `CACHE_TTL_SECONDS` | No | `86400` | `24` hours |
| `LOG_LEVEL` | No | `info` | `debug` \| `info` \| `warn` \| `error` |

---

## 4. Local Development & Benchmarks (Docker Compose)

`infra/docker-compose.yml` starts:
- `postgres` (`pgvector/pgvector:pg17`)
- `redis` (`redis:7-alpine`)
- `mock-llm` (`apps/mock-llm`)
- `gateway` (`apps/gateway`)
- `prometheus` (`prom/prometheus`, scraping `gateway:3000/metrics`)
- `grafana` (`grafana/grafana`, pre-provisioned CacheRoute dashboard)

Benchmarks run via Docker using `grafana/k6`:
```bash
docker compose -f infra/docker-compose.yml up -d
docker run --rm --network infra_default -i grafana/k6 run - < bench/k6/b1-overhead.js
```

---

## 5. Production Setup (Vercel + Neon + Upstash)

1. **Create Neon DB:** Create database in **`aws-us-east-1`**, copy `DATABASE_URL`, run Drizzle migrations (`CREATE EXTENSION IF NOT EXISTS vector;` + tables/HNSW index).
2. **Add Upstash Redis:** In your Vercel project → **Integrations / Storage** → add **Upstash Redis** in **`us-east-1`**, revealing `REDIS_URL` (`rediss://...`).
3. **Configure Vercel Project:**
   - **Root Directory:** `apps/gateway`
   - **Region:** Pin Vercel Functions to **`iad1`** (matches Neon `aws-us-east-1` and Upstash `us-east-1`).
   - **Runtime:** Node.js 24 LTS on Fluid Compute (`300s` default max duration).
   - **Environment Variables:** Add all secrets (`DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `SEMANTIC_THRESHOLD=0.92`, `CACHE_TTL_SECONDS=86400`).
4. **Provision Protected Public Demo Key:**
   Call `POST /admin/keys` with `{ "name": "public-demo", "rpmLimit": 10, "burst": 5, "dailyTokenBudget": 20000 }` and restrict the public demo showcase to `cr-fast` only.

---

## 6. Free-Tier Limits Summary *(as researched Nov 2026 — re-verify)*

| Service | Free Limit | Operational Rule |
| :--- | :--- | :--- |
| **Vercel Hobby** | `300s` max duration, `2 GB / 1 vCPU`, `4.5 MB` body (streaming exempt), `250 MB` bundle (`5 GB` beta) | Pass Phase 0 spike first |
| **Neon Free** | `~0.5 GB` storage; auto-suspends after `~5 min` idle | Expect `0.5–2s` cold wake-up after idle |
| **Upstash Free** | `~500K` commands/month, `256 MB` RAM | No vectors in Redis; compact JSON only |
| **Groq** | `~30` RPM / `~1,000` RPD / `~6–8K` TPM | Never load-test against Groq |
| **Gemini** | Per-model RPM/RPD; free prompts used for training | Non-sensitive demo traffic only |
| **OpenRouter** | `20` RPM / `50` RPD (`1,000` RPD after `$10` credit) | 3rd-tier backup only |
