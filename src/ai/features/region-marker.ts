// Persistent visual marker for the "last cropped region" that AI figure-analysis will use.
//
// Problem this fixes: PDF++'s own rectangular-selection tool (color-palette.ts) draws a dashed
// box ONLY while dragging and removes it the instant the pointer is released — so after cropping
// a figure for AI analysis, there was no visible trace of what got selected, and no way to act on
// it except remembering to open the command palette and run "Analyze last cropped region"
// separately. "Analyze image (active page)" (figure-analysis.ts:analyzeImageAction) never
// consulted the selection either, so it always analyzed the whole current page — from the user's
// perspective, "the AI doesn't know which image is active."
//
// Fix: draw a persistent, clickable bordered overlay on the page at the cropped rect (same
// position:absolute-child-of-the-page-div technique the transient drag box uses, so it scrolls
// with the page for free). Clicking it — or its embedded button — runs region analysis directly.
// analyzeImageAction now also prefers this rect when it matches the active file+page, so "active
// image" and "the region I just cropped" are the same thing when one is marked.

import { setIcon } from 'obsidian';
import PDFPlus from 'main';
import { Rect } from 'typings';
import { analyzeRegionAction } from './figure-analysis';

let cleanup: (() => void) | null = null;

/** Remove the current marker, if any. Safe to call when there is none. */
export function clearRegionMarker() {
    cleanup?.();
    cleanup = null;
}

/** Draw (or replace) the marker for `rect` on `pageNumber` of `file`. Best-effort: does nothing
 *  if that page isn't currently rendered (e.g. a different PDF is active). */
export function showRegionMarker(plugin: PDFPlus, file: string, pageNumber: number, rect: Rect) {
    clearRegionMarker();

    const child = plugin.lib.getPDFViewerChild(true);
    if (!child || child.file?.path !== file) return;
    const pageView = child.getPage(pageNumber);
    if (!pageView?.div || !pageView.viewport) return;

    // pdfjs-dist types convertToViewportRectangle loosely as any[]; it always returns 4 numbers
    // (the PDF-space rect flipped into viewport/CSS-pixel space, same frame the page's canvas
    // and PDF++'s own drag-select box are positioned in).
    const coords = pageView.viewport.convertToViewportRectangle(rect) as unknown as [number, number, number, number];
    const [vx0, vy0, vx1, vy1] = coords;
    const left = Math.min(vx0, vx1);
    const top = Math.min(vy0, vy1);
    const width = Math.abs(vx1 - vx0);
    const height = Math.abs(vy1 - vy0);

    const markerEl = pageView.div.createDiv('pdf-plus-ai-region-marker');
    markerEl.setCssStyles({ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    markerEl.setAttr('aria-label', 'PDF++ AI: click to analyze this region');

    const analyzeBtn = markerEl.createDiv('pdf-plus-ai-region-marker-btn');
    setIcon(analyzeBtn, 'lucide-sparkles');

    const closeBtn = markerEl.createDiv('pdf-plus-ai-region-marker-close');
    setIcon(closeBtn, 'lucide-x');

    const onMarkerClick = (evt: MouseEvent) => {
        evt.stopPropagation();
        analyzeRegionAction(plugin, pageNumber, rect);
    };
    const onCloseClick = (evt: MouseEvent) => {
        evt.stopPropagation();
        clearRegionMarker();
    };
    markerEl.addEventListener('click', onMarkerClick);
    closeBtn.addEventListener('click', onCloseClick);

    cleanup = () => {
        markerEl.removeEventListener('click', onMarkerClick);
        closeBtn.removeEventListener('click', onCloseClick);
        markerEl.remove();
    };
}
