// F7: turn a paper into a knowledge map — either an Obsidian .canvas (JSON Canvas 1.0) or a
// set of interlinked graph notes. Reuses the F1 extractor for the outline; nodes carry PDF++
// page links where the model can suggest a page.

import { Notice, TFile } from 'obsidian';
import PDFPlus from 'main';
import { extractPDFText } from '../context/extractor';
import { getOrCreateAISidebar } from '../ui/sidebar-view';
import { chatJSON } from '../provider/json';
import { normalizeError } from '../provider/types';

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }
function langFor(plugin: PDFPlus): 'zh' | 'en' { return plugin.settings.ai.outputLanguage === 'zh' ? 'zh' : 'en'; }

interface OutlineSection { id: string; title: string; summary: string; page?: number; }
interface Outline { center: { title: string; summary: string }; sections: OutlineSection[]; }

function outlineSystem(lang: 'zh' | 'en'): string {
    return `You produce a structured outline of an academic paper for a knowledge map.
Return ONLY JSON: { "center": { "title": "<paper title or short label>", "summary": "<2-3 sentence overview>" }, "sections": [ { "id": "s1", "title": "<section name>", "summary": "<1-2 sentence condensation>", "page": <1-based page number if known, else omit> } ] }
Cover: research question, method, results, limitations, contributions. 5–8 sections. Do not output anything outside the JSON object.${lang === 'zh' ? ' Reply in 中文.' : ' Reply in English.'}`;
}

export async function generateKnowledgeMapAction(plugin: PDFPlus) {
    const file = activePDFFile(plugin);
    if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return; }

    plugin.ai.assertBudget();
    if (!plugin.ai.hasConsent()) return;

    const view = await getOrCreateAISidebar(plugin, true);
    const block = view?.addBlock({ action: 'Generate knowledge map', sourcePath: file.path });
    block?.setLoading('Extracting & outlining paper…');

    new Notice('PDF++ AI: extracting & outlining paper…', 3000);
    let extracted;
    try { extracted = await extractPDFText(plugin, file); }
    catch (e) {
        const msg = normalizeError(e).message;
        new Notice(`PDF++ AI: ${msg}`, 6000);
        block?.setError(`Extraction failed: ${msg}`);
        return;
    }

    const lang = langFor(plugin);
    let outline: Outline;
    try {
        block?.setLoading('Building outline (LLM)…');
        const parsed = await chatJSON(plugin, [
            { role: 'system', content: outlineSystem(lang) },
            { role: 'user', content: 'Produce the outline JSON from this paper:\n\n' + extracted.fullText },
        ]);
        outline = normalizeOutline(parsed);
    } catch (e) {
        const msg = normalizeError(e).message;
        new Notice(`PDF++ AI: outline failed — ${msg}`, 7000);
        block?.setError(`Outline failed: ${msg}`);
        return;
    }

    const ai = plugin.settings.ai.knowledgeMap;
    const kind = ai.output === 'notes' ? 'graph notes' : 'canvas';
    block?.setLoading(`Emitting ${kind}…`);
    try {
        let outPath = '';
        let summary = '';
        if (ai.output === 'notes') {
            outPath = await emitGraphNotes(plugin, file, outline);
            summary = `**Graph notes** saved under \`${outPath}\` — ${outline.sections.length + 1} interlinked notes.`;
        } else {
            outPath = await emitCanvas(plugin, file, outline);
            summary = `**Canvas** saved to \`${outPath}\` — ${outline.sections.length + 1} nodes around "${outline.center.title}".`;
        }
        const nodes = [`${pdfLink(file)} — **${outline.center.title}** — ${outline.center.summary}`]
            .concat(outline.sections.map((s) => `${pdfLink(file, s.page)} — **${s.title}** — ${s.summary}`))
            .map((line) => `- ${line}`)
            .join('\n');
        block?.setMarkdown(`${summary}\n\nOpen: [[${outPath}]].\n\n## Outline\n\n${nodes}`);
        block?.setDone();
        new Notice(`PDF++ AI: ${kind} saved to "${outPath}".`, 5000);
        plugin.app.workspace.openLinkText(outPath, '', false);
    } catch (e) {
        const msg = normalizeError(e).message;
        new Notice(`PDF++ AI: ${msg}`, 7000);
        block?.setError(`Emit failed: ${msg}`);
    }
}

