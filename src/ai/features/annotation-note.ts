// Shared Markdown contract for PDF++ backlinks and K-Plex note-to-section content.
import type { AnnotationProposal } from '../ui/review-modal';
import type { Located } from './quote-locator';

export interface PaperSection {
	title: string;
	level: number;
	page: number;
	beginIndex: number;
}

export function comparePosition(a: { page: number; beginIndex: number }, b: { page: number; beginIndex: number }): number {
	return a.page - b.page || a.beginIndex - b.beginIndex;
}

function singleLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
/** PDF++ native annotation callouts, grouped under the paper's heading hierarchy. */
export function renderAnnotationNote(
	title: string,
	sourcePath: string,
	sections: PaperSection[],
	annotations: AnnotationProposal[],
	linkFor: (location: Located, alias: string) => string,
	colorNameFor: (proposal: AnnotationProposal) => string,
	calloutType = 'PDF',
): string {
	const ordered = [...sections].sort(comparePosition);
	const buckets = ordered.map(() => [] as AnnotationProposal[]);
	const unsectioned: AnnotationProposal[] = [];
	for (const proposal of [...annotations].sort((a, b) => a.located && b.located ? comparePosition(a.located, b.located) : 0)) {
		if (!proposal.located) continue;
		let at = -1;
		for (let i = 0; i < ordered.length; i++) {
			if (comparePosition(ordered[i], proposal.located) <= 0) at = i;
			else break;
		}
		(at < 0 ? unsectioned : buckets[at]).push(proposal);
	}
	const lines = ['---', 'pdf-plus-ai: annotations', 'schema-version: 2', `source-pdf: ${JSON.stringify(sourcePath)}`, 'tags: [pdf-plus-ai/annotations]', '---', '', `# ${singleLine(title)}`, ''];
	const render = (items: AnnotationProposal[]) => {
		for (const p of items) {
			if (!p.located) continue;
			const colorName = singleLine(colorNameFor(p)).replace(/[\]|]/g, '').toLowerCase() || 'note';
			const basename = sourcePath.split('/').pop()?.replace(/\.pdf$/i, '') ?? title;
			const alias = `${basename}, p.${p.located.page}`;
			const link = linkFor(p.located, alias).replace(/^!/, '');
			lines.push(`> [!${calloutType}|${colorName}] ${link}`, `> > ${singleLine(p.located.matchedText || p.quote)}`, '>',
				`> **AI · ${p.category}**：${singleLine(p.comment)}`, '');
		}
	};
	if (unsectioned.length || !ordered.length) { lines.push('## 批注 / Annotations', ''); render(unsectioned); }
	ordered.forEach((section, i) => {
		lines.push(`${'#'.repeat(Math.min(6, Math.max(2, section.level + 1)))} ${singleLine(section.title)}`, '');
		render(buckets[i]);
	});
	lines.push('');
	return lines.join('\n');
}
