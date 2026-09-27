import type { PaperSection } from './annotation-note';
import { comparePosition } from './annotation-note';
import type { Located } from './quote-locator';
import { ANNOTATION_CATEGORIES, type AnnotationCategory } from '../settings';

export interface ReadingText {
	quote: string;
	translation: string;
	category: AnnotationCategory;
	explanation: string;
}
export interface ReadingVisual {
	kind: 'figure' | 'chart' | 'diagram' | 'table' | 'formula';
	title: string;
	captionQuote: string;
	captionTranslation: string;
	explanation: string;
	markdown_table: string;
	latex: string;
	bbox?: [number, number, number, number];
}
export interface ReadingEntry {
	page: number;
	beginIndex: number;
	kind: 'text' | ReadingVisual['kind'];
	title: string;
	quote: string;
	/** Translation of `quote`; rendered below the original so the note stays bilingual. */
	translation?: string;
	explanation: string;
	location: Located | null;
	category?: AnnotationCategory;
	rect?: [number, number, number, number];
	markdownTable?: string;
	latex?: string;
}
export interface ReadingCoverage {
	page: number;
	text: 'done' | 'empty' | 'failed' | 'pending';
	visuals: 'done' | 'failed' | 'pending';
	error?: string;
	unmatched?: number;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
export function parseReadingText(value: unknown): ReadingText[] {
	if (!Array.isArray(value)) throw new Error('Missing annotations array.');
	return value.map((item) => {
		const r = record(item);
		if (!r || typeof r.quote !== 'string' || r.quote.trim().length < 4 || typeof r.explanation !== 'string'
			|| !r.explanation.trim() || !ANNOTATION_CATEGORIES.includes(r.category as AnnotationCategory)) throw new Error('Invalid close-reading annotation.');
		return { quote: r.quote, translation: typeof r.translation === 'string' ? r.translation : '',
			category: r.category as AnnotationCategory, explanation: r.explanation };
	});
}
export function validBox(value: unknown): value is [number, number, number, number] {
	return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
		&& value[0] < value[2] && value[1] < value[3];
}
export function parseReadingVisuals(value: unknown): ReadingVisual[] {
	if (!Array.isArray(value)) throw new Error('Missing visuals array.');
	return value.map((item) => {
		const r = record(item);
		if (!r || !['figure', 'chart', 'diagram', 'table', 'formula'].includes(String(r.kind)) || typeof r.title !== 'string'
			|| typeof r.explanation !== 'string' || !r.explanation.trim()) throw new Error('Invalid visual explanation.');
		return { kind: r.kind as ReadingVisual['kind'], title: r.title, explanation: r.explanation,
			captionQuote: typeof r.captionQuote === 'string' ? r.captionQuote : '',
			captionTranslation: typeof r.captionTranslation === 'string' ? r.captionTranslation : '',
			markdown_table: typeof r.markdown_table === 'string' ? r.markdown_table : '',
			latex: typeof r.latex === 'string' ? r.latex : '', ...(validBox(r.bbox) ? { bbox: r.bbox } : {}) };
	});
}

export function boxToPDFRect(box: [number, number, number, number], width: number, height: number,
	convert: (x: number, y: number) => number[]): [number, number, number, number] {
	const points = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => convert(x * width, y * height));
	return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])),
		Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
}

function oneLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
export function renderFullReadingNote(title: string, sourcePath: string, sections: PaperSection[], entries: ReadingEntry[],
	coverage: ReadingCoverage[], linkFor: (entry: ReadingEntry, alias: string) => string, colorFor: (entry: ReadingEntry) => string,
	calloutType = 'PDF'): string {
	const complete = coverage.every((p) => p.text !== 'pending' && p.text !== 'failed' && p.visuals === 'done');
	const lines = ['---', 'pdf-plus-ai: full-reading', 'schema-version: 1', `source-pdf: ${JSON.stringify(sourcePath)}`,
		`complete: ${complete}`, 'tags: [pdf-plus-ai/full-reading]', '---', '', `# ${oneLine(title)}`, '',
		complete ? '> 全部页面已处理；图表和公式的识别结果仍以原文为准。' : '> 本次精读尚未完成，请查看末尾的页面处理记录；重新运行可复用已完成页面的缓存。', ''];
	const emptyPages = coverage.filter((p) => p.text === 'empty').length;
	if (emptyPages) lines.push(`> 有 ${emptyPages} 页无可提取正文，仅进行了视觉解释；若为扫描正文，请先 OCR 再运行。`, '');
	const orderedSections = [...sections].sort(comparePosition);
	const grouped = orderedSections.map(() => [] as ReadingEntry[]);
	const preamble: ReadingEntry[] = [];
	for (const entry of [...entries].sort(comparePosition)) {
		let group = -1;
		for (let i = 0; i < orderedSections.length && comparePosition(orderedSections[i], entry) <= 0; i++) group = i;
		(group < 0 ? preamble : grouped[group]).push(entry);
	}
	const render = (items: ReadingEntry[]) => {
		for (const entry of items) {
			const alias = `${sourcePath.split('/').pop()?.replace(/\.pdf$/i, '')}, p.${entry.page}`;
			const color = oneLine(colorFor(entry)).replace(/[\]|]/g, '').toLowerCase() || 'note';
			lines.push(`> [!${calloutType}|${color}] ${linkFor(entry, alias).replace(/^!/, '')}`,
				`> > ${oneLine(entry.quote || entry.title)}`);
			if (entry.translation?.trim()) lines.push('> >', `> > ${oneLine(entry.translation)}`);
			lines.push('>', `> **AI 精读 · ${oneLine(entry.title)}**`, '>');
			for (const line of entry.explanation.split(/\r?\n/)) lines.push(`> ${line}`);
			if (entry.markdownTable) { lines.push('>'); for (const line of entry.markdownTable.split(/\r?\n/)) lines.push(`> ${line}`); }
			if (entry.latex) lines.push('>', '> $$', ...entry.latex.split(/\r?\n/).map((line) => `> ${line}`), '> $$');
			if (entry.kind === 'text' && !entry.location) lines.push('>', '> 原文选区未能精确定位；此链接仅跳转到所在页面。');
			lines.push('');
		}
	};
	if (preamble.length || !orderedSections.length) { lines.push('## 导读 / Reading notes', ''); render(preamble); }
	orderedSections.forEach((section, i) => { lines.push(`${'#'.repeat(Math.min(6, Math.max(2, section.level + 1)))} ${oneLine(section.title)}`, ''); render(grouped[i]); });
	lines.push('## 页面处理记录', '');
	const status = { done: '已处理', empty: '无可提取正文', failed: '失败', pending: '未处理' };
	for (const page of coverage) lines.push(`- p.${page.page}：正文 ${status[page.text]}；图片、表格、独立公式 ${status[page.visuals]}${page.error ? `；${oneLine(page.error)}` : ''}${page.unmatched ? `；${page.unmatched} 条引文未能精确定位，未写入` : ''}`);
	return lines.join('\n') + '\n';
}
