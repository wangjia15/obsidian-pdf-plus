// F2: image / figure parsing via M3 vision.
//   analyzeImageAction    — analyze the active page image (single, cached)
//   parseAllFiguresAction — scan every page, describe figures, write a companion note
// Vision calls are non-streaming JSON; batch is queued ≤ 2 concurrent via the 'vision' limiter.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { getCache, cacheKey } from '../context/cache';
import { renderPage, renderRect } from '../context/image-context';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { AIProgressModal } from '../ui/progress';
import { figureAnalysisSystem, figureAnalysisUser, pageFiguresSystem, pageFiguresUser, PROMPT_VERSION } from '../prompts/figure';
import { chatJSON, ParsedJSON } from '../provider/json';
import { AIError, normalizeError } from '../provider/types';
import { Rect } from 'typings';

interface FigureResult {
    kind: string;
    reading: string;
    markdown_table?: string;
    latex?: string;
    label?: string;
}

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }
function activePageNumber(plugin: PDFPlus): number | null {
    const v = plugin.lib.getPDFViewer();
    return v?.currentPageNumber ?? null;
}
function langFor(plugin: PDFPlus): 'zh' | 'en' { return plugin.settings.ai.outputLanguage === 'zh' ? 'zh' : 'en'; }

/** Vision JSON call. Retry/concurrency is owned by chatJSON (capability 'vision'); callers
 *  shape the parsed object for their context (single figure vs. per-page figure array). */
async function visionJSON(plugin: PDFPlus, system: string, user: string, dataUrl: string): Promise<ParsedJSON> {
    const text = { type: 'text', text: `${system}\n\n${user}` } as const;
    const image = { type: 'image_url', image_url: { url: dataUrl } } as const;
    const parsed = await chatJSON(plugin, [{ role: 'user', content: [text, image] }], 'vision');
    if (!parsed) throw new AIError('badResponse', 'Vision model did not return valid JSON.', { retryable: false });
    return parsed;
}

/** Coerce a page-figures result ({ figures: [...] }) into the figure array. */
function asFigures(parsed: ParsedJSON | null): FigureResult[] {
    const raw = parsed?.figures;
    return Array.isArray(raw) ? (raw as FigureResult[]) : [];
}

function formatFigure(f: FigureResult): string {
    const lines: string[] = [];
    if (f.label) lines.push(`#### ${f.label}`);
    lines.push(`**Kind:** ${f.kind || 'unknown'}`);
    if (f.reading) lines.push('', f.reading);
    if (f.markdown_table) lines.push('', f.markdown_table);
    if (f.latex) lines.push('', `$$${f.latex}$$`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function analyzeImageAction(plugin: PDFPlus) {
    const file = activePDFFile(plugin);
    if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }
    const pageNumber = activePageNumber(plugin);
    if (!pageNumber) { new Notice('PDF++ AI: no active page.', 3000); return; }

    // "Active image" = the region the user last cropped on THIS page, if any — otherwise the
    // whole page. Without this, this command always analyzed the whole page and ignored any
    // crop selection, which looked like "the AI doesn't know what's selected."
    const cropped = plugin.ai.lastCroppedRect;
    if (cropped && cropped.file === file.path && cropped.pageNumber === pageNumber) {
        return analyzeRegionAction(plugin, pageNumber, cropped.rect);
    }

    plugin.ai.assertBudget();
    if (!plugin.ai.hasConsent()) return;

    const lang = langFor(plugin);
    const cache = getCache(plugin);
    const key = await cacheKey('figure', file.name, file.stat.mtime, pageNumber, PROMPT_VERSION, lang);

    const view = await getOrCreateAISidebar(plugin, true);
    if (!view) return;
    const block = view.addBlock({ action: `Analyze image (p.${pageNumber})`, sourcePath: file.path });

    try {
        const cached = await cache.get<FigureResult>(key);
        let result: FigureResult;
        if (cached) {
            result = cached;
            block.meta = { ...block.meta, action: `Analyze image (p.${pageNumber}, cached)` };
        } else {
            new Notice(`PDF++ AI: rendering page ${pageNumber}…`, 3000);
            const img = await renderPage(plugin, file, pageNumber);
            const parsed = await visionJSON(plugin, figureAnalysisSystem(lang), figureAnalysisUser(), img.dataUrl);
            result = parsed as unknown as FigureResult;
            await cache.set(key, result);
        }
        await block.setMarkdown(formatFigure(result));
        block.setDone();
        view.updateFooter();
    } catch (e) {
        const err = normalizeError(e);
        block.setError(`${err.kind}: ${err.message}`);
    }
}

/** Analyze a rectangular sub-region of a page (the output of PDF++'s crop/box-select). */
export async function analyzeRegionAction(plugin: PDFPlus, pageNumber: number, rect: Rect) {
    const file = activePDFFile(plugin);
    if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }
    if (!rect || rect.length < 4 || rect.some((c) => isNaN(c))) {
        new Notice('PDF++ AI: invalid region.', 3000);
        return;
    }

    plugin.ai.assertBudget();
    if (!plugin.ai.hasConsent()) return;

    const lang = langFor(plugin);
    const cache = getCache(plugin);
    const key = await cacheKey('figure-region', file.name, file.stat.mtime, pageNumber, rect.map((n) => Math.round(n)).join(','), PROMPT_VERSION, lang);

    const view = await getOrCreateAISidebar(plugin, true);
    if (!view) return;
    const block = view.addBlock({ action: `Analyze region (p.${pageNumber})`, sourcePath: file.path });

    try {
        let fromCache = true;
        const result = await cache.getOrCompute<FigureResult>(key, async () => {
            fromCache = false;
            new Notice(`PDF++ AI: rendering region on p.${pageNumber}…`, 3000);
            const img = await renderRect(plugin, file, pageNumber, rect);
            const parsed = await visionJSON(plugin, figureAnalysisSystem(lang), figureAnalysisUser(), img.dataUrl);
            return parsed as unknown as FigureResult;
        });
        if (fromCache) block.meta = { ...block.meta, action: `Analyze region (p.${pageNumber}, cached)` };
        await block.setMarkdown(formatFigure(result));
        block.setDone();
        view.updateFooter();
    } catch (e) {
        const err = normalizeError(e);
        block.setError(`${err.kind}: ${err.message}`);
    }
}

