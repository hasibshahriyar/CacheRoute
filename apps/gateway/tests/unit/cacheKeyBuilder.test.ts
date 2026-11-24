import { describe, expect, it } from 'vitest';
import { CacheKeyBuilder } from '../../src/domain/CacheKeyBuilder.js';
import type { ChatCompletionRequest } from '../../src/domain/types.js';

describe('CacheKeyBuilder', () => {
  const builder = new CacheKeyBuilder();

  const baseRequest: ChatCompletionRequest = {
    model: 'cr-fast',
    messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: 'Explain Redis Lua scripts.' },
    ],
    temperature: 0.2,
    top_p: 1,
    stream: false,
  };

  it('produces identical exact_key regardless of extra non-canonical fields or stream flag', () => {
    const key1 = builder.buildExactKey(baseRequest, 1);
    const key2 = builder.buildExactKey(
      {
        ...baseRequest,
        stream: true,
      },
      1,
    );
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
  });

  it('produces different exact_key when namespace, model, temperature, or messages change', () => {
    const baseKey = builder.buildExactKey(baseRequest, 1);
    const ns2Key = builder.buildExactKey(baseRequest, 2);
    const modelKey = builder.buildExactKey({ ...baseRequest, model: 'cr-smart' }, 1);
    const tempKey = builder.buildExactKey({ ...baseRequest, temperature: 0.5 }, 1);

    expect(baseKey).not.toBe(ns2Key);
    expect(baseKey).not.toBe(modelKey);
    expect(baseKey).not.toBe(tempKey);
  });

  it('formats Redis L1 key with tenantId, namespace, and exactKey', () => {
    const exactKey = builder.buildExactKey(baseRequest, 3);
    const redisKey = builder.buildRedisCacheKey('tenant-123', 3, exactKey);
    expect(redisKey).toBe(`cr:cache:tenant-123:3:${exactKey}`);
  });

  it('produces identical scope_hash when only the final user message changes', () => {
    const scope1 = builder.buildScopeHash(baseRequest);
    const scope2 = builder.buildScopeHash({
      ...baseRequest,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: 'Tell me in one sentence how Redis Lua scripts work.' },
      ],
    });
    expect(scope1).toBe(scope2);
  });

  it('produces different scope_hash when system prompt or prior history differs', () => {
    const scope1 = builder.buildScopeHash(baseRequest);
    const scope2 = builder.buildScopeHash({
      ...baseRequest,
      messages: [
        { role: 'system', content: 'You are a pirate.' },
        { role: 'user', content: 'Explain Redis Lua scripts.' },
      ],
    });
    expect(scope1).not.toBe(scope2);
  });
});
