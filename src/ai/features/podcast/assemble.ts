// Stage 3: stitch all synthesized parts into one mp3 + a note with an embedded player.
// Cheap and local-only (no API calls). Refuses to assemble if any part is missing/failed,
// so you never get a silently-truncated podcast.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { normalizeError } from '../../provider/types';
import { readManifest, partAbsPath, finalAudioPath, finalNotePath, type PodcastManifest } from './manifest';
import { getOrCreateAISidebar } from '../../ui/sidebar-view';

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }

export async function assembleAction(plugin: PDFPlus): Promise<void> {
	const file = activePDFFile(plugin);
	if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }

	const view = await getOrCreateAISidebar(plugin, true);
	const block = view?.addBlock({ action: 'Podcast — Assemble final', sourcePath: file.path });

	const manifest = await readManifest(plugin, file);
	if (!manifest) {
		new Notice('PDF++ AI: no podcast manifest found. Run "Generate script" then "Synthesize audio" first.', 6000);
		block?.setError('No podcast manifest found. Run "Generate script" then "Synthesize audio" first.');
		return;
	}

	const done = manifest.segments.filter((e) => e.status === 'done');
	const missing = manifest.segments.filter((e) => e.status !== 'done');
	if (!done.length) {
		new Notice('PDF++ AI: no synthesized parts yet. Run "Synthesize audio" first.', 5000);
		block?.setError('No synthesized parts yet. Run "Synthesize audio" first.');
		return;
	}
	if (missing.length) {
		new Notice(`PDF++ AI [podcast 3/3]: ${missing.length} part(s) not ready (${missing.length} pending/failed). Assembling the ${done.length} ready part(s) anyway — re-run "Synthesize audio" to fill gaps.`, 8000);
	}

	block?.setLoading(`Assembling ${done.length} part(s)…`);

	try {
		// Read parts in index order (manifest.segments is already index-sorted).
		const buffers: ArrayBuffer[] = [];
		for (const e of done) {
			const f = plugin.app.vault.getAbstractFileByPath(partAbsPath(plugin, file, e.partFile));
			if (f instanceof TFile) buffers.push(await plugin.app.vault.readBinary(f));
		}
		const mp3 = concatMp3(buffers);

		const audioPath = finalAudioPath(plugin, file);
		const existing = plugin.app.vault.getAbstractFileByPath(audioPath);
		if (existing instanceof TFile) await plugin.app.vault.modifyBinary(existing, mp3);
		else await plugin.app.vault.createBinary(audioPath, mp3);

		const notePath = finalNotePath(plugin, file);
		await plugin.lib.write(notePath, renderNote(file, manifest), false);

		const gapNote = missing.length ? `\n\n*Note: ${missing.length} part(s) were not ready and were skipped — re-run "Synthesize audio" then "Assemble final" for the full podcast.*` : '';
		block?.setMarkdown(`**Assembled** ${done.length} part(s) → \`${audioPath}\`.\n\nOpen the podcast note: [[${notePath}]].${gapNote}`);
		block?.setDone();

		new Notice(`PDF++ AI [podcast 3/3]: assembled ${done.length} part(s) → ${audioPath}.`, 5000);
		plugin.app.workspace.openLinkText(notePath, '', false);
	} catch (e) {
		const msg = normalizeError(e).message;
		new Notice(`PDF++ AI [podcast 3/3]: ${msg}`, 7000);
		block?.setError(`Assembly failed: ${msg}`);
	}
}

function renderNote(file: TFile, manifest: PodcastManifest): string {
	const turns = manifest.segments
		.map((e) => `**${e.speaker}:** ${e.text}`)
		.join('\n\n');
	return `# Podcast — ${file.basename}\n\n![[${file.basename}.podcast.mp3]]\n\n> ${manifest.segments.length} part(s) · mode: ${manifest.mode} · assembled from \`${podcastDirFor(file)}/\`\n\n## Script\n\n${turns}\n`;
}

function podcastDirFor(file: TFile): string { return `${file.basename}.podcast`; }

/** Concatenate CBR mp3 buffers, stripping ID3v2 tags from all but the first (carried from v1). */
function concatMp3(buffers: ArrayBuffer[]): ArrayBuffer {
	if (!buffers.length) return new ArrayBuffer(0);
	const parts: Uint8Array[] = buffers.map((b, i) => {
		const bytes = new Uint8Array(b);
		return i === 0 ? bytes : stripId3v2(bytes);
	});
	const total = parts.reduce((n, a) => n + a.length, 0);
	const merged = new Uint8Array(total);
	let off = 0;
	for (const a of parts) { merged.set(a, off); off += a.length; }
	return merged.buffer;
}

function stripId3v2(b: Uint8Array): Uint8Array {
	if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // 'ID3'
		const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
		return b.slice(10 + size);
	}
	return b;
}
