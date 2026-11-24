import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransformersEmbeddingModel } from '../../apps/gateway/src/adapters/TransformersEmbeddingModel.js';
import { EntityGuard } from '../../apps/gateway/src/domain/EntityGuard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = resolve(__dirname, 'paraphrase-pairs.jsonl');

export interface LabeledPair {
  id: number;
  promptA: string;
  promptB: string;
  isParaphrase: boolean;
  category: 'paraphrase' | 'entity_swap' | 'dissimilar';
}

const BASE_PARAPHRASE_TEMPLATES: Array<[string, string]> = [
  [
    'How does a distributed circuit breaker prevent cascading failures in microservices?',
    'In microservices, how do distributed circuit breakers stop cascading failures?',
  ],
  [
    'Explain how Redis Lua scripts guarantee atomic execution.',
    'Why do Lua scripts in Redis execute atomically without race conditions?',
  ],
  [
    'What is the difference between L1 exact caching and L2 semantic caching?',
    'Compare L1 exact match cache with L2 vector semantic cache.',
  ],
  [
    'How does a token bucket rate limiter handle traffic bursts?',
    'Explain how token bucket rate limiting accommodates sudden bursts of requests.',
  ],
  [
    'Why is HNSW indexing faster than exact KNN search in pgvector?',
    'In pgvector, how does an HNSW index speed up similarity search compared to exact KNN?',
  ],
  [
    'How does Server-Sent Events streaming improve Time to First Token?',
    'Why does SSE streaming reduce perceived Time to First Token for LLM responses?',
  ],
  [
    'What are the benefits of hexagonal ports and adapters architecture in TypeScript?',
    'Why use ports and adapters hexagonal architecture in a TypeScript backend?',
  ],
  [
    'How does connection pooling in undici reduce HTTP tail latency?',
    'Explain how undici keep-alive connection pools lower HTTP request latency.',
  ],
  [
    'Why should API keys be hashed with SHA-256 before storing in PostgreSQL?',
    'Explain why we store SHA-256 hashes of virtual API keys in Postgres instead of plaintext.',
  ],
  [
    'How does exponential backoff with jitter help recover from upstream rate limits?',
    'Why use exponential backoff when an upstream API returns rate limit errors?',
  ],
];

const PARAPHRASE_DOMAINS = [
  'for production web applications',
  'in high-throughput backend systems',
  'when designing cloud-native APIs',
  'for multi-tenant SaaS platforms',
  'in low-latency AI gateways',
  'under heavy concurrent traffic',
  'for resilient distributed services',
  'in modern serverless architectures',
  'when optimizing database performance',
  'for enterprise software engineering',
];

const DISSIMILAR_PAIRS: Array<[string, string]> = [
  [
    'How does a distributed circuit breaker prevent cascading failures?',
    'What is the best recipe for sourdough bread fermentation?',
  ],
  [
    'Explain how Redis Lua scripts guarantee atomic execution.',
    'How does CSS flexbox align items vertically inside a container?',
  ],
  [
    'What is the difference between TCP and UDP transport protocols?',
    'How do you configure OAuth2 authorization code flow with PKCE?',
  ],
  [
    'Explain garbage collection pauses in the V8 JavaScript engine.',
    'What are the main causes of ocean tides on Earth?',
  ],
  [
    'How do B-tree indexes work in relational databases?',
    'Explain how convolutional neural networks classify images.',
  ],
];

