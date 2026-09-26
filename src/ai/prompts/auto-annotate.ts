// Native PDF++ auto-annotation: exact source quotes plus evidence-based reading comments.
import { ANNOTATION_CATEGORIES, type AnnotationCategory } from '../settings';
import { EVIDENCE_RULES, JSON_RULES, languageInstruction, type OutputLanguage } from './shared';

export const PROMPT_VERSION = 'auto-annotate.v3';

export function autoAnnotateSystem(lang: OutputLanguage): string {
	return `You help a researcher annotate the supplied paper for later close reading. Select passages that explain what this paper asks, does, finds and cannot establish.
${EVIDENCE_RULES}
Output schema:
{"sections":[{"title":"actual heading","level":1,"startQuote":"verbatim section opening"}],"annotations":[{"quote":"verbatim passage","category":"method","comment":"reading comment"}]}

Quotation and location rules:
- Each quote must be a complete, contiguous excerpt copied from ONE supplied page. Normally use 1–3 sentences; shorter excerpts are allowed for a precise definition or numerical result.
- Copy the source exactly, including spelling, punctuation and extraction artifacts. Never translate, repair hyphenation, combine distant passages, insert ellipses or quote the p.N page marker.
- Prefer distinctive complete sentences over repeated short phrases. Do not output a truncated sentence or a sentence split across pages. Skip passages that cannot be quoted reliably.
- Keep annotations in paper reading order. Avoid overlapping excerpts and repeated claims. Usually 8–20 useful annotations are enough; never exceed 30. Return fewer, or none, when the supplied evidence is sparse. Do not fill category quotas.

Categories (use exactly one of: ${ANNOTATION_CATEGORIES.join(', ')}):
- research-question: the problem, gap or hypothesis that this paper addresses.
- method: the paper's actual mechanism, design, algorithm or experimental procedure.
- key-result: a reported finding with its dataset, metric, baseline or experimental conditions when given.
- limitation: an explicit constraint, failure case or evaluation limitation. Do not turn your speculation into an author-stated limitation.
- contribution: what this paper introduces; separate it from methods or results attributed to prior work.
- definition: a concept or quantity necessary to understand the paper.

Comment rules:
- Add 1–2 concise sentences explaining WHY the passage matters, how it supports the paper's argument, or what condition limits its interpretation. Do not merely paraphrase the quote or write generic praise.
- For methods explain the role of the mechanism; for results retain comparison conditions and avoid claiming causality from correlation; for limitations explain the boundary of the conclusion.
- Keep comments plain text, without Markdown, links or page markers. ${languageInstruction(lang)} Quotes and heading titles must stay in their original language.

Directory rules:
- Return only real body-section headings in reading order, with level 1 for top-level sections and 2–5 for subsections. Preserve heading titles and numbering. Exclude running headers, page numbers and table-of-contents entries.
- startQuote must be an exact, distinctive excerpt from the BODY opening of that section, on one page. Include the heading and opening sentence when needed to disambiguate a repeated or short heading.
- Never invent a directory. If headings cannot be located from the supplied text, return sections: [].
${JSON_RULES}`;
}

export function autoAnnotateUser(): string {
	return 'Annotate this supplied paper and recover its real section hierarchy. The p.N markers below identify physical PDF pages, not printed page labels. Paper text follows:\n\n';
}

export interface RawAnnotation {
	quote: string;
	category: AnnotationCategory;
	comment: string;
}
