// Register all PDF++ AI commands (palette entries). Registered once at plugin load;
// each command checks settings.ai.aiEnabled at runtime and notices if AI is off.
//
// The structured `AI_COMMANDS` list below is the single source of truth for every AI
// command. It drives both the command palette (registerAICommands) and the sidebar
// "AI Commands" dropdown menu (sidebar-view.ts via executeAICommand), so the two surfaces
// can never drift out of sync.

import { Notice } from 'obsidian';
import PDFPlus from 'main';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { stopSpeaking } from '../audio/speak';
import { summarizePaperAction, explainSelectionAction, summarizeSelectionAction, translateSelectionAction, askSelectionAction } from './summarize';
import { analyzeImageAction, parseAllFiguresAction, analyzeRegionAction } from './figure-analysis';
import { autoAnnotateAction } from './auto-annotate';
import { showReferencesPanelAction } from './references';
import { generatePodcastAction, generateScriptAction, synthesizeAudioAction, assembleAction } from './podcast';
import { generateKnowledgeMapAction } from './knowledge-map';

let registered = false;

/** Logical grouping used to organize commands in both the palette and the sidebar menu. */
export type AICommandGroup = 'read' | 'image' | 'annotate' | 'podcast' | 'knowledge' | 'util';

/** Display order of the groups in the sidebar menu. */
export const AI_GROUP_ORDER: AICommandGroup[] = ['read', 'image', 'annotate', 'podcast', 'knowledge', 'util'];

/** Human-readable group headings (shown as section labels in the sidebar menu). */
export const AI_GROUP_LABEL: Record<AICommandGroup, string> = {
    read: '阅读理解',
    image: '图像分析',
    annotate: '注释与引用',
    podcast: '播客',
    knowledge: '知识图谱',
    util: '工具',
};

export interface AICommandDef {
    /** Command id suffix appended to `${manifest.id}-ai-`. */
    suffix: string;
    /** Display label (shown after the `PDF++ AI: ` prefix in the palette). */
    label: string;
    group: AICommandGroup;
    /** The action to run; receives the plugin. Should notice if AI is off / no PDF is open. */
    run: (plugin: PDFPlus) => any;
    /** Omit from the sidebar menu (e.g. "Open sidebar" is meaningless inside the sidebar). */
    hideInSidebar?: boolean;
    /** Optional lucide icon for the sidebar menu entry. */
    icon?: string;
}

/** Every AI command. Add new commands here and they appear in both the palette and the sidebar menu. */
export const AI_COMMANDS: AICommandDef[] = [
    // --- 阅读理解 ---
    { suffix: 'summarize-paper', label: 'Summarize paper', group: 'read', icon: 'lucide-file-text', run: (p) => summarizePaperAction(p) },
    { suffix: 'explain-selection', label: 'Explain selection', group: 'read', icon: 'lucide-help-circle', run: (p) => explainSelectionAction(p) },
    { suffix: 'summarize-selection', label: 'Summarize selection', group: 'read', icon: 'lucide-align-left', run: (p) => summarizeSelectionAction(p) },
    { suffix: 'translate-selection', label: 'Translate selection', group: 'read', icon: 'lucide-languages', run: (p) => translateSelectionAction(p) },
    { suffix: 'ask-selection', label: 'Ask AI about selection', group: 'read', icon: 'lucide-message-circle', run: (p) => askSelectionAction(p) },

    // --- 图像分析 ---
    { suffix: 'analyze-image', label: 'Analyze image (active page)', group: 'image', icon: 'lucide-image', run: (p) => analyzeImageAction(p) },
    { suffix: 'parse-all-figures', label: 'Parse all figures', group: 'image', icon: 'lucide-images', run: (p) => parseAllFiguresAction(p) },
    {
        suffix: 'analyze-region',
        label: 'Analyze last cropped region',
        group: 'image',
        icon: 'lucide-crop',
        run: (p) => {
            const r = p.ai.lastCroppedRect;
            if (!r) { new Notice('PDF++ AI: crop a rectangular selection first — click the box-select icon in the PDF toolbar, then drag.', 6000); return; }
            return analyzeRegionAction(p, r.pageNumber, r.rect);
        },
    },

    // --- 注释与引用 ---
    { suffix: 'auto-annotate', label: 'Auto-annotate paper', group: 'annotate', icon: 'lucide-highlighter', run: (p) => autoAnnotateAction(p) },
    { suffix: 'references', label: 'Show references panel', group: 'annotate', icon: 'lucide-book-marked', run: (p) => showReferencesPanelAction(p) },

    // --- 播客 ---
    { suffix: 'podcast', label: 'Generate podcast from PDF', group: 'podcast', icon: 'lucide-mic', run: (p) => generatePodcastAction(p) },
    { suffix: 'podcast-script', label: 'Podcast — Generate script', group: 'podcast', icon: 'lucide-file-text', run: (p) => generateScriptAction(p) },
    { suffix: 'podcast-synthesize', label: 'Podcast — Synthesize audio', group: 'podcast', icon: 'lucide-audio-lines', run: (p) => synthesizeAudioAction(p) },
    { suffix: 'podcast-assemble', label: 'Podcast — Assemble final mp3', group: 'podcast', icon: 'lucide-file-audio', run: (p) => assembleAction(p) },

    // --- 知识图谱 ---
    { suffix: 'knowledge-map', label: 'Generate knowledge map (canvas/graph notes)', group: 'knowledge', icon: 'lucide-workflow', run: (p) => generateKnowledgeMapAction(p) },

    // --- 工具 ---
    { suffix: 'open-sidebar', label: 'Open AI sidebar', group: 'util', icon: 'lucide-panel-right', hideInSidebar: true, run: (p) => getOrCreateAISidebar(p, true) },
    { suffix: 'stop-speaking', label: 'Stop speaking', group: 'util', icon: 'lucide-volume-x', run: (p) => stopSpeaking(p) },
    {
        suffix: 'toggle',
        label: 'Toggle AI module',
        group: 'util',
        icon: 'lucide-power',
        run: async (p) => {
            const next = !p.settings.ai.aiEnabled;
            p.settings.ai.aiEnabled = next;
            await p.saveSettings();
            p.ai.setActive(next);
            new Notice(`PDF++ AI: ${next ? 'enabled' : 'disabled'}.`, 3000);
        },
    },
];

/** Run an AI command by suffix with the same enable-guard + error handling as the palette.
 *  Used by the sidebar dropdown menu so both surfaces behave identically. */
export function executeAICommand(plugin: PDFPlus, suffix: string): void {
    const def = AI_COMMANDS.find((d) => d.suffix === suffix);
    if (!def) return;
    ensureEnabled(plugin, () => def.run(plugin));
}

export function registerAICommands(plugin: PDFPlus) {
    if (registered) return;
    registered = true;

    const A = 'PDF++ AI: ';
    const id = (s: string) => `${plugin.manifest.id}-ai-${s}`;
    for (const def of AI_COMMANDS) {
        plugin.addCommand({
            id: id(def.suffix),
            name: `${A}${def.label}`,
            callback: () => ensureEnabled(plugin, () => def.run(plugin)),
        });
    }
}

function ensureEnabled(plugin: PDFPlus, fn: () => any) {
    if (!plugin.settings.ai.aiEnabled) { new Notice('PDF++ AI: enable the AI module first (command "PDF++ AI: Toggle AI module" or Settings).', 5000); return; }
    Promise.resolve(fn()).catch((e) => console.error('PDF++ AI command failed', e));
}
