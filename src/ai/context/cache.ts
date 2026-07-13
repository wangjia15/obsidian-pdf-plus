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
    /** In-flight getOrCompute promises keyed by cache key, so concurrent callers for the same
     *  key share one compute() call instead of racing (double API spend + last-write-wins). */
    private inflight = new Map<string, Promise<unknown>>();

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
        const finalPath = normalizePath(`${dir}/${key}.json`);
        // Atomic-ish: write to a sibling temp file first, then move it into place. A crash
        // mid-write leaves the temp file orphaned (harmless) rather than a truncated final file
        // that would parse-fail on the next read.
        const tmpPath = normalizePath(`${dir}/${key}.json.tmp`);
        const payload = JSON.stringify(value, null, 2);
        try {
            await this.writeFile(tmpPath, payload);
            const tmpFile = this.plugin.app.vault.getAbstractFileByPath(tmpPath);
            await this.writeFile(finalPath, payload);
            if (tmpFile instanceof TFile) await this.plugin.app.vault.trash(tmpFile, true);
        } catch (e) {
            console.warn('PDF++ AI: failed to write cache', e);
        }
    }

    /** create-or-modify at `path`. Race-safe: getAbstractFileByPath + create() is a
     *  check-then-act pair, so two concurrent set() calls for the same key (e.g. a fast
     *  double-click on "Analyze") can both see no existing file and both call create() —
     *  the loser throws "File already exists". Catch that and fall back to modify() on the
     *  now-visible file instead of surfacing the race as a write failure. */
    private async writeFile(path: string, payload: string): Promise<void> {
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, payload);
            return;
        }
        try {
            await this.plugin.app.vault.create(path, payload);
        } catch (e) {
            const retry = this.plugin.app.vault.getAbstractFileByPath(path);
            if (retry instanceof TFile) await this.plugin.app.vault.modify(retry, payload);
            else throw e;
        }
    }

    /** Return cached value if present, otherwise call compute(), store, and return it.
     *  Concurrent calls for the same key share one compute() (dedup) so parallel feature
     *  invocations don't double-spend the API.
     *
     *  The in-flight slot is claimed SYNCHRONOUSLY (check-then-set on `inflight` with no
     *  `await` in between) before the cache lookup runs. Checking the on-disk cache first and
     *  claiming `inflight` only afterward (the previous order) left a race window: two calls
     *  arriving close together could both see "not cached yet", both miss `inflight` (neither
     *  had claimed it yet), and both call compute() — e.g. a marker click and a menu command
     *  landing on the same region within the same tick both hit the vision API concurrently. */
    async getOrCompute<T>(key: string, compute: () => Promise<T>): Promise<T> {
        const existing = this.inflight.get(key) as Promise<T> | undefined;
        if (existing) return existing;

        const p = (async () => {
            try {
                const hit = await this.get<T>(key);
                if (hit !== null) return hit;
                const value = await compute();
                await this.set(key, value);
                return value;
            } finally {
                this.inflight.delete(key);
            }
        })();
        this.inflight.set(key, p);
        return p;
    }
}

/** Singleton accessor bound to the plugin. */
let _cache: AICache | null = null;
export function getCache(plugin: PDFPlus): AICache {
    if (!_cache) _cache = new AICache(plugin);
    return _cache;
}
