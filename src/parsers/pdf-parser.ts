import { readFile } from "node:fs/promises";
import pdfParse from "pdf-parse";
import type { FountainResult, FountainToken } from "./fountain-parser.js";

// Re-export for convenience so consumers can import from either module.
export type { FountainResult, FountainToken };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Scene heading prefixes (case-insensitive, after trimming). */
const SCENE_HEADING_RE = /^\s*(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)\s*/i;

/**
 * Common transition patterns.
 * Matches lines ending with "TO:" and well-known named transitions.
 */
const TRANSITION_ENDINGS_RE = /\bTO:$/;
const NAMED_TRANSITIONS = new Set([
  "CUT TO:",
  "SMASH CUT TO:",
  "MATCH CUT TO:",
  "JUMP CUT TO:",
  "DISSOLVE TO:",
  "FADE IN:",
  "FADE OUT.",
  "FADE OUT:",
  "FADE TO BLACK.",
  "FADE TO BLACK:",
  "FADE TO WHITE.",
  "FADE TO WHITE:",
  "WIPE TO:",
  "IRIS IN:",
  "IRIS OUT.",
  "IRIS OUT:",
  "TIME CUT:",
]);

/**
 * Heuristic: a line is a character cue if it is ALL CAPS (ignoring
 * parenthetical extensions like "(V.O.)" or "(O.S.)"), at least 2
 * characters long, and not a scene heading or transition.
 */
const CHARACTER_CUE_RE = /^[A-Z][A-Z0-9 .'\-/]+(\s*\(.*\))?$/;

/**
 * Lines that look like page numbers commonly emitted by PDF renderers.
 */
const PAGE_NUMBER_RE = /^\s*\d{1,4}\s*\.?\s*$/;

// ---------------------------------------------------------------------------
// Raw text extraction
// ---------------------------------------------------------------------------

/**
 * Extract the full text content from a PDF screenplay file.
 *
 * @param filePath - Absolute or relative path to a `.pdf` file.
 * @returns The concatenated plain-text content of every page.
 * @throws If the file cannot be read or is not a valid PDF.
 */
export async function parsePdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const result = await pdfParse(buffer);
  return result.text;
}

// ---------------------------------------------------------------------------
// Heuristic tokenizer
// ---------------------------------------------------------------------------

/**
 * Determine whether a trimmed, non-empty line is a transition.
 */
function isTransition(line: string): boolean {
  const upper = line.toUpperCase();
  if (TRANSITION_ENDINGS_RE.test(upper)) return true;
  if (NAMED_TRANSITIONS.has(upper)) return true;
  return false;
}

/**
 * Determine whether a trimmed, non-empty line looks like a scene heading.
 */
function isSceneHeading(line: string): boolean {
  return SCENE_HEADING_RE.test(line);
}

/**
 * Determine whether a trimmed, non-empty line looks like a character cue.
 * Must NOT also be a scene heading or transition.
 */
function isCharacterCue(line: string): boolean {
  if (isSceneHeading(line)) return false;
  if (isTransition(line)) return false;
  if (PAGE_NUMBER_RE.test(line)) return false;
  // Character names are typically short-ish; reject very long lines.
  if (line.length > 60) return false;
  return CHARACTER_CUE_RE.test(line.trim());
}

/**
 * Detect whether a line is a parenthetical (e.g. "(softly)").
 */
function isParenthetical(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("(") && trimmed.endsWith(")");
}

/**
 * Extract screenplay text from a PDF and apply format-agnostic heuristics
 * to produce the same `FountainResult` shape that `parseFountain` returns.
 *
 * Because PDF extraction loses explicit formatting metadata, the heuristics
 * are necessarily best-effort.  They work well on industry-standard
 * screenplay PDFs (Final Draft, WriterSolo, Highland, etc.) but may
 * misclassify some elements in heavily stylised documents.
 *
 * @param filePath - Path to a `.pdf` screenplay file.
 * @returns A `FountainResult` with heuristically classified tokens.
 */
export async function parsePdfToTokens(
  filePath: string,
): Promise<FountainResult> {
  const rawText = await parsePdf(filePath);
  const lines = rawText.split(/\r?\n/);

  const tokens: FountainToken[] = [];

  // Title-page heuristic: the very first non-blank lines before the first
  // scene heading are treated as the title block.  We try to extract a
  // title, credit, and author from them.
  let title = "";
  let credit = "";
  let author = "";
  let titleBlockDone = false;
  const titleBlockLines: string[] = [];

  // State machine for dialogue grouping.
  let expectDialogue = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip empty lines -- they reset the dialogue expectation.
    if (trimmed.length === 0) {
      expectDialogue = false;
      continue;
    }

    // Skip page numbers.
    if (PAGE_NUMBER_RE.test(trimmed)) {
      continue;
    }

    // --- Title block collection (before first scene heading) ---
    if (!titleBlockDone) {
      if (isSceneHeading(trimmed)) {
        titleBlockDone = true;
        // Parse collected title block.
        parseTitleBlock(titleBlockLines, (t, c, a) => {
          title = t;
          credit = c;
          author = a;
        });
        // Fall through so this line gets processed as a scene heading.
      } else {
        titleBlockLines.push(trimmed);
        continue;
      }
    }

    // --- Scene heading ---
    if (isSceneHeading(trimmed)) {
      expectDialogue = false;
      tokens.push({ type: "scene_heading", text: trimmed });
      continue;
    }

    // --- Transition ---
    if (isTransition(trimmed)) {
      expectDialogue = false;
      tokens.push({ type: "transition", text: trimmed });
      continue;
    }

    // --- Parenthetical (only valid within dialogue context) ---
    if (expectDialogue && isParenthetical(trimmed)) {
      tokens.push({ type: "parenthetical", text: trimmed });
      // Stay in dialogue mode.
      continue;
    }

    // --- Dialogue (indented text after a character cue) ---
    if (expectDialogue) {
      tokens.push({ type: "dialogue", text: trimmed });
      // Dialogue can span multiple contiguous non-blank lines.
      continue;
    }

    // --- Character cue ---
    if (isCharacterCue(trimmed)) {
      tokens.push({ type: "character", text: trimmed });
      expectDialogue = true;
      continue;
    }

    // --- Everything else is action ---
    tokens.push({ type: "action", text: trimmed });
  }

  // If there was never a scene heading, the title block was never
  // committed.  Handle that edge case.
  if (!titleBlockDone && titleBlockLines.length > 0) {
    parseTitleBlock(titleBlockLines, (t, c, a) => {
      title = t;
      credit = c;
      author = a;
    });
  }

  return { title, credit, author, tokens };
}

// ---------------------------------------------------------------------------
// Title block helpers
// ---------------------------------------------------------------------------

/**
 * Very rough heuristic to pull title / credit / author from the lines
 * that precede the first scene heading in a PDF screenplay.
 *
 * Common patterns:
 *   Line 1: TITLE
 *   Line 2: "Written by" | "Screenplay by" | "by"  (credit)
 *   Line 3: Author Name
 */
function parseTitleBlock(
  lines: string[],
  cb: (title: string, credit: string, author: string) => void,
): void {
  if (lines.length === 0) {
    cb("", "", "");
    return;
  }

  let title = lines[0] ?? "";
  let credit = "";
  let author = "";

  for (let i = 1; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (
      lower.startsWith("written by") ||
      lower.startsWith("screenplay by") ||
      lower === "by"
    ) {
      credit = lines[i];
      // The next non-empty line is likely the author.
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().length > 0) {
          author = lines[j].trim();
          break;
        }
      }
      break;
    }
  }

  cb(title, credit, author);
}
