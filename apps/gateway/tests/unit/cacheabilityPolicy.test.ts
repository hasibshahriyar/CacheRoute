import { describe, expect, it } from 'vitest';
import { CacheabilityPolicy } from '../../src/domain/CacheabilityPolicy.js';
import { EntityGuard } from '../../src/domain/EntityGuard.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../src/domain/types.js';

describe('EntityGuard & CacheabilityPolicy', () => {
  const guard = new EntityGuard();
  const policy = new CacheabilityPolicy(guard);

  const validRequest: ChatCompletionRequest = {
    model: 'cr-fast',
    messages: [{ role: 'user', content: 'What is a circuit breaker in distributed systems?' }],
    temperature: 0.2,
    stream: false,
  };

  it('EntityGuard rejects 3+ consecutive digits, emails, and URLs', () => {
    expect(guard.inspect('What is the status of order 1421?')).toEqual({
      passed: false,
      reason: 'contains_digits',
    });
    expect(guard.inspect('Send report to alice@example.com please')).toEqual({
      passed: false,
      reason: 'contains_email',
    });
    expect(guard.inspect('Summarize https://example.com/docs/intro')).toEqual({
      passed: false,
      reason: 'contains_url',
    });
    expect(guard.inspect('Give me 2 examples of caching strategies')).toEqual({
      passed: true,
    });
  });

  it('bypasses both L1 and L2 when x-cacheroute-cache header is bypass', () => {
    const decision = policy.evaluateRequest(validRequest, { semanticCacheEnabled: true }, 'bypass');
    expect(decision).toEqual({
      exactEligible: false,
      semanticEligible: false,
      bypassReason: 'header_bypass',
    });
  });

  it('bypasses both L1 and L2 when n > 1, tools/logprobs are present, or last role is not user', () => {
    expect(
      policy.evaluateRequest({ ...validRequest, n: 2 }, { semanticCacheEnabled: true }),
    ).toMatchObject({ exactEligible: false, semanticEligible: false });

    expect(
      policy.evaluateRequest(
        { ...validRequest, tools: [{ type: 'function' }] },
        { semanticCacheEnabled: true },
      ),
    ).toMatchObject({ exactEligible: false, semanticEligible: false });

    expect(
      policy.evaluateRequest({ ...validRequest, logprobs: true }, { semanticCacheEnabled: true }),
    ).toMatchObject({ exactEligible: false, semanticEligible: false });

    expect(
      policy.evaluateRequest(
        {
          ...validRequest,
          messages: [{ role: 'assistant', content: 'Hello there' }],
        },
        { semanticCacheEnabled: true },
      ),
    ).toMatchObject({ exactEligible: false, semanticEligible: false });
  });

  it('allows L1 exact cache but disables L2 semantic cache for temp > 0.7, > 2000 chars, or entity guard hits', () => {
    expect(
      policy.evaluateRequest({ ...validRequest, temperature: 0.9 }, { semanticCacheEnabled: true }),
    ).toEqual({
      exactEligible: true,
      semanticEligible: false,
      bypassReason: 'temperature_above_0.7',
    });

    expect(
      policy.evaluateRequest(
        {
          ...validRequest,
          messages: [{ role: 'user', content: 'a'.repeat(2005) }],
        },
        { semanticCacheEnabled: true },
      ),
    ).toEqual({
      exactEligible: true,
      semanticEligible: false,
      bypassReason: 'message_exceeds_2000_chars',
    });

    expect(
      policy.evaluateRequest(
        {
          ...validRequest,
          messages: [{ role: 'user', content: 'Check order 9876 status' }],
        },
        { semanticCacheEnabled: true },
      ),
    ).toEqual({
      exactEligible: true,
      semanticEligible: false,
      bypassReason: 'entity_guard_contains_digits',
    });
  });

  it('validates response cacheability strictly on HTTP 200, finish_reason=stop, and non-empty content', () => {
    const goodResponse: ChatCompletionResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'cr-fast',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Valid answer.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    expect(policy.isResponseCacheable(200, goodResponse)).toBe(true);
    expect(policy.isResponseCacheable(500, goodResponse)).toBe(false);
    expect(
      policy.isResponseCacheable(200, {
        ...goodResponse,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Truncated' },
            finish_reason: 'length',
          },
        ],
      }),
    ).toBe(false);
    expect(
      policy.isResponseCacheable(200, {
        ...goodResponse,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '   ' },
            finish_reason: 'stop',
          },
        ],
      }),
    ).toBe(false);
  });
});
