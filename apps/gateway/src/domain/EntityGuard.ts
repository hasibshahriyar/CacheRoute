export interface EntityGuardResult {
  passed: boolean;
  reason?: 'contains_digits' | 'contains_email' | 'contains_url';
}

const THREE_OR_MORE_DIGITS_REGEX = /\d{3,}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL_REGEX = /https?:\/\/\S+|www\.\S+/i;

/**
 * Prevents semantic cache false positives when prompts contain specific identifiers
 * such as 3+ consecutive digits (order IDs, ports, dates, zip codes), email addresses, or URLs.
 */
export class EntityGuard {
  public inspect(text: string): EntityGuardResult {
    if (EMAIL_REGEX.test(text)) {
      return { passed: false, reason: 'contains_email' };
    }
    if (URL_REGEX.test(text)) {
      return { passed: false, reason: 'contains_url' };
    }
    if (THREE_OR_MORE_DIGITS_REGEX.test(text)) {
      return { passed: false, reason: 'contains_digits' };
    }
    return { passed: true };
  }
}
