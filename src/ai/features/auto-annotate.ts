// F5: auto-annotation of papers.
// extract text → M3 returns JSON quote list → quote locator maps each to a selection range →
// review modal (user approves) → write:
//   • vault mode: companion Markdown note with one PDF++ selection link per annotation
//   • pdf mode:   real Highlight annotations via lib/highlights/write-file (@cantoo/pdf-lib)
// Quote matching is fuzzy; unmatched quotes are reported, never guessed.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { AnnotationCategory } from '../settings';
import { extractPDFText } from '../context/extractor';
import { buildLocator, locateQuote, Located } from './quote-locator';
import { chatJSON } from '../provider/json';
import { autoAnnotateSystem, autoAnnotateUser, RawAnnotation, PROMPT_VERSION } from '../prompts/auto-annotate';
import { AutoAnnotationReviewModal, AnnotationProposal } from '../ui/review-modal';
import { companionNotePath } from './figure-analysis';
import { getCache, cacheKey } from '../context/cache';
import { normalizeError } from '../provider/types';

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }
function langFor(plugin: PDFPlus): 'zh' | 'en' { return plugin.settings.ai.outputLanguage === 'zh' ? 'zh' : 'en'; }

export function categoryColorName(plugin: PDFPlus, category: AnnotationCategory): string {
    return plugin.settings.ai.annotation.categoryColors[category] ?? 'yellow';
}

export async function autoAnnotateAction(plugin: PDFPlus) {
    const file = activePDFFile(plugin);
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

    const lang = langFor(plugin);
    const cache = getCache(plugin);
    const key = await cacheKey('annotate', extracted.fileKey, PROMPT_VERSION, lang);

    block?.setLoading('Asking M3 for important passages…');
    let raw: RawAnnotation[];
    const cached = await cache.get<RawAnnotation[]>(key);
    if (cached) {
        raw = cached;
        block?.setLoading(`Loaded ${raw.length} cached annotations…`);
    } else {
        try {
            const parsed = await chatJSON(plugin, [
                { role: 'system', content: autoAnnotateSystem(lang) },
                { role: 'user', content: autoAnnotateUser() + extracted.fullText },
            ]);
            raw = (parsed?.annotations ?? []) as RawAnnotation[];
            await cache.set(key, raw);
        } catch (e) {
            block?.setError(`${normalizeError(e).kind}: ${normalizeError(e).message}`);
            return;
        }
    }

    block?.setLoading(`Locating ${raw.length} quotes in the text layer…`);
    const index = buildLocator(extracted.pages);
    const proposals: AnnotationProposal[] = raw.map((a) => {
        const located: Located | null = a.quote ? locateQuote(index, a.quote) : null;
        return { quote: a.quote, category: a.category, comment: a.comment, located };
    });
    const locatedCount = proposals.filter((p) => p.located).length;

    await block?.setMarkdown(`Proposed **${proposals.length}** annotations; **${locatedCount}** located. Review to write.`);
    block?.setDone();

    new AutoAnnotationReviewModal(plugin, proposals, (approved) => writeAnnotations(plugin, file, approved)).open();
}

async function writeAnnotations(plugin: PDFPlus, file: TFile, approved: AnnotationProposal[]) {
    if (!approved.length) { new Notice('PDF++ AI: nothing approved.', 3000); return; }
    const mode = plugin.settings.ai.annotation.defaultMode;
    try {
        if (mode === 'pdf') {
            await writeIntoPDF(plugin, file, approved);
        } else {
            await writeToCompanionNote(plugin, file, approved);
        }
    } catch (e) {
        const err = normalizeError(e);
        new Notice(`PDF++ AI: ${err.kind}: ${err.message}`, 7000);
    }
}

/** Vault-only mode: companion note with one PDF++ selection link per annotation. PDF byte-identical. */
async function writeToCompanionNote(plugin: PDFPlus, file: TFile, approved: AnnotationProposal[]) {
    const lines: string[] = [`# Annotations — ${file.basename}\n`];
    for (const p of approved) {
        if (!p.located) continue;
        const color = categoryColorName(plugin, p.category);
        const subpath = selectionSubpath(p.located, color);
        const alias = p.comment || p.quote.slice(0, 40);
        const link = plugin.lib.generateMarkdownLink(file, '', subpath, alias);
        lines.push(`- **${p.category}** — ${link}`);
        if (p.comment) lines.push(`  ${p.comment}`);
    }
    const notePath = companionNotePath(plugin, file);
    await plugin.lib.write(notePath, lines.join('\n') + '\n', false);
    new Notice(`PDF++ AI: wrote ${approved.filter((p) => p.located).length} annotations to ${notePath}.`, 5000);
    plugin.app.workspace.openLinkText(notePath, '', false);
}

/** Write-to-PDF mode: real Highlight annotations via PDF++'s write-file infrastructure. */
async function writeIntoPDF(plugin: PDFPlus, file: TFile, approved: AnnotationProposal[]) {
    if (!plugin.settings.enablePDFEdit) {
        new Notice('PDF++ AI: enable "Editing PDF files" in PDF++ settings to use write-into-PDF mode.', 6000);
        return;
    }
    const child = plugin.lib.getPDFViewerChild(true);
    if (!child) { new Notice('PDF++ AI: no active PDF viewer.', 3000); return; }
    const writeLib = plugin.lib.highlight.writeFile;
    let written = 0;
    let skipped = 0;
    for (const p of approved) {
        if (!p.located) continue;
        const color = categoryColorName(plugin, p.category);
        const res = await writeLib.addAnnotationToTextRange(
            async (f, page, rects) => writeLib.pdflib.addHighlightAnnotation(f, page, rects, color, p.comment),
            child, p.located.page, p.located.beginIndex, p.located.beginOffset, p.located.endIndex, p.located.endOffset,
        );
        if (res?.annotationID !== undefined) written++; else skipped++;
    }
    new Notice(`PDF++ AI: wrote ${written} highlight(s) into PDF${skipped ? ` (${skipped} skipped — page not loaded)` : ''}.`, 6000);
}

/** Build a PDF++ selection subpath with a color param. */
export function selectionSubpath(loc: Located, colorName?: string): string {
    const base = `#page=${loc.page}&selection=${loc.beginIndex},${loc.beginOffset},${loc.endIndex},${loc.endOffset}`;
    return colorName ? `${base}&color=${colorName.toLowerCase()}` : base;
}
