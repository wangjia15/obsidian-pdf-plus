// F5: auto-annotation of papers.
// extract text → M3 returns JSON quote list → quote locator maps each to a selection range →
// review modal (user approves) → write:
//   • vault mode: companion Markdown note with one PDF++ selection link per annotation
//   • pdf mode:   real Highlight annotations via lib/highlights/write-file (@cantoo/pdf-lib)
// Quote matching is fuzzy; unmatched quotes are reported, never guessed.

import { Component, Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import type { PDFViewerChild } from 'typings';
import { getTextLayerInfo } from 'utils';
import { AnnotationCategory, ANNOTATION_CATEGORIES } from '../settings';
import { extractPDFText, isScanned } from '../context/extractor';
import { buildLocator, locateQuote, Located } from './quote-locator';
import { chatJSON } from '../provider/json';
import { autoAnnotateSystem, autoAnnotateUser, RawAnnotation, PROMPT_VERSION } from '../prompts/auto-annotate';
import { AutoAnnotationReviewModal, AnnotationProposal } from '../ui/review-modal';
import { PaperSection, renderAnnotationNote } from './annotation-note';
import { getCache, providerCacheKey } from '../context/cache';
import { getAutoAnnotationTarget } from './annotation-target';
import { AIError, normalizeError } from '../provider/types';

function langFor(plugin: PDFPlus) { return plugin.settings.ai.outputLanguage; }

export function categoryColorName(plugin: PDFPlus, category: AnnotationCategory): string {
    const requested = plugin.settings.ai.annotation.categoryColors[category] ?? 'yellow';
    return Object.keys(plugin.settings.colors).find((name) => name.toLowerCase() === requested.toLowerCase())
        ?? Object.keys(plugin.settings.colors)[0] ?? requested;
}

export async function autoAnnotateAction(plugin: PDFPlus) {
    const target = getAutoAnnotationTarget(plugin);
    const file = target?.file;
    const child = target?.viewer?.child ?? null;
    if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }

    plugin.ai.assertBudget();
    if (!plugin.ai.hasConsent()) return;

    const view = await import('../ui/sidebar-view').then((m) => m.getOrCreateAISidebar(plugin, true));
    const block = view?.addBlock({ action: 'Auto-annotate paper', sourcePath: file.path });
    block?.setLoading('Extracting text…');

    let extracted;
    try {
        extracted = await extractPDFText(plugin, file);
    } catch (e) {
        block?.setError(normalizeError(e).message);
        return;
    }

    if (isScanned(extracted)) { block?.setError('This PDF has no extractable text. Run OCR before auto-annotation.'); return; }
    const lang = langFor(plugin);
    const cache = getCache(plugin);
    const key = await providerCacheKey(plugin, 'annotate', extracted.fileKey, PROMPT_VERSION, lang);

    block?.setLoading('Finding paper sections and important passages…');
    let raw: RawAnnotation[];
    let sections: PaperSection[] = extracted.outline;
    const index = buildLocator(extracted.pages);
    const cached = await cache.get<{ annotations: RawAnnotation[]; sections: PaperSection[] }>(key);
    if (cached) {
        raw = validateAnnotations(cached.annotations);
        sections = Array.isArray(cached.sections) ? cached.sections : extracted.outline;
        block?.setLoading(`Loaded ${raw.length} cached annotations…`);
    } else {
        try {
            const parsed = await chatJSON(plugin, [
                { role: 'system', content: autoAnnotateSystem(lang) },
                { role: 'user', content: autoAnnotateUser() + extracted.fullText },
            ]);
            raw = validateAnnotations(parsed?.annotations);
            if (!raw.length) throw new AIError('badResponse', 'No valid annotations returned.');
            if (!sections.length && Array.isArray(parsed?.sections)) {
                for (const entry of parsed.sections) {
                    if (!entry || typeof entry !== 'object') continue;
                    const { title, level, startQuote } = entry;
                    if (typeof title !== 'string' || typeof startQuote !== 'string' || !Number.isInteger(level) || level < 1 || level > 5) continue;
                    const location = locateQuote(index, startQuote);
                    if (location && !location.fuzzy) sections.push({ title, level, page: location.page, beginIndex: location.beginIndex });
                }
            }
            await cache.set(key, { annotations: raw, sections });
        } catch (e) {
            block?.setError(`${normalizeError(e).kind}: ${normalizeError(e).message}`);
            return;
        }
    }

    block?.setLoading(`Locating ${raw.length} quotes in the text layer…`);
    const proposals: AnnotationProposal[] = raw.map((a) => {
        const located: Located | null = a.quote ? locateQuote(index, a.quote) : null;
        return { quote: a.quote, category: a.category, comment: a.comment, located };
    });
    const locatedCount = proposals.filter((p) => p.located).length;

    await block?.setMarkdown(`Proposed **${proposals.length}** annotations; **${locatedCount}** located. Review to write.`);
    block?.setDone();

    new AutoAnnotationReviewModal(plugin, proposals, (approved) => writeAnnotations(plugin, file, approved, sections, child)).open();
}

