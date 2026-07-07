// MiniMax async TTS (T2A Async + File API, speech-2.8-hd) for long-form podcast audio.
//
// Contract (国内版; endpoint paths kept as constants so they're easy to correct against
// MiniMax docs at https://platform.minimaxi.com/):
//   1. submit  POST {baseUrl}/v1/t2a_async            → { data: { task_id } }
//   2. poll    GET  {baseUrl}/v1/t2a_async_query?task_id=… → { data: { status, file_id } }
//      status 'Success' means done; download the file before the 9-hour URL expiry.
//   3. retrieve GET {baseUrl}/v1/files/retrieve?file_id=…   → { file: { download_url } }
//   4. download GET download_url                            → mp3 bytes
//
// Returns mp3 bytes. Honors an AbortSignal so the UI can cancel polling.

import { requestUrl } from 'obsidian';
import PDFPlus from 'main';
import { AISettings } from '../settings';
import { AIError, normalizeError } from './types';
import { getLimiter } from './ratelimit';

const PATH_SUBMIT = '/v1/t2a_async';
const PATH_QUERY = '/v1/t2a_async_query';
const PATH_RETRIEVE = '/v1/files/retrieve';

export interface AsyncTTSSubmitOptions {
    voice: string;
    rate?: number;
    model?: string;
    signal?: AbortSignal;
}

export class MiniMaxAsyncTTSClient {
    constructor(private getSettings: () => AISettings) {}

    private get s() { return this.getSettings(); }
    private base() { return trimSlash(this.s.minimax.baseUrl); }
    private get headers(): Record<string, string> {
        return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.s.minimax.apiKey}` };
    }
    // GroupId (when set) goes in the query string, not a header — see minimax-chat.ts for why.
    private withGroup(url: string): string {
        return this.s.minimax.groupId ? `${url}${url.includes('?') ? '&' : '?'}GroupId=${encodeURIComponent(this.s.minimax.groupId)}` : url;
    }

    /** Submit an async TTS job; returns the task_id. */
    async submit(text: string, opts: AsyncTTSSubmitOptions): Promise<string> {
        const body = {
            model: opts.model || this.s.minimax.ttsModelPodcast,
            text,
            voice_setting: { voice_id: opts.voice, speed: opts.rate ?? this.s.speechRate, vol: this.s.speechVolume, audio_format: 'mp3' },
            audio_setting: { sample_rate: 32000, bit_rate: 32000, format: 'mp3', channel: 1 },
        };
        const r = await requestUrl({ url: this.withGroup(`${this.base()}${PATH_SUBMIT}`), method: 'POST', headers: this.headers, body: JSON.stringify(body), throw: false });
        if (r.status >= 400) throw makeErr(r.json, r.status);
        const taskId = r.json?.data?.task_id ?? r.json?.task_id;
        if (!taskId) throw new AIError('badResponse', 'Async TTS submit returned no task_id.', { retryable: false });
        return taskId;
    }

    /** Poll until the task completes; returns the file_id. */
    async poll(taskId: string, opts: AsyncTTSSubmitOptions): Promise<string> {
        const lim = getLimiter('tts-async');
        const maxAttempts = 600; // ~50 min at 5s intervals
        for (let i = 0; i < maxAttempts; i++) {
            if (opts.signal?.aborted) throw new AIError('aborted', 'Cancelled.', { retryable: false });
            const r = await lim(() => requestUrl({ url: this.withGroup(`${this.base()}${PATH_QUERY}?task_id=${encodeURIComponent(taskId)}`), headers: this.headers, throw: false }));
            if (r.status >= 500) { await sleep(5000, opts.signal); continue; }
            if (r.status >= 400 && r.status < 500) throw makeErr(r.json, r.status);
            const status = r.json?.data?.status ?? r.json?.status;
            const fileId = r.json?.data?.file_id ?? r.json?.file_id;
            if (status === 'Success' || status === 2 || (fileId && status !== 'Processing' && status !== 1)) {
                if (fileId) return fileId;
            }
            await sleep(5000, opts.signal);
        }
        throw new AIError('network', 'Async TTS polling timed out.', { retryable: true });
    }

    /** Retrieve the download URL for a file_id, then download the mp3 bytes. */
    async download(fileId: string, opts: AsyncTTSSubmitOptions): Promise<ArrayBuffer> {
        const meta = await requestUrl({ url: this.withGroup(`${this.base()}${PATH_RETRIEVE}?file_id=${encodeURIComponent(fileId)}`), headers: this.headers, throw: false });
        if (meta.status >= 400) throw makeErr(meta.json, meta.status);
        const downloadUrl: string | undefined = meta.json?.file?.download_url ?? meta.json?.download_url;
        if (!downloadUrl) throw new AIError('badResponse', 'File retrieve returned no download_url.', { retryable: false });
        const audio = await requestUrl({ url: downloadUrl, throw: false });
        if (audio.status >= 400) throw makeErr(audio.json, audio.status);
        return audio.arrayBuffer;
    }

    /** Full pipeline for one text segment → mp3 bytes. */
    async synthesize(text: string, opts: AsyncTTSSubmitOptions): Promise<ArrayBuffer> {
        const taskId = await this.submit(text, opts);
        const fileId = await this.poll(taskId, opts);
        return this.download(fileId, opts);
    }
}

let _async: MiniMaxAsyncTTSClient | null = null;
export function getSharedAsyncTTSClient(plugin: PDFPlus): MiniMaxAsyncTTSClient {
    if (!_async) _async = new MiniMaxAsyncTTSClient(() => plugin.settings.ai);
    return _async;
}

function trimSlash(s: string) { return s.replace(/\/+$/, ''); }
function makeErr(json: any, status: number): AIError {
    const msg = json?.base_resp?.status_msg || JSON.stringify(json);
    return new AIError(normalizeError({ status, json }).kind, msg, { retryable: status === 429 || status >= 500, status });
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new AIError('aborted', 'Cancelled.', { retryable: false }));
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AIError('aborted', 'Cancelled.', { retryable: false })); }, { once: true });
    });
}
