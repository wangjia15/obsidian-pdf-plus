// F6 action: gather parsed bibliography from the active viewer's BibliographyManager, enrich
// it via the resolver chain, and open the sortable References panel.

import { Notice } from 'obsidian';
import PDFPlus from 'main';
import { enrichReferences } from './citations';
import { ReferencesPanelModal } from '../ui/references-panel';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { normalizeError } from '../provider/types';

export async function showReferencesPanelAction(plugin: PDFPlus) {
    plugin.ai.assertBudget();
    if (!plugin.ai.hasConsent()) return;

    const bib = plugin.lib.getBibliographyManager(true);
    if (!bib || bib.destIdToParsedBib.size === 0) {
        new Notice('PDF++ AI: no bibliography extracted for this PDF. PDF++ citation parsing must be active.', 6000);
        return;
    }

    const view = await getOrCreateAISidebar(plugin, true);
    const block = view?.addBlock({ action: 'Resolve references', sourcePath: plugin.lib.getPDFView()?.file?.path });
    block?.setLoading('Resolving references (Semantic Scholar → Crossref → OpenAlex)…');

    try {
        const refs = await enrichReferences(plugin, bib.destIdToParsedBib);
        const resolved = refs.filter((r) => r.citationCount !== null).length;
        await block?.setMarkdown(`Resolved **${resolved} / ${refs.length}** references with citation data.`);
        block?.setDone();
        new ReferencesPanelModal(plugin, refs).open();
    } catch (e) {
        block?.setError(normalizeError(e).message);
    }
}
