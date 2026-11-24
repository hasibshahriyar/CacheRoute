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

  app.get('/admin/providers/models', async (request) => {
    verifyAdminToken(request, deps.adminToken);
    const probes: Array<{ name: string; url: string; key: string }> = [
      {
        name: 'groq',
        url: 'https://api.groq.com/openai/v1/models',
        key: process.env.GROQ_API_KEY?.trim() ?? '',
      },
      {
        name: 'gemini',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        key: process.env.GEMINI_API_KEY?.trim() ?? '',
      },
    ];

    const results: Record<string, unknown> = {};
    for (const p of probes) {
      if (!p.key) {
        results[p.name] = { configured: false };
        continue;
      }
      try {
        const res = await fetch(p.url, {
          headers: { Authorization: `Bearer ${p.key}` },
        });
        if (!res.ok) {
          results[p.name] = { status: res.status, error: (await res.text()).slice(0, 200) };
        } else {
          const data = (await res.json()) as { data?: Array<{ id: string }> };
          results[p.name] = {
            status: res.status,
            models: (data.data ?? []).map((m) => m.id).slice(0, 25),
          };
        }
      } catch (err: unknown) {
        results[p.name] = { error: err instanceof Error ? err.message : 'fetch_failed' };
      }
    }
    return results;
  });
}
