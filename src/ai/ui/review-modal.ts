// F5 review modal: lists proposed annotations with checkboxes (grouped by located/unmatched),
// shows category colors, and reports unmatched quotes. Nothing is written until the user approves.

import PDFPlus from 'main';
import { PDFPlusModal } from 'modals';
import { Located } from '../features/quote-locator';
import { AnnotationCategory } from '../settings';

export interface AnnotationProposal {
    quote: string;
    category: AnnotationCategory;
    comment: string;
    located: Located | null;
}

export class AutoAnnotationReviewModal extends PDFPlusModal {
    private checks: HTMLInputElement[] = [];

    constructor(plugin: PDFPlus, private proposals: AnnotationProposal[], private onApprove: (approved: AnnotationProposal[]) => void) {
        super(plugin);
        this.titleEl.setText('PDF++ AI — Review annotations');
    }

    onOpen() {
        super.onOpen();
        const { contentEl } = this;

        const located = this.proposals.filter((p) => p.located);
        const unmatched = this.proposals.filter((p) => !p.located);

        contentEl.createEl('p', { text: `${located.length} of ${this.proposals.length} quotes were located in the PDF. Select which to write.` });

        const list = contentEl.createDiv('pdf-plus-ai-review-list');
        this.checks = [];

        const render = (p: AnnotationProposal) => {
            const row = list.createDiv('pdf-plus-ai-review-row');
            const check = row.createEl('input', { type: 'checkbox' });
            check.checked = !!p.located;
            if (!p.located) check.disabled = true;
            this.checks.push(check);

            const body = row.createDiv('pdf-plus-ai-review-body');
            const color = this.plugin.settings.ai.annotation.categoryColors[p.category] ?? 'yellow';
            body.createEl('span', { cls: 'pdf-plus-ai-cat', attr: { 'data-cat': p.category }, text: p.category });
            body.createEl('blockquote', { text: p.quote, cls: 'pdf-plus-ai-quote' });
            // Show what was actually anchored in the PDF so the reviewer can verify the model's
            // quote matches real text (guards against silent prefix-fallback mismatches).
            if (p.located) {
                body.createEl('div', { cls: 'pdf-plus-ai-matched', text: `In PDF: “${p.located.matchedText}”` });
                if (p.located.fuzzy) {
                    body.createEl('div', { text: '⚠ fuzzy match — only the opening of this quote was located; verify before writing.', cls: 'pdf-plus-ai-warn' });
                }
            }
            if (p.comment) body.createEl('em', { text: p.comment, cls: 'pdf-plus-ai-muted' });
            if (!p.located) body.createEl('div', { text: '⚠ not located — skipped', cls: 'pdf-plus-ai-warn' });

            // color dot
            row.style.setProperty('--pdf-plus-ai-cat-color', `var(--pdf-plus-${color}-rgb, var(--pdf-plus-default-color-rgb))`);
        };

        located.forEach(render);
        if (unmatched.length) {
            list.createEl('h4', { text: 'Unmatched (will not be written)' });
            unmatched.forEach(render);
        }

        const footer = contentEl.createDiv({ cls: 'pdf-plus-ai-modal-footer' });
        const approve = footer.createEl('button', { cls: 'mod-cta', text: `Write ${located.length} annotations` });
        approve.onclick = () => {
            const approved = this.proposals.filter((_, i) => this.checks[i].checked);
            this.close();
            this.onApprove(approved);
        };
        const cancel = footer.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }
}
