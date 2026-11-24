export type OpenAIErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'rate_limit_error'
  | 'service_unavailable_error'
  | 'server_error';

export type OpenAIErrorCode =
  | 'invalid_api_key'
  | 'invalid_admin_token'
  | 'invalid_request'
  | 'model_not_found'
  | 'rate_limit_exceeded'
  | 'token_budget_exceeded'
  | 'upstream_client_error'
  | 'auth_backend_unavailable'
  | 'all_providers_failed'
  | 'internal_error';

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: OpenAIErrorType;
    code: OpenAIErrorCode;
  };
}

export class GatewayError extends Error {
  public readonly statusCode: number;
  public readonly type: OpenAIErrorType;
  public readonly code: OpenAIErrorCode;
  public readonly retryAfterSeconds?: number;

  constructor(params: {
    statusCode: number;
    message: string;
    type: OpenAIErrorType;
    code: OpenAIErrorCode;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'GatewayError';
    this.statusCode = params.statusCode;
    this.type = params.type;
    this.code = params.code;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }

  public toOpenAIEnvelope(): OpenAIErrorEnvelope {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
      },
    };
  }

  public static invalidApiKey(
    message = 'Missing, malformed, or revoked virtual API key.',
  ): GatewayError {
    return new GatewayError({
      statusCode: 401,
      message,
      type: 'authentication_error',
      code: 'invalid_api_key',
    });
  }

  public static invalidAdminToken(message = 'Missing or invalid ADMIN_TOKEN.'): GatewayError {
    return new GatewayError({
      statusCode: 401,
      message,
      type: 'authentication_error',
      code: 'invalid_admin_token',
    });
  }

  public static invalidRequest(message: string): GatewayError {
    return new GatewayError({
      statusCode: 400,
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  }

  public static modelNotFound(model: string): GatewayError {
    return new GatewayError({
      statusCode: 400,
      message: `Unknown model alias '${model}'. Supported aliases: cr-fast, cr-smart, mock.`,
      type: 'invalid_request_error',
      code: 'model_not_found',
    });
  }

  public static rateLimitExceeded(retryAfterSeconds: number): GatewayError {
    return new GatewayError({
      statusCode: 429,
      message: 'Rate limit exceeded for virtual API key.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      retryAfterSeconds,
    });
  }

  public static tokenBudgetExceeded(budget: number): GatewayError {
    return new GatewayError({
      statusCode: 429,
      message: `Daily token budget (${budget} tokens) exceeded for virtual API key.`,
      type: 'rate_limit_error',
      code: 'token_budget_exceeded',
    });
  }

  public static upstreamClientError(statusCode: number, message: string): GatewayError {
    return new GatewayError({
      statusCode,
      message,
      type: 'invalid_request_error',
      code: 'upstream_client_error',
    });
  }

  public static authBackendUnavailable(): GatewayError {
    return new GatewayError({
      statusCode: 503,
      message: 'Authentication backend is temporarily unavailable.',
      type: 'service_unavailable_error',
      code: 'auth_backend_unavailable',
    });
  }

  public static allProvidersFailed(details?: string): GatewayError {
    return new GatewayError({
      statusCode: 503,
      message: details
        ? `All upstream providers failed: ${details}`
        : 'All configured upstream LLM providers failed or have open circuit breakers.',
      type: 'service_unavailable_error',
      code: 'all_providers_failed',
    });
  }
}
