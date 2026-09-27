// Full-paper beginner reading notes: independent text and vision passes on every page.
import { Component, Notice } from 'obsidian';
import type PDFPlus from 'main';
import { extractPDFText } from '../context/extractor';
import { renderPage } from '../context/image-context';
import { getCache, providerCacheKey } from '../context/cache';
import { chatJSON } from '../provider/json';
import { AIError, normalizeError } from '../provider/types';
import { fullReadingTextSystem, fullReadingVisualSystem, PROMPT_VERSION } from '../prompts/full-reading';
import { resolveOutputLanguage } from '../prompts/shared';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { AIProgressModal } from '../ui/progress';
import { getAutoAnnotationTarget } from './annotation-target';
import { categoryColorName, selectionSubpath } from './auto-annotate';
import { buildLocator, locateQuote } from './quote-locator';
import { boxToPDFRect, parseReadingText, parseReadingVisuals, renderFullReadingNote,
	type ReadingEntry, type ReadingCoverage, type ReadingText, type ReadingVisual } from './full-reading-note';
import type { PaperSection } from './annotation-note';

interface TextPageResult { annotations: ReadingText[]; sections: PaperSection[]; }

class ReadingProgress extends AIProgressModal {
	private finished = false;
	constructor(plugin: PDFPlus, private controller: AbortController) {
		super(plugin, 'PDF++ AI — 全文精读批注', () => controller.abort());
	}
	onClose() { if (!this.finished) this.controller.abort(); }
	finish() { this.finished = true; this.forceClose(); }
}

function fatal(error: unknown): boolean {
	return ['auth', 'budget', 'quota', 'network', 'aborted'].includes(normalizeError(error).kind);
}