function normalizeOutline(parsed: any): Outline {
    const center = parsed?.center ?? { title: 'Paper', summary: '' };
    const sections: OutlineSection[] = Array.isArray(parsed?.sections)
        ? parsed.sections.map((s: any, i: number) => ({ id: s.id ?? `s${i + 1}`, title: s.title ?? `Section ${i + 1}`, summary: s.summary ?? '', page: typeof s.page === 'number' ? s.page : undefined }))
        : [];
    return { center, sections };
}

function pdfLink(file: TFile, page?: number): string {
    return page ? `[[${file.name}#page=${page}]]` : `[[${file.name}]]`;
}

// --- Canvas emitter (JSON Canvas 1.0) ---

async function emitCanvas(plugin: PDFPlus, file: TFile, outline: Outline): Promise<string> {
    const dir = plugin.settings.ai.knowledgeMap.folder || file.parent?.path || '';
    const path = `${dir ? dir + '/' : ''}${file.basename}.canvas`;

    const nodes: any[] = [];
    const edges: any[] = [];

    // center = file node pointing at the PDF
    const centerId = 'center';
    nodes.push({ id: centerId, type: 'file', file: file.path, x: -350, y: -260, width: 700, height: 520, label: outline.center.title });

    const n = Math.max(outline.sections.length, 1);
    const R = 520;
    outline.sections.forEach((s, i) => {
        const ang = (2 * Math.PI * i) / n - Math.PI / 2;
        const x = Math.round(Math.cos(ang) * R) - 160;
        const y = Math.round(Math.sin(ang) * R) - 100;
        const text = `## ${s.title}\n\n${s.summary}\n\n${pdfLink(file, s.page)}`;
        const id = s.id;
        nodes.push({ id, type: 'text', x, y, width: 320, height: 200, text });
        edges.push({ id: `e-${id}`, fromNode: centerId, toNode: id, label: 'covers' });
    });

    const canvas = { nodes, edges, metadata: {} };
    await plugin.lib.write(path, JSON.stringify(canvas, null, 2), false);
    return path;
}

// --- Graph-notes emitter (one .md per node, interlinked + tagged) ---

async function emitGraphNotes(plugin: PDFPlus, file: TFile, outline: Outline): Promise<string> {
    const base = plugin.settings.ai.knowledgeMap.folder || file.parent?.path || '';
    const folder = `${base ? base + '/' : ''}${file.basename}`;
    // ensure folder
    if (plugin.app.vault.getAbstractFileByPath(folder) === null) {
        try { await plugin.app.vault.createFolder(folder); } catch { /* exists */ }
    }

    const indexPath = `${folder}/index.md`;
    const slugs = outline.sections.map((s) => slugify(s.title));

    // index note
    const indexLines: string[] = [`# ${outline.center.title}`, '', outline.center.summary, '', `PDF: ${pdfLink(file)}`, '', '## Sections', ''];
    outline.sections.forEach((s, i) => { indexLines.push(`- [[${slugs[i]}|${s.title}]]`); });
    indexLines.push('', '`#pdf-plus-ai/paper`');
    await plugin.lib.write(indexPath, indexLines.join('\n') + '\n', false);

    // per-section notes
    for (let i = 0; i < outline.sections.length; i++) {
        const s = outline.sections[i];
        const lines: string[] = [`# ${s.title}`, '', s.summary, '', `PDF: ${pdfLink(file, s.page)}`, '', `Back: [[index]]`, '', '`#pdf-plus-ai/section`'];
        await plugin.lib.write(`${folder}/${slugs[i]}.md`, lines.join('\n') + '\n', false);
    }
    return indexPath;
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'section';
}
