// Locate an M3-returned quote in the PDF text layer and map it to the exact
// {page, beginIndex, beginOffset, endIndex, endOffset} selection-subpath format that
// PDF++ selection links use (see lib.getSelectedText & parsePDFSubpath).
//
// Matching is normalized: lowercase, whitespace collapsed, hyphens and quotes removed, so it
// tolerates hyphenated line breaks and minor whitespace differences. Falls back to prefix
// matching when M3 truncates the quote. Unmatched quotes are reported (never guessed).

import { ExtractedPage } from '../context/extractor';

export interface Located {
    page: number;          // 1-based
    beginIndex: number;    // pdfjs text-content item index
    beginOffset: number;   // char offset within items[beginIndex].str
    endIndex: number;
    endOffset: number;     // exclusive-ish: slice(0, endOffset) covers the matched span
}

interface Pos { itemIdx: number; offsetInItem: number; }

interface PageIndex {
    page: ExtractedPage;
    searchText: string;
    posMap: Pos[];
}

/** Drop apostrophes/quotes and hyphens; collapse whitespace; lowercase. Keeps a char→origin map. */
function normalizeWithMap(s: string): { out: string; map: number[] } {
    let out = '';
    const map: number[] = [];
    let lastWasSpace = true; // suppresses leading spaces
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!lastWasSpace) { out += ' '; map.push(i); lastWasSpace = true; }
            continue;
        }
        if (/[''`]/.test(ch)) continue;
        if (/[-‐-―]/.test(ch)) continue;
        out += ch.toLowerCase();
        map.push(i);
        lastWasSpace = false;
    }
    // strip trailing space
    while (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
    return { out, map };
}

function normalizeQuery(s: string): string {
    return normalizeWithMap(s).out;
}

function buildPageIndex(page: ExtractedPage): PageIndex {
    let searchText = '';
    const posMap: Pos[] = [];
    for (let itemIdx = 0; itemIdx < page.items.length; itemIdx++) {
        const { out, map } = normalizeWithMap(page.items[itemIdx].str);
        for (let k = 0; k < out.length; k++) {
            searchText += out[k];
            posMap.push({ itemIdx, offsetInItem: map[k] });
        }
        // separator space between items (boundary marker)
        if (itemIdx < page.items.length - 1) {
            searchText += ' ';
            posMap.push({ itemIdx: -1, offsetInItem: -1 });
        }
    }
    return { page, searchText, posMap };
}

/** Build a search index over all pages (call once per paper, reuse for every quote). */
export function buildLocator(pages: ExtractedPage[]): PageIndex[] {
    return pages.map(buildPageIndex);
}

/** Find the quote across pages. Returns the first page that matches, or null if unmatched. */
export function locateQuote(index: PageIndex[], quote: string): Located | null {
    const q = normalizeQuery(quote);
    if (q.length < 4) return null;

    for (const pi of index) {
        const found = locateInPage(pi, q);
        if (found) return { page: pi.page.pageNumber, ...found };
    }
    return null;
}

function locateInPage(pi: PageIndex, q: string): Omit<Located, 'page'> | null {
    // 1. exact normalized match
    let start = pi.searchText.indexOf(q);
    let matchLen = q.length;
    if (start < 0) {
        // 2. prefix fallbacks for truncated quotes
        for (const plen of [60, 45, 30, 20]) {
            if (q.length <= plen) continue;
            const prefix = q.slice(0, plen);
            const at = pi.searchText.indexOf(prefix);
            if (at >= 0) { start = at; matchLen = prefix.length; break; }
        }
    }
    if (start < 0) return null;

    let end = start + matchLen - 1;
    // clamp away boundary (separator-space) positions
    while (start < end && pi.posMap[start].itemIdx < 0) start++;
    while (end > start && pi.posMap[end].itemIdx < 0) end--;
    if (pi.posMap[start].itemIdx < 0 || pi.posMap[end].itemIdx < 0) return null;

    const startPos = pi.posMap[start];
    const endPos = pi.posMap[end];
    return {
        beginIndex: startPos.itemIdx,
        beginOffset: startPos.offsetInItem,
        endIndex: endPos.itemIdx,
        endOffset: endPos.offsetInItem + 1,
    };
}
