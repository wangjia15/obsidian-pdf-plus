// Content-hash keyed response cache under <vault>/.pdf-plus-ai/cache/<hash>.json.
// Deleting .pdf-plus-ai/ fully resets AI state.

import { normalizePath, TFile } from 'obsidian';
import PDFPlus from 'main';

async function sha1Hex(s: string): Promise<string> {
    const buf = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compute a cache key from the given parts (file key, action, prompt version, language, …). */
export async function cacheKey(...parts: (string | number)[]): Promise<string> {
    return sha1Hex(parts.map(String).join('|'));
}

async function ensureDir(plugin: PDFPlus, dir: string): Promise<void> {
    const { vault } = plugin.app;
    if (!(vault.getAbstractFileByPath(dir) instanceof TFile) && vault.getAbstractFileByPath(dir) === null) {
        try { await vault.createFolder(dir); } catch { /* already exists */ }
    }
}

export class AICache {
    constructor(private plugin: PDFPlus) {}

    private dir() { return this.plugin.ai.cacheDir; }

    async get<T>(key: string): Promise<T | null> {
        const path = normalizePath(`${this.dir()}/${key}.json`);
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        try {
            const raw = await this.plugin.app.vault.read(file);
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }

    async set<T>(key: string, value: T): Promise<void> {
        const dir = this.dir();
        await ensureDir(this.plugin, dir);
        const path = normalizePath(`${dir}/${key}.json`);
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        try {
            if (existing instanceof TFile) {
                await this.plugin.app.vault.modify(existing, JSON.stringify(value, null, 2));
            } else {
                await this.plugin.app.vault.create(path, JSON.stringify(value, null, 2));
            }
        } catch (e) {
            console.warn('PDF++ AI: failed to write cache', e);
        }
    }

    /** Return cached value if present, otherwise call compute(), store, and return it. */
    async getOrCompute<T>(key: string, compute: () => Promise<T>): Promise<T> {
        const hit = await this.get<T>(key);
        if (hit !== null) return hit;
        const value = await compute();
        await this.set(key, value);
        return value;
    }
}

/** Singleton accessor bound to the plugin. */
let _cache: AICache | null = null;
export function getCache(plugin: PDFPlus): AICache {
    if (!_cache) _cache = new AICache(plugin);
    return _cache;
}
