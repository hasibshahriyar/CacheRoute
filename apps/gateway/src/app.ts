import Fastify, { type FastifyInstance } from 'fastify';
import { createContainer, type ContainerOverrides, type GatewayContainer } from './container.js';
import { GatewayError } from './domain/GatewayError.js';
import { registerAdminRoutes } from './routes/adminRoutes.js';
import { registerHealthRoutes } from './routes/healthRoutes.js';
import { registerV1Routes } from './routes/v1Routes.js';

export interface GatewayApp {
  app: FastifyInstance;
  container: GatewayContainer;
}

export function buildGatewayApp(overrides: ContainerOverrides = {}): GatewayApp {
  const logLevel = overrides.config?.env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info';
  const app = Fastify({
    logger:
      overrides.config?.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'
        ? false
        : { level: logLevel },
  });

  const container = createContainer({
    ...overrides,
    logger: app.log,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof GatewayError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply.code(error.statusCode).send(error.toOpenAIEnvelope());
    }

    // Handle Fastify built-in JSON syntax parse errors as 400 invalid_request_error
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: number }).statusCode === 400
    ) {
      const msg = error instanceof Error ? error.message : 'Malformed JSON request body.';
      return reply.code(400).send(GatewayError.invalidRequest(msg).toOpenAIEnvelope());
    }

    request.log.error({ err: error }, 'Unhandled gateway error');
    return reply.code(500).send({
      error: {
        message: 'Internal gateway server error.',
        type: 'server_error',
        code: 'internal_error',
      },
    });
  });

  registerHealthRoutes(app, {
    redis: container.redis,
    pgPool: container.pgPool,
    embeddingModel: container.embeddingModel,
    metrics: container.metrics,
  });

  registerAdminRoutes(app, {
    adminToken: container.config.env.ADMIN_TOKEN,
    apiKeyRepository: container.apiKeyRepository,
    requestLogSink: container.requestLogSink,
  });

  registerV1Routes(app, {
    apiKeyRepository: container.apiKeyRepository,
    rateLimiter: container.rateLimiter,
    tokenBudget: container.tokenBudget,
    providerRouter: container.providerRouter,
    chatCompletionService: container.chatCompletionService,
  });

  app.addHook('onClose', async () => {
    await container.close();
  });

  return { app, container };
}
