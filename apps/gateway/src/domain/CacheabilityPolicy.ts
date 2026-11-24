import { EntityGuard } from './EntityGuard.js';
import type { ApiKeyContext, ChatCompletionRequest, ChatCompletionResponse } from './types.js';

export interface CacheabilityDecision {
  exactEligible: boolean;
  semanticEligible: boolean;
  bypassReason?: string;
}

export class CacheabilityPolicy {
  private readonly entityGuard: EntityGuard;

  constructor(entityGuard = new EntityGuard()) {
    this.entityGuard = entityGuard;
  }

  public evaluateRequest(
    request: ChatCompletionRequest,
    keyContext: Pick<ApiKeyContext, 'semanticCacheEnabled'>,
    cacheHeader?: string,
  ): CacheabilityDecision {
    if (cacheHeader?.toLowerCase() === 'bypass') {
      return {
        exactEligible: false,
        semanticEligible: false,
        bypassReason: 'header_bypass',
      };
    }

    if (request.n !== undefined && request.n > 1) {
      return {
        exactEligible: false,
        semanticEligible: false,
        bypassReason: 'n_greater_than_1',
      };
    }

    if (
      (Array.isArray(request.tools) && request.tools.length > 0) ||
      (Array.isArray(request.functions) && request.functions.length > 0) ||
      request.tool_choice !== undefined ||
      Boolean(request.logprobs)
    ) {
      return {
        exactEligible: false,
        semanticEligible: false,
        bypassReason: 'tools_or_logprobs_present',
      };
    }

    const lastMessage = request.messages[request.messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content.trim().length === 0) {
      return {
        exactEligible: false,
        semanticEligible: false,
        bypassReason: 'last_message_not_user',
      };
    }

    if (!keyContext.semanticCacheEnabled) {
      return {
        exactEligible: true,
        semanticEligible: false,
        bypassReason: 'semantic_disabled_on_key',
      };
    }

    if (request.temperature !== undefined && request.temperature > 0.7) {
      return {
        exactEligible: true,
        semanticEligible: false,
        bypassReason: 'temperature_above_0.7',
      };
    }

    if (lastMessage.content.length > 2000) {
      return {
        exactEligible: true,
        semanticEligible: false,
        bypassReason: 'message_exceeds_2000_chars',
      };
    }

    const entityResult = this.entityGuard.inspect(lastMessage.content);
    if (!entityResult.passed) {
      return {
        exactEligible: true,
        semanticEligible: false,
        bypassReason: `entity_guard_${entityResult.reason}`,
      };
    }

    return {
      exactEligible: true,
      semanticEligible: true,
    };
  }

  public isResponseCacheable(statusCode: number, response: ChatCompletionResponse): boolean {
    if (statusCode !== 200) return false;
    const firstChoice = response.choices[0];
    if (!firstChoice) return false;
    if (firstChoice.finish_reason !== 'stop') return false;
    if (!firstChoice.message?.content || firstChoice.message.content.trim().length === 0) {
      return false;
    }
    return true;
  }
}
