import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/domain/GatewayError.js';

describe('GatewayError OpenAI error mapping', () => {
  it('maps authentication, validation, rate limit, budget, and 503 errors to OpenAI envelope', () => {
    const authErr = GatewayError.invalidApiKey();
    expect(authErr.statusCode).toBe(401);
    expect(authErr.toOpenAIEnvelope()).toEqual({
      error: {
        message: 'Missing, malformed, or revoked virtual API key.',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });

    const modelErr = GatewayError.modelNotFound('gpt-99');
    expect(modelErr.statusCode).toBe(400);
    expect(modelErr.toOpenAIEnvelope().error.code).toBe('model_not_found');

    const rlErr = GatewayError.rateLimitExceeded(12);
    expect(rlErr.statusCode).toBe(429);
    expect(rlErr.retryAfterSeconds).toBe(12);
    expect(rlErr.toOpenAIEnvelope().error.code).toBe('rate_limit_exceeded');

    const budgetErr = GatewayError.tokenBudgetExceeded(200000);
    expect(budgetErr.statusCode).toBe(429);
    expect(budgetErr.toOpenAIEnvelope().error.code).toBe('token_budget_exceeded');

    const allFailedErr = GatewayError.allProvidersFailed('groq:500, gemini:503');
    expect(allFailedErr.statusCode).toBe(503);
    expect(allFailedErr.toOpenAIEnvelope().error.code).toBe('all_providers_failed');
  });
});
