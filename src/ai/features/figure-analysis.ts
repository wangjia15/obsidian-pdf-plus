// F2: image / figure parsing via M3 vision.
//   analyzeImageAction    — analyze the active page image (single, cached)
//   parseAllFiguresAction — scan every page, describe figures, write a companion note
// Vision calls are non-streaming JSON; batch is queued ≤ 2 concurrent via the 'vision' limiter.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { getSharedChatClient } from '../provider/minimax-chat';
import { getCache, cacheKey } from '../context/cache';
import { renderPage, renderRect } from '../context/image-context';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { figureAnalysisSystem, figureAnalysisUser, pageFiguresSystem, pageFiguresUser, PROMPT_VERSION } from '../prompts/figure';
import { withRetry } from '../provider/ratelimit';
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

/** Vision JSON call with one "fix your JSON" retry. */
async function visionJSON(plugin: PDFPlus, system: string, user: string, dataUrl: string): Promise<any> {
    const client = getSharedChatClient(plugin);
    const call = () => client.chat({
        messages: [{ role: 'user', content: [{ type: 'text', text: `${system}\n\n${user}` }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        json: true, thinking: 'off', temperature: 0.1,
    });
    let res = await withRetry('vision', call);
    let parsed = parseJsonLoose(res.text);
    if (!parsed) {
        // one repair attempt
        res = await client.chat({
            messages: [
                { role: 'user', content: [{ type: 'text', text: `${system}\n\n${user}` }, { type: 'image_url', image_url: { url: dataUrl } }] },
                { role: 'assistant', content: res.text },
                { role: 'user', content: 'Your previous response was not valid JSON. Return ONLY the JSON object now, no prose, no code fences.' },
            ],
            json: true, thinking: 'off', temperature: 0,
        });
        parsed = parseJsonLoose(res.text);
        if (!parsed) throw new AIError('badResponse', 'Vision model did not return valid JSON.', { retryable: false });
    }
    return parsed;
}

function parseJsonLoose(text: string): any | null {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    // trim to outermost braces
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
    try { return JSON.parse(t); } catch { return null; }
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
            result = parsed as FigureResult;
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
        const cached = await cache.get<FigureResult>(key);
        let result: FigureResult;
        if (cached) {
            result = cached;
            block.meta = { ...block.meta, action: `Analyze region (p.${pageNumber}, cached)` };
        } else {
            new Notice(`PDF++ AI: rendering region on p.${pageNumber}…`, 3000);
            const img = await renderRect(plugin, file, pageNumber, rect);
            const parsed = await visionJSON(plugin, figureAnalysisSystem(lang), figureAnalysisUser(), img.dataUrl);
            result = parsed as FigureResult;
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

    const sections: string[] = [`# Figures — ${file.basename}\n`];
    let found = 0;
    try {
        for (let n = 1; n <= pageCount!; n++) {
            block?.setLoading(`Scanning page ${n}/${pageCount}…`);
            const img = await renderPage(plugin, file, n);
            const parsed = await visionJSON(plugin, pageFiguresSystem(lang), pageFiguresUser(n), img.dataUrl);
            const figs: FigureResult[] = parsed?.figures ?? [];
            if (!figs.length) continue;
            found += figs.length;
            sections.push(`## Page ${n}\n`);
            for (const f of figs) {
                if (!f.label) f.label = `Figure on page ${n}`;
                sections.push(formatFigure(f), '');
            }
            block?.setLoading(`Page ${n}: found ${figs.length} figure(s) so far (${found} total)…`);
        }

        const md = sections.join('\n');
        const notePath = companionNotePath(plugin, file);
        await plugin.lib.write(notePath, md + `\n\n> Generated by PDF++ AI · ${found} figure(s) across ${pageCount} pages.\n`, false);
        await block?.setMarkdown(`Parsed **${found}** figure(s) across ${pageCount} pages.\n\nSaved to [[${notePath}]].`);
        block?.setDone();
        view?.updateFooter();
        new Notice(`PDF++ AI: parsed ${found} figure(s). Saved to ${notePath}.`, 5000);
    } catch (e) {
        const err = normalizeError(e);
        block?.setError(`${err.kind}: ${err.message}`);
    }
}

/** Companion note path: <name>.ai.md next to the PDF (configurable later). */
export function companionNotePath(_plugin: PDFPlus, file: TFile): string {
    const dir = file.parent?.path ?? '';
    return `${dir ? dir + '/' : ''}${file.basename}.ai.md`;
}
