// AI settings slice + settings-tab section builder.
// All fields live under `plugin.settings.ai`. Defaults are injected in settings.ts's
// DEFAULT_SETTINGS; migration is "absence of the block = feature off".

import { Notice, Setting } from 'obsidian';
import PDFPlus from 'main';
import type { PDFPlusSettingTab } from 'settings';

/** Annotation categories produced by F5 (auto-annotate). Shared with features/auto-annotate. */
export type AnnotationCategory =
    | 'research-question'
    | 'method'
    | 'key-result'
    | 'limitation'
    | 'contribution'
    | 'definition';

export const ANNOTATION_CATEGORIES: AnnotationCategory[] = [
    'research-question', 'method', 'key-result', 'limitation', 'contribution', 'definition',
];

export interface AISettings {
    /** Master switch (default false). When off, the plugin behaves exactly as without AI. */
    aiEnabled: boolean;
    /** First-run privacy consent: "selected text/images will be sent to MiniMax". */
    consentGiven: boolean;

    minimax: {
        baseUrl: string;        // 'https://api.minimaxi.com'
        apiKey: string;         // stored in data.json (masked input; warning that vault sync syncs it)
        groupId: string;
        chatModel: string;      // 'MiniMax-M3'
        ttsModelInstant: string;// 'speech-2.8-turbo'
        ttsModelPodcast: string;// 'speech-2.8-hd'
    };

    outputLanguage: 'zh' | 'en' | 'auto';
    voices: { zh: string; en: string; podcastHostA: string; podcastHostB: string };
    speechRate: number;   // 0.5–2.0
    speechVolume: number; // 0–1

    podcast: {
        mode: 'narrator' | 'dialogue';
        targetMinutes: 5 | 15 | 30;
        folder: string;   // '' = next to PDF
        concurrency: number;  // parallel async-TTS jobs (stage 2). 1 = serial (old behavior).
        chunkSize: number;    // max chars per TTS request; smaller → more parallelism, faster per-job.
    };

    annotation: {
        defaultMode: 'vault' | 'pdf';
        categoryColors: Partial<Record<AnnotationCategory, string>>; // color name in palette
    };

    citations: {
        enabled: boolean;
        s2ApiKey: string;     // optional, for higher Semantic Scholar rate limits
        cacheTtlDays: number;
    };

    knowledgeMap: {
        output: 'canvas' | 'notes';
        folder: string;       // '' = next to PDF
    };

    /** null = unlimited. Monthly token budget. */
    monthlyTokenBudget: number | null;
    /** Rolling monthly counter; periodKey is 'YYYY-MM'. Resets when the month changes. */
    tokenUsage: { periodKey: string; tokens: number };
}

export const DEFAULT_AI_SETTINGS: AISettings = {
    aiEnabled: false,
    consentGiven: false,

    minimax: {
        baseUrl: 'https://api.minimaxi.com',
        apiKey: '',
        groupId: '',
        chatModel: 'MiniMax-M3',
        ttsModelInstant: 'speech-2.8-turbo',
        ttsModelPodcast: 'speech-2.8-hd',
    },

    outputLanguage: 'auto',
    voices: { zh: 'zh-CN-NewsYunhaoNeural', en: 'English_Trust', podcastHostA: 'male-qn-qingse', podcastHostB: 'female-shaonv' },
    speechRate: 1.0,
    speechVolume: 1.0,

    podcast: { mode: 'dialogue', targetMinutes: 15, folder: '', concurrency: 3, chunkSize: 3000 },

    annotation: {
        defaultMode: 'vault',
        categoryColors: {
            'research-question': 'yellow',
            'method': 'blue',
            'key-result': 'green',
            'limitation': 'red',
            'contribution': 'purple',
            'definition': 'orange',
        },
    },

    citations: { enabled: true, s2ApiKey: '', cacheTtlDays: 30 },

    knowledgeMap: { output: 'canvas', folder: '' },

    monthlyTokenBudget: null,
    tokenUsage: { periodKey: currentPeriodKey(), tokens: 0 },
};

/** 'YYYY-MM' in the user's locale. Used for the monthly budget window. */
export function currentPeriodKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Mutate settings.ai in place to apply migrations / fill missing defaults. */
export function migrateAISettings(ai: any): AISettings {
    if (!ai || typeof ai !== 'object') return structuredClone(DEFAULT_AI_SETTINGS);
    const out: any = structuredClone(DEFAULT_AI_SETTINGS);
    // shallow-deep merge: top-level scalars from ai win; nested objects merged key-by-key
    for (const k of Object.keys(out)) {
        if (k in ai) {
            if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && ai[k] && typeof ai[k] === 'object') {
                Object.assign(out[k], ai[k]);
            } else {
                out[k] = ai[k];
            }
        }
    }
    // ensure the monthly window resets
    if (out.tokenUsage?.periodKey !== currentPeriodKey()) {
        out.tokenUsage = { periodKey: currentPeriodKey(), tokens: 0 };
    }
    return out as AISettings;
}

