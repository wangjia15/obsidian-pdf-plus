import type PDFPlus from 'main';
import type { PDFView } from 'typings';

/** The active PDF, or the most recent document pane when the AI sidebar has focus.
 * Do not select an arbitrary PDF from the workspace when multiple PDFs are open. */
export function getAutoAnnotationTarget(plugin: PDFPlus): PDFView | null {
	const active = plugin.lib.getPDFView(true);
	if (active?.file) return active;
	const recent = plugin.app.workspace.getMostRecentLeaf();
	if (recent && plugin.lib.isPDFView(recent.view) && recent.view.file) return recent.view;
	return null;
}
