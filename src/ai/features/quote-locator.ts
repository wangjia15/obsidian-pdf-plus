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
    /** True when the match came from a prefix fallback, not an exact normalized hit. A fuzzy
     *  match anchors only the quote's *opening* against real text, so the tail is unverified —
     *  downstream UI must surface it for human confirmation (don't silently trust it). */
    fuzzy: boolean;
    /** The actual text in the PDF that this location spans, so reviewers can compare it against
     *  the model's quoted text. */
    matchedText: string;
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
    let fuzzy = false;
    if (start < 0) {
        // 2. prefix fallbacks for truncated (or subtly-mismatched) quotes. A prefix hit anchors
        // only the quote's opening against real text, so mark it fuzzy for human confirmation.
        for (const plen of [60, 45, 30, 20]) {
            if (q.length <= plen) continue;
            const prefix = q.slice(0, plen);
            const at = pi.searchText.indexOf(prefix);
            if (at >= 0) { start = at; matchLen = prefix.length; fuzzy = true; break; }
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
    const matchedText = textBetween(pi.page, startPos.itemIdx, startPos.offsetInItem, endPos.itemIdx, endPos.offsetInItem);
    return {
        beginIndex: startPos.itemIdx,
        beginOffset: startPos.offsetInItem,
        endIndex: endPos.itemIdx,
        endOffset: endPos.offsetInItem + 1,
        fuzzy,
        matchedText,
    };
}

/** Reconstruct the original (un-normalized) PDF text a selection range spans, so the review
 *  UI can show the user exactly what got anchored. */
function textBetween(page: ExtractedPage, beginIndex: number, beginOffset: number, endIndex: number, endOffset: number): string {
    const items = page.items;
    if (beginIndex === endIndex) return items[beginIndex]?.str.slice(beginOffset, endOffset + 1) ?? '';
    const parts: string[] = [items[beginIndex]?.str.slice(beginOffset) ?? ''];
    for (let i = beginIndex + 1; i < endIndex; i++) parts.push(items[i]?.str ?? '');
    parts.push(items[endIndex]?.str.slice(0, endOffset + 1) ?? '');
    return parts.join(' ');
}