async function writeAnnotations(plugin: PDFPlus, file: TFile, approved: AnnotationProposal[], sections: PaperSection[], child: PDFViewerChild | null) {
    if (!approved.length) { new Notice('PDF++ AI: nothing approved.', 3000); return; }
    const mode = plugin.settings.ai.annotation.defaultMode;
    try {
        if (mode === 'pdf') {
            if (await writeIntoPDF(plugin, file, approved, child)) await writeToCompanionNote(plugin, file, approved, sections);
        } else {
            await writeToCompanionNote(plugin, file, approved, sections);
        }
    } catch (e) {
        const err = normalizeError(e);
        new Notice(`PDF++ AI: ${err.kind}: ${err.message}`, 7000);
    }
}

/** Vault-only mode: companion note with one PDF++ selection link per annotation. PDF byte-identical. */
async function writeToCompanionNote(plugin: PDFPlus, file: TFile, approved: AnnotationProposal[], sections: PaperSection[]) {
    const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : '';
    const base = `${dir}${file.basename}.annotations`;
    let notePath = `${base}.md`;
    let suffix = 2;
    while (plugin.app.vault.getAbstractFileByPath(notePath)) notePath = `${base}-${suffix++}.md`;
    const markdown = renderAnnotationNote(
        `Annotations — ${file.basename}`, file.path, sections, approved,
        (loc, alias) => {
            const proposal = approved.find((p) => p.located === loc)!;
            return plugin.lib.generateMarkdownLink(file, notePath, selectionSubpath(loc, categoryColorName(plugin, proposal.category)), alias).replace(/^!/, '');
        },
        (p) => categoryColorName(plugin, p.category),
        plugin.settings.calloutType,
    );
    // create() deliberately refuses a collision instead of overwriting existing reading notes.
    await plugin.app.vault.create(notePath, markdown);
    new Notice(`PDF++ AI: saved ${approved.length} annotations to ${notePath}. Open this note in K-Plex and expand note to sections.`, 6000);
    await plugin.app.workspace.openLinkText(notePath, '', false);
}

function validateAnnotations(value: unknown): RawAnnotation[] {
    if (!Array.isArray(value)) return [];
    return value.filter((a): a is RawAnnotation => a && typeof a.quote === 'string' && a.quote.trim().length >= 4
        && ANNOTATION_CATEGORIES.includes(a.category) && typeof a.comment === 'string');
}

