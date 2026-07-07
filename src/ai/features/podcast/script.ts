// Stage 1: turn a PDF into a podcast script and write it to disk as a manifest.
// Fast (one chat call). Produces script.json + script.md + manifest.json (all parts pending).
// Stages 2 and 3 consume the manifest, so this can be re-run independently to change
// length/style without touching audio.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { extractPDFText } from '../../context/extractor';
import { chatJSON } from '../../provider/json';
import { podcastSystem, podcastUser, PodcastSegment, PROMPT_VERSION } from '../../prompts/podcast';
import { getCache, cacheKey } from '../../context/cache';
import { normalizeError } from '../../provider/types';
import { getOrCreateAISidebar } from '../../ui/sidebar-view';
import { buildManifest, writeManifest, scriptJsonPath, scriptMdPath, podcastDir, type PodcastManifest } from './manifest';

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }
function langFor(plugin: PDFPlus): 'zh' | 'en' { return plugin.settings.ai.outputLanguage === 'zh' ? 'zh' : 'en'; }

function renderScriptMd(file: TFile, segments: PodcastSegment[]): string {
	const turns = segments.map((s) => `**${s.speaker}:** ${s.text}`).join('\n\n');
	return `# Podcast script — ${file.basename}\n\n${turns}\n`;
}

export async function generateScriptAction(plugin: PDFPlus): Promise<PodcastManifest | null> {
	const file = activePDFFile(plugin);
	if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return null; }

	plugin.ai.assertBudget();
	if (!plugin.ai.hasConsent()) return null;

	const ai = plugin.settings.ai;
	const mode = ai.podcast.mode;
	const minutes = ai.podcast.targetMinutes;
	const lang = langFor(plugin);

	// Persistent sidebar block so the stage progress is visible long after the notice is gone.
	const view = await getOrCreateAISidebar(plugin, true);
	const block = view?.addBlock({ action: 'Podcast — Generate script', sourcePath: file.path });
	block?.setLoading('Extracting paper text…');

	// 1. extract
	new Notice('PDF++ AI [podcast 1/3]: extracting paper text…', 3000);
	let extracted;
	try { extracted = await extractPDFText(plugin, file); }
	catch (e) {
		const msg = normalizeError(e).message;
		new Notice(`PDF++ AI: ${msg}`, 6000);
		block?.setError(`Extraction failed: ${msg}`);
		return null;
	}

	// 2. script (cached by file + prompt version + mode/length/lang so re-runs are free)
	block?.setLoading('Generating script…');
	const cache = getCache(plugin);
	const key = await cacheKey('podcast-script', extracted.fileKey, PROMPT_VERSION, mode, String(minutes), lang);
	let segments: PodcastSegment[];
	const cached = await cache.get<PodcastSegment[]>(key);
	if (cached) {
		segments = cached;
		new Notice('PDF++ AI [podcast 1/3]: using cached script.', 2500);
	} else {
		try {
			const parsed = await chatJSON(plugin, [
				{ role: 'system', content: podcastSystem(mode, minutes, lang) },
				{ role: 'user', content: podcastUser() + extracted.fullText },
			]);
			segments = (parsed?.segments ?? []) as PodcastSegment[];
		} catch (e) {
			const msg = normalizeError(e).message;
			new Notice(`PDF++ AI: script generation failed — ${msg}`, 7000);
			block?.setError(`Script generation failed: ${msg}`);
			return null;
		}
		if (!segments.length) {
			new Notice('PDF++ AI: script was empty.', 4000);
			block?.setError('Script was empty — try again or adjust length.');
			return null;
		}
		await cache.set(key, segments);
	}

	// 3. build manifest + persist
	block?.setLoading('Writing script to vault…');
	const manifest = await buildManifest(plugin, file, segments, { mode, lang });
	await plugin.lib.write(scriptJsonPath(plugin, file), JSON.stringify(segments, null, 2), false);
	await plugin.lib.write(scriptMdPath(plugin, file), renderScriptMd(file, segments), false);
	await writeManifest(plugin, file, manifest);

	const dir = podcastDir(plugin, file);
	const preview = segments.slice(0, 6).map((s) => `**${s.speaker}:** ${s.text}`).join('\n\n');
	const more = segments.length > 6 ? `\n\n*…and ${segments.length - 6} more turn(s).*` : '';
	block?.setMarkdown(`**Script ready** — ${manifest.segments.length} audio part(s) in \`${dir}/\`.\n\nNext: run **Podcast — Synthesize audio**.\n\n## Preview\n\n${preview}${more}`);
	block?.setDone();

	new Notice(`PDF++ AI [podcast 1/3]: script ready — ${manifest.segments.length} audio part(s) in "${dir}". Run "Synthesize audio" next.`, 6000);
	return manifest;
}