// ---------------------------------------------------------------------------
// Settings-tab section
// ---------------------------------------------------------------------------

/** Render the "AI (MiniMax)" section into the PDF++ settings tab. */
export function renderAISettingsSection(plugin: PDFPlus, tab: PDFPlusSettingTab) {
    const ai = () => plugin.settings.ai;
    const save = async (redisplay = false) => { await plugin.saveSettings(); if (redisplay) tab.redisplay(); };

    tab.addHeading('AI (MiniMax) — experimental', 'ai', 'lucide-sparkles');

    new Setting(tab.contentEl)
        .setName('Enable AI module')
        .setDesc('Master switch. Disabling removes all AI UI without affecting the rest of PDF++. Requires a MiniMax API key.')
        .addToggle((t) => t.setValue(ai().aiEnabled).onChange(async (v) => {
            ai().aiEnabled = v;
            await save(true);
            plugin.ai?.setActive(v);
            if (v) new Notice('PDF++ AI: enabled.', 3000);
        }));

    new Setting(tab.contentEl)
        .setName('Privacy consent')
        .setDesc('When AI is used, selected text and images from the current PDF are sent to MiniMax. Nothing is sent without an explicit action.')
        .addToggle((t) => t.setValue(ai().consentGiven).onChange(async (v) => { ai().consentGiven = v; await save(); }));

    // --- Provider ---
    new Setting(tab.contentEl)
        .setName('API key')
        .setDesc('MiniMax API key (Bearer token). Stored in data.json — vault sync will sync it.')
        .addText((t) => { t.inputEl.type = 'password'; t.setValue(ai().minimax.apiKey).onChange(async (v) => { ai().minimax.apiKey = v.trim(); await save(); }); });

    new Setting(tab.contentEl).setName('Group ID').addText((t) => t.setValue(ai().minimax.groupId).onChange(async (v) => { ai().minimax.groupId = v.trim(); await save(); }));

    new Setting(tab.contentEl).setName('Base URL').setDesc('Domestic: https://api.minimaxi.com · International: https://api.minimax.io')
        .addText((t) => t.setValue(ai().minimax.baseUrl).onChange(async (v) => { ai().minimax.baseUrl = v.trim(); await save(); }));

    new Setting(tab.contentEl).setName('Chat model').addText((t) => t.setValue(ai().minimax.chatModel).onChange(async (v) => { ai().minimax.chatModel = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('TTS model (instant)').addText((t) => t.setValue(ai().minimax.ttsModelInstant).onChange(async (v) => { ai().minimax.ttsModelInstant = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('TTS model (podcast)').addText((t) => t.setValue(ai().minimax.ttsModelPodcast).onChange(async (v) => { ai().minimax.ttsModelPodcast = v.trim(); await save(); }));

    new Setting(tab.contentEl)
        .setName('Test connection')
        .setDesc('Sends a trivial chat request to verify the key, base URL, and model.')
        .addButton((b) => b.setButtonText('Test').onClick(async () => {
            if (!ai().minimax.apiKey) { new Notice('PDF++ AI: set an API key first.', 4000); return; }
            b.setDisabled(true).setButtonText('Testing…');
            const client = (await import('./provider/minimax-chat')).getSharedChatClient(plugin);
            const r = await client.testConnection();
            b.setDisabled(false).setButtonText('Test');
            new Notice(`PDF++ AI: ${r.ok ? '✓' : '✗'} ${r.detail}`, r.ok ? 4000 : 8000);
        }));

    // --- Output ---
    new Setting(tab.contentEl).setName('Output language').addDropdown((d) => d.addOptions({ 'auto': 'Auto (follow PDF)', 'zh': '中文', 'en': 'English' }).setValue(ai().outputLanguage).onChange(async (v) => { ai().outputLanguage = v as any; await save(); }));
    new Setting(tab.contentEl).setName('Voice (中文)').addText((t) => t.setValue(ai().voices.zh).onChange(async (v) => { ai().voices.zh = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('Voice (English)').addText((t) => t.setValue(ai().voices.en).onChange(async (v) => { ai().voices.en = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('Podcast host A voice').addText((t) => t.setValue(ai().voices.podcastHostA).onChange(async (v) => { ai().voices.podcastHostA = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('Podcast host B voice').addText((t) => t.setValue(ai().voices.podcastHostB).onChange(async (v) => { ai().voices.podcastHostB = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('Speech rate').addSlider((s) => s.setLimits(0.5, 2, 0.1).setValue(ai().speechRate).setDynamicTooltip().onChange(async (v) => { ai().speechRate = v; await save(); }));
    new Setting(tab.contentEl).setName('Speech volume').addSlider((s) => s.setLimits(0, 1, 0.05).setValue(ai().speechVolume).setDynamicTooltip().onChange(async (v) => { ai().speechVolume = v; await save(); }));

    // --- Podcast ---
    new Setting(tab.contentEl).setName('Podcast mode').addDropdown((d) => d.addOptions({ 'narrator': 'Single narrator', 'dialogue': 'Two-host dialogue' }).setValue(ai().podcast.mode).onChange(async (v) => { ai().podcast.mode = v as any; await save(); }));
    new Setting(tab.contentEl).setName('Podcast length target').addDropdown((d) => d.addOptions({ '5': '5 min', '15': '15 min', '30': '30 min' }).setValue(String(ai().podcast.targetMinutes)).onChange(async (v) => { ai().podcast.targetMinutes = Number(v) as any; await save(); }));
    new Setting(tab.contentEl).setName('Podcast output folder').setDesc('Empty = next to the PDF.').addText((t) => t.setValue(ai().podcast.folder).onChange(async (v) => { ai().podcast.folder = v.trim(); await save(); }));
    new Setting(tab.contentEl).setName('Podcast TTS concurrency').setDesc('Parallel async-TTS jobs in the synthesize stage. 1 = serial (slower). Higher = faster but may hit rate limits; 3 is a safe default.').addSlider((s) => s.setLimits(1, 8, 1).setValue(ai().podcast.concurrency).setDynamicTooltip().onChange(async (v) => { ai().podcast.concurrency = v; await save(); }));
    new Setting(tab.contentEl).setName('Podcast chunk size (chars)').setDesc('Max characters per TTS request. Smaller chunks → more parts → more parallelism and faster per-job synthesis.').addText((t) => t.setValue(String(ai().podcast.chunkSize)).onChange(async (v) => { const n = Math.max(500, Number(v) || 3000); ai().podcast.chunkSize = n; await save(true); }));

    // --- Annotation ---
    new Setting(tab.contentEl).setName('Auto-annotation default mode').addDropdown((d) => d.addOptions({ 'vault': 'Vault-only (non-destructive)', 'pdf': 'Write into PDF' }).setValue(ai().annotation.defaultMode).onChange(async (v) => { ai().annotation.defaultMode = v as any; await save(); }));

    // --- Citations ---
    new Setting(tab.contentEl).setName('Enable citation enrichment').addToggle((t) => t.setValue(ai().citations.enabled).onChange(async (v) => { ai().citations.enabled = v; await save(); }));
    new Setting(tab.contentEl).setName('Semantic Scholar API key (optional)').addText((t) => { t.inputEl.type = 'password'; t.setValue(ai().citations.s2ApiKey).onChange(async (v) => { ai().citations.s2ApiKey = v.trim(); await save(); }); });
    new Setting(tab.contentEl).setName('Citation cache TTL (days)').addSlider((s) => s.setLimits(1, 180, 1).setValue(ai().citations.cacheTtlDays).setDynamicTooltip().onChange(async (v) => { ai().citations.cacheTtlDays = v; await save(); }));

    // --- Knowledge map ---
    new Setting(tab.contentEl).setName('Knowledge map output').addDropdown((d) => d.addOptions({ 'canvas': 'Obsidian Canvas (.canvas)', 'notes': 'Graph notes (.md)' }).setValue(ai().knowledgeMap.output).onChange(async (v) => { ai().knowledgeMap.output = v as any; await save(); }));
    new Setting(tab.contentEl).setName('Knowledge map output folder').setDesc('Empty = next to the PDF.').addText((t) => t.setValue(ai().knowledgeMap.folder).onChange(async (v) => { ai().knowledgeMap.folder = v.trim(); await save(); }));

    // --- Budget ---
    new Setting(tab.contentEl)
        .setName('Monthly token budget')
        .setDesc('Null/0 = unlimited. AI actions are blocked when exceeded.')
        .addText((t) => t.setValue(String(ai().monthlyTokenBudget ?? '')).onChange(async (v) => { ai().monthlyTokenBudget = v.trim() ? Math.max(0, Number(v)) : null; await save(); }))
        .addExtraButton((b) => b.setIcon('lucide-rotate-ccw').setTooltip('Reset usage counter').onClick(async () => { ai().tokenUsage = { periodKey: currentPeriodKey(), tokens: 0 }; await save(true); }));
    new Setting(tab.contentEl)
        .setName('Token usage this month')
        .setDesc(descUsage(ai()))
        .addButton((b) => b.setButtonText('Refresh').onClick(() => save(true)));
}

function descUsage(ai: AISettings): string {
    const used = ai.tokenUsage?.tokens ?? 0;
    const budget = ai.monthlyTokenBudget;
    if (!budget) return `${formatNum(used)} tokens used (unlimited).`;
    return `${formatNum(used)} / ${formatNum(budget)} tokens (${ai.tokenUsage?.periodKey ?? '?'}).`;
}

function formatNum(n: number): string {
    return n.toLocaleString();
}
