// MiniMax-M3 chat client (OpenAI-compatible endpoint).
//
// MiniMax 国内版 base URL: https://api.minimaxi.com (international: https://api.minimax.io).
// Chat:  POST {baseUrl}/v1/text/chatcompletion_v2   (OpenAI-compatible)
// Auth:  Authorization: Bearer <apiKey>
// Multimodal: images passed as image_url content parts (base64 data URL).
//
// Networking strategy:
//   - chatStream(): true SSE streaming when the platform `fetch` exists (desktop + modern mobile);
//     otherwise falls back to a single requestUrl round-trip (non-streaming).
//   - chat(): always a single requestUrl round-trip (works everywhere, incl. older mobile).

import { Notice, requestUrl } from 'obsidian';
import PDFPlus from 'main';
import { AISettings } from '../settings';
import { ChatRequest, ChatResponse, ChatStreamHandle, AIError, normalizeError } from './types';
import { withRetry } from './ratelimit';

/** Lazy singleton chat client bound to the plugin's live AI settings. */
let _sharedChat: MiniMaxChatClient | null = null;
export function getSharedChatClient(plugin: PDFPlus): MiniMaxChatClient {
    if (!_sharedChat) {
        _sharedChat = new MiniMaxChatClient({
            getSettings: () => plugin.settings.ai,
            onUsage: (u) => plugin.ai?.recordUsage(u.totalTokens),
        });
    }
    return _sharedChat;
}

export interface MiniMaxChatConfig {
    getSettings: () => AISettings;
    /** Called with token usage after each successful call (for the budget meter). */
    onUsage?: (u: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}

export class MiniMaxChatClient {
    constructor(private cfg: MiniMaxChatConfig) {}

    private get s() { return this.cfg.getSettings(); }

    private get headers(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.s.minimax.apiKey}`,
        };
    }

    // GroupId (when set) goes in the query string, not a custom header: a `fetch()`-based
    // streaming request (see chatStream) is subject to real CORS preflight, and MiniMax's
    // CORS config does not allow-list a "GroupId" header — it 400s/blocks at preflight.
    // requestUrl-based calls would work either way, but query-string keeps both paths consistent.
    private get chatUrl() {
        const base = `${trimSlash(this.s.minimax.baseUrl)}/v1/text/chatcompletion_v2`;
        return this.s.minimax.groupId ? `${base}?GroupId=${encodeURIComponent(this.s.minimax.groupId)}` : base;
    }

    private body(req: ChatRequest, stream: boolean) {
        const payload: Record<string, unknown> = {
            model: req.model ?? this.s.minimax.chatModel,
            messages: req.messages,
            stream,
            temperature: req.temperature ?? 0.2,
        };
        if (req.maxTokens) payload['max_tokens'] = req.maxTokens;
        if (req.thinking === 'adaptive') payload['thinking'] = { type: 'adaptive' };
        if (req.json) {
            payload['response_format'] = { type: 'json_object' };
        }
        return payload;
    }

    /** Non-streaming chat completion. Works on all platforms via requestUrl. */
    async chat(req: ChatRequest): Promise<ChatResponse> {
        const res = await withRetry('chat', async () => {
            const r = await requestUrl({
                url: this.chatUrl,
                method: 'POST',
                headers: this.headers,
                contentType: 'application/json',
                body: JSON.stringify(this.body(req, false)),
                throw: false,
            });
            if (r.status >= 400) {
                throw makeErr(r.json, r.status);
            }
            const data = r.json;
            const text = data?.choices?.[0]?.message?.content ?? '';
            const usage = parseUsage(data?.usage);
            return { text, usage, raw: data } as ChatResponse;
        }, { signal: req.signal });

        this.cfg.onUsage?.(res.usage);
        return res;
    }

    /**
     * Streaming chat completion. Emits incremental text via onDelta.
     * Falls back to a non-streaming round-trip (emitting the whole text at once) when the
     * platform does not expose a streaming-capable `fetch`.
     */
    chatStream(req: ChatRequest, onDelta: (delta: string) => void): ChatStreamHandle {
        let partial = '';
        let cancelRequested = false;
        const ac = req.signal ? undefined : new AbortController();
        const signal = req.signal ?? ac!.signal;

        const done = (async (): Promise<ChatResponse> => {
            if (typeof fetch === 'undefined') {
                // Fallback: single round-trip, emit all at once.
                const full = await this.chat({ ...req, signal });
                if (full.text) { partial = full.text; onDelta(full.text); }
                return full;
            }
            const resp = await fetch(this.chatUrl, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(this.body(req, true)),
                signal,
            });
            if (!resp.ok || !resp.body) {
                let json: any;
                try { json = await resp.json(); } catch { /* ignore */ }
                throw makeErr(json, resp.status);
            }
            let usage: ChatResponse['usage'] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            await readSSE(resp.body, (data) => {
                if (data === '[DONE]' || cancelRequested) return;
                let evt: any;
                try { evt = JSON.parse(data); } catch { return; }
                const delta: string = evt?.choices?.[0]?.delta?.content ?? '';
                if (delta) { partial += delta; onDelta(delta); }
                if (evt?.usage) usage = parseUsage(evt.usage);
            });
            const result: ChatResponse = { text: partial, usage, raw: null };
            this.cfg.onUsage?.(usage);
            return result;
        })();

        return {
            done: done.finally(() => { /* no-op */ }),
            partial: () => partial,
            cancel: () => { cancelRequested = true; ac?.abort(); },
        };
    }

    /** Quick connectivity check used by the "Test connection" button. */
    async testConnection(): Promise<{ ok: boolean; detail: string }> {
        try {
            await this.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 4, thinking: 'off' });
            return { ok: true, detail: `OK (model: ${this.s.minimax.chatModel}).` };
        } catch (e) {
            const norm = normalizeError(e);
            return { ok: false, detail: `${norm.kind}: ${norm.message}` };
        }
    }
}

function parseUsage(u: any): ChatResponse['usage'] {
    return {
        promptTokens: u?.prompt_tokens ?? u?.total_tokens ?? 0,
        completionTokens: u?.completion_tokens ?? 0,
        totalTokens: u?.total_tokens ?? 0,
    };
}

function trimSlash(s: string): string { return s.replace(/\/+$/, ''); }

function makeErr(json: any, status: number): AIError {
    const msg = json?.base_resp?.status_msg || json?.error?.message || JSON.stringify(json);
    return new AIError(normalizeError({ status, json }).kind, msg, { retryable: status === 429 || (status >= 500 && status < 600), status });
}

/** Minimal SSE reader: invokes onData with the payload of each `data:` line. */
async function readSSE(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            line = line.replace(/\r$/, '');
            if (line.startsWith('data:')) {
                const data = line.slice(5).trim();
                if (data) onData(data);
            }
        }
    }
}

export function warnIfNoKey(settings: AISettings): boolean {
    if (!settings.minimax.apiKey) {
        new Notice('PDF++ AI: No MiniMax API key configured. Open Settings > PDF++ > AI (MiniMax).', 6000);
        return false;
    }
    return true;
}