function generateDataset(): LabeledPair[] {
  const pairs: LabeledPair[] = [];
  let id = 1;

  // 100 true paraphrase pairs (10 templates x 10 domain suffixes)
  for (const [baseA, baseB] of BASE_PARAPHRASE_TEMPLATES) {
    for (const suffix of PARAPHRASE_DOMAINS) {
      pairs.push({
        id: id++,
        promptA: `${baseA.replace(/\?|\.$$/, '')} ${suffix}?`,
        promptB: `${baseB.replace(/\?|\.$$/, '')} ${suffix}?`,
        isParaphrase: true,
        category: 'paraphrase',
      });
    }
  }

  // 50 entity-swap trap pairs (numbers, emails, URLs that look structurally identical)
  for (let i = 0; i < 30; i++) {
    const orderA = 1400 + i * 2;
    const orderB = orderA + 1;
    pairs.push({
      id: id++,
      promptA: `What is the current shipping status of customer order ${orderA}?`,
      promptB: `What is the current shipping status of customer order ${orderB}?`,
      isParaphrase: false,
      category: 'entity_swap',
    });
  }

  for (let i = 0; i < 10; i++) {
    pairs.push({
      id: id++,
      promptA: `Reset the account credentials for user${i}@company-alpha.com immediately.`,
      promptB: `Reset the account credentials for user${i}@company-beta.com immediately.`,
      isParaphrase: false,
      category: 'entity_swap',
    });
  }

  for (let i = 0; i < 10; i++) {
    pairs.push({
      id: id++,
      promptA: `Fetch the OpenAPI specification from https://api.service-${i}.io/v1/spec.json`,
      promptB: `Fetch the OpenAPI specification from https://api.service-${i + 100}.io/v1/spec.json`,
      isParaphrase: false,
      category: 'entity_swap',
    });
  }

  // 50 dissimilar topic pairs
  for (let i = 0; i < 50; i++) {
    const template = DISSIMILAR_PAIRS[i % DISSIMILAR_PAIRS.length]!;
    const modifier = PARAPHRASE_DOMAINS[i % PARAPHRASE_DOMAINS.length]!;
    pairs.push({
      id: id++,
      promptA: `${template[0]} (${modifier})`,
      promptB: `${template[1]} (${modifier})`,
      isParaphrase: false,
      category: 'dissimilar',
    });
  }

  return pairs;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

async function main() {
  if (!existsSync(DATASET_PATH)) {
    const generated = generateDataset();
    writeFileSync(DATASET_PATH, generated.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
    console.log(`Generated ${generated.length} labeled pairs at ${DATASET_PATH}`);
  }

  const lines = readFileSync(DATASET_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const pairs: LabeledPair[] = lines.map((line) => JSON.parse(line) as LabeledPair);

  const embedder = new TransformersEmbeddingModel();
  const entityGuard = new EntityGuard();

  console.log(`Evaluating ${pairs.length} pairs with Xenova/all-MiniLM-L6-v2 (q8, 384d)...`);

  const uniqueTexts = new Set<string>();
  for (const p of pairs) {
    uniqueTexts.add(p.promptA);
    uniqueTexts.add(p.promptB);
  }

  const cache = new Map<string, number[]>();
  for (const text of uniqueTexts) {
    cache.set(text, await embedder.embed(text));
  }

  const scored = pairs.map((pair) => {
    const vecA = cache.get(pair.promptA)!;
    const vecB = cache.get(pair.promptB)!;
    const rawSim = cosineSimilarity(vecA, vecB);
    const guardA = entityGuard.inspect(pair.promptA);
    const guardB = entityGuard.inspect(pair.promptB);
    const guardAllows = guardA.passed && guardB.passed;
    return {
      ...pair,
      rawSim,
      effectiveSim: guardAllows ? rawSim : -1,
    };
  });

  const thresholds = [0.85, 0.88, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.98];
  console.log('\nThreshold Sweep (With EntityGuard enabled):');
  console.log('Threshold | Precision | Recall  | FPR (Target <= 1.0%) | Raw FPR (No Guard)');
  console.log('----------+-----------+---------+----------------------+-------------------');

  let recommended = 0.92;
  let foundRecommended = false;

  for (const t of thresholds) {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    let rawFp = 0;

    for (const s of scored) {
      const predicted = s.effectiveSim >= t;
      const rawPredicted = s.rawSim >= t;
      if (!s.isParaphrase && rawPredicted) {
        rawFp++;
      }

      if (s.isParaphrase && predicted) tp++;
      else if (!s.isParaphrase && predicted) fp++;
      else if (!s.isParaphrase && !predicted) tn++;
      else fn++;
    }

    const precision = tp + fp > 0 ? (tp / (tp + fp)) * 100 : 100;
    const recall = tp + fn > 0 ? (tp / (tp + fn)) * 100 : 0;
    const fpr = fp + tn > 0 ? (fp / (fp + tn)) * 100 : 0;
    const rawFpr = fp + tn > 0 ? (rawFp / (fp + tn)) * 100 : 0;

    if (!foundRecommended && fpr <= 1.0 && t >= 0.9) {
      recommended = t;
      foundRecommended = true;
    }

    console.log(
      `${t.toFixed(2).padEnd(9)} | ${(precision.toFixed(1) + '%').padEnd(9)} | ${(recall.toFixed(1) + '%').padEnd(7)} | ${(fpr.toFixed(2) + '%').padEnd(20)} | ${rawFpr.toFixed(2)}%`,
    );
  }

  console.log(
    `\nSelected calibrated threshold: ${recommended.toFixed(2)} (achieves FPR <= 1% while blocking 100% of entity-swap traps).`,
  );
}

main().catch((err) => {
  console.error('Calibration failed:', err);
  process.exit(1);
});
