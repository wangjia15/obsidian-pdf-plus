// AIManager: lifecycle + feature-flag + budget + consent for the AI module.
// Always instantiated as a Component child of the plugin (lightweight). Its activate()/deactivate()
// register/unregister the AI view, commands, and menu items so the master toggle works live
// without a plugin reload. With `aiEnabled=false`, nothing is registered and the plugin behaves
// exactly as without AI.

import { Component, Notice } from 'obsidian';
import PDFPlus from 'main';
import { currentPeriodKey } from './settings';
import { MiniMaxChatClient } from './provider/minimax-chat';
import { getSharedChatClient } from './provider/minimax-chat';
import { AIError } from './provider/types';
import { registerAIUI } from './ui';
import { registerAIView, getOrCreateAISidebar, closeAISidebars } from './ui/sidebar-view';
import { registerAICommands } from './features/commands';
import { registerAIContextMenu } from './ui/context-menu';
import { registerRectHook, CroppedRect } from './features/rect-hook';
import { clearRegionMarker } from './features/region-marker';

export class AIManager extends Component {
    plugin: PDFPlus;
    /** Inner component holding everything that exists only while AI is active. */
    private active: Component | null = null;
    private chatClient: MiniMaxChatClient;

    /** The most recent rectangular crop the user made via PDF++'s box-select, captured by
     *  the rect hook. Consumed by the "Analyze last cropped region" command. */
    lastCroppedRect: CroppedRect | null = null;

    constructor(plugin: PDFPlus) {
        super();
        this.plugin = plugin;
        this.chatClient = getSharedChatClient(plugin);
    }

    get settings() { return this.plugin.settings.ai; }
    get chat() { return this.chatClient; }

    onload() {
        // Register the view type, commands, and the context-menu patch once for the plugin's
        // lifetime. Commands notice if AI is disabled; the sidebar only opens when active.
        registerAIView(this.plugin);
        registerAICommands(this.plugin);
        registerAIContextMenu(this.plugin);
        registerRectHook(this.plugin);

        if (this.settings.aiEnabled) this.activate();
    }

    /** Register the AI view, commands, and menu items. Idempotent. */
    activate() {
        if (this.active) return;
        this.active = new Component();
        this.addChild(this.active);
        // Per-activate UI contributed by feature modules via addAIRegistration().
        registerAIUI(this, this.active);
        // Reveal the sidebar (non-fatal if it can't be created).
        getOrCreateAISidebar(this.plugin, true).catch(() => { /* ignore */ });
    }

    /** Unregister everything registered by activate(). Idempotent. */
    deactivate() {
        if (!this.active) return;
        this.removeChild(this.active);
        this.active = null;
        closeAISidebars(this.plugin);
        clearRegionMarker();
    }

    /** Toggle live, called by the settings master switch. */
    setActive(enabled: boolean) {
        if (enabled) this.activate(); else this.deactivate();
    }

    // --- Budget + consent gates (used by every feature before an API call) ---

    /** Throws AIError(budget) when the monthly budget is exceeded. */
    assertBudget() {
        const ai = this.settings;
        if (!ai.monthlyTokenBudget) return;
        const usage = ai.tokenUsage ?? { periodKey: currentPeriodKey(), tokens: 0 };
        if (usage.periodKey !== currentPeriodKey()) {
            // window rolled over
            ai.tokenUsage = { periodKey: currentPeriodKey(), tokens: 0 };
            this.plugin.saveSettings();
        }
        if (ai.tokenUsage!.tokens >= ai.monthlyTokenBudget) {
            throw new AIError('budget', `Monthly token budget reached (${ai.tokenUsage!.tokens}/${ai.monthlyTokenBudget}).`, { retryable: false });
        }
    }

    /** Returns false (and notices) if consent has not been given. */
    hasConsent(): boolean {
        if (!this.settings.consentGiven) {
            new Notice('PDF++ AI: privacy consent required. Open Settings > PDF++ > AI (MiniMax).', 6000);
            return false;
        }
        return true;
    }

    /** Accumulate token spend into the monthly counter; persists asynchronously. */
    recordUsage(tokens: number) {
        if (!tokens) return;
        const ai = this.settings;
        if (!ai.tokenUsage || ai.tokenUsage.periodKey !== currentPeriodKey()) {
            ai.tokenUsage = { periodKey: currentPeriodKey(), tokens: 0 };
        }
        ai.tokenUsage.tokens += tokens;
        // fire-and-forget persist (debouncing is fine; saveSettings is cheap and deduped by Obsidian)
        this.plugin.saveSettings();
    }

    /** Shared cache directory under the vault: <vault>/.pdf-plus-ai/ */
    get aiDir() { return '.pdf-plus-ai'; }
    get cacheDir() { return `${this.aiDir}/cache`; }
}
