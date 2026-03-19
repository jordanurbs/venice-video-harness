import { readFile } from "node:fs/promises";
import { Fountain, type Token } from "fountain-js";

/**
 * A single token extracted from a Fountain screenplay.
 * Mirrors the fountain-js Token shape but uses a plain object
 * so consumers are not coupled to the library's class hierarchy.
 */
export interface FountainToken {
  type: string;
  text?: string;
  scene_number?: string;
  is_title?: boolean;
  dual?: string;
  depth?: number;
}

/**
 * Structured result returned by both the Fountain parser and the
 * PDF-to-tokens heuristic parser, ensuring a single contract that
 * downstream code (scene-extractor, storyboard pipeline, etc.) can
 * depend on regardless of source format.
 */
export interface FountainResult {
  title: string;
  credit: string;
  author: string;
  tokens: FountainToken[];
}

/**
 * Strip simple HTML tags that fountain-js may inject into token text
 * (e.g. `<b>`, `<i>`, `<u>`, `<br />`).
 */
function stripHtml(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/<\/?[^>]+(>|$)/g, "").trim();
}

/**
 * Extract a title-page field value from the raw token list.
 *
 * fountain-js represents the title page as tokens whose `type` equals the
 * lowercased key name (e.g. "title", "credit", "author") and whose `text`
 * holds the value.  The `is_title` flag is `true` for all of them.
 */
function extractTitleField(tokens: Token[], key: string): string {
  const tok = tokens.find(
    (t) => t.is_title && t.type.toLowerCase() === key.toLowerCase(),
  );
  return stripHtml(tok?.text);
}

/**
 * Convert a library Token (class instance with methods) into a plain
 * FountainToken object.
 */
function toPlainToken(tok: Token): FountainToken {
  const plain: FountainToken = { type: tok.type };
  if (tok.text !== undefined) plain.text = stripHtml(tok.text);
  if (tok.scene_number !== undefined) plain.scene_number = tok.scene_number;
  if (tok.is_title !== undefined) plain.is_title = tok.is_title;
  if (tok.dual !== undefined) plain.dual = tok.dual;
  if (tok.depth !== undefined) plain.depth = tok.depth;
  return plain;
}

/**
 * Parse a `.fountain` file from disk and return a structured result.
 *
 * @param filePath - Absolute or relative path to a `.fountain` screenplay file.
 * @returns A `FountainResult` containing metadata and an ordered token array.
 * @throws If the file cannot be read or is not valid UTF-8 text.
 */
export async function parseFountain(filePath: string): Promise<FountainResult> {
  const raw = await readFile(filePath, "utf-8");

  const fountain = new Fountain();
  const script = fountain.parse(raw, true);

  const title = extractTitleField(script.tokens, "title");
  const credit = extractTitleField(script.tokens, "credit");
  const author = extractTitleField(script.tokens, "author");

  // Filter out purely structural tokens that carry no semantic content
  // (dialogue_begin, dialogue_end, dual_dialogue_begin, dual_dialogue_end,
  // spaces, page_break) so downstream consumers get a clean stream.
  const structuralTypes = new Set([
    "dialogue_begin",
    "dialogue_end",
    "dual_dialogue_begin",
    "dual_dialogue_end",
    "spaces",
    "page_break",
  ]);

  const tokens: FountainToken[] = script.tokens
    .filter((t) => !t.is_title && !structuralTypes.has(t.type))
    .map(toPlainToken);

  return { title, credit, author, tokens };
}
