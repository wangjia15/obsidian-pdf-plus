// F6 references panel: a sortable modal list of enriched bibliography entries with
// "open DOI" and "copy BibTeX" actions. Sortable by citation count / year / title.

import { Notice } from 'obsidian';
import PDFPlus from 'main';
import { PDFPlusModal } from 'modals';
import { EnrichedReference } from '../features/citations';

type SortKey = 'citationCount' | 'year' | 'title';

export class ReferencesPanelModal extends PDFPlusModal {
    private sortKey: SortKey = 'citationCount';
    private rowsEl: HTMLElement;

    constructor(plugin: PDFPlus, private refs: EnrichedReference[]) {
        super(plugin);
        this.titleEl.setText(`PDF++ AI — References (${refs.length})`);
    }

    onOpen() {
        super.onOpen();
        const { contentEl } = this;

        const resolved = this.refs.filter((r) => r.citationCount !== null).length;
        contentEl.createEl('p', { cls: 'pdf-plus-ai-muted', text: `${resolved} of ${this.refs.length} references resolved with citation data.` });

        const toolbar = contentEl.createDiv('pdf-plus-ai-ref-toolbar');
        const mkSort = (label: string, key: SortKey) => {
            const b = toolbar.createEl('button', { cls: 'pdf-plus-ai-btn', text: label });
            b.onclick = () => { this.sortKey = key; this.renderRows(); };
        };
        mkSort('Sort: citations', 'citationCount');
        mkSort('Sort: year', 'year');
        mkSort('Sort: title', 'title');

        this.rowsEl = contentEl.createDiv('pdf-plus-ai-ref-list');
        this.renderRows();
    }

    private renderRows() {
        this.rowsEl.empty();
        const sorted = [...this.refs].sort((a, b) => {
            if (this.sortKey === 'title') return a.title.localeCompare(b.title);
            if (this.sortKey === 'year') return (Number(b.year) || 0) - (Number(a.year) || 0);
            return (b.citationCount ?? -1) - (a.citationCount ?? -1);
        });

        for (const r of sorted) {
            const row = this.rowsEl.createDiv('pdf-plus-ai-ref-row');
            const main = row.createDiv('pdf-plus-ai-ref-main');
            main.createEl('div', { cls: 'pdf-plus-ai-ref-title', text: r.title || '(untitled)' });
            const meta = main.createEl('div', { cls: 'pdf-plus-ai-ref-meta pdf-plus-ai-muted' });
            const bits = [r.authors, r.year, r.venue].filter(Boolean);
            meta.setText(bits.join(' · '));

            const side = row.createDiv('pdf-plus-ai-ref-side');
            if (r.citationCount !== null) side.createEl('span', { cls: 'pdf-plus-ai-cite-badge', text: ` ${r.citationCount} ` });
            side.createEl('span', { cls: 'pdf-plus-ai-ref-src', text: r.source });

            const actions = row.createDiv('pdf-plus-ai-ref-actions');
            if (r.doi) {
                const doiBtn = actions.createEl('button', { cls: 'pdf-plus-ai-btn', text: 'DOI' });
                doiBtn.onclick = () => window.open(`https://doi.org/${r.doi}`, '_blank');
            }
            if (r.oaUrl) {
                const oaBtn = actions.createEl('button', { cls: 'pdf-plus-ai-btn', text: 'PDF' });
                oaBtn.onclick = () => window.open(r.oaUrl!, '_blank');
            }
            const bibBtn = actions.createEl('button', { cls: 'pdf-plus-ai-btn', text: 'BibTeX' });
            bibBtn.onclick = () => { navigator.clipboard.writeText(r.bibtex); new Notice('BibTeX copied.', 1500); };
        }
    }
}
