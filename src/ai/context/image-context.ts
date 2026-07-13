// Render a PDF page (or a rectangular region of it) to an image data URL for vision prompts.
// Reuses PDF++'s own rendering pipeline (lib.loadPDFDocument + lib.pdfPageToImageDataUrl),
// so theming/HiDPI behavior matches the rest of the plugin.
//
// For vision we cap canvas resolution and prefer JPEG: a full-page PNG at the default desktop
// resolution (~7× viewport) is multi-megabyte and dwarfs the token cost of the prompt itself.
// Downscaling to a ~1600px long edge at JPEG q0.8 keeps figures legible while cutting payload
// and per-call token spend roughly an order of magnitude.

import { TFile } from 'obsidian';
import { PDFPageProxy } from 'pdfjs-dist';
import { Rect } from 'typings';
import PDFPlus from 'main';

/** Long-edge pixel cap applied to vision renders before base64 encoding. */
const VISION_MAX_LONG_EDGE = 1600;

/** Downscale a source canvas to at most VISION_MAX_LONG_EDGE on its long edge, then encode JPEG. */
function toCappedJpeg(source: HTMLCanvasElement): string {
    const { width, height } = source;
    const longEdge = Math.max(width, height);
    if (longEdge <= VISION_MAX_LONG_EDGE) return source.toDataURL('image/jpeg', 0.8);
    const scale = VISION_MAX_LONG_EDGE / longEdge;
    const out = document.createElement('canvas');
    out.width = Math.round(width * scale);
    out.height = Math.round(height * scale);
    const ctx = out.getContext('2d');
    if (!ctx) return source.toDataURL('image/jpeg', 0.8);
    ctx.drawImage(source, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.8);
}

/** Render a page via pdfPageToImageDataUrl and return the (post-downscale) JPEG canvas for vision. */
async function renderCappedCanvas(plugin: PDFPlus, page: PDFPageProxy, cropRect?: Rect): Promise<HTMLCanvasElement> {
    const opts: { resolution?: number; cropRect?: Rect; renderParams?: object } = { resolution: 2 };
    // resolution:2 is a deliberate, modest scale (≈ 2× viewport). getOptionalRenderParameters
    // preserves dark-mode theme adaptation; toCappedJpeg enforces the hard long-edge cap.
    const dataUrl = await plugin.lib.pdfPageToImageDataUrl(page, { type: 'image/jpeg', encoderOptions: 0.8, ...opts });
    // pdfPageToImageDataUrl returns a JPEG data URL already; load it back onto a canvas so the
    // long-edge cap applies uniformly (matters for large pages where resolution:2 still exceeds it).
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas;
}

export interface RenderedImage {
    dataUrl: string;
    pageNumber: number;
}

export async function renderPage(plugin: PDFPlus, file: TFile, pageNumber: number): Promise<RenderedImage> {
    // Prefer the canvas PDF.js has already painted on screen — a full loadPDFDocument +
    // render round-trip per page is the main cost in parseAllFigures. Fall back to an
    // independent render only when there's no live viewer or the page isn't painted yet.
    // Either way, run it through toCappedJpeg so the model never receives a multi-MB PNG.
    const child = plugin.lib.getPDFViewerChild(true);
    const canvas = child?.getPage(pageNumber)?.canvas;
    if (canvas && canvas.width > 1 && canvas.height > 1) {
        try {
            return { dataUrl: toCappedJpeg(canvas), pageNumber };
        } catch {
            // tainted canvas (shouldn't happen for in-vault PDFs) — fall through
        }
    }

    const doc = await plugin.lib.loadPDFDocument(file);
    try {
        const page = await doc.getPage(pageNumber);
        const capped = await renderCappedCanvas(plugin, page);
        return { dataUrl: toCappedJpeg(capped), pageNumber };
    } finally {
        await doc.destroy().catch(() => { /* ignore */ });
    }
}

export async function renderRect(plugin: PDFPlus, file: TFile, pageNumber: number, rect: Rect): Promise<RenderedImage> {
    const doc = await plugin.lib.loadPDFDocument(file);
    try {
        const page = await doc.getPage(pageNumber);
        const normalized = window.pdfjsLib.Util.normalizeRect(rect);
        const capped = await renderCappedCanvas(plugin, page, normalized);
        return { dataUrl: toCappedJpeg(capped), pageNumber };
    } finally {
        await doc.destroy().catch(() => { /* ignore */ });
    }
}
