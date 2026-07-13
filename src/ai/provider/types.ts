// Shared types for the AI provider layer.
// MiniMax is the only v1 provider, but all calls go through these types so
// other providers can be added without touching feature code.

/** A single message in a chat conversation. Multimodal content supported via image parts. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | ChatContentPart[];
}

/** One part of a multimodal message. Text parts are plain strings; images are data URLs. */
export type ChatContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** Provider call capability — selects the concurrency limiter (see ratelimit.ts). */
export type Capability = 'chat' | 'tts-instant' | 'tts-async' | 'vision' | 'citation';

/** Strip bearer tokens / api keys a provider may echo inside an error body, and cap the length. */
export function redactSecrets(s: string): string {
    let out = s.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>');
    out = out.replace(/("(?:api[_-]?key|apiKey|authorization|token|secret)"\s*:\s*")[^"]*"/gi, '$1<redacted>"');
    return out.length > 500 ? out.slice(0, 500) + '…' : out;
}

/** A request to a chat completion endpoint. */
export interface ChatRequest {
    /** Conversation history, system message first. */
    messages: ChatMessage[];
    /** Override the configured model for this call. */
    model?: string;
    /** Sampling temperature. */
    temperature?: number;
    /** Request JSON output (best-effort; provider-specific). */
    json?: boolean;
    /** "thinking" / reasoning effort. Disabled for strict-JSON extraction tasks. */
    thinking?: 'adaptive' | 'off';
    /** Max output tokens. */
    maxTokens?: number;
    /** Concurrency-limiter capability (default 'chat'). Use 'vision' for multimodal calls so they
     *  don't share the chat limiter queue. */
    capability?: Capability;
    /** Abort signal from the invoking UI; aborts the in-flight request. */
    signal?: AbortSignal;
}

/** A complete (non-streaming) chat response. */
export interface ChatResponse {
    text: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    raw: unknown;
}

/** Handle returned by a streaming chat call; call `.done` to wait for completion. */
export interface ChatStreamHandle {
    /** Resolves with the final usage + full text when the stream ends. Rejects on error. */
    done: Promise<ChatResponse>;
    /** Append-only text emitted so far. */
    partial: () => string;
    /** Stop generation early (best-effort). */
    cancel: () => void;
}

/** A request to an instant (sync streaming) TTS endpoint. */
export interface TTSRequest {
    text: string;
    voice?: string;
    rate?: number;     // speed multiplier
    volume?: number;
    model?: string;
    signal?: AbortSignal;
}

/** Error categories surfaced to the UI. */
export type AIErrorKind = 'auth' | 'quota' | 'network' | 'badResponse' | 'aborted' | 'budget' | 'unknown';

/** Normalized provider error, surfaced to the UI as a single error type. */
export class AIError extends Error {
    kind: AIErrorKind;
    retryable: boolean;
    status?: number;

    constructor(kind: AIErrorKind, message: string, opts: { retryable?: boolean; status?: number } = {}) {
        super(message);
        this.name = 'AIError';
        this.kind = kind;
        this.retryable = opts.retryable ?? false;
        this.status = opts.status;
    }
}

/** Convert any thrown value into a normalized AIError. */
export function normalizeError(err: unknown): AIError {
    if (err instanceof AIError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
        return new AIError('aborted', 'Cancelled.', { retryable: false });
    }
    // Narrow the throw value and its nested MiniMax envelope (no casts on raw unknown — each
    // access is guarded by a typeof/object check first).
    const rec = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
    const jsonVal = rec?.json;
    const json = typeof jsonVal === 'object' && jsonVal !== null ? (jsonVal as Record<string, unknown>) : null;
    const brVal = json?.base_resp;
    const baseResp = typeof brVal === 'object' && brVal !== null ? (brVal as Record<string, unknown>) : null;
    const statusRaw: unknown = rec?.status ?? baseResp?.status_code;
    const status = typeof statusRaw === 'number' ? statusRaw : undefined;
    const recMsg = typeof rec?.message === 'string' ? rec.message : undefined;
    const brMsg = typeof baseResp?.status_msg === 'string' ? baseResp.status_msg : undefined;
    const msg: string = err instanceof Error ? (recMsg ?? err.message) : (recMsg ?? brMsg ?? String(err));
    // MiniMax error codes: auth ~ 1004/1039, quota ~ 1139, etc. Treat 4xx-auth, 429-quota, 5xx-network.
    if (status === 401 || status === 403 || status === 1004 || status === 1039) {
        return new AIError('auth', msg, { retryable: false, status });
    }
    if (status === 429 || status === 1139) {
        return new AIError('quota', msg, { retryable: true, status });
    }
    if (status !== undefined && status >= 500) {
        return new AIError('network', msg, { retryable: true, status });
    }
    if (msg && /network|fetch|timeout|ECONN/i.test(msg)) {
        return new AIError('network', msg, { retryable: true });
    }
    return new AIError('badResponse', msg || 'Unexpected response from provider.', { retryable: false, status });
}
