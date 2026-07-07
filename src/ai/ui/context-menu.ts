// Append an "AI" section to PDF++'s custom PDF context menu (PDFPlusContextMenu), shown when
// there is a text selection and AI is enabled. Uses monkey-around, the same patching library
// the rest of PDF++ uses. Only active when the user has "Replace built-in context menu" on;
// otherwise selection actions are available via commands.

import { around } from 'monkey-around';
import PDFPlus from 'main';
import { PDFPlusContextMenu } from 'context-menu';
import { explainSelectionAction, summarizeSelectionAction, translateSelectionAction, askSelectionAction } from '../features/summarize';

let patched = false;

export function registerAIContextMenu(plugin: PDFPlus) {
    if (patched) return;
    patched = true;

    plugin.register(around(PDFPlusContextMenu.prototype as any, {
        addItems(old: any) {
            return async function (this: PDFPlusContextMenu, evt?: MouseEvent) {
                await old.call(this, evt);
                tryAppendAIItems(this as any, plugin);
            };
        },
    }));
}

function tryAppendAIItems(menu: any, plugin: PDFPlus) {
    if (!plugin.settings.ai.aiEnabled) return;
    const child = menu.child;
    if (!child?.containerEl) return;
    const sel = child.containerEl.win.getSelection()?.toString().trim();
    if (!sel) return;

    const add = (label: string, fn: () => any) => menu.addItem((item: any) => item.setTitle(label).setIcon('lucide-sparkles').onClick(fn));

    add('AI: Explain', () => explainSelectionAction(plugin));
    add('AI: Summarize', () => summarizeSelectionAction(plugin));
    add('AI: Translate', () => translateSelectionAction(plugin));
    add('AI: Ask…', () => askSelectionAction(plugin));
}
