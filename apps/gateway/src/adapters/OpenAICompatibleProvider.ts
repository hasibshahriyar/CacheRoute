import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ProviderEndpointConfig } from '../config.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../domain/types.js';
import type {
  LlmProvider,
  UpstreamCompletionResult,
  UpstreamStreamResult,
} from '../ports/index.js';

export class UpstreamProviderError extends Error {
  public readonly provider: string;
  public readonly statusCode: number;
  public readonly isFailoverEligible: boolean;
  public readonly countsAsBreakerFailure: boolean;
  public readonly isCriticalAuthAlert: boolean;
  public readonly retryAfterMs: number;

  constructor(params: {
    provider: string;
    statusCode: number;
    message: string;
    isFailoverEligible: boolean;
    countsAsBreakerFailure: boolean;
    isCriticalAuthAlert?: boolean;
    retryAfterMs?: number;
  }) {
    super(params.message);
    this.name = 'UpstreamProviderError';
    this.provider = params.provider;
    this.statusCode = params.statusCode;
    this.isFailoverEligible = params.isFailoverEligible;
    this.countsAsBreakerFailure = params.countsAsBreakerFailure;
    this.isCriticalAuthAlert = params.isCriticalAuthAlert ?? false;
    this.retryAfterMs = params.retryAfterMs ?? 0;
  }
}

export interface ProviderTimeouts {
  connectTimeoutMs: number;
  ttftTimeoutMs: number;
  totalTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: ProviderTimeouts = {
  connectTimeoutMs: 3_000,
  ttftTimeoutMs: 20_000,
  totalTimeoutMs: 120_000,
};

function parseRetryAfterMs(headerVal: string | null): number {
  if (!headerVal) return 0;
  const seconds = Number(headerVal);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }
  return 0;
}

export class OpenAICompatibleProvider implements LlmProvider {
  public readonly name: string;
  public readonly upstreamModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeouts: ProviderTimeouts;
  private readonly dispatcher: Dispatcher;

  constructor(config: ProviderEndpointConfig, timeouts: Partial<ProviderTimeouts> = {}) {
    this.name = config.provider;
    this.upstreamModel = config.upstreamModel;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.dispatcher = new Agent({
      connectTimeout: this.timeouts.connectTimeoutMs,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }

  private classifyHttpError(
    status: number,
    bodyText: string,
    retryAfterHeader: string | null,
  ): UpstreamProviderError {
    let message = `Upstream ${this.name} returned HTTP ${status}`;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      const firstObj = Array.isArray(parsed)
        ? (parsed[0] as { error?: { message?: string } } | undefined)
        : (parsed as { error?: { message?: string } } | undefined);
      if (firstObj?.error?.message) {
        message = `[${this.name}] ${firstObj.error.message}`;
      } else if (bodyText.trim().length > 0) {
        message = `[${this.name}] ${bodyText.slice(0, 240)}`;
      }
    } catch {
      if (bodyText.trim().length > 0) {
        message = `[${this.name}] ${bodyText.slice(0, 240)}`;
      }
    }

    const lowerMsg = message.toLowerCase();
    const isProviderKeyOrModelError =
      lowerMsg.includes('api key') ||
      lowerMsg.includes('api_key') ||
      lowerMsg.includes('not found') ||
      lowerMsg.includes('does not exist') ||
      lowerMsg.includes('not supported') ||
      lowerMsg.includes('do not have access') ||
      lowerMsg.includes('decommissioned') ||
      lowerMsg.includes('permission denied');

    // 401, 403, or Google Gemini 400 API_KEY_INVALID / model-not-found -> failover + trip breaker
    if (status === 401 || status === 403 || (status === 400 && isProviderKeyOrModelError)) {
      return new UpstreamProviderError({
        provider: this.name,
        statusCode: status,
        message,
        isFailoverEligible: true,
        countsAsBreakerFailure: true,
        isCriticalAuthAlert: true,
      });
    }

    // 400, 404, 422 -> client bad request (unless provider model 404)
    if (status === 404 && isProviderKeyOrModelError) {
      return new UpstreamProviderError({
        provider: this.name,
        statusCode: status,
        message,
        isFailoverEligible: true,
        countsAsBreakerFailure: true,
      });
    }

    if (status === 400 || status === 404 || status === 422) {
      return new UpstreamProviderError({
        provider: this.name,
        statusCode: status,
        message,
        isFailoverEligible: false,
        countsAsBreakerFailure: false,
      });
    }

    // 408, 429, 5xx -> failover + trip breaker
    return new UpstreamProviderError({
      provider: this.name,
      statusCode: status,
      message,
      isFailoverEligible: true,
      countsAsBreakerFailure: true,
      retryAfterMs: parseRetryAfterMs(retryAfterHeader),
    });
  }

  public async complete(
    request: ChatCompletionRequest,
    forwardHeaders: Record<string, string> = {},
  ): Promise<UpstreamCompletionResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const ttftController = new AbortController();
    const ttftTimer = setTimeout(() => ttftController.abort(), this.timeouts.ttftTimeoutMs);
    const totalTimer = setTimeout(() => ttftController.abort(), this.timeouts.totalTimeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...forwardHeaders,
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const upstreamBody = {
        ...request,
        model: this.upstreamModel,
        stream: false,
      };

      const res = await undiciFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: ttftController.signal,
        dispatcher: this.dispatcher,
      });

      clearTimeout(ttftTimer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw this.classifyHttpError(res.status, text, res.headers.get('retry-after'));
      }

      const payload = (await res.json()) as ChatCompletionResponse;
      return {
        provider: this.name,
        upstreamModel: this.upstreamModel,
        response: payload,
      };
    } catch (err: unknown) {
      if (err instanceof UpstreamProviderError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Upstream network/timeout failure';
      throw new UpstreamProviderError({
        provider: this.name,
        statusCode: 504,
        message: `${this.name} request failed: ${msg}`,
        isFailoverEligible: true,
        countsAsBreakerFailure: true,
      });
    } finally {
      clearTimeout(ttftTimer);
      clearTimeout(totalTimer);
    }
  }

  public async stream(
    request: ChatCompletionRequest,
    forwardHeaders: Record<string, string> = {},
  ): Promise<UpstreamStreamResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const startedAt = Date.now();
    const ttftController = new AbortController();
    const ttftTimer = setTimeout(() => ttftController.abort(), this.timeouts.ttftTimeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...forwardHeaders,
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const upstreamBody = {
        ...request,
        model: this.upstreamModel,
        stream: true,
        stream_options: {
          ...request.stream_options,
          include_usage: true,
        },
      };

      const res = await undiciFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: ttftController.signal,
        dispatcher: this.dispatcher,
      });

      clearTimeout(ttftTimer);

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw this.classifyHttpError(res.status, text, res.headers.get('retry-after'));
      }

      const ttftMs = Math.max(1, Date.now() - startedAt);
      return {
        provider: this.name,
        upstreamModel: this.upstreamModel,
        ttftMs,
        stream: res.body as unknown as ReadableStream<Uint8Array>,
      };
    } catch (err: unknown) {
      clearTimeout(ttftTimer);
      if (err instanceof UpstreamProviderError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Upstream stream connection failure';
      throw new UpstreamProviderError({
        provider: this.name,
        statusCode: 504,
        message: `${this.name} stream failed before first byte: ${msg}`,
        isFailoverEligible: true,
        countsAsBreakerFailure: true,
      });
    }
  }
}
