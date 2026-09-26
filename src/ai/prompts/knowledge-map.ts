import { EVIDENCE_RULES, JSON_RULES, languageInstruction, type OutputLanguage } from './shared';

export function outlineSystem(lang: OutputLanguage): string {
	return `Organize the supplied academic paper into a compact knowledge map for later retrieval.
${EVIDENCE_RULES}
Output schema: {"center":{"title":"paper title or supported short label","summary":"2–3 sentence overview"},"sections":[{"id":"s1","title":"specific concept or section title","summary":"1–2 sentence explanation","page":1}]}.
Use 5–8 sections when the source supports them, fewer when incomplete. Cover the research question, core mechanism, experimental evidence, limitations and contributions without duplicating the same claim. Titles should name concrete concepts rather than generic labels when possible. Summaries should explain their role in the paper's argument; distinguish cited background from this paper's own work.
Use unique stable IDs s1, s2, and so on, in paper reading order. Preserve the real paper title if available; do not invent a title, author or relationship. The page field is optional: include a positive integer only when the source p.N marker supports it; otherwise omit it. Never use a bibliography index or printed section number as a physical page number.
${languageInstruction(lang)}
${JSON_RULES}`;
}
