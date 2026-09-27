import { EVIDENCE_RULES, JSON_RULES, languageInstruction, type OutputLanguage } from './shared';

export const PROMPT_VERSION = 'full-reading.v2';

const BEGINNER_RULES = `Explain for a beginner who has not studied this field. For EVERY item, explain: what it says or shows; unfamiliar terms and symbols; the reasoning or mechanism step by step; why it matters to the paper; and the limits of the evidence. Use short sentences and concrete language. If a simple analogy helps, explicitly label it as an analogy. Do not merely paraphrase the source, say "as shown", or refer the reader to another unexplained item. Distinguish general educational background from claims established by this paper. Use several short paragraphs when necessary; explanation is plain text, with newlines allowed.`;

/** Second pass after annotating: translate each verbatim excerpt so the note keeps both languages. */
function translationRule(lang: OutputLanguage, field: string, source: string): string {
	const target = lang === 'zh' ? 'Simplified Chinese' : lang === 'en' ? 'English' : 'Simplified Chinese if the source is mainly English, or English if the source is mainly Chinese';
	return `After finishing the annotations, translate each ${source} into ${target} and put it in ${field}. The ${source} itself must stay verbatim in the original language, so the note is bilingual. Translate faithfully: preserve claim strength, negation, conditions, numbers, units, symbols and citation markers; keep standard acronyms. If the ${source} is already in ${target} or is empty, set ${field} to an empty string.`;
}

export function fullReadingTextSystem(lang: OutputLanguage): string {
	return `Provide thorough close-reading annotations of the CURRENT physical PDF page. This is dense reading support, not a shortlist of the paper's best passages.
${EVIDENCE_RULES}
${BEGINNER_RULES}
Output schema: {"sections":[{"title":"real heading","level":1,"startQuote":"verbatim section opening"}],"annotations":[{"quote":"verbatim excerpt","translation":"translation of quote","category":"method","explanation":"beginner explanation"}]}.
Cover every substantive paragraph or distinct claim on this page: motivation, mechanisms, definitions, assumptions, experiments, comparisons, limitations and conclusions. Avoid overlapping or redundant quotes. There is no whole-paper quota. Bibliography entries, running headers and purely administrative text need no annotation. If a page only contains such content, annotations may be empty.
Use category exactly one of research-question, method, key-result, limitation, contribution, definition. Do not misattribute related work to this paper.
Each quote must be a distinctive, contiguous excerpt copied EXACTLY from the CURRENT page, usually 1–3 complete sentences. Preserve extraction spelling and punctuation; do not repair, translate, insert ellipses, include p.N markers or splice excerpts from different pages. Adjacent-page context is for understanding only and must never be quoted as current-page evidence.
Return only real section headings beginning on the current page. Preserve numbering and titles, level 1 for top-level headings and 2–5 for subsections. startQuote must be a distinctive verbatim body-section opening on this page, not a table-of-contents entry. Do not invent sections.
For quantitative claims, explain the dataset, metric, baseline, direction of improvement and conditions. Distinguish a reported result from a causal claim. Dedicated image, table and displayed-equation analysis happens separately; focus these annotations on the prose and reasoning.
${languageInstruction(lang)} Keep quotes and section titles in their original language.
${translationRule(lang, 'translation', 'quote')}
${JSON_RULES}`;
}

export function fullReadingVisualSystem(lang: OutputLanguage): string {
	return `Inspect ONE complete PDF page image and explain ALL visible academic visual objects for a beginner.
${EVIDENCE_RULES}
${BEGINNER_RULES}
Output schema: {"visuals":[{"kind":"figure","title":"visible label or descriptive title","captionQuote":"verbatim readable caption, or empty string","captionTranslation":"translation of captionQuote","explanation":"beginner explanation","markdown_table":"","latex":"","bbox":[0.1,0.1,0.9,0.5]}]}.
Inventory every figure, chart, illustration, architecture/flow diagram, results table and independently displayed mathematical formula. Do not omit objects because they look less important. Ignore ordinary inline math, body text, running headers and decorative logos. Return objects in page reading order; group the panels of one labeled figure, but explain EACH panel and its relationship to the others. Report independent tables and displayed formulas separately. If there are no objects, return {"visuals":[]}.
kind must be figure, chart, diagram, table or formula. Retain visible Figure/Table/equation numbers. Never invent a label or use a number mentioned in body text as if its object were visible.
For EVERY image or diagram: describe what to look at, axes/units/legend or components/arrows, how to read it step by step, what the visible evidence supports, and what it does not establish.
For EVERY table: explain the task and datasets, each metric and whether higher/lower is better when supported, how to compare rows fairly, the main results and ablations, and caveats. Preserve numbers, units, signs and comparison conditions. Distinguish absolute differences from percentage changes. Bold text is not proof of statistical significance. Do not guess values; optional markdown_table must faithfully transcribe legible cells, using [unreadable] for illegible cells, with valid Markdown columns and escaped pipes.
For EVERY displayed formula: explain its purpose, each readable symbol, inputs/outputs, operations and intuition step by step, relevant assumptions, and its role in the method. A toy example must be labeled illustrative. Transcribe legible LaTeX into latex with JSON-escaped backslashes. Leave latex empty if symbols are uncertain and explain what is unreadable instead of guessing.
Use captionQuote only for a readable verbatim caption or nearby equation label on this page. bbox is OPTIONAL: if you can identify the object, give [left, top, right, bottom] in normalized coordinates 0–1, measured from the IMAGE top-left, enclosing only the object/caption. Omit bbox if uncertain. Never report a box outside the image.
${languageInstruction(lang)} Preserve original labels, table headers and mathematical symbols.
${translationRule(lang, 'captionTranslation', 'captionQuote')}
${JSON_RULES}`;
}
