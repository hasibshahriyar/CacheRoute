import { CacheabilityPolicy } from '../domain/CacheabilityPolicy.js';
import type {
  ApiKeyContext,
  CacheStatus,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../domain/types.js';
import type { BackgroundTasks } from '../ports/index.js';
import type { CacheService } from './CacheService.js';
import type { ProviderRouter } from './ProviderRouter.js';
import type { UsageService } from './UsageService.js';

export interface NonStreamExecutionOutput {
  response: ChatCompletionResponse;
  cacheStatus: CacheStatus;
  provider: string;
  attempts: number;
  latencyMs: number;
  similarity?: number;
}

export interface StreamExecutionOutput {
  cacheStatus: CacheStatus;
  provider: string;
  attempts: number;
  ttftMs: number;
  similarity?: number;
  writeToResponse: (rawReply: { write: (chunk: string) => void; end: () => void }) => Promise<void>;
}

export class ChatCompletionService {
  private readonly cacheService: CacheService;
  private readonly providerRouter: ProviderRouter;
  private readonly usageService: UsageService;
  private readonly backgroundTasks: BackgroundTasks;
  private readonly policy: CacheabilityPolicy;

  constructor(params: {
    cacheService: CacheService;
    providerRouter: ProviderRouter;
    usageService: UsageService;
    backgroundTasks: BackgroundTasks;
    policy?: CacheabilityPolicy;
  }) {
    this.cacheService = params.cacheService;
    this.providerRouter = params.providerRouter;
    this.usageService = params.usageService;
    this.backgroundTasks = params.backgroundTasks;
    this.policy = params.policy ?? new CacheabilityPolicy();
  }

  public async executeNonStream(params: {
    requestId: string;
    request: ChatCompletionRequest;
    keyContext: ApiKeyContext;
    cacheHeader?: string;
    forwardHeaders?: Record<string, string>;
    startedAtMs: number;
  }): Promise<NonStreamExecutionOutput> {
    const { requestId, request, keyContext, cacheHeader, forwardHeaders, startedAtMs } = params;

    // Validate model alias upfront so invalid aliases fail fast even before cache
    this.providerRouter.resolveRoute(request.model);

    // Stage 5: Cacheability Decision
    const decision = this.policy.evaluateRequest(request, keyContext, cacheHeader);

    // Stages 6 & 7: L1 Exact & L2 Semantic Lookup
    const lookup = await this.cacheService.lookup(request, keyContext, decision);

    if (
      (lookup.status === 'HIT-EXACT' || lookup.status === 'HIT-SEMANTIC') &&
      lookup.record !== undefined
    ) {
      const latencyMs = Math.max(1, Date.now() - startedAtMs);
      const cachedResponse: ChatCompletionResponse = {
        ...lookup.record.response,
        model: request.model,
      };
      const logEntry = {
        requestId,
        tenantId: keyContext.id,
        modelAlias: request.model,
        provider: 'cache',
        upstreamModel: lookup.record.response.model ?? null,
        stream: false,
        cacheStatus: lookup.status,
        similarity: lookup.similarity ?? null,
        statusCode: 200,
        errorCode: null,
        attempts: 0,
        latencyMs,
        ttftMs: null,
        promptTokens: lookup.record.promptTokens,
        completionTokens: lookup.record.completionTokens,
      };
      this.usageService.recordMetricsSync(logEntry);
      this.backgroundTasks.run(() => this.usageService.persistAsync(logEntry));

      return {
        response: cachedResponse,
        cacheStatus: lookup.status,
        provider: 'cache',
        attempts: 0,
        latencyMs,
        similarity: lookup.similarity,
      };
    }

    // Stages 8 & 9: Route Resolution + Provider Attempt Loop
    const upstream = await this.providerRouter.complete(request, forwardHeaders);
    const latencyMs = Math.max(1, Date.now() - startedAtMs);

    const response: ChatCompletionResponse = {
      ...upstream.response,
      model: request.model,
    };

    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;

    const logEntry = {
      requestId,
      tenantId: keyContext.id,
      modelAlias: request.model,
      provider: upstream.provider,
      upstreamModel: upstream.upstreamModel,
      stream: false,
      cacheStatus: lookup.status,
      similarity: null,
      statusCode: 200,
      errorCode: null,
      attempts: upstream.attempts,
      latencyMs,
      ttftMs: null,
      promptTokens,
      completionTokens,
    };

    this.usageService.recordMetricsSync(logEntry);

    // Stage 11: Background Tasks
    this.backgroundTasks.run(async () => {
      await Promise.all([
        this.cacheService.store({
          request,
          keyContext,
          decision,
          exactKey: lookup.exactKey,
          scopeHash: lookup.scopeHash,
          embedding: lookup.embedding,
          response,
          statusCode: 200,
        }),
        this.usageService.persistAsync(logEntry),
      ]);
    });

    return {
      response,
      cacheStatus: lookup.status,
      provider: upstream.provider,
      attempts: upstream.attempts,
      latencyMs,
    };
  }

  public async executeStream(params: {
    requestId: string;
    request: ChatCompletionRequest;
    keyContext: ApiKeyContext;
    cacheHeader?: string;
    forwardHeaders?: Record<string, string>;
    startedAtMs: number;
  }): Promise<StreamExecutionOutput> {
    const { requestId, request, keyContext, cacheHeader, forwardHeaders, startedAtMs } = params;

    this.providerRouter.resolveRoute(request.model);

    // Stage 5: Cacheability Decision
    const decision = this.policy.evaluateRequest(request, keyContext, cacheHeader);

    // Stages 6 & 7: L1 Exact & L2 Semantic Lookup
    const lookup = await this.cacheService.lookup(request, keyContext, decision);

    if (
      (lookup.status === 'HIT-EXACT' || lookup.status === 'HIT-SEMANTIC') &&
      lookup.record !== undefined
    ) {
      const record = lookup.record;
      const ttftMs = Math.max(1, Date.now() - startedAtMs);

      return {
        cacheStatus: lookup.status,
        provider: 'cache',
        attempts: 0,
        ttftMs,
        similarity: lookup.similarity,
        writeToResponse: async (rawReply) => {
          const content = record.response.choices[0]?.message?.content ?? '';
          const id = record.response.id || `chatcmpl-cr-${requestId.slice(0, 8)}`;
          const created = record.response.created || Math.floor(Date.now() / 1000);
          const chunkSize = 20;

          for (let i = 0; i < content.length; i += chunkSize) {
            const slice = content.slice(i, i + chunkSize);
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: i === 0 ? { role: 'assistant', content: slice } : { content: slice },
                  finish_reason: null,
                },
              ],
            };
            rawReply.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          const finalChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: record.promptTokens,
              completion_tokens: record.completionTokens,
              total_tokens: record.promptTokens + record.completionTokens,
            },
          };
          rawReply.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          rawReply.write('data: [DONE]\n\n');
          rawReply.end();

          const latencyMs = Math.max(1, Date.now() - startedAtMs);
          const logEntry = {
            requestId,
            tenantId: keyContext.id,
            modelAlias: request.model,
            provider: 'cache',
            upstreamModel: record.response.model ?? null,
            stream: true,
            cacheStatus: lookup.status,
            similarity: lookup.similarity ?? null,
            statusCode: 200,
            errorCode: null,
            attempts: 0,
            latencyMs,
            ttftMs,
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
          };
          this.usageService.recordMetricsSync(logEntry);
          this.backgroundTasks.run(() => this.usageService.persistAsync(logEntry));
        },
      };
    }

    // Stages 8 & 9: Stream from upstream (fails over automatically if failure is before first byte)
    const upstream = await this.providerRouter.stream(request, forwardHeaders);

    return {
      cacheStatus: lookup.status,
      provider: upstream.provider,
      attempts: upstream.attempts,
      ttftMs: upstream.ttftMs,
      writeToResponse: async (rawReply) => {
        const reader = upstream.stream.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let accumulatedContent = '';
        let finishReason: string | null = null;
        let promptTokens = 0;
        let completionTokens = 0;
        let responseId = `chatcmpl-cr-${requestId.slice(0, 8)}`;

        const parseSseLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const payloadStr = trimmed.slice(5).trim();
          if (payloadStr === '[DONE]' || payloadStr.length === 0) return;
          try {
            const parsed = JSON.parse(payloadStr) as {
              id?: string;
              choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
              };
            };
            if (parsed.id) responseId = parsed.id;
            const choice = parsed.choices?.[0];
            if (choice?.delta?.content) {
              accumulatedContent += choice.delta.content;
            }
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
              completionTokens = parsed.usage.completion_tokens ?? completionTokens;
            }
          } catch {
            // Ignore malformed SSE JSON fragment
          }
        };

        try {
          while (true) {
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            const readPromise = reader.read();
            const timeoutPromise = new Promise<never>((_, reject) => {
              idleTimer = setTimeout(
                () => reject(new Error('Idle chunk timeout (30s) exceeded')),
                30_000,
              );
            });

            const { done, value } = await Promise.race([readPromise, timeoutPromise]).finally(
              () => {
                if (idleTimer) clearTimeout(idleTimer);
              },
            );

            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            rawReply.write(chunkText);

            sseBuffer += chunkText;
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? '';
            for (const line of lines) {
              parseSseLine(line);
            }
          }

          if (sseBuffer.trim().length > 0) {
            parseSseLine(sseBuffer);
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : 'Upstream stream interrupted';
          const errorEvent = {
            error: {
              message: errMsg,
              type: 'server_error',
              code: 'stream_interrupted',
            },
          };
          rawReply.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          rawReply.write('data: [DONE]\n\n');
          finishReason = 'error';
        } finally {
          rawReply.end();
        }

        const latencyMs = Math.max(1, Date.now() - startedAtMs);
        if (completionTokens === 0 && accumulatedContent.length > 0) {
          completionTokens = Math.max(1, Math.ceil(accumulatedContent.length / 4));
        }

        const syntheticResponse: ChatCompletionResponse = {
          id: responseId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: accumulatedContent,
              },
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };

        const logEntry = {
          requestId,
          tenantId: keyContext.id,
          modelAlias: request.model,
          provider: upstream.provider,
          upstreamModel: upstream.upstreamModel,
          stream: true,
          cacheStatus: lookup.status,
          similarity: null,
          statusCode: 200,
          errorCode: null,
          attempts: upstream.attempts,
          latencyMs,
          ttftMs: upstream.ttftMs,
          promptTokens,
          completionTokens,
        };

        this.usageService.recordMetricsSync(logEntry);

        this.backgroundTasks.run(async () => {
          await Promise.all([
            this.cacheService.store({
              request,
              keyContext,
              decision,
              exactKey: lookup.exactKey,
              scopeHash: lookup.scopeHash,
              embedding: lookup.embedding,
              response: syntheticResponse,
              statusCode: 200,
            }),
            this.usageService.persistAsync(logEntry),
          ]);
        });
      },
    };
  }
}
