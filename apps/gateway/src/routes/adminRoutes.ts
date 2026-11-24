import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../domain/GatewayError.js';
import type { ApiKeyRepository, RequestLogSink } from '../ports/index.js';

const CreateKeyBodySchema = z.object({
  name: z.string().min(1).max(120),
  rpmLimit: z.number().int().positive().max(100000).optional(),
  burst: z.number().int().positive().max(100000).optional(),
  dailyTokenBudget: z.number().int().positive().optional(),
  semanticCacheEnabled: z.boolean().optional(),
});

const StatsQuerySchema = z.object({
  window: z.enum(['1h', '24h', '7d', '30d']).optional().default('24h'),
});

const CacheDeleteQuerySchema = z.object({
  keyId: z.string().uuid(),
});

function verifyAdminToken(request: FastifyRequest, adminToken: string): void {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw GatewayError.invalidAdminToken();
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token || token !== adminToken) {
    throw GatewayError.invalidAdminToken();
  }
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: {
    adminToken: string;
    apiKeyRepository: ApiKeyRepository;
    requestLogSink: RequestLogSink;
  },
): void {
  app.post('/admin/keys', async (request, reply) => {
    verifyAdminToken(request, deps.adminToken);
    const parsed = CreateKeyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw GatewayError.invalidRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const created = await deps.apiKeyRepository.createKey(parsed.data);
    reply.code(201);
    return created;
  });

  app.delete<{ Params: { id: string } }>('/admin/keys/:id', async (request) => {
    verifyAdminToken(request, deps.adminToken);
    const idSchema = z.string().uuid();
    const idParsed = idSchema.safeParse(request.params.id);
    if (!idParsed.success) {
      throw GatewayError.invalidRequest('Invalid key UUID parameter.');
    }
    const revoked = await deps.apiKeyRepository.revokeKey(idParsed.data);
    return {
      revoked,
      id: idParsed.data,
    };
  });

  app.get('/admin/stats', async (request) => {
    verifyAdminToken(request, deps.adminToken);
    const parsed = StatsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw GatewayError.invalidRequest(
        'Invalid window query parameter. Allowed: 1h, 24h, 7d, 30d',
      );
    }
    return deps.requestLogSink.getStats(parsed.data.window);
  });

  app.delete('/admin/cache', async (request) => {
    verifyAdminToken(request, deps.adminToken);
    const parsed = CacheDeleteQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw GatewayError.invalidRequest('Missing or invalid keyId UUID query parameter.');
    }
    const newNamespace = await deps.apiKeyRepository.incrementCacheNamespace(parsed.data.keyId);
    if (newNamespace === null) {
      throw GatewayError.invalidRequest(`API key '${parsed.data.keyId}' not found.`);
    }
    return {
      keyId: parsed.data.keyId,
      newNamespace,
    };
  });
}
