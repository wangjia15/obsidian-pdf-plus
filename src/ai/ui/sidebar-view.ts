// "PDF++ AI" right-sidebar ItemView. Holds the running list of OutputBlocks, a Summarize
// toolbar, and an Ask-AI input. Feature modules obtain the active view via getOrCreateAISidebar().

import { ItemView, Menu, setIcon, WorkspaceLeaf } from 'obsidian';
import PDFPlus from 'main';
import { OutputBlock, OutputBlockMeta } from './output-block';
import { AI_COMMANDS, AI_GROUP_LABEL, AI_GROUP_ORDER, executeAICommand } from '../features/commands';
// summarize actions are imported lazily (dynamic import) to avoid a static circular import
// (features/summarize imports this module to push output blocks).

export const VIEW_TYPE_PDF_PLUS_AI = 'pdf-plus-ai';

let viewRegistered = false;

/** Register the view type once (idempotent). Called from AIManager.onload(). */
export function registerAIView(plugin: PDFPlus) {
    if (viewRegistered) return;
    viewRegistered = true;
    plugin.registerView(VIEW_TYPE_PDF_PLUS_AI, (leaf) => new PAISidebarView(leaf, plugin));
}

/** Find an existing AI sidebar leaf, or create one in the right sidebar. */
export async function getOrCreateAISidebar(plugin: PDFPlus, reveal = true): Promise<PAISidebarView | null> {
    if (!plugin.settings.ai.aiEnabled) return null;
    let leaf: WorkspaceLeaf | null = null;
    const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_PLUS_AI);
    if (existing.length) leaf = existing[0];
    if (!leaf) {
        leaf = plugin.app.workspace.getRightLeaf(false);
        if (!leaf) return null;
        await leaf.setViewState({ type: VIEW_TYPE_PDF_PLUS_AI, active: true });
    }
    if (reveal) plugin.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof PAISidebarView ? leaf.view : null;
}

/** Detach all open AI sidebar leaves (used when the master switch turns AI off). */
export function closeAISidebars(plugin: PDFPlus) {
    for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_PLUS_AI)) {
        leaf.detach();
    }
}

export class PAISidebarView extends ItemView {
    plugin: PDFPlus;
    private listEl: HTMLElement;
    private askInputEl: HTMLTextAreaElement;
    private footerEl: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: PDFPlus) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_PDF_PLUS_AI; }
    getDisplayText() { return 'PDF++ AI'; }
    getIcon() { return 'lucide-sparkles'; }

    async onOpen() {
        const c = this.contentEl;
        c.empty();
        c.addClass('pdf-plus-ai-sidebar');

        // Toolbar
        const toolbar = c.createDiv('pdf-plus-ai-toolbar');
        // Grouped dropdown mirroring the command palette — every AI command reachable from the sidebar.
        const cmdsBtn = toolbar.createEl('button', { cls: 'pdf-plus-ai-btn pdf-plus-ai-cmds-btn' });
        setIcon(cmdsBtn, 'lucide-sparkles');
        cmdsBtn.createSpan({ text: 'AI 命令' });
        this.registerDomEvent(cmdsBtn, 'click', (evt) => this.showCommandsMenu(evt));
        const summarizeBtn = toolbar.createEl('button', { cls: 'pdf-plus-ai-btn pdf-plus-ai-btn-primary', text: 'Summarize paper' });
        this.registerDomEvent(summarizeBtn, 'click', () => {
            import('../features/summarize').then((m) => m.summarizePaperAction(this.plugin)).catch((e) => console.error(e));
        });

        const clearBtn = toolbar.createEl('button', { cls: 'pdf-plus-ai-btn', text: 'Clear' });
        this.registerDomEvent(clearBtn, 'click', () => this.listEl.empty());

        // Output list
        this.listEl = c.createDiv('pdf-plus-ai-list');

        // Ask box
        const askWrap = c.createDiv('pdf-plus-ai-ask');
        this.askInputEl = askWrap.createEl('textarea', { cls: 'pdf-plus-ai-ask-input', attr: { placeholder: 'Ask AI about the current selection or paper…', rows: '2' } });
        const sendBtn = askWrap.createEl('button', { cls: 'pdf-plus-ai-btn pdf-plus-ai-btn-primary', text: 'Ask' });
        this.registerDomEvent(sendBtn, 'click', () => this.sendAsk());
        this.registerDomEvent(this.askInputEl, 'keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.sendAsk(); }
        });

        // Footer (token usage)
        this.footerEl = c.createDiv('pdf-plus-ai-footer pdf-plus-ai-muted');
        this.updateFooter();
    }

    /** Build the grouped "AI Commands" dropdown. Each entry runs the same command the
     *  palette registers (via executeAICommand), so the two surfaces never drift. */
    private showCommandsMenu(evt: MouseEvent) {
        const menu = new Menu().addSections(AI_GROUP_ORDER);
        for (const group of AI_GROUP_ORDER) {
            const defs = AI_COMMANDS.filter((d) => d.group === group && !d.hideInSidebar);
            if (!defs.length) continue;
            menu.addItem((item) => item.setSection(group).setIsLabel(true).setTitle(AI_GROUP_LABEL[group]));
            for (const def of defs) {
                menu.addItem((item) => {
                    item.setSection(group).setTitle(def.label);
                    if (def.icon) item.setIcon(def.icon);
                    item.onClick(() => executeAICommand(this.plugin, def.suffix));
                });
            }
        }
        menu.showAtMouseEvent(evt);
    }

    async onClose() {
        // Stop any in-flight TTS playback when the sidebar closes.
        import('../audio/speak').then((m) => m.stopSpeaking(this.plugin)).catch(() => { /* ignore */ });
    }

    /** Push a new output block onto the list and return it for streaming. */
    addBlock(meta: OutputBlockMeta): OutputBlock {
        const block = new OutputBlock(this.plugin, this.listEl, meta);
        this.listEl.insertBefore(block.containerEl, this.listEl.firstChild); // newest on top
        block.register(() => block.containerEl.remove());
        this.addChild(block);
        return block;
    }

    updateFooter() {
        const ai = this.plugin.settings.ai;
        const used = ai.tokenUsage?.tokens ?? 0;
        const budget = ai.monthlyTokenBudget;
        this.footerEl.setText(budget ? `Tokens this month: ${used.toLocaleString()} / ${budget.toLocaleString()}` : `Tokens this month: ${used.toLocaleString()} (unlimited)`);
    }

    /** The active PDF file this view is associated with (for link resolution). */
    currentPDFFilename(): string | null {
        const view = this.plugin.lib.getPDFView();
        return view?.file?.path ?? null;
    }

    private async sendAsk() {
        const q = this.askInputEl.value.trim();
        if (!q) return;
        this.askInputEl.value = '';
        const { askSelectionAction } = await import('../features/summarize');
        await askSelectionAction(this.plugin, q);
    }
}
