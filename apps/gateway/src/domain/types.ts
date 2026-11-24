import { z } from 'zod';

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: z.string(),
  name: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional().default(false),
    stream_options: z
      .object({
        include_usage: z.boolean().optional(),
      })
      .optional(),
    n: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    response_format: z.record(z.unknown()).optional(),
    tools: z.array(z.unknown()).optional(),
    functions: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    logprobs: z.boolean().optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ApiKeyContext {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  rpmLimit: number;
  burst: number;
  dailyTokenBudget: number;
  cacheNamespace: number;
  semanticCacheEnabled: boolean;
  revokedAt: Date | null;
}

export type CacheStatus = 'HIT-EXACT' | 'HIT-SEMANTIC' | 'MISS' | 'BYPASS';
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CachedCompletionRecord {
  response: ChatCompletionResponse;
  promptTokens: number;
  completionTokens: number;
  createdAtMs: number;
}
