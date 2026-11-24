import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

export interface MockFaultConfig {
  latencyMs: number;
  ttftMs: number;
  interChunkMs: number;
  errorRate: number;
  errorStatus: number;
  timeoutRate: number;
  retryAfter: number;
}

export interface MockLlmOptions {
  providerName?: string;
  initialFaults?: Partial<MockFaultConfig>;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequestBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        },
        { once: true },
      );
    }
  });
}

function parseHeaderNumber(val: string | string[] | undefined, fallback: number): number {
  if (typeof val !== 'string' || val.trim() === '') return fallback;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildMockLlmApp(options: MockLlmOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const providerName = options.providerName ?? process.env.PROVIDER_NAME ?? 'mock-primary';

  const defaultFaults: MockFaultConfig = {
    latencyMs: Number(process.env.MOCK_LATENCY_MS ?? 0),
    ttftMs: Number(process.env.MOCK_TTFT_MS ?? 0),
    interChunkMs: Number(process.env.MOCK_INTER_CHUNK_MS ?? 2),
    errorRate: Number(process.env.MOCK_ERROR_RATE ?? 0),
    errorStatus: Number(process.env.MOCK_ERROR_STATUS ?? 500),
    timeoutRate: Number(process.env.MOCK_TIMEOUT_RATE ?? 0),
    retryAfter: Number(process.env.MOCK_RETRY_AFTER ?? 0),
    ...options.initialFaults,
  };

  app.get('/healthz', async () => ({
    status: 'ok',
    provider: providerName,
    faults: defaultFaults,
  }));

  app.get('/admin/faults', async () => defaultFaults);

  app.post<{ Body: Partial<MockFaultConfig> }>('/admin/faults', async (request) => {
    Object.assign(defaultFaults, request.body ?? {});
    return defaultFaults;
  });

  app.get('/v1/models', async () => ({
    object: 'list',
    data: [{ id: 'mock-model-v1', object: 'model', owned_by: providerName }],
  }));

  const handleChatCompletion = async (
    request: {
      headers: Record<string, string | string[] | undefined>;
      body: ChatRequestBody;
    },
    reply: {
      code: (status: number) => unknown;
      header: (k: string, v: string) => unknown;
      send: (payload: unknown) => unknown;
      hijack: () => unknown;
      raw: {
        on: (ev: string, cb: () => void) => void;
        writeHead: (status: number, headers: Record<string, string>) => void;
        write: (chunk: string) => void;
        end: () => void;
      };
    },
  ) => {
    const latencyMs = parseHeaderNumber(
      request.headers['x-mock-latency-ms'],
      defaultFaults.latencyMs,
    );
    const ttftMs = parseHeaderNumber(request.headers['x-mock-ttft-ms'], defaultFaults.ttftMs);
    const interChunkMs = parseHeaderNumber(
      request.headers['x-mock-inter-chunk-ms'],
      defaultFaults.interChunkMs,
    );
    const errorRate = parseHeaderNumber(
      request.headers['x-mock-error-rate'],
      defaultFaults.errorRate,
    );
    const errorStatus = parseHeaderNumber(
      request.headers['x-mock-error-status'],
      defaultFaults.errorStatus,
    );
    const timeoutRate = parseHeaderNumber(
      request.headers['x-mock-timeout-rate'],
      defaultFaults.timeoutRate,
    );
    const retryAfter = parseHeaderNumber(
      request.headers['x-mock-retry-after'],
      defaultFaults.retryAfter,
    );
    const finishReason =
      typeof request.headers['x-mock-finish-reason'] === 'string'
        ? request.headers['x-mock-finish-reason']
        : 'stop';

    const abortController = new AbortController();
    reply.raw.on('close', () => abortController.abort());

    if (timeoutRate > 0 && Math.random() < timeoutRate) {
      try {
        await sleep(25000, abortController.signal);
      } catch {
        return;
      }
    }

    if (errorRate > 0 && Math.random() < errorRate) {
      if (errorStatus === 429 && retryAfter > 0) {
        reply.header('Retry-After', String(retryAfter));
      }
      reply.code(errorStatus);
      return reply.send({
        error: {
          message: `Simulated ${errorStatus} error from ${providerName}`,
          type: errorStatus === 429 ? 'rate_limit_error' : 'server_error',
          code: errorStatus === 429 ? 'rate_limit_exceeded' : 'upstream_error',
        },
      });
    }

    const body = request.body ?? {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastMessage = messages[messages.length - 1]?.content ?? '';
    const hash = createHash('sha256').update(lastMessage).digest('hex').slice(0, 12);
    const responseText = `[${providerName}:${hash}] Deterministic response to: ${lastMessage.slice(0, 80)}`;
    const promptTokens = Math.max(4, Math.ceil(lastMessage.length / 4));
    const completionTokens = Math.max(6, Math.ceil(responseText.length / 4));
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? 'mock-model-v1';
    const id = `chatcmpl-mock-${hash}`;

    if (!body.stream) {
      if (latencyMs > 0) {
        try {
          await sleep(latencyMs, abortController.signal);
        } catch {
          return;
        }
      }
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: responseText,
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    }

    if (ttftMs > 0) {
      try {
        await sleep(ttftMs, abortController.signal);
      } catch {
        return;
      }
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const chunkSize = 20;
    for (let i = 0; i < responseText.length; i += chunkSize) {
      if (abortController.signal.aborted) return;
      const slice = responseText.slice(i, i + chunkSize);
      const chunkPayload = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: i === 0 ? { role: 'assistant', content: slice } : { content: slice },
            finish_reason: null,
          },
        ],
      };
      reply.raw.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
      if (interChunkMs > 0) {
        try {
          await sleep(interChunkMs, abortController.signal);
        } catch {
          return;
        }
      }
    }

    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
      ...(body.stream_options?.include_usage
        ? {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          }
        : {}),
    };
    reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  };

  app.post<{ Body: ChatRequestBody }>('/v1/chat/completions', handleChatCompletion);
  app.post<{ Body: ChatRequestBody }>('/chat/completions', handleChatCompletion);

  return app;
}
