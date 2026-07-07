// F1: paper understanding + selection actions.
//   summarizePaperAction     — whole-paper structured summary (streamed into the sidebar)
//   explain/summarize/translate/askSelectionAction — operate on the active PDF text selection
//
// All actions go through the consent + budget gates, reuse the shared cache, and stream into
// an OutputBlock in the PDF++ AI sidebar.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { getSharedChatClient } from '../provider/minimax-chat';
import { getCache, cacheKey } from '../context/cache';
import { extractPDFText, isScanned } from '../context/extractor';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { summarizePaperPrompt, explainPrompt, summarizeSelectionPrompt, translatePrompt, askPrompt, PROMPT_VERSION } from '../prompts/summarize';
import { AIError, normalizeError } from '../provider/types';

function activePDFFile(plugin: PDFPlus): TFile | null {
    return plugin.lib.getPDFView()?.file ?? null;
}

function activeSelectionText(plugin: PDFPlus): string {
    const child = plugin.lib.getPDFViewerChild();
    const win = child?.containerEl.win ?? activeWindow;
    const sel = win.getSelection();
    return sel && !sel.isCollapsed ? sel.toString().trim() : '';
}

function resolveLang(plugin: PDFPlus, text: string): 'zh' | 'en' {
    const ai = plugin.settings.ai.outputLanguage;
    if (ai === 'zh' || ai === 'en') return ai;
    // auto: detect CJK
    return /[一-鿿぀-ヿ]/.test(text.slice(0, 1000)) ? 'zh' : 'en';
}

async function requireSidebar(plugin: PDFPlus) {
    const view = await getOrCreateAISidebar(plugin, true);
    if (!view) new Notice('PDF++ AI: enable the AI module first (Settings > PDF++ > AI).', 4000);
    return view;
}

async function runStream(plugin: PDFPlus, action: string, sourcePath: string | undefined, system: string, user: string, cacheKeyParts: (string | number)[]): Promise<string> {
    const manager = plugin.ai;
    manager.assertBudget();
    if (!manager.hasConsent()) throw new AIError('auth', 'Consent required.');

    const view = await requireSidebar(plugin);
    if (!view) throw new AIError('aborted', 'No sidebar.');

    const cache = getCache(plugin);
    const key = await cacheKey(...cacheKeyParts);
    const cached = await cache.get<string>(key);
    if (cached !== null) {
        const block = view.addBlock({ action: `${action} (cached)`, sourcePath });
        await block.setMarkdown(cached);
        block.setDone();
        return cached;
    }

    const block = view.addBlock({ action, sourcePath });
    const client = getSharedChatClient(plugin);
    const handle = client.chatStream({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], thinking: 'adaptive' }, (delta) => {
        block.appendDelta(delta, handle.partial());
    });
    try {
        const res = await handle.done;
        await block.setMarkdown(res.text);
        block.setDone();
        view.updateFooter();
        await cache.set(key, res.text);
        return res.text;
    } catch (e) {
        const err = normalizeError(e);
        block.setError(`${err.kind}: ${err.message}`);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function summarizePaperAction(plugin: PDFPlus) {
    const file = activePDFFile(plugin);
    if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }

    let extracted;
    try {
        new Notice(`PDF++ AI: extracting text from ${file.name}…`, 3000);
        extracted = await extractPDFText(plugin, file);
    } catch (e) {
        new Notice(`PDF++ AI: failed to read PDF. ${normalizeError(e).message}`, 6000);
        return;
    }
    if (isScanned(extracted)) {
        new Notice('PDF++ AI: this looks like a scanned PDF (no text layer). Summary may be poor; figure/vision features still work.', 7000);
    }
    if (extracted.estimatedTokens > 500_000) {
        new Notice(`PDF++ AI: paper is large (~${extracted.estimatedTokens.toLocaleString()} tokens). Summary will take a while.`, 5000);
    }

    const lang = resolveLang(plugin, extracted.fullText);
    const { system, user } = summarizePaperPrompt(extracted.fullText, lang);
    try {
        await runStream(plugin, 'Summarize paper', file.path, system, user, [extracted.fileKey, PROMPT_VERSION, lang]);
    } catch (e) {
        if (!(e instanceof AIError && e.kind === 'aborted')) new Notice(`PDF++ AI: ${normalizeError(e).message}`, 6000);
    }
}

async function selectionAction(plugin: PDFPlus, action: string, build: (sel: string, lang: 'zh' | 'en') => { system: string; user: string }) {
    const sel = activeSelectionText(plugin);
    if (!sel) { new Notice('PDF++ AI: select some text in the PDF first.', 3000); return; }
    const sourcePath = activePDFFile(plugin)?.path;
    const lang = resolveLang(plugin, sel);
    const { system, user } = build(sel, lang);
    try {
        await runStream(plugin, action, sourcePath, system, user, ['sel', action, sel, PROMPT_VERSION, lang]);
    } catch (e) {
        if (!(e instanceof AIError && e.kind === 'aborted')) new Notice(`PDF++ AI: ${normalizeError(e).message}`, 6000);
    }
}

export const explainSelectionAction = (plugin: PDFPlus) => selectionAction(plugin, 'Explain', (s, l) => explainPrompt(s, l));
export const summarizeSelectionAction = (plugin: PDFPlus) => selectionAction(plugin, 'Summarize selection', (s, l) => summarizeSelectionPrompt(s, l));
export const translateSelectionAction = (plugin: PDFPlus) => selectionAction(plugin, 'Translate', (s, l) => translatePrompt(s, l));

export async function askSelectionAction(plugin: PDFPlus, question?: string) {
    const sel = activeSelectionText(plugin);
    const q = question ?? await promptUser(plugin, 'Ask AI');
    if (!q) return;
    const sourcePath = activePDFFile(plugin)?.path;
    const ctx = sel || '';
    const lang = resolveLang(plugin, ctx || q);
    const { system, user } = askPrompt(ctx || '(no selection — answer about the open paper if you can, else say so)', q, lang);
    try {
        await runStream(plugin, 'Ask AI', sourcePath, system, user, ['ask', q, ctx, PROMPT_VERSION, lang]);
    } catch (e) {
        if (!(e instanceof AIError && e.kind === 'aborted')) new Notice(`PDF++ AI: ${normalizeError(e).message}`, 6000);
    }
}

/** Tiny native prompt() wrapper for the "Ask AI" command (no question pre-filled). */
async function promptUser(_plugin: PDFPlus, label: string): Promise<string | null> {
    const v = window.prompt(`PDF++ AI — ${label}`);
    return v?.trim() || null;
}
