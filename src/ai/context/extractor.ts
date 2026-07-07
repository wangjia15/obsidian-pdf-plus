// PDF text extraction → page-anchored structured text.
// Walks pdfjs text items per page, preserving page boundaries and per-item char offsets so:
//   - F1 prompts can cite "p.N: …"
//   - F5 quote locator can map a matched char range back to {page, beginIndex, beginOffset, ...}
//     (the same subpath format PDF++ selection links use).

import { TFile } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';
import PDFPlus from 'main';

/** Minimal shape of a pdfjs text-content item (only what we use). */
type PdfTextItem = { str?: string; hasEOL?: boolean };

export interface ExtractedItem {
    /** index of this item within its page's text-content array */
    index: number;
    str: string;
    /** begin/end char offsets within the page's assembled text */
    begin: number;
    end: number;
}

export interface ExtractedPage {
    pageNumber: number; // 1-based
    text: string;
    items: ExtractedItem[];
}

export interface ExtractedText {
    file: TFile;
    /** Cheap cache key: basename:size:mtime. Hashing a large PDF is too costly per-open. */
    fileKey: string;
    pages: ExtractedPage[];
    /** Concatenation of page texts with "\n\n" between pages, prefixed "p.N:". */
    fullText: string;
    /** Rough token estimate (~4 chars/token) for budget warnings. */
    estimatedTokens: number;
    charCount: number;
}

export async function extractPDFText(plugin: PDFPlus, file: TFile): Promise<ExtractedText> {
    const fileKey = `${file.name}:${file.stat.size}:${file.stat.mtime}`;
    const doc: PDFDocumentProxy = await plugin.lib.loadPDFDocument(file);

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
            if (!str) continue;
            const begin = text.length;
            text += str;
            // pdfjs inserts explicit spaces between items via the 'hasEOL'/'str' " " markers;
            // join items with a space when neither side ends/starts with whitespace.
            if (i < content.items.length - 1 && !/\s$/.test(str)) text += ' ';
            const end = text.length;
            items.push({ index: i, str, begin, end });
        }
        const clean = text.replace(/[ \t]+\n/g, '\n').trim();
        pages.push({ pageNumber: n, text: clean, items });
        parts.push(`p.${n}:\n${clean}`);
        charCount += clean.length;
    }

    const fullText = parts.join('\n\n');
    doc.destroy().catch(() => { /* ignore */ });

    return { file, fileKey, pages, fullText, estimatedTokens: Math.ceil(charCount / 4), charCount };
}

/** True when the PDF has effectively no extractable text (scanned PDF). */
export function isScanned(extracted: ExtractedText): boolean {
    return extracted.charCount < 50;
}
