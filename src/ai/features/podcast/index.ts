// Podcast pipeline entry point. Three independently-runnable stages + a one-click
// "do all" wrapper that preserves the original generatePodcastAction name for back-compat:
//   1. generateScriptAction   — PDF → script.json + manifest.json (one chat call)
//   2. synthesizeAudioAction  — manifest → parts/*.mp3 (parallel, resumable)
//   3. assembleAction         — parts → <name>.podcast.mp3 + .md (local concat)

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { generateScriptAction } from './script';
import { synthesizeAudioAction } from './synthesize';
import { assembleAction } from './assemble';

export { generateScriptAction } from './script';
export { synthesizeAudioAction } from './synthesize';
export { assembleAction } from './assemble';

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }

/** One-click full pipeline (back-compat with the original command). Runs all three stages
 *  in sequence; each stage is also resumable on its own if this is interrupted. */
export async function generatePodcastAction(plugin: PDFPlus): Promise<void> {
	const file = activePDFFile(plugin);
	if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }

	plugin.ai.assertBudget();
	if (!plugin.ai.hasConsent()) return;

	const manifest = await generateScriptAction(plugin);
	if (!manifest) return;

	const synth = await synthesizeAudioAction(plugin);
	if (!synth) return;

	// Only assemble if everything succeeded; partial results stay on disk for a re-run.
	const allDone = synth.segments.length > 0 && synth.segments.every((e) => e.status === 'done');
	if (!allDone) {
		new Notice('PDF++ AI: pipeline finished with incomplete audio. Re-run "Synthesize audio", then "Assemble final".', 8000);
		return;
	}
	await assembleAction(plugin);
}
