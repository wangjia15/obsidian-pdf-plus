// PDF text extraction → page-anchored structured text.
// Walks pdfjs text items per page, preserving page boundaries and per-item char offsets so:
//   - F1 prompts can cite "p.N: …"
//   - F5 quote locator can map a matched char range back to {page, beginIndex, beginOffset, ...}
//     (the same subpath format PDF++ selection links use).

import { TFile } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';
import PDFPlus from 'main';
import { buildLocator, locateQuote } from '../features/quote-locator';
import type { PaperSection } from '../features/annotation-note';

/** Minimal shape of a pdfjs text-content item (only what we use). */
type PdfTextItem = { str?: string; hasEOL?: boolean };

export interface ExtractedItem {
    /** The text of this pdfjs text-content item. (Per-item begin/end offsets were removed —
     *  they were computed against the un-cleaned text and never read; quote-locator rebuilds
     *  offsets from items[].str directly, so this is the only field anyone consumes.) */
    str: string;
}

export interface ExtractedPage {
    pageNumber: number; // 1-based
    text: string;
    items: ExtractedItem[];
}

export interface ExtractedText {
    file: TFile;
    /** Cheap cache key: vault-path:size:mtime. Hashing a large PDF is too costly per-open. */
    fileKey: string;
    pages: ExtractedPage[];
    outline: PaperSection[];
    /** Concatenation of page texts with "\n\n" between pages, prefixed "p.N:". */
    fullText: string;
    /** Rough token estimate (~4 chars/token) for budget warnings. */
    estimatedTokens: number;
    charCount: number;
}

export async function extractPDFText(plugin: PDFPlus, file: TFile): Promise<ExtractedText> {
    const fileKey = `${file.path}:${file.stat.size}:${file.stat.mtime}`;
    const doc: PDFDocumentProxy = await plugin.lib.loadPDFDocument(file);

    try {
        const pages: ExtractedPage[] = [];
        const parts: string[] = [];
        let charCount = 0;
        const pageCount = doc.numPages;

        for (let n = 1; n <= pageCount; n++) {
            const page = await doc.getPage(n);
            const content = await page.getTextContent();
            let text = '';
            const items: ExtractedItem[] = [];
            for (let i = 0; i < content.items.length; i++) {
                const it = content.items[i] as PdfTextItem;
                const str = it.str ?? '';
                text += str;
                // pdfjs inserts explicit spaces between items via the 'hasEOL'/'str' " " markers;
                // join items with a space when neither side ends/starts with whitespace.
                if (i < content.items.length - 1 && !/\s$/.test(str)) text += ' ';
                items.push({ str });
            }
            const clean = text.replace(/[ \t]+\n/g, '\n').trim();
            pages.push({ pageNumber: n, text: clean, items });
            parts.push(`p.${n}:\n${clean}`);
            charCount += clean.length;
        }

        const outline: PaperSection[] = [];
        try {
            const walk = async (items: NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>, level: number) => {
                for (const item of items) {
                    const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
                    if (dest?.[0] !== undefined) {
                        const pageIndex = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
                        const page = pages[pageIndex];
                        if (page && item.title.trim()) {
                            const title = item.title.replace(/\s+/g, ' ').trim();
                            const located = locateQuote(buildLocator([page]), title);
                            const beginIndex = located && !located.fuzzy ? located.beginIndex : 0;
                            outline.push({ title, level, page: pageIndex + 1, beginIndex: Math.max(0, beginIndex) });
                        }
                    }
                    if (item.items?.length) await walk(item.items, level + 1);
                }
            };
            await walk(await doc.getOutline() ?? [], 1);
        } catch { /* Some PDFs have broken outline destinations; AI headings are a fallback. */ }

        const fullText = parts.join('\n\n');

        return { file, fileKey, pages, outline, fullText, estimatedTokens: Math.ceil(charCount / 4), charCount };
    } finally {
        await doc.destroy().catch(() => { /* ignore */ });
    }
}

/** True when the PDF has effectively no extractable text (scanned PDF). */
export function isScanned(extracted: ExtractedText): boolean {
    return extracted.charCount < 50;
}
