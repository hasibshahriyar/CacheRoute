import { createHash } from 'node:crypto';
import type { ChatCompletionRequest } from './types.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const val = (value as Record<string, unknown>)[key];
      if (val !== undefined) {
        result[key] = canonicalize(val);
      }
    }
    return result;
  }
  return value;
}

export class CacheKeyBuilder {
  /**
   * Builds the deterministic SHA-256 hash for L1 Exact Cache lookup.
   * Canonicalizes strictly: namespace, model, messages ({role, content}),
   * temperature, top_p, max_tokens, response_format, stop.
   */
  public buildExactKey(request: ChatCompletionRequest, namespace: number): string {
    const payload = canonicalize({
      namespace,
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature ?? null,
      top_p: request.top_p ?? null,
      max_tokens: request.max_tokens ?? null,
      response_format: request.response_format ?? null,
      stop: request.stop ?? null,
    });
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * Builds the Redis L1 storage key: cr:cache:{tenantId}:{namespace}:{exactKey}
   */
  public buildRedisCacheKey(tenantId: string, namespace: number, exactKey: string): string {
    return `cr:cache:${tenantId}:${namespace}:${exactKey}`;
  }

  /**
   * Builds the SHA-256 context scope_hash for L2 Semantic Cache lookup.
   * Includes all messages prior to the final user turn (system prompt + conversation history)
   * and generation parameters so semantic hits never cross conversation contexts.
   */
  public buildScopeHash(request: ChatCompletionRequest): string {
    const priorMessages = request.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const payload = canonicalize({
      priorMessages,
      temperature: request.temperature ?? null,
      top_p: request.top_p ?? null,
      max_tokens: request.max_tokens ?? null,
      response_format: request.response_format ?? null,
      stop: request.stop ?? null,
    });
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }
}
