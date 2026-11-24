# 04 — Two-Tier Caching & Safety Policies

## In Plain Words

CacheRoute uses two cache layers to get the best of both worlds: **Redis (L1)** gives instant `1–3 ms` answers when someone sends the exact same request, and **pgvector (L2)** catches paraphrased questions with a `384`-dimension local AI embedding. Strict guardrails (**Entity Guard** and **Context Scoping**) prevent the semantic cache from ever returning a dangerously wrong answer.

---

## 1. L1 Exact Cache (Redis)

- **Key Format:** `cr:cache:{tenantId}:{namespace}:{exactKey}`
- **Canonicalization:** Build a JSON object with **sorted keys** containing strictly:
  - `namespace` (integer `cache_namespace` on the `api_keys` row)
  - `model` (requested alias, e.g., `cr-fast`)
  - `messages` (ordered array of `{ role, content }`)
  - `temperature`
  - `top_p`
  - `max_tokens`
  - `response_format`
  - `stop`
- **Hash:** `exactKey = SHA-256(canonicalJson)`
- **TTL:** `CACHE_TTL_SECONDS` (`86400` seconds = `24` hours).
- **Behavior:** Exact byte-level semantic certainty with zero embedding cost and zero false-positive risk.

---

## 2. L2 Semantic Cache (`pgvector` HNSW)

### 2.1 Embedding Model
- **Library:** `@huggingface/transformers`
- **Model:** `Xenova/all-MiniLM-L6-v2` (quantized `q8`, `384` dimensions, mean-pooled + L2-normalized).
- **Singleton Rule:** Initialized once at startup / module scope so the ONNX session stays warm across requests.
- **One-Model Invariant:** The exact same model and dimension (`384`) are used locally, in CI, and on Vercel. Similarity thresholds do **not** transfer across embedding models; changing the model requires a new database vector column dimension and full recalibration.

### 2.2 What Gets Embedded vs. What Gets Scoped
- **Embedded Text:** **Only the last user message** (`messages[last].content`).
- **Context Scope (`scope_hash`):** `SHA-256` over `{ systemPrompt, allPriorMessages, temperature, top_p, max_tokens, response_format, stop }`.
- **SQL Isolation:** Every L2 lookup filters strictly on:
  - `tenant_id = $tenantId`
  - `namespace = $namespace`
  - `model_alias = $modelAlias`
  - `scope_hash = $scopeHash`
  - `expires_at > NOW()`
  - `(1 - (embedding <=> $queryVec)) >= $threshold` (default `0.92`)

### 2.3 pgvector HNSW Configuration
- **Index Definition:** `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`
- **Filtered Scan Accuracy:** Before running the similarity `SELECT`, the connection executes:
  ```sql
  SET LOCAL hnsw.ef_search = 100;
  SET LOCAL hnsw.iterative_scan = relaxed_order;
  ```
  `iterative_scan = relaxed_order` (available in `pgvector >= 0.8`) ensures filtered HNSW queries keep scanning candidates when early matches are filtered out by `tenant_id` or `scope_hash`.

---

## 3. Cacheability Rules & Entity Guard

A request is evaluated by `CacheabilityPolicy` and `EntityGuard` **before** querying L1 or L2:

### 3.1 Eligible for Exact & Semantic Cache (`exactEligible`)
All must be true:
1. Header `x-cacheroute-cache` is **not** `bypass`.
2. `n` is unset or `n === 1`.
3. No `tools`, `functions`, `tool_choice`, or `logprobs` fields are present.
4. The final message in `messages` has `role === "user"` and non-empty string `content`.

### 3.2 Additional Rules for Semantic Cache (`semanticEligible`)
All of 3.1 **plus** all of the following must be true:
1. `api_keys.semantic_cache_enabled === true`.
2. `temperature` is unset or `<= 0.7` (high-temperature creative requests expect variety).
3. Last user message length is `<= 2000` characters.
4. **Entity Guard passes:** skips semantic caching if the last user message contains any of:
   - **3+ consecutive digits** (`/\b\d{3,}\b/` or `/\d{3,}/`) — e.g., *"order 1421"* vs *"order 1422"*, invoices, port numbers, zip codes, or dates.
   - **Email address** (`/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/`).
   - **URL** (`/https?:\/\/\S+|www\.\S+/i`).

> **Why Entity Guard Exists:** Sentence transformers focus on overall phrasing structure. Without Entity Guard, `"What is the status of order 1421?"` and `"What is the status of order 1422?"` produce a `~0.98` cosine similarity score, causing CacheRoute to return order 1421's answer for order 1422. Entity Guard forces those queries to either exact match or miss cleanly to the LLM.

---

## 4. Writeback Rules & Cache Invalidation

- **Write Only on Clean Completion:** CacheRoute stores a response into L1 (`RedisExactCache`) and L2 (`PgVectorSemanticCache`, if `semanticEligible`) **only when**:
  1. Upstream HTTP status is `200`.
  2. `finish_reason === "stop"` (truncated `length` or filtered responses are never cached).
  3. Assistant text `content` is non-empty.
- **Zero-Downtime Namespace Invalidation:** Calling `DELETE /admin/cache?keyId=<uuid>` atomically increments `api_keys.cache_namespace` (`namespace + 1`) in Postgres and invalidates the Redis key-lookup entry (`cr:key:{sha256}`). All prior L1 and L2 keys immediately become unreachable without running expensive `KEYS`/`SCAN` purges on Redis or `DELETE` locks on Postgres; expired rows age out naturally via TTL.

---

## 5. Streaming Cache Replay & Miss Tee

- **Streaming Cache Hit (`stream: true`):**
  - Instead of rejecting streaming requests on a cache hit, CacheRoute replays the cached completion text as synthetic OpenAI `chat.completion.chunk` SSE events (~`20`-character chunks) followed by a final usage chunk and `data: [DONE]\n\n`.
  - Delivers near-instant Time to First Token (`TTFT`) on both L1 and L2 hits.
- **Streaming Cache Miss (`stream: true`):**
  - CacheRoute injects `stream_options: { include_usage: true }` into the upstream request so providers report `prompt_tokens` and `completion_tokens` in the final SSE frame.
  - Each chunk is forwarded to the client immediately as bytes arrive while an internal tee buffer accumulates the assistant text and `finish_reason`.
  - After stream completion, stage 11 (`BackgroundTasks`) writes L1/L2 cache entries and logs token usage.

---

## 6. Threshold Calibration (`bench/datasets/paraphrase-pairs.jsonl`)

- We maintain a ~200-pair labeled dataset (~100 true paraphrase pairs + ~100 dissimilar/entity-swap trap pairs).
- A calibration script computes cosine similarity for all pairs using `Xenova/all-MiniLM-L6-v2` (`q8`) and sweeps thresholds (`0.85` → `0.98`) to measure **Precision**, **Recall**, and **False-Positive Rate (FPR)**.
- We select the lowest threshold that guarantees **`FPR <= 1%`** (`0.92` default baseline until measured).

---

## 7. Privacy & Safety Rules

- **Strict Tenant Isolation:** Every L1 Redis key includes `tenantId` and every L2 SQL query filters on `tenant_id`. One tenant can never read another tenant's cached completions.
- **Free-Tier Privacy Note:** Requests routed to free Gemini/OpenRouter endpoints may be subject to provider prompt logging policies; production users should bypass or avoid free tiers for sensitive PII.
- **Client Opt-Out:** Sending `x-cacheroute-cache: bypass` guarantees both L1 and L2 are skipped for both reads and writes.
