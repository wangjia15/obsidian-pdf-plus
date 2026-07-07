// Simple cancellable progress modal for long AI tasks (F3 podcast, F2 batch).
// Shows a status line + progress bar + cancel button. resolve()/reject() driven by the task.

import { Modal } from 'obsidian';
import PDFPlus from 'main';

export class AIProgressModal extends Modal {
    private statusEl: HTMLElement;
    private barEl: HTMLElement;
    private cancelBtn: HTMLButtonElement;
    private done = false;

    constructor(plugin: PDFPlus, private title: string, private onCancel: () => void) {
        super(plugin.app);
    }

    onOpen() {
        this.titleEl.setText(this.title);
        this.statusEl = this.contentEl.createDiv('pdf-plus-ai-progress-status');
        this.barEl = this.contentEl.createDiv('pdf-plus-ai-progress-bar').createDiv('pdf-plus-ai-progress-fill');
        this.barEl.style.width = '0%';
        const footer = this.contentEl.createDiv('pdf-plus-ai-modal-footer');
        this.cancelBtn = footer.createEl('button', { cls: 'mod-warning', text: 'Cancel' });
        this.cancelBtn.onclick = () => { if (!this.done) { this.onCancel(); } };
    }

    setStatus(text: string, fraction?: number) {
        if (this.done) return;
        this.statusEl.setText(text);
        if (typeof fraction === 'number') this.barEl.style.width = `${Math.round(fraction * 100)}%`;
    }

    closeWith(message: string) {
        this.done = true;
        this.statusEl.setText(message);
        this.barEl.style.width = '100%';
        this.cancelBtn.setText('Close');
        this.cancelBtn.onclick = () => this.close();
    }

    forceClose() { this.done = true; this.close(); }
}
