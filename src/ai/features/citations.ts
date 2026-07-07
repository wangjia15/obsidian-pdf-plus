// F6: enrich bibliography entries with live citation data.
// Resolver chain: Semantic Scholar (primary) → Crossref → OpenAlex. API matching is done by
// string search on title/author/year, NOT by the LLM (to avoid hallucinated metadata). M3 is
// only a repair step (not wired here for v1) for entries AnyStyle failed to parse.
// Results cached in <vault>/.pdf-plus-ai/citations.json with a configurable TTL.

import { normalizePath, requestUrl, TFile } from 'obsidian';
import PDFPlus from 'main';
import { AnystyleJson } from 'bib';
import { withRetry } from '../provider/ratelimit';

export interface EnrichedReference {
    destId: string;
    title: string;
    authors: string;
    year: string | null;
    venue: string;
    citationCount: number | null;
    doi: string | null;
    oaUrl: string | null;
    source: 'semantic-scholar' | 'crossref' | 'openalex' | 'none';
    similarity: number;
    bibtex: string;
}

const CITATIONS_PATH = '.pdf-plus-ai/citations.json';

interface CacheShape { [normalizedTitle: string]: { fetchedAt: number; ref: EnrichedReference }; }

async function readCache(plugin: PDFPlus): Promise<CacheShape> {
    const f = plugin.app.vault.getAbstractFileByPath(normalizePath(CITATIONS_PATH));
    if (f instanceof TFile) {
        try { return JSON.parse(await plugin.app.vault.read(f)); } catch { return {}; }
    }
    return {};
}

async function writeCache(plugin: PDFPlus, cache: CacheShape): Promise<void> {
    const path = normalizePath(CITATIONS_PATH);
    try {
        const dir = path.split('/').slice(0, -1).join('/');
        if (dir && plugin.app.vault.getAbstractFileByPath(dir) === null) {
            try { await plugin.app.vault.createFolder(dir); } catch { /* exists */ }
        }
        const existing = plugin.app.vault.getAbstractFileByPath(path);
        const body = JSON.stringify(cache, null, 2);
        if (existing instanceof TFile) await plugin.app.vault.modify(existing, body);
        else await plugin.app.vault.create(path, body);
    } catch (e) { console.warn('PDF++ AI: citation cache write failed', e); }
}

// --- title similarity -------------------------------------------------------

function normalizeTitle(t: string): string[] {
    return (t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1));
}

/** Jaccard similarity over normalized word sets (0–1). */
export function titleSimilarity(a: string, b: string): number {
    const wa = new Set(normalizeTitle(a));
    const wb = new Set(normalizeTitle(b));
    if (!wa.size || !wb.size) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    return inter / (wa.size + wb.size - inter);
}

const SIM_THRESHOLD = 0.6;

// --- resolvers --------------------------------------------------------------

function s2Headers(plugin: PDFPlus): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    const key = plugin.settings.ai.citations.s2ApiKey;
    if (key) h['x-api-key'] = key;
    return h;
}

async function resolveSemanticScholar(plugin: PDFPlus, title: string, year?: string): Promise<Partial<EnrichedReference> | null> {
    try {
        const r = await withRetry('citation', () => requestUrl({
            url: `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=title,year,citationCount,venue,externalIds,openAccessPdf`,
            headers: s2Headers(plugin), throw: false,
        }));
        if (r.status >= 400) return null;
        const data = r.json?.data?.[0];
        if (!data) return null;
        const sim = titleSimilarity(title, data.title || '');
        if (sim < SIM_THRESHOLD) return null;
        return {
            title: data.title, year: data.year ? String(data.year) : null, venue: data.venue || '',
            citationCount: typeof data.citationCount === 'number' ? data.citationCount : null,
            doi: data.externalIds?.DOI ?? null, oaUrl: data.openAccessPdf?.url ?? null,
            source: 'semantic-scholar', similarity: sim,
        };
    } catch { return null; }
}

async function resolveCrossref(plugin: PDFPlus, title: string): Promise<Partial<EnrichedReference> | null> {
    try {
        const r = await withRetry('citation', () => requestUrl({
            url: `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=1&mailto=pdf-plus-ai@users.noreply`,
            headers: { accept: 'application/json', 'User-Agent': 'PDF++-AI/0.1 (mailto:pdf-plus-ai@users.noreply)' }, throw: false,
        }));
        if (r.status >= 400) return null;
        const item = r.json?.message?.items?.[0];
        if (!item) return null;
        const crTitle: string = (item.title?.[0]) || '';
        const sim = titleSimilarity(title, crTitle);
        if (sim < SIM_THRESHOLD) return null;
        const year = item['published-print']?.['date-parts']?.[0]?.[0] ?? item['published-online']?.['date-parts']?.[0]?.[0];
        return {
            title: crTitle, year: year ? String(year) : null, venue: item['container-title']?.[0] || '',
            citationCount: typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : null,
            doi: item.DOI ?? null, oaUrl: null, source: 'crossref', similarity: sim,
        };
    } catch { return null; }
}

