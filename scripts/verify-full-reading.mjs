// End-to-end action checks with deterministic provider responses; never calls external APIs.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const mocks = {
	'../context/extractor': 'export const extractPDFText = async () => globalThis.__reading.extracted;',
	'../context/image-context': 'export const renderPage = async (_plugin, file, page, doc) => { globalThis.__reading.renders.push([file.path, page, !!doc]); return { dataUrl: `data:image/png;base64,PAGE${page}` }; };',
	'../context/cache': `export const providerCacheKey = async (_plugin, ...parts) => JSON.stringify(parts);
		export const getCache = () => ({ getOrCompute: async (key, compute) => { const cache = globalThis.__reading.cache; if (cache.has(key)) return cache.get(key); const result = await compute(); cache.set(key, result); return result; } });`,
	'../ui/sidebar-view': 'export const getOrCreateAISidebar = async () => globalThis.__reading.sidebar;',
	'../ui/progress': 'export class AIProgressModal { constructor(_plugin, _title, cancel) { globalThis.__reading.cancel = cancel; } open() {} setStatus() {} forceClose() {} }',
	'./auto-annotate': 'export const categoryColorName = () => "note"; export const selectionSubpath = loc => `#page=${loc.page}&selection=${loc.beginIndex},${loc.beginOffset},${loc.endIndex},${loc.endOffset}&color=note`;',
};
const result = await build({
	entryPoints: [resolve('src/ai/features/full-reading.ts')], bundle: true, write: false, platform: 'node', format: 'esm',
	plugins: [{ name: 'reading-test-host', setup(b) {
		b.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'reading-mock' } : undefined);
		b.onLoad({ filter: /.*/, namespace: 'reading-mock' }, args => ({ contents: mocks[args.path] }));
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
		b.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: `
			export class Notice {} export class Setting {}
			export class Component { callbacks=[]; register(callback) { this.callbacks.push(callback); } }
			export const requestUrl = options => globalThis.__reading.request(options);
		` }));
	} }],
});
const { fullReadingAction } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const pages = [1, 2].map(page => ({ pageNumber: page, text: `Page ${page} has an important method.`, items: [{ str: `Page ${page} has an important method.` }] }));
const notes = new Map();
const state = {
	extracted: { fileKey: 'p.pdf:10:1', pages, outline: [], fullText: pages.map(p => `p.${p.pageNumber}:\n${p.text}`).join('\n\n') },
	cache: new Map(), requests: [], renders: [], cancelVision: false,
	sidebar: { addBlock: () => ({ setLoading() {}, async setMarkdown() {}, setDone() {}, setError(message) { throw new Error(message); } }), updateFooter() {} },
	async request(options) {
		const body = JSON.parse(options.body);
		this.requests.push(body);
		const vision = Array.isArray(body.messages[1].content);
		const user = vision ? body.messages[1].content[0].text : body.messages[1].content;
		const page = Number(user.match(/CURRENT PAGE p\.(\d+)/)[1]);
		const content = vision ? { visuals: [
			{ kind: 'figure', title: `Figure on p.${page}`, captionQuote: '', explanation: 'The arrows show how inputs become outputs.', bbox: [0.1, 0.2, 0.9, 0.8] },
			{ kind: 'table', title: `Table on p.${page}`, explanation: 'Compare accuracy on the same dataset.' },
			{ kind: 'formula', title: `Equation on p.${page}`, explanation: 'x is the input and y is the output.', latex: 'y=2x' },
		] } : { sections: [], annotations: [
			{ quote: `Page ${page} has an important method.`, category: 'method', explanation: 'This sentence introduces a method.\n\nA method tells us how the task is performed.' },
			{ quote: 'Invented content that is absent from the page.', category: 'method', explanation: 'This must not become an anchored quote.' },
		] };
		if (vision && this.cancelVision) { this.cancelVision = false; this.cancel(); }
		return { status: 200, json: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } } };
	},
};
globalThis.__reading = state;
const file = { path: 'p.pdf', basename: 'p', parent: { path: '/' } };
const doc = { async getPage() { return { getViewport: () => ({ width: 100, height: 200, convertToPdfPoint: (x, y) => [x, 200 - y] }) }; }, async destroy() {} };
const plugin = {
	settings: { ai: { aiEnabled: true, consentGiven: true, outputLanguage: 'zh', chatProvider: 'glm-cn', glm: { apiKey: 'test-key', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', chatModel: 'glm-5.3', visionModel: 'glm-5.3' } }, calloutType: 'PDF' },
	ai: { assertBudget() {}, hasConsent: () => true, recordUsage() {} },
	lib: { getPDFView: () => ({ file }), loadPDFDocument: async () => doc,
		generateMarkdownLink: (_file, _source, subpath, alias) => `![[p.pdf${subpath}|${alias}]]` },
	app: { vault: { getAbstractFileByPath: path => notes.has(path) ? {} : null, create: async (path, text) => notes.set(path, text) }, workspace: { async openLinkText() {} } },
	addChild: child => child, removeChild: child => child.callbacks.forEach(callback => callback()),
};
await fullReadingAction(plugin);
assert.equal(state.requests.length, 4); // Both text and vision on EVERY page.
assert.deepEqual(state.requests.map(r => r.model), ['glm-5.3', 'glm-5.3-flash', 'glm-5.3', 'glm-5.3-flash']);
for (const body of state.requests.filter(r => r.model === 'glm-5.3')) assert.equal(typeof body.messages[1].content, 'string');
assert.deepEqual(state.renders, [['p.pdf', 1, true], ['p.pdf', 2, true]]);
const complete = notes.get('p.reading.md');
assert.match(complete, /complete: true/);
assert.equal((complete.match(/\[!PDF\|note\]/g) ?? []).length, 8);
assert.ok(!complete.includes('Invented content'));
assert.ok(complete.includes('rect=10,40,90,160'));
await fullReadingAction(plugin);
assert.equal(state.requests.length, 4); // Completed pages resume entirely from cache.
assert.ok(notes.has('p.reading-2.md'));

state.cache.clear(); state.cancelVision = true;
await fullReadingAction(plugin);
const partial = notes.get('p.reading-3.md');
assert.match(partial, /complete: false/);
assert.match(partial, /p\.2：正文 未处理/);
const beforeResume = state.requests.length;
await fullReadingAction(plugin);
assert.equal(state.requests.length - beforeResume, 3); // Page 1 text checkpoint survived cancellation.
assert.match(notes.get('p.reading-4.md'), /complete: true/);
console.log('Full-reading action: all pages, model routing, exact quotes, visual anchors, cancellation and cache resume passed.');
delete globalThis.__reading;
