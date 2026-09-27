import { ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import PDFPlus from 'main';
import { ChatStreamHandle, normalizeError } from '../provider/types';
import { getAutoAnnotationTarget } from '../features/annotation-target';
import { extractPDFText } from '../context/extractor';
import { summarizePaperPrompt, explainPrompt, summarizeSelectionPrompt, translatePrompt, askPrompt } from '../prompts/summarize';
import { fullReadingTextSystem, fullReadingVisualSystem } from '../prompts/full-reading';
import { autoAnnotateSystem, autoAnnotateUser } from '../prompts/auto-annotate';
import { figureAnalysisSystem, figureAnalysisUser, pageFiguresSystem, pageFiguresUser } from '../prompts/figure';
import { podcastSystem, podcastUser } from '../prompts/podcast';
import { outlineSystem } from '../prompts/knowledge-map';
import { resolveOutputLanguage, type OutputLanguage } from '../prompts/shared';

interface PromptTemplate { label: string; build: (lang: OutputLanguage) => { system: string; user: string } }

/** Every built-in prompt, so the editor can show and tweak any of them. `user` is the instruction preamble (source text excluded). */
const PROMPT_TEMPLATES: Record<string, PromptTemplate> = {
	paper: { label: '论文总结', build: (lang) => summarizePaperPrompt('', lang) },
	explain: { label: '解释文本', build: (lang) => explainPrompt('', lang) },
	summary: { label: '段落总结', build: (lang) => summarizeSelectionPrompt('', lang) },
	translate: { label: '翻译', build: (lang) => translatePrompt('', lang) },
	ask: { label: '提问', build: (lang) => askPrompt('', '', lang) },
	'auto-annotate': { label: '自动标注', build: (lang) => ({ system: autoAnnotateSystem(lang), user: autoAnnotateUser() }) },
	'full-reading-text': { label: '全文精读 · 正文', build: (lang) => ({ system: fullReadingTextSystem(lang), user: 'CURRENT PAGE p.1:\n' }) },
	'full-reading-visual': { label: '全文精读 · 图表公式', build: (lang) => ({ system: fullReadingVisualSystem(lang), user: 'CURRENT PAGE p.1. Inventory and explain every visible image, table and displayed formula. Page text for context only:\n' }) },
	figure: { label: '图表分析（选区）', build: (lang) => ({ system: figureAnalysisSystem(lang), user: figureAnalysisUser() }) },
	'page-figures': { label: '整页图表清点', build: (lang) => ({ system: pageFiguresSystem(lang), user: pageFiguresUser(1) }) },
	'podcast-narrator': { label: '播客 · 单人', build: (lang) => ({ system: podcastSystem('narrator', 5, resolveOutputLanguage(lang, '')), user: podcastUser() }) },
	'podcast-dialogue': { label: '播客 · 对话', build: (lang) => ({ system: podcastSystem('dialogue', 5, resolveOutputLanguage(lang, '')), user: podcastUser() }) },
	'knowledge-map': { label: '知识地图', build: (lang) => ({ system: outlineSystem(lang), user: '' }) },
};

/** Grow a textarea to fit its content, capped so the modal stays usable. */
function fitHeight(el: HTMLTextAreaElement, maxVh: number) {
	el.style.height = 'auto';
	el.style.height = `${Math.min(el.scrollHeight + 2, el.win.innerHeight * maxVh / 100)}px`;
}

/** Standalone editor. Drafts persist only on Save; source text is never sent on open. */
export class PromptEditorModal extends Modal {
	private handle?: ChatStreamHandle;
	private closed = false;
	private loading = false;

	constructor(private plugin: PDFPlus) { super(plugin.app); }

	onOpen() {
		this.closed = false;
		this.titleEl.setText('AI Prompt 编辑器');
		this.modalEl.addClass('pdf-plus-prompt-editor');
		const draft = this.plugin.settings.ai.promptEditor;
		const system = this.contentEl.createEl('textarea', { attr: { 'aria-label': 'System prompt', placeholder: 'System prompt' } });
		system.value = draft.system;
		const user = this.contentEl.createEl('textarea', { attr: { 'aria-label': 'User prompt', placeholder: '输入问题或粘贴 PDF 文本' } });
		user.value = draft.user;
		const refit = () => { fitHeight(system, 45); fitHeight(user, 30); };
		system.addEventListener('input', () => fitHeight(system, 45));
		user.addEventListener('input', () => fitHeight(user, 30));
		const options: Record<string, string> = { custom: '自定义 / 已保存' };
		for (const [id, t] of Object.entries(PROMPT_TEMPLATES)) options[id] = t.label;
		new Setting(this.contentEl).setName('提示词模板').addDropdown((d) => d.addOptions(options).onChange((v) => {
			const template = PROMPT_TEMPLATES[v];
			if (!template) { system.value = draft.system; user.value = draft.user; refit(); return; }
			const prompt = template.build(this.plugin.settings.ai.outputLanguage);
			system.value = prompt.system;
			// Keep any source/question already typed; only seed the user preamble when empty.
			if (!user.value.trim()) user.value = prompt.user;
			refit();
		}));
		// Place the textareas after the selector and size them once they are in the DOM.
		this.contentEl.append(system, user);
		activeWindow.requestAnimationFrame(refit);
		const status = this.contentEl.createDiv({ cls: 'pdf-plus-prompt-status', text: '就绪', attr: { role: 'status' } });
		const output = this.contentEl.createEl('pre', { cls: 'pdf-plus-prompt-output', attr: { 'aria-label': 'AI 输出' } });
		let run: ButtonComponent;
		let stop: ButtonComponent;
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('载入当前 PDF 文本').onClick(async () => {
				const file = getAutoAnnotationTarget(this.plugin)?.file;
				if (!file) { new Notice('请先打开 PDF。'); return; }
				b.setDisabled(true);
				this.loading = true;
				run.setDisabled(true);
				try {
					const text = await extractPDFText(this.plugin, file);
					if (!this.closed) { user.value = `${user.value}\n\n${text.fullText}`.trim(); fitHeight(user, 30); }
				} catch (e) { if (!this.closed) status.setText(normalizeError(e).message); }
				finally { this.loading = false; b.setDisabled(false); run.setDisabled(!!this.handle); }
			}))
			.addButton((b) => b.setButtonText('保存提示词').onClick(async () => {
				try {
					this.plugin.settings.ai.promptEditor = { system: system.value, user: user.value };
					await this.plugin.saveSettings();
					Object.assign(draft, this.plugin.settings.ai.promptEditor);
					new Notice('提示词已保存。');
				} catch (e) { status.setText(normalizeError(e).message); }
			}))
			.addButton((b) => { run = b; b.setButtonText('调用 AI').setCta().onClick(async () => {
				if (this.handle || this.loading) return;
				if (!this.plugin.settings.ai.aiEnabled) { new Notice('请先启用 AI 模块。'); return; }
				if (!user.value.trim()) { new Notice('请输入 User prompt。'); return; }
				if (!this.plugin.ai.hasConsent()) return;
				run.setDisabled(true);
				stop.setDisabled(false);
				output.setText('');
				status.setText('生成中…');
				let text = '';
				try {
					this.handle = this.plugin.ai.chat.chatStream({ messages: [
						{ role: 'system', content: system.value }, { role: 'user', content: user.value },
					], thinking: 'adaptive' }, (delta) => {
						if (this.closed) return;
						text += delta;
						output.setText(text);
						output.scrollTop = output.scrollHeight;
					});
					const result = await this.handle.done;
					if (!this.closed) { output.setText(result.text); status.setText(`完成 · ${result.usage.totalTokens} tokens`); }
				} catch (e) { if (!this.closed) status.setText(normalizeError(e).message); }
				finally { this.handle = undefined; run.setDisabled(this.loading); stop.setDisabled(true); }
			}); })
			.addButton((b) => { stop = b; b.setButtonText('停止').setDisabled(true).onClick(() => { this.handle?.cancel(); status.setText('正在停止…'); }); });
		this.plugin.register(() => this.close());
	}

	onClose() {
		this.closed = true;
		this.handle?.cancel();
		this.contentEl.empty();
	}
}