/** Write-to-PDF mode: real Highlight annotations via PDF++'s write-file infrastructure. */
async function writeIntoPDF(plugin: PDFPlus, file: TFile, approved: AnnotationProposal[], child: PDFViewerChild | null): Promise<boolean> {
    if (!plugin.settings.enablePDFEdit) {
        new Notice('PDF++ AI: enable "Editing PDF files" in PDF++ settings to use write-into-PDF mode.', 6000);
        return false;
    }
    if (!child || child.file?.path !== file.path) { new Notice('PDF++ AI: reopen the original PDF before writing annotations.', 5000); return false; }
    const writeLib = plugin.lib.highlight.writeFile;
    const written: AnnotationProposal[] = [];
    let skipped = 0;
    const viewer = child.pdfViewer.pdfViewer;
    const originalPage = viewer?.currentPageNumber;
    const originalScale = viewer?.currentScale ?? 1;
    const originalLocation = viewer?._location ? { ...viewer._location } : null;
    try {
        for (const p of [...approved].sort((a, b) => (a.located?.page ?? 0) - (b.located?.page ?? 0))) {
            if (!p.located) continue;
            if (!await ensureTextLayer(plugin, child, file, p.located.page)) { skipped++; continue; }
            if (child.file?.path !== file.path) throw new AIError('badResponse', 'The PDF viewer changed while writing annotations.');
            const color = categoryColorName(plugin, p.category);
            const res = await writeLib.addAnnotationToTextRange(
                async (f, page, rects) => writeLib.pdflib.addHighlightAnnotation(f, page, rects, color, p.comment),
                child, p.located.page, p.located.beginIndex, p.located.beginOffset, p.located.endIndex, p.located.endOffset,
            );
            if (res?.annotationID !== undefined) written.push(p); else skipped++;
        }
    } finally {
        if (child.file?.path === file.path && viewer && originalPage) {
            if (originalLocation) viewer.scrollPageIntoView({ pageNumber: originalLocation.pageNumber, destArray: [originalLocation.pageNumber, { name: 'XYZ' }, originalLocation.left, originalLocation.top, originalScale] });
            else viewer.currentPageNumber = originalPage;
        }
    }
    new Notice(`PDF++ AI: wrote ${written.length} highlight(s) into PDF${skipped ? ` (${skipped} kept as Markdown highlights)` : ''}.`, 6000);
    return true;
}

/** Scroll lazy pages into view and wait for their real text layer, then use the existing
 * PDF++ geometry/writer. The listener and timer are removed on success, timeout or unload. */
async function ensureTextLayer(plugin: PDFPlus, child: PDFViewerChild, file: TFile, page: number): Promise<boolean> {
    const ready = () => {
        const view = child.getPage(page);
        return child.file?.path === file.path && !!view?.div.dataset.loaded && !!view.textLayer && !!getTextLayerInfo(view.textLayer);
    };
    if (ready()) return true;
    const viewer = child.pdfViewer.pdfViewer;
    if (!viewer) return false;
    return new Promise((resolve) => {
        const bus = child.pdfViewer.eventBus;
        let finished = false;
        const finish = (ok: boolean) => {
            if (finished) return;
            finished = true;
            window.clearTimeout(timer);
            bus.off('textlayerrendered', onRendered);
            plugin.removeChild(lifecycle);
            resolve(ok);
        };
        const onRendered = (event: { pageNumber: number }) => { if (event.pageNumber === page) finish(ready()); };
        const timer = window.setTimeout(() => finish(ready()), 10000);
        bus.on('textlayerrendered', onRendered);
        const lifecycle = plugin.addChild(new Component());
        lifecycle.register(() => finish(false));
        try { viewer.scrollPageIntoView({ pageNumber: page }); if (ready()) finish(true); }
        catch { finish(false); }
    });
}

/** Build a PDF++ selection subpath with a color param. */
export function selectionSubpath(loc: Located, colorName?: string): string {
    const base = `#page=${loc.page}&selection=${loc.beginIndex},${loc.beginOffset},${loc.endIndex},${loc.endOffset}`;
    return colorName ? `${base}&color=${encodeURIComponent(colorName.toLowerCase())}` : base;
}
