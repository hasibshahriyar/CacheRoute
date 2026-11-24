import type { Clock } from '../ports/index.js';

export class SystemClock implements Clock {
  public nowMs(): number {
    return Date.now();
  }
}
