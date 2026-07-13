// Hook PDF++'s rectangular-selection ("copy embed link to rect") so the AI module can
// remember the last cropped region and analyze just that region — instead of feeding
// the whole page to the vision model.
//
// Zero core changes: wraps copyLinkLib.copyEmbedLinkToRect with monkey-around (the same
// patching library the rest of PDF++ uses). No-op unless AI is enabled, and only records
// on the real copy path (checking=false), never on the probing check.

import { Notice } from 'obsidian';
import { around } from 'monkey-around';
import PDFPlus from 'main';
import { copyLinkLib } from 'lib/copy-link';
import { Rect } from 'typings';
import { showRegionMarker } from './region-marker';

export interface CroppedRect {
    file: string;
    pageNumber: number;
    rect: Rect;
}

let patched = false;

export function registerRectHook(plugin: PDFPlus) {
    if (patched) return;
    patched = true;

    plugin.register(around(copyLinkLib.prototype as any, {
        copyEmbedLinkToRect(old: any) {
            return function (this: copyLinkLib, ...args: any[]) {
                const ret = old.apply(this, args);
                try {
                    const [checking, child, pageNumber, rect] = args as [boolean, any, number, Rect];
                    // Only capture on the actual copy (not the checking=true probe), on success,
                    // and only when the AI module is on.
                    if (!checking && ret !== false && plugin.settings.ai?.aiEnabled && child?.file?.path && Array.isArray(rect)) {
                        const croppedRect: Rect = [...rect] as Rect;
                        plugin.ai.lastCroppedRect = {
                            file: child.file.path,
                            pageNumber,
                            rect: croppedRect,
                        };
                        showRegionMarker(plugin, child.file.path, pageNumber, croppedRect);
                        new Notice('PDF++ AI: region marked — click the highlighted box on the page to analyze it.', 5000);
                    }
                } catch {
                    /* never let the hook break the original copy */
                }
                return ret;
            };
        },
    }));
}
