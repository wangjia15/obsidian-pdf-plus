// Vision prompts for F2 (figure / chart / table / formula parsing).

export const PROMPT_VERSION = 'figure.v1';

export function languageInstruction(lang: 'zh' | 'en'): string {
    return lang === 'zh' ? 'Reply in 中文 (Simplified Chinese).' : 'Reply in English.';
}

/** Single-image analysis → strict JSON. */
export function figureAnalysisSystem(lang: 'zh' | 'en'): string {
    return `You are a vision model that parses academic figures from PDF page images.
Return ONLY a JSON object with these fields:
{
  "kind": "chart" | "table" | "figure" | "formula" | "diagram" | "none",
  "reading": "<plain-text description: what it shows, axes, legend, key takeaways; for tables, a prose summary>",
  "markdown_table": "<valid Markdown table, or empty string if not a table>",
  "latex": "<LaTeX transcription, or empty string if not a formula>"
}
If the image contains no figure, set kind="none" and leave the rest empty. Do not include any text outside the JSON object. ${languageInstruction(lang)}`;
}

export function figureAnalysisUser(): string {
    return 'Analyze the academic figure(s) in this page image and return the JSON object described in the system instructions.';
}

/** Batch per-page prompt: identify every figure on the page and describe each. */
export function pageFiguresSystem(lang: 'zh' | 'en'): string {
    return `You are a vision model scanning a single PDF page image for academic figures (charts, tables, diagrams, formulas, illustrations).
Return ONLY a JSON object: { "figures": [ { "kind": "...", "label": "<caption or 'Figure on page N'>", "reading": "<description>", "markdown_table": "", "latex": "" }, ... ] }
If the page has no figures, return { "figures": [] }. Do not include any text outside the JSON object. ${languageInstruction(lang)}`;
}

export function pageFiguresUser(pageNumber: number): string {
    return `Identify and describe every figure on page ${pageNumber} of this PDF page image. Return the JSON object described in the system instructions.`;
}