async function resolveOpenAlex(title: string): Promise<Partial<EnrichedReference> | null> {
    try {
        const r = await withRetry('citation', () => requestUrl({
            url: `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title)}&per-page=1&mailto=pdf-plus-ai@users.noreply`,
            headers: { accept: 'application/json', 'User-Agent': 'PDF++-AI/0.1 (mailto:pdf-plus-ai@users.noreply)' }, throw: false,
        }));
        if (r.status >= 400) return null;
        const item = r.json?.results?.[0];
        if (!item) return null;
        const sim = titleSimilarity(title, item.title || '');
        if (sim < SIM_THRESHOLD) return null;
        return {
            title: item.title, year: item.publication_year ? String(item.publication_year) : null,
            venue: item.host_venue?.display_name || item.primary_location?.source?.display_name || '',
            citationCount: typeof item.cited_by_count === 'number' ? item.cited_by_count : null,
            doi: item.doi ? item.doi.replace('https://doi.org/', '') : null,
            oaUrl: item.open_access?.oa_url ?? null, source: 'openalex', similarity: sim,
        };
    } catch { return null; }
}

// --- orchestration ----------------------------------------------------------

function entryToFields(destId: string, e: AnystyleJson): { title: string; authors: string; year: string | null; venue: string } {
    return {
        title: (e.title?.[0] || '').trim(),
        authors: (e.author || []).map((a) => a.family).filter(Boolean).join(', '),
        year: e.year || e.date?.[0]?.slice(0, 4) || null,
        venue: e['container-title']?.[0] || '',
    };
}

function toBibtex(destId: string, e: AnystyleJson, enriched: Partial<EnrichedReference>): string {
    const key = (e.author?.[0]?.family || 'ref').toLowerCase().replace(/[^a-z]/g, '') + (enriched.year || '');
    const lines = [`@article{${key},`];
    if (e.title?.[0]) lines.push(`  title = {${e.title[0]}},`);
    if (e.author?.length) lines.push(`  author = {${e.author.map((a) => `${a.family}, ${a.given}`).join(' and ')}},`);
    if (enriched.year) lines.push(`  year = {${enriched.year}},`);
    if (enriched.venue || e['container-title']?.[0]) lines.push(`  journal = {${enriched.venue || e['container-title']![0]}},`);
    if (enriched.doi) lines.push(`  doi = {${enriched.doi}},`);
    lines.push('}');
    return lines.join('\n');
}

/** Enrich a map of destId → parsed entry, using the cache and the resolver chain. */
export async function enrichReferences(plugin: PDFPlus, entries: Map<string, AnystyleJson>): Promise<EnrichedReference[]> {
    if (!plugin.settings.ai.citations.enabled) return [];
    const cache = await readCache(plugin);
    const ttlMs = plugin.settings.ai.citations.cacheTtlDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const out: EnrichedReference[] = [];
    let cacheDirty = false;

    for (const [destId, e] of entries) {
        const fields = entryToFields(destId, e);
        if (!fields.title) continue;
        const normKey = normalizeTitle(fields.title).join(' ');
        const cached = cache[normKey];

        let partial: Partial<EnrichedReference> | null = null;
        if (cached && (now - cached.fetchedAt) < ttlMs) {
            partial = cached.ref;
        } else {
            partial = await resolveSemanticScholar(plugin, fields.title, fields.year ?? undefined)
                || await resolveCrossref(plugin, fields.title)
                || await resolveOpenAlex(fields.title);
            if (partial) { cache[normKey] = { fetchedAt: now, ref: { ...partial } as EnrichedReference }; cacheDirty = true; }
        }

        const ref: EnrichedReference = {
            destId,
            title: fields.title,
            authors: fields.authors,
            year: fields.year,
            venue: partial?.venue || fields.venue,
            citationCount: partial?.citationCount ?? null,
            doi: partial?.doi ?? null,
            oaUrl: partial?.oaUrl ?? null,
            source: (partial?.source as EnrichedReference['source']) ?? 'none',
            similarity: partial?.similarity ?? 0,
            bibtex: toBibtex(destId, e, partial || {}),
        };
        out.push(ref);
    }

    if (cacheDirty) await writeCache(plugin, cache);
    return out;
}
