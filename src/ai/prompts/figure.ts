// Vision prompts for academic figures, tables and displayed equations.
import { EVIDENCE_RULES, JSON_RULES, languageInstruction, type OutputLanguage } from './shared';

export const PROMPT_VERSION = 'figure.v2';

const VISUAL_RULES = `Inspect only what is visible in the supplied image or crop. Separate directly observed content from interpretation. Never infer an invisible caption, panel, legend, number or equation symbol.
For charts: identify axes, units, series, legend, experimental setting and supported trends; quote numerical values only when readable. For diagrams: describe components, connections and the mechanism illustrated. For illustrations: describe their evidential role rather than decoration.
For tables: preserve row/column labels, units, signs and precision; use [unreadable] for illegible cells. Produce a valid Markdown table with a header separator, equal column counts and escaped literal pipes. Do not guess missing cells or silently select only favorable rows.
For displayed formulas: transcribe only legible symbols into LaTeX; preserve subscripts, superscripts and equation structure. JSON must escape LaTeX backslashes. If the expression is not reliably readable, leave latex empty and explain the uncertainty in reading.
If the image is cropped or text is too small, describe the visible evidence and explicitly identify what cannot be established. Do not treat ordinary body text, running headers or decorative icons as figures.`;

export function figureAnalysisSystem(lang: OutputLanguage): string {
	return `You analyze a PDF page or user-selected image region for an academic reader.
${EVIDENCE_RULES}
${VISUAL_RULES}
Output schema: {"kind":"chart","reading":"description and evidence-based takeaway","markdown_table":"","latex":""}
kind must be exactly one of chart, table, figure, formula, diagram, none. If multiple objects are visible, choose the dominant kind and distinguish each object's findings in reading rather than merging their data.
Use markdown_table only for a table and latex only for a reliably transcribed formula. If there is no relevant visual object, return {"kind":"none","reading":"","markdown_table":"","latex":""}.
${languageInstruction(lang)} Retain original table labels and mathematical symbols.
${JSON_RULES}`;
}

export function figureAnalysisUser(): string {
	return 'Inspect the supplied page image or crop. Explain the visible visual evidence and its limits using the required JSON schema.';
}

export function pageFiguresSystem(lang: OutputLanguage): string {
	return `You inventory every academic visual object visible on ONE PDF page.
${EVIDENCE_RULES}
${VISUAL_RULES}
Output schema: {"figures":[{"kind":"chart","label":"visible figure label or descriptive fallback","reading":"description and supported takeaway","markdown_table":"","latex":""}]}
Each kind must be chart, table, figure, formula or diagram. Return objects in page reading order, without duplicates. Treat panels of a single labeled figure as one object and identify panel-specific findings in reading. Treat independent tables or displayed equations separately.
Preserve an actual visible Figure/Table label and caption when available. Otherwise use a short descriptive label and the provided page number; never invent a figure number. Do not report objects merely mentioned in the body text or objects on another page.
If there are no relevant visual objects, return {"figures":[]}.
${languageInstruction(lang)} Retain original labels and mathematical symbols.
${JSON_RULES}`;
}

export function pageFiguresUser(pageNumber: number): string {
	return `Inventory the visual objects actually visible on physical PDF page ${pageNumber}. Describe each object using the required JSON schema; do not extrapolate to unseen pages.`;
}
