// Concurrency + retry for provider calls.
// p-limit is already a PDF++ dependency. We keep one limiter per capability so a slow
// capability (e.g. async podcast TTS) can't starve another (e.g. chat).

import pLimit, { type LimitFunction } from 'p-limit';
import { normalizeError, AIError } from './types';

export type Capability = 'chat' | 'tts-instant' | 'tts-async' | 'vision' | 'citation';

const DEFAULT_CONCURRENCY: Record<Capability, number> = {
    'chat': 2,
    'tts-instant': 1,
    'tts-async': 2,
    'vision': 2,
    'citation': 1,
};

/** Per-capability p-limit queues. */
const limiters = new Map<Capability, LimitFunction>();

export function getLimiter(capability: Capability, concurrency = DEFAULT_CONCURRENCY[capability]): LimitFunction {
    let lim = limiters.get(capability);
    if (!lim) {
        lim = pLimit(concurrency);
        limiters.set(capability, lim);
    }
    return lim;
}

/** Total active + queued across a limiter, for UI progress. */
export function limiterActiveCount(capability: Capability): number {
    const lim = limiters.get(capability);
    return lim ? lim.activeCount + lim.pendingCount : 0;
}

export interface RetryOptions {
    retries?: number;        // default 3
    baseDelayMs?: number;    // default 800
    maxDelayMs?: number;     // default 8000
    signal?: AbortSignal;
    /** Return true to retry this particular error (default: error.retryable). */
    shouldRetry?: (err: unknown) => boolean;
}

/**
 * Run `task` under the given capability's limiter, retrying with jittered exponential backoff
 * on retryable errors. Honors the abort signal between attempts.
 */
export async function withRetry<T>(capability: Capability, task: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    const baseDelay = opts.baseDelayMs ?? 800;
    const maxDelay = opts.maxDelayMs ?? 8000;
    const lim = getLimiter(capability);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (opts.signal?.aborted) throw new AIError('aborted', 'Cancelled.', { retryable: false });
        try {
            return await lim(async () => {
                if (opts.signal?.aborted) throw new AIError('aborted', 'Cancelled.', { retryable: false });
                return task();
            });
        } catch (err) {
            lastErr = err;
            const norm = normalizeError(err);
            const retryable = opts.shouldRetry ? opts.shouldRetry(norm) : norm.retryable;
            if (!retryable || attempt === retries) throw norm.kind === 'unknown' ? err : new AIError(norm.kind, norm.message, { retryable: norm.retryable, status: norm.status });
            // jittered exponential backoff
            const exp = Math.min(maxDelay, baseDelay * 2 ** attempt);
            const delay = Math.floor(exp * (0.5 + Math.random() * 0.5));
            await sleep(delay, opts.signal);
        }
    }
    throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new AIError('aborted', 'Cancelled.', { retryable: false }));
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AIError('aborted', 'Cancelled.', { retryable: false })); }, { once: true });
    });
}
