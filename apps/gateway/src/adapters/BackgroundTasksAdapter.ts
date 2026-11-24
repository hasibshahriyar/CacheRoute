import { waitUntil } from '@vercel/functions';
import type { FastifyBaseLogger } from 'fastify';
import type { BackgroundTasks } from '../ports/index.js';

export class InlineBackgroundTasks implements BackgroundTasks {
  private readonly logger?: FastifyBaseLogger;
  private readonly pending = new Set<Promise<void>>();

  constructor(logger?: FastifyBaseLogger) {
    this.logger = logger;
  }

  public run(task: () => Promise<void>): void {
    const promise = Promise.resolve()
      .then(() => task())
      .catch((err: unknown) => {
        this.logger?.error({ err }, 'Background task execution failed');
      })
      .finally(() => {
        this.pending.delete(promise);
      });
    this.pending.add(promise);
  }

  public async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this.pending));
  }
}

export class VercelBackgroundTasks implements BackgroundTasks {
  private readonly logger?: FastifyBaseLogger;

  constructor(logger?: FastifyBaseLogger) {
    this.logger = logger;
  }

  public run(task: () => Promise<void>): void {
    const promise = Promise.resolve()
      .then(() => task())
      .catch((err: unknown) => {
        this.logger?.error({ err }, 'Vercel background task failed');
      });
    try {
      waitUntil(promise);
    } catch {
      // Fallback if invoked outside a Vercel request context
    }
  }
}
