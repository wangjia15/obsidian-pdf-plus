// MiniMax instant TTS client (T2A sync, speech-2.8-turbo).
// Endpoint: POST {baseUrl}/v1/t2a_v2  with stream:false.
// Non-streaming response is JSON: { data: { audio: "<hex>" }, base_resp: { status_code, status_msg } }.
// We extract the hex audio and decode to an ArrayBuffer (mp3) for the Web Audio player.
//
// Non-streaming is the honest, mobile-safe baseline (works via requestUrl everywhere).
// True SSE streaming for sub-second first-audio is a future enhancement; for a paragraph of
// text the round-trip is fast enough to meet the "<2s" feel in practice.

import { requestUrl } from 'obsidian';
import PDFPlus from 'main';
import { AISettings } from '../settings';
import { AIError, normalizeError } from './types';
import { withRetry } from './ratelimit';

export interface TTSSynthesizeOptions {
    voice?: string;
    rate?: number;
    volume?: number;
    model?: string;
    signal?: AbortSignal;
}

export class MiniMaxTTSClient {
    constructor(private getSettings: () => AISettings) {}

    private get s() { return this.getSettings(); }
    private get url() {
        const base = `${trimSlash(this.s.minimax.baseUrl)}/v1/t2a_v2`;
        return this.s.minimax.groupId ? `${base}?GroupId=${encodeURIComponent(this.s.minimax.groupId)}` : base;
    }

    async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<ArrayBuffer> {
        if (text.length > 10_000) {
            throw new AIError('badResponse', 'Text exceeds the 10,000-character per-request limit for instant TTS.', { retryable: false });
        }
        const voice = opts.voice || this.s.voices[this.s.outputLanguage === 'zh' ? 'zh' : 'en'];
        const body = {
            model: opts.model || this.s.minimax.ttsModelInstant,
            text,
            stream: false,
            voice_setting: {
                voice_id: voice,
                speed: opts.rate ?? this.s.speechRate,
                vol: opts.volume ?? this.s.speechVolume,
                audio_format: 'mp3',
            },
            audio_setting: { sample_rate: 32000, bit_rate: 32000, format: 'mp3', channel: 1 },
        };

        return withRetry('tts-instant', async () => {
            const r = await requestUrl({
                url: this.url,
                method: 'POST',
                headers: this.headers,
                contentType: 'application/json',
                body: JSON.stringify(body),
                throw: false,
            });
            if (r.status >= 400) throw makeErr(r.json, r.status);
            const hex: string | undefined = r.json?.data?.audio;
            const status = r.json?.base_resp?.status_code;
            if (status !== 0 && status !== undefined) {
                throw makeErr(r.json, r.status);
            }
            if (!hex) throw new AIError('badResponse', 'TTS response contained no audio data.', { retryable: false });
            return hexToArrayBuffer(hex);
        }, { signal: opts.signal });
    }

    private get headers(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.s.minimax.apiKey}`,
        };
    }
}

let _tts: MiniMaxTTSClient | null = null;
export function getSharedTTSClient(plugin: PDFPlus): MiniMaxTTSClient {
    if (!_tts) _tts = new MiniMaxTTSClient(() => plugin.settings.ai);
    return _tts;
}

function trimSlash(s: string) { return s.replace(/\/+$/, ''); }

function makeErr(json: any, status: number): AIError {
    const msg = json?.base_resp?.status_msg || JSON.stringify(json);
    const kind = normalizeError({ status, json }).kind;
    return new AIError(kind, msg, { retryable: status === 429 || (status >= 500 && status < 600), status });
}

/** Decode a hex string into an ArrayBuffer. */
function hexToArrayBuffer(hex: string): ArrayBuffer {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes.buffer;
}