export async function fullReadingAction(plugin: PDFPlus) {
	const file = getAutoAnnotationTarget(plugin)?.file;
	if (!file) { new Notice('PDF++ AI: 请先打开要精读的 PDF。', 4000); return; }
	plugin.ai.assertBudget();
	if (!plugin.ai.hasConsent()) return;
	const sidebar = await getOrCreateAISidebar(plugin, true);
	const block = sidebar?.addBlock({ action: '全文精读批注', sourcePath: file.path });
	const controller = new AbortController();
	const lifecycle = plugin.addChild(new Component());
	lifecycle.register(() => controller.abort());
	const modal = new ReadingProgress(plugin, controller);
	modal.open();
	const entries: ReadingEntry[] = [];
	const coverage: ReadingCoverage[] = [];
	let sections: PaperSection[] = [];
	let stopReason = '';
	const identity = () => {
		const ai = plugin.settings.ai;
		return JSON.stringify([ai.chatProvider, ai.outputLanguage, ai.chatProvider === 'glm-cn' ? ai.glm.baseUrl : ai.minimax.baseUrl,
			ai.chatProvider === 'glm-cn' ? ai.glm.chatModel : ai.minimax.chatModel, ai.chatProvider === 'glm-cn' ? ai.glm.visionModel : '']);
	};
	const initialIdentity = identity();
	const check = () => {
		if (controller.signal.aborted || !plugin.settings.ai.aiEnabled) throw new AIError('aborted', '已取消全文精读。');
		if (identity() !== initialIdentity) throw new AIError('aborted', '模型或语言设置已改变，请重新运行。');
	};
	try {
		modal.setStatus('提取全文和目录…', 0);
		block?.setLoading('提取全文和目录…');
		const extracted = await extractPDFText(plugin, file);
		sections = [...extracted.outline];
		const lang = resolveOutputLanguage(plugin.settings.ai.outputLanguage, extracted.fullText);
		const cache = getCache(plugin);
		for (const page of extracted.pages) coverage.push({ page: page.pageNumber, text: page.text.trim() ? 'pending' : 'empty', visuals: 'pending' });
		// Reuse one independent PDF document to convert visual boxes into native PDF coordinates.
		const doc = await plugin.lib.loadPDFDocument(file);
		try {
			for (let i = 0; i < extracted.pages.length; i++) {
				const page = extracted.pages[i];
				const state = coverage[i];
				const index = buildLocator([page]);
				check();
				modal.setStatus(`正文精读 p.${page.pageNumber}/${extracted.pages.length}`, i / extracted.pages.length);
				block?.setLoading(`正文精读 p.${page.pageNumber}/${extracted.pages.length}`);
				if (page.text.trim()) {
					try {
						const key = await providerCacheKey(plugin, 'full-reading-text', extracted.fileKey, page.pageNumber, PROMPT_VERSION, lang);
						const result = await cache.getOrCompute<TextPageResult>(key, async () => {
							check();
							const before = extracted.pages[i - 1]?.text.slice(-1000) ?? '';
							const after = extracted.pages[i + 1]?.text.slice(0, 1000) ?? '';
							const parsed = await chatJSON(plugin, [
								{ role: 'system', content: fullReadingTextSystem(lang) },
								{ role: 'user', content: `Adjacent context (do NOT quote):\n${before}\n${after}\n\nCURRENT PAGE p.${page.pageNumber}:\n${page.text}` },
							], 'chat', { signal: controller.signal, maxTokens: 16384 });
							const annotations = parseReadingText(parsed?.annotations);
							const pageSections: PaperSection[] = [];
							if (Array.isArray(parsed?.sections)) for (const raw of parsed.sections) {
								if (!raw || typeof raw !== 'object') continue;
								const { title, level, startQuote } = raw;
								if (typeof title !== 'string' || typeof startQuote !== 'string' || !Number.isInteger(level) || level < 1 || level > 5) continue;
								const located = locateQuote(index, startQuote);
								if (located && !located.fuzzy) pageSections.push({ title, level, page: page.pageNumber, beginIndex: located.beginIndex });
							}
							return { annotations, sections: pageSections };
						});
						check();
						if (!extracted.outline.length) sections.push(...result.sections);
						for (const annotation of parseReadingText(result.annotations)) {
							const located = locateQuote(index, annotation.quote);
							const exact = located && !located.fuzzy ? located : null;
							if (!exact) { state.unmatched = (state.unmatched ?? 0) + 1; continue; }
							entries.push({ page: page.pageNumber, beginIndex: exact?.beginIndex ?? 0, kind: 'text', title: annotation.category,
								quote: exact?.matchedText ?? annotation.quote, translation: annotation.translation, explanation: annotation.explanation, location: exact, category: annotation.category });
						}
						state.text = 'done';
					} catch (error) {
						state.text = 'failed'; state.error = `正文：${normalizeError(error).message}`;
						if (fatal(error)) throw error;
					}
				}
				check();
				modal.setStatus(`图片、表格与公式 p.${page.pageNumber}/${extracted.pages.length}`, (i + 0.5) / extracted.pages.length);
				block?.setLoading(`图片、表格与公式 p.${page.pageNumber}/${extracted.pages.length}`);
				try {
					const key = await providerCacheKey(plugin, 'full-reading-vision', extracted.fileKey, page.pageNumber, PROMPT_VERSION, lang, plugin.settings.ai.chatProvider === 'glm-cn' ? 'glm-5.3-flash' : plugin.settings.ai.minimax.chatModel);
					const visuals = await cache.getOrCompute<ReadingVisual[]>(key, async () => {
						check();
						const image = await renderPage(plugin, file, page.pageNumber, doc);
						check();
						const parsed = await chatJSON(plugin, [
							{ role: 'system', content: fullReadingVisualSystem(lang) },
							{ role: 'user', content: [
								{ type: 'text', text: `CURRENT PAGE p.${page.pageNumber}. Inventory and explain every visible image, table and displayed formula. Page text for context only:\n${page.text}` },
								{ type: 'image_url', image_url: { url: image.dataUrl } },
							] },
						], 'vision', { signal: controller.signal, maxTokens: 24576, ...(plugin.settings.ai.chatProvider === 'glm-cn' ? { model: 'glm-5.3-flash' } : {}) });
						return parseReadingVisuals(parsed?.visuals);
					});
					check();
					const pdfPage = await doc.getPage(page.pageNumber);
					const viewport = pdfPage.getViewport({ scale: 1 });
					for (const visual of parseReadingVisuals(visuals)) {
						const located = visual.captionQuote ? locateQuote(index, visual.captionQuote) : null;
						const exact = located && !located.fuzzy ? located : null;
						entries.push({ page: page.pageNumber, beginIndex: exact?.beginIndex ?? 0, kind: visual.kind, title: visual.title,
							quote: exact?.matchedText || visual.title, translation: exact ? visual.captionTranslation : '', explanation: visual.explanation, location: exact,
							...(visual.bbox ? { rect: boxToPDFRect(visual.bbox, viewport.width, viewport.height, (x, y) => viewport.convertToPdfPoint(x, y)) } : {}),
							markdownTable: visual.markdown_table, latex: visual.latex });
					}
					state.visuals = 'done';
				} catch (error) {
					state.visuals = 'failed'; state.error = `${state.error ? state.error + '；' : ''}视觉：${normalizeError(error).message}`;
					if (fatal(error)) throw error;
				}
			}
		} finally { await doc.destroy().catch(() => { /* independent document cleanup */ }); }
	} catch (error) { stopReason = normalizeError(error).message; }
	finally { modal.finish(); plugin.removeChild(lifecycle); }

	if (!coverage.length) { block?.setError(stopReason || '未能提取 PDF。'); return; }
	try {
		const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : '';
		const base = `${dir}${file.basename}.reading`;
		let notePath = `${base}.md`;
		for (let suffix = 2; plugin.app.vault.getAbstractFileByPath(notePath); suffix++) notePath = `${base}-${suffix}.md`;
		const colorFor = (entry: ReadingEntry) => categoryColorName(plugin, entry.category ?? 'definition');
		const markdown = renderFullReadingNote(`全文精读 — ${file.basename}`, file.path, sections, entries, coverage,
			(entry, alias) => {
				const color = colorFor(entry);
				const subpath = entry.rect ? `#page=${entry.page}&rect=${entry.rect.map((n) => Math.round(n * 100) / 100).join(',')}`
					: entry.location ? selectionSubpath(entry.location, color) : `#page=${entry.page}`;
				return plugin.lib.generateMarkdownLink(file, notePath, subpath, alias).replace(/^!/, '');
			}, colorFor, plugin.settings.calloutType);
		await plugin.app.vault.create(notePath, markdown);
		const completed = coverage.filter((p) => (p.text === 'done' || p.text === 'empty') && p.visuals === 'done').length;
		await block?.setMarkdown(`已处理 **${completed}/${coverage.length}** 页，生成 **${entries.length}** 条精读批注。\n\n[[${notePath}]]${stopReason ? `\n\n本次停止：${stopReason}` : ''}`);
		block?.setDone(); sidebar?.updateFooter();
		new Notice(`PDF++ AI: 全文精读笔记已保存：${notePath}`, 6000);
		await plugin.app.workspace.openLinkText(notePath, '', false);
	} catch (error) { block?.setError(normalizeError(error).message); }
}
