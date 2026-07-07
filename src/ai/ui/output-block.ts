// An AI output block: rendered Markdown + Copy / Insert / Speak / Save buttons.
// Lives inside the PDF++ AI sidebar. Markdown is rendered with MarkdownRenderer, so
// [[wikilinks]] inside AI output work when inserted into notes.

import { Component, MarkdownRenderer, MarkdownView, Notice } from 'obsidian';
import PDFPlus from 'main';
import { speakText } from '../audio/speak';

export interface OutputBlockMeta {
    action: string;          // e.g. "Summarize paper"
    sourcePath?: string;     // the PDF the action ran on (for link resolution)
    tokens?: number;         // cost of this block
}

export class OutputBlock extends Component {
    containerEl: HTMLElement;
    private bodyEl: HTMLElement;
    private footerEl: HTMLElement;
    private metaEl: HTMLElement;
    meta: OutputBlockMeta;
    private rawText = '';
    private status: 'streaming' | 'done' | 'error' = 'streaming';

    /** Speak callback (defaults to MiniMax TTS with obsidian-tts fallback). */
    speak: (text: string) => void = (text) => { speakText(this.plugin, text); };

    constructor(private plugin: PDFPlus, parent: HTMLElement, meta: OutputBlockMeta) {
        super();
        this.meta = meta;
        this.containerEl = parent.createDiv('pdf-plus-ai-block');
        this.bodyEl = this.containerEl.createDiv('pdf-plus-ai-block-body');
        this.metaEl = this.containerEl.createDiv('pdf-plus-ai-block-meta');
        this.footerEl = this.containerEl.createDiv('pdf-plus-ai-block-footer');
        this.renderMeta();
        this.renderFooter();
        this.setLoading();
    }

    private renderMeta() {
        this.metaEl.empty();
        const time = new Date().toLocaleTimeString();
        this.metaEl.createSpan({ text: this.meta.action });
        this.metaEl.createSpan({ text: ` · ${time}`, cls: 'pdf-plus-ai-muted' });
        if (this.meta.tokens) this.metaEl.createSpan({ text: ` · ${this.meta.tokens} tok`, cls: 'pdf-plus-ai-muted' });
    }

    private renderFooter() {
        this.footerEl.empty();
        const mk = (icon: string, label: string, fn: () => void) => {
            const b = this.footerEl.createEl('button', { cls: 'pdf-plus-ai-btn' });
            b.setText(label);
            this.registerDomEvent(b, 'click', fn);
            return b;
        };
        mk('copy', 'Copy', () => { navigator.clipboard.writeText(this.rawText); new Notice('Copied.', 1500); });
        mk('insert', 'Insert', () => this.insertIntoNote());
        mk('speak', 'Speak', () => { if (this.speak) this.speak(this.rawText); else new Notice('PDF++ AI: voice output not ready yet.', 3000); });
        mk('save', 'Save', () => this.saveToVault());
    }

    setLoading(text = 'Thinking…') {
        this.status = 'streaming';
        this.bodyEl.empty();
        this.bodyEl.createDiv({ cls: 'pdf-plus-ai-spinner', text });
        this.containerEl.addClass('is-streaming');
    }

    /** Render markdown (called repeatedly during streaming and once at the end). */
    async setMarkdown(md: string) {
        this.rawText = md;
        this.bodyEl.empty();
        await MarkdownRenderer.render(this.plugin.app, md, this.bodyEl, this.meta.sourcePath ?? '', this);
    }

    /** Stream-friendly: append a delta and re-render. */
    async appendDelta(delta: string, full: string) {
        this.rawText = full;
        // Re-rendering markdown on every delta is expensive; throttle by only re-rendering
        // at most ~8/sec. For simplicity we render the full accumulated text each call;
        // callers may instead call setMarkdown once on completion.
        this.bodyEl.empty();
        this.bodyEl.setText(full);
        if (delta === '\n') { /* no-op */ }
    }

    setDone() {
        this.status = 'done';
        this.containerEl.removeClass('is-streaming');
        // Final markdown render (turns raw text into rendered MD with links).
        MarkdownRenderer.render(this.plugin.app, this.rawText, this.bodyEl, this.meta.sourcePath ?? '', this);
    }

    setError(message: string) {
        this.status = 'error';
        this.containerEl.removeClass('is-streaming');
        this.containerEl.addClass('is-error');
        this.bodyEl.empty();
        this.bodyEl.createDiv({ cls: 'pdf-plus-ai-error', text: message });
    }

    private insertIntoNote() {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) { new Notice('PDF++ AI: open a Markdown note to insert into.', 3000); return; }
        const editor = view.editor;
        editor.replaceSelection(editor.getSelection() ? `\n\n${this.rawText}\n` : `${this.rawText}\n`);
        new Notice('Inserted.', 1500);
    }

    private async saveToVault() {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        const dir = view?.file?.parent?.path ?? '';
        const base = `pdf-plus-ai-${Date.now()}`;
        const path = `${dir ? dir + '/' : ''}${base}.md`;
        const file = await this.plugin.lib.write(path, this.rawText, false);
        if (file) new Notice(`Saved to ${path}.`, 3000);
    }
}
