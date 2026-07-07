// Render a PDF page (or a rectangular region of it) to a PNG data URL for vision prompts.
// Reuses PDF++'s own rendering pipeline (lib.loadPDFDocument + lib.pdfPageToImageDataUrl),
// so theming/HiDPI behavior matches the rest of the plugin.

import { TFile } from 'obsidian';
import { Rect } from 'typings';
import PDFPlus from 'main';

export interface RenderedImage {
    dataUrl: string;
    pageNumber: number;
}

export async function renderPage(plugin: PDFPlus, file: TFile, pageNumber: number): Promise<RenderedImage> {
    // Prefer the canvas PDF.js has already painted on screen — a full loadPDFDocument +
    // render round-trip per page is the main cost in parseAllFigures. Fall back to an
    // independent render only when there's no live viewer or the page isn't painted yet.
    const child = plugin.lib.getPDFViewerChild(true);
    const canvas = child?.getPage(pageNumber)?.canvas;
    if (canvas && canvas.width > 1 && canvas.height > 1) {
        try {
            return { dataUrl: canvas.toDataURL('image/png'), pageNumber };
        } catch {
            // tainted canvas (shouldn't happen for in-vault PDFs) — fall through
        }
    }

    const doc = await plugin.lib.loadPDFDocument(file);
    try {
        const page = await doc.getPage(pageNumber);
        const dataUrl = await plugin.lib.pdfPageToImageDataUrl(page, {
            type: 'image/png',
            renderParams: plugin.lib.getOptionalRenderParameters(),
        });
        return { dataUrl, pageNumber };
    } finally {
        await doc.destroy().catch(() => { /* ignore */ });
    }
}

export async function renderRect(plugin: PDFPlus, file: TFile, pageNumber: number, rect: Rect): Promise<RenderedImage> {
    const doc = await plugin.lib.loadPDFDocument(file);
    try {
        const page = await doc.getPage(pageNumber);
        const normalized = window.pdfjsLib.Util.normalizeRect(rect);
        const dataUrl = await plugin.lib.pdfPageToImageDataUrl(page, {
            type: 'image/png',
            cropRect: normalized,
            renderParams: plugin.lib.getOptionalRenderParameters(),
        });
        return { dataUrl, pageNumber };
    } finally {
        await doc.destroy().catch(() => { /* ignore */ });
    }
}
