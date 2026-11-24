import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GatewayError } from '../domain/GatewayError.js';
import { ChatCompletionRequestSchema, type ApiKeyContext } from '../domain/types.js';
import type { ApiKeyRepository, RateLimiter, TokenBudget } from '../ports/index.js';
import type { ChatCompletionService } from '../services/ChatCompletionService.js';
import type { ProviderRouter } from '../services/ProviderRouter.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRequestId(request: FastifyRequest): string {
  const headerVal = request.headers['x-request-id'];
  if (typeof headerVal === 'string' && UUID_REGEX.test(headerVal.trim())) {
    return headerVal.trim();
  }
  return randomUUID();
}

async function authenticateVirtualKey(
  request: FastifyRequest,
  repo: ApiKeyRepository,
): Promise<ApiKeyContext> {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw GatewayError.invalidApiKey();
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token.startsWith('cr_live_') || token.length < 16) {
    throw GatewayError.invalidApiKey();
  }

  const keyContext = await repo.findByPlaintextKey(token);
  if (!keyContext || keyContext.revokedAt !== null) {
    throw GatewayError.invalidApiKey();
  }
  return keyContext;
}

function extractMockForwardHeaders(request: FastifyRequest): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [key, val] of Object.entries(request.headers)) {
    if (key.toLowerCase().startsWith('x-mock-') && typeof val === 'string') {
      forwarded[key] = val;
    }
  }
  return forwarded;
}

export function registerV1Routes(
  app: FastifyInstance,
  deps: {
    apiKeyRepository: ApiKeyRepository;
    rateLimiter: RateLimiter;
    tokenBudget: TokenBudget;
    providerRouter: ProviderRouter;
    chatCompletionService: ChatCompletionService;
  },
): void {
  app.get('/v1/models', async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header('x-request-id', requestId);
    await authenticateVirtualKey(request, deps.apiKeyRepository);

    const aliases = deps.providerRouter.getSupportedModels();
    return {
      object: 'list',
      data: aliases.map((id) => ({
        id,
        object: 'model',
        owned_by: 'cacheroute',
      })),
    };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const startedAtMs = Date.now();
    // Stage 1: Request ID
    const requestId = resolveRequestId(request);
    reply.header('x-request-id', requestId);

    // Stage 2: Virtual Key Auth
    const keyContext = await authenticateVirtualKey(request, deps.apiKeyRepository);

    // Stage 3: Zod Validation
    const parsed = ChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw GatewayError.invalidRequest(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const chatRequest = parsed.data;

    // Stage 4: Rate Limit & Daily Budget
    const rl = await deps.rateLimiter.consume(keyContext.id, keyContext.rpmLimit, keyContext.burst);
    reply.header('x-ratelimit-limit-requests', String(rl.limit));
    reply.header('x-ratelimit-remaining-requests', String(rl.remaining));
    reply.header('x-ratelimit-reset-requests', String(rl.resetSeconds));

    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSeconds));
      throw GatewayError.rateLimitExceeded(rl.retryAfterSeconds);
    }

    const budgetCheck = await deps.tokenBudget.check(keyContext.id, keyContext.dailyTokenBudget);
    if (!budgetCheck.allowed) {
      throw GatewayError.tokenBudgetExceeded(keyContext.dailyTokenBudget);
    }

    const cacheHeader =
      typeof request.headers['x-cacheroute-cache'] === 'string'
        ? request.headers['x-cacheroute-cache']
        : undefined;
    const forwardHeaders = extractMockForwardHeaders(request);

    // Stages 5–11
    if (!chatRequest.stream) {
      const result = await deps.chatCompletionService.executeNonStream({
        requestId,
        request: chatRequest,
        keyContext,
        cacheHeader,
        forwardHeaders,
        startedAtMs,
      });

      reply.header('x-cacheroute-cache', result.cacheStatus);
      reply.header('x-cacheroute-provider', result.provider);
      reply.header('x-cacheroute-attempts', String(result.attempts));
      reply.header('x-cacheroute-latency-ms', String(result.latencyMs));
      if (result.similarity !== undefined) {
        reply.header('x-cacheroute-similarity', result.similarity.toFixed(4));
      }

      return reply.send(result.response);
    }

    const streamResult = await deps.chatCompletionService.executeStream({
      requestId,
      request: chatRequest,
      keyContext,
      cacheHeader,
      forwardHeaders,
      startedAtMs,
    });

    const sseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'x-request-id': requestId,
      'x-cacheroute-cache': streamResult.cacheStatus,
      'x-cacheroute-provider': streamResult.provider,
      'x-cacheroute-attempts': String(streamResult.attempts),
      'x-cacheroute-latency-ms': String(streamResult.ttftMs),
      'x-ratelimit-limit-requests': String(rl.limit),
      'x-ratelimit-remaining-requests': String(rl.remaining),
      'x-ratelimit-reset-requests': String(rl.resetSeconds),
    };
    if (streamResult.similarity !== undefined) {
      sseHeaders['x-cacheroute-similarity'] = streamResult.similarity.toFixed(4);
    }

    reply.hijack();
    reply.raw.writeHead(200, sseHeaders);
    await streamResult.writeToResponse(reply.raw);
    return;
  });
}