export async function parseAllFiguresAction(plugin: PDFPlus) {
    const file = activePDFFile(plugin);
    if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }

    plugin.ai.assertBudget();
    if (!plugin.ai.hasConsent()) return;

    const lang = langFor(plugin);
    const view = await getOrCreateAISidebar(plugin, true);
    const block = view?.addBlock({ action: 'Parse all figures', sourcePath: file.path });
    block?.setLoading('Scanning pages…');

    let pageCount = plugin.lib.getPDFDocument(true)?.numPages;
    if (!pageCount) {
        // load doc to learn page count
        const doc = await plugin.lib.loadPDFDocument(file);
        pageCount = doc.numPages;
        await doc.destroy().catch(() => { /* ignore */ });
    }
    if (!pageCount) { block?.setError('Could not read page count.'); return; }

    // Cost guard: each page is one vision call (~0.6–1.5k image tokens + prompt). Warn before
    // committing a large doc to the queue so users don't burn their monthly budget by accident.
    const estTokens = pageCount * 1500;
    const remaining = remainingBudget(plugin);
    if (remaining !== null && estTokens > remaining) {
        const proceed = confirm(`PDF++ AI: parsing all ${pageCount} pages will cost ~${estTokens.toLocaleString()} tokens (you have ~${remaining.toLocaleString()} left this month). Continue?`);
        if (!proceed) { new Notice('PDF++ AI: cancelled.', 2000); return; }
    }

    const ac = new AbortController();
    const modal = new AIProgressModal(plugin, 'PDF++ AI — Parsing figures', () => ac.abort());
    modal.open();

    const sections: string[] = [`# Figures — ${file.basename}\n`];
    let found = 0;
    try {
        for (let n = 1; n <= pageCount; n++) {
            if (ac.signal.aborted) break;
            modal.setStatus(`Scanning page ${n}/${pageCount}…`, (n - 1) / pageCount);
            block?.setLoading(`Scanning page ${n}/${pageCount}…`);
            const img = await renderPage(plugin, file, n);
            const parsed = await visionJSON(plugin, pageFiguresSystem(lang), pageFiguresUser(n), img.dataUrl);
            const figs = asFigures(parsed);
            if (!figs.length) continue;
            found += figs.length;
            sections.push(`## Page ${n}\n`);
            for (const f of figs) {
                if (!f.label) f.label = `Figure on page ${n}`;
                sections.push(formatFigure(f), '');
            }
            block?.setLoading(`Page ${n}: found ${figs.length} figure(s) so far (${found} total)…`);
        }

        modal.close();
        if (ac.signal.aborted) {
            await block?.setMarkdown(`**Cancelled** after scanning part of the document — ${found} figure(s) parsed, not saved. Re-run to resume.`);
            block?.setDone();
            return;
        }

        const md = sections.join('\n');
        const notePath = companionNotePath(plugin, file);
        await plugin.lib.write(notePath, md + `\n\n> Generated by PDF++ AI · ${found} figure(s) across ${pageCount} pages.\n`, false);
        await block?.setMarkdown(`Parsed **${found}** figure(s) across ${pageCount} pages.\n\nSaved to [[${notePath}]].`);
        block?.setDone();
        view?.updateFooter();
        new Notice(`PDF++ AI: parsed ${found} figure(s). Saved to ${notePath}.`, 5000);
    } catch (e) {
        modal.close();
        const err = normalizeError(e);
        block?.setError(`${err.kind}: ${err.message}`);
    }
}

/** Remaining tokens in the current monthly budget window, or null when the budget is unlimited. */
function remainingBudget(plugin: PDFPlus): number | null {
    const ai = plugin.settings.ai;
    if (ai.monthlyTokenBudget === null) return null;
    return Math.max(0, ai.monthlyTokenBudget - (ai.tokenUsage?.tokens ?? 0));
}

/** Companion note path: <name>.ai.md next to the PDF (configurable later). */
export function companionNotePath(_plugin: PDFPlus, file: TFile): string {
    const dir = file.parent?.path ?? '';
    return `${dir ? dir + '/' : ''}${file.basename}.ai.md`;
}
