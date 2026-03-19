// ---------------------------------------------------------------------------
// Shot Planner -- breaks a Scene into an ordered sequence of camera shots.
//
// Analyses the scene's action beats, dialogue exchanges, and emotional
// cues to produce a cinematically sensible shot list that a prompt builder
// can turn into image-generation prompts.
// ---------------------------------------------------------------------------

import type { Scene, DialogueLine } from "../parsers/scene-extractor.js";

// ---- Public types ---------------------------------------------------------

export type ShotType =
  | "extreme-wide"
  | "wide"
  | "medium-wide"
  | "medium"
  | "medium-close-up"
  | "close-up"
  | "extreme-close-up"
  | "insert";

export type CameraAngle =
  | "eye-level"
  | "low-angle"
  | "high-angle"
  | "dutch-angle"
  | "birds-eye"
  | "worms-eye";

export type CameraMovement =
  | "static"
  | "pan-left"
  | "pan-right"
  | "tilt-up"
  | "tilt-down"
  | "dolly-in"
  | "dolly-out"
  | "tracking"
  | "crane"
  | "handheld"
  | "rack-focus";

export interface Shot {
  shotNumber: number;
  type: ShotType;
  angle: CameraAngle;
  movement: CameraMovement;
  lens: string;
  characters: string[];
  focusCharacter?: string;
  action: string;
  dialogue?: string;
  transitionIn?: string;
  transitionOut?: string;
  notes: string;
}

// ---- Lens mapping ---------------------------------------------------------

const LENS_BY_SHOT_TYPE: Record<ShotType, string> = {
  "extreme-wide": "14mm ultra-wide",
  wide: "24mm wide",
  "medium-wide": "35mm standard",
  medium: "50mm standard",
  "medium-close-up": "50mm standard",
  "close-up": "85mm portrait",
  "extreme-close-up": "100mm macro",
  insert: "100mm macro",
};

// ---- Keyword sets for heuristic classification ----------------------------

const EMOTIONAL_KEYWORDS = new Set([
  "tears",
  "crying",
  "cries",
  "weeps",
  "sobbing",
  "screams",
  "whispers",
  "trembles",
  "shaking",
  "heartbreak",
  "anguish",
  "devastated",
  "shock",
  "stunned",
  "gasps",
  "smiles",
  "laughs",
  "grins",
  "kisses",
  "embraces",
  "holds",
  "hugs",
  "love",
  "fear",
  "terror",
  "horror",
  "rage",
  "fury",
  "anger",
  "joy",
  "elation",
]);

const ACTION_KEYWORDS = new Set([
  "runs",
  "chases",
  "fights",
  "punches",
  "kicks",
  "ducks",
  "jumps",
  "climbs",
  "crashes",
  "explodes",
  "fires",
  "shoots",
  "falls",
  "leaps",
  "dives",
  "rolls",
  "sprints",
  "charges",
  "tackles",
  "slams",
  "breaks",
  "smashes",
  "throws",
  "dodges",
]);

const INSERT_KEYWORDS = new Set([
  "letter",
  "note",
  "phone",
  "screen",
  "photo",
  "photograph",
  "document",
  "newspaper",
  "headline",
  "clock",
  "watch",
  "ring",
  "key",
  "gun",
  "weapon",
  "knife",
  "blood",
  "hand",
  "envelope",
  "map",
  "badge",
  "wallet",
  "glass",
  "bottle",
  "pill",
  "syringe",
  "book",
  "diary",
  "mirror",
  "sign",
]);

const DISSOLVE_KEYWORDS = new Set([
  "later",
  "hours pass",
  "time passes",
  "morning",
  "sunset",
  "dawn",
  "dusk",
  "next day",
  "the following",
  "weeks",
  "months",
  "years",
]);

const MATCH_CUT_KEYWORDS = new Set([
  "match cut",
  "smash cut",
  "match on",
]);

// ---- Helpers --------------------------------------------------------------

/**
 * Check whether a text block contains any word from a keyword set.
 */
function containsKeyword(text: string, keywords: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/**
 * Extract potential object insert subjects from an action line.
 */
function findInsertSubjects(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const kw of INSERT_KEYWORDS) {
    if (lower.includes(kw)) {
      found.push(kw);
    }
  }
  return found;
}

/**
 * Determine the default transition OUT for a shot based on surrounding text.
 */
function inferTransitionOut(
  actionText: string,
  isLastInScene: boolean,
): string | undefined {
  if (containsKeyword(actionText, MATCH_CUT_KEYWORDS)) return "MATCH CUT";
  if (containsKeyword(actionText, DISSOLVE_KEYWORDS)) return "DISSOLVE";
  if (isLastInScene) return undefined; // scene boundary handled externally
  return "CUT";
}

/**
 * Infer whether a scene heading indicates an exterior location.
 * Parses the heading for INT/EXT prefixes.
 */
function isExterior(heading: string): boolean {
  const upper = heading.toUpperCase().trim();
  // EXT. or EXT/INT. -- exterior establishing shots
  return upper.startsWith("EXT.") || upper.startsWith("EXT/INT");
}

/**
 * Split action text into discrete beats (paragraphs or sentences that
 * represent distinct visual moments).
 */
function splitActionBeats(actionLines: string[]): string[] {
  // Each element of the action array is already a paragraph from the parser.
  // If a single paragraph is very long, split on sentence boundaries.
  const beats: string[] = [];

  for (const paragraph of actionLines) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // If the paragraph is short enough, treat it as one beat.
    if (trimmed.length < 200) {
      beats.push(trimmed);
      continue;
    }

    // Split long paragraphs on sentence boundaries.
    const sentences = trimmed
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (sentences.length > 1) {
      beats.push(...sentences);
    } else {
      beats.push(trimmed);
    }
  }

  return beats.length > 0 ? beats : [];
}

/**
 * Extract character names mentioned in an action beat. Matches known
 * scene characters by checking for their names (case-insensitive) in
 * the beat text.
 */
function findCharactersInBeat(
  beat: string,
  knownCharacters: string[],
): string[] {
  const upperBeat = beat.toUpperCase();
  return knownCharacters.filter((c) => upperBeat.includes(c.toUpperCase()));
}

// ---- Dialogue grouping ----------------------------------------------------

/**
 * Group sequential dialogue lines into exchanges. An exchange is a
 * contiguous block of dialogue lines between 2 or more speakers.
 * A single-speaker monologue becomes its own exchange.
 */
function groupDialogueExchanges(
  dialogue: DialogueLine[],
): DialogueLine[][] {
  if (dialogue.length === 0) return [];

  const speakers = new Set(dialogue.map((d) => d.character));

  // Single speaker -- each line is its own exchange.
  if (speakers.size === 1) {
    return dialogue.map((d) => [d]);
  }

  // Multiple speakers -- group into contiguous exchanges. Start a new
  // exchange when the set of active speakers grows large (3+) and the
  // current group is already substantial.
  const exchanges: DialogueLine[][] = [];
  let current: DialogueLine[] = [];

  for (const line of dialogue) {
    current.push(line);

    const currentSpeakers = new Set(current.map((d) => d.character));
    if (currentSpeakers.size >= 3 && current.length >= 6) {
      exchanges.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    exchanges.push(current);
  }

  return exchanges;
}

// ---- Core planning --------------------------------------------------------

/**
 * Plan a sequence of camera shots for a given scene.
 *
 * The planner follows classical cinematographic conventions:
 *
 * 1. Every scene opens with an establishing shot (extreme-wide or wide).
 * 2. Action beats get wide-to-medium coverage with dynamic camera movement.
 * 3. Dialogue exchanges are covered with a two-shot opener followed by
 *    over-the-shoulder singles alternating between speakers.
 * 4. Emotional moments receive close-ups or extreme close-ups.
 * 5. Important objects mentioned in action text receive insert shots.
 * 6. Transitions default to CUT; DISSOLVE is used for time passages and
 *    MATCH CUT where the screenplay indicates one.
 */
export function planShots(scene: Scene): Shot[] {
  const shots: Shot[] = [];
  let shotCounter = 0;

  const push = (partial: Omit<Shot, "shotNumber">): void => {
    shotCounter++;
    shots.push({ shotNumber: shotCounter, ...partial });
  };

  const exterior = isExterior(scene.heading);

  // ---- 1. Establishing shot ------------------------------------------------

  push({
    type: exterior ? "extreme-wide" : "wide",
    angle: "eye-level",
    movement: exterior ? "crane" : "dolly-in",
    lens: exterior
      ? LENS_BY_SHOT_TYPE["extreme-wide"]
      : LENS_BY_SHOT_TYPE["wide"],
    characters: scene.characters.slice(0, 3),
    action: `Establishing shot: ${scene.heading}`,
    transitionIn: "CUT",
    notes: `Establish location: ${scene.location}, ${scene.timeOfDay}.`,
  });

  // ---- 2. Action beats -----------------------------------------------------

  if (scene.action.length > 0) {
    const beats = splitActionBeats(scene.action);

    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const beatCharacters = findCharactersInBeat(beat, scene.characters);
      const isLast = i === beats.length - 1 && scene.dialogue.length === 0;

      // Emotional beat
      if (containsKeyword(beat, EMOTIONAL_KEYWORDS)) {
        const focus = beatCharacters[0];
        push({
          type: "close-up",
          angle: "eye-level",
          movement: "dolly-in",
          lens: LENS_BY_SHOT_TYPE["close-up"],
          characters: beatCharacters,
          focusCharacter: focus,
          action: beat,
          transitionOut: inferTransitionOut(beat, isLast),
          notes: "Emotional beat -- close-up to capture performance.",
        });
        continue;
      }

      // Insert shot for important objects
      const insertSubjects = findInsertSubjects(beat);
      if (insertSubjects.length > 0) {
        push({
          type: "insert",
          angle: "high-angle",
          movement: "static",
          lens: LENS_BY_SHOT_TYPE["insert"],
          characters: [],
          action: `Insert: ${insertSubjects.join(", ")} -- ${beat}`,
          transitionOut: inferTransitionOut(beat, isLast),
          notes: `Insert shot of: ${insertSubjects.join(", ")}.`,
        });

        // Reaction shot if characters are present
        if (beatCharacters.length > 0) {
          push({
            type: "medium-close-up",
            angle: "eye-level",
            movement: "static",
            lens: LENS_BY_SHOT_TYPE["medium-close-up"],
            characters: beatCharacters,
            focusCharacter: beatCharacters[0],
            action: `Reaction to ${insertSubjects.join(", ")}`,
            transitionOut: inferTransitionOut(beat, isLast),
            notes: "Reaction shot following insert.",
          });
        }
        continue;
      }

      // Physical action beat
      if (containsKeyword(beat, ACTION_KEYWORDS)) {
        push({
          type: beatCharacters.length > 2 ? "wide" : "medium-wide",
          angle: "eye-level",
          movement: "tracking",
          lens:
            beatCharacters.length > 2
              ? LENS_BY_SHOT_TYPE["wide"]
              : LENS_BY_SHOT_TYPE["medium-wide"],
          characters: beatCharacters,
          focusCharacter: beatCharacters[0],
          action: beat,
          transitionOut: inferTransitionOut(beat, isLast),
          notes: "Action coverage with tracking camera.",
        });
        continue;
      }

      // Default action beat
      push({
        type: beatCharacters.length > 2 ? "medium-wide" : "medium",
        angle: "eye-level",
        movement: "static",
        lens:
          beatCharacters.length > 2
            ? LENS_BY_SHOT_TYPE["medium-wide"]
            : LENS_BY_SHOT_TYPE["medium"],
        characters: beatCharacters,
        focusCharacter: beatCharacters[0],
        action: beat,
        transitionOut: inferTransitionOut(beat, isLast),
        notes: "Standard coverage.",
      });
    }
  }

  // ---- 3. Dialogue coverage ------------------------------------------------

  if (scene.dialogue.length > 0) {
    const exchanges = groupDialogueExchanges(scene.dialogue);

    for (const exchange of exchanges) {
      const speakers = [...new Set(exchange.map((d) => d.character))];

      // Two-shot opener for conversations with 2+ speakers
      if (speakers.length >= 2) {
        push({
          type: "medium",
          angle: "eye-level",
          movement: "static",
          lens: LENS_BY_SHOT_TYPE["medium"],
          characters: speakers.slice(0, 2),
          action: `Two-shot: ${speakers[0]} and ${speakers[1]} in conversation.`,
          dialogue: exchange[0].text,
          transitionOut: "CUT",
          notes: "Two-shot opener for dialogue exchange.",
        });
      }

      // OTS singles for each line
      for (let i = 0; i < exchange.length; i++) {
        const line = exchange[i];
        const otherSpeaker = speakers.find((s) => s !== line.character);
        const isEmotionalLine = containsKeyword(
          line.text + (line.parenthetical ?? ""),
          EMOTIONAL_KEYWORDS,
        );
        const isLastLine =
          i === exchange.length - 1 &&
          exchange === exchanges[exchanges.length - 1];

        if (isEmotionalLine) {
          push({
            type: "close-up",
            angle: "eye-level",
            movement: "dolly-in",
            lens: LENS_BY_SHOT_TYPE["close-up"],
            characters: [line.character],
            focusCharacter: line.character,
            action: line.parenthetical
              ? `${line.character} (${line.parenthetical})`
              : `${line.character} speaks with intensity.`,
            dialogue: line.text,
            transitionOut: inferTransitionOut(line.text, isLastLine),
            notes: "Emotional close-up during dialogue.",
          });
        } else {
          const shotCharacters = otherSpeaker
            ? [line.character, otherSpeaker]
            : [line.character];

          push({
            type: "medium-close-up",
            angle: "eye-level",
            movement: "static",
            lens: LENS_BY_SHOT_TYPE["medium-close-up"],
            characters: shotCharacters,
            focusCharacter: line.character,
            action: otherSpeaker
              ? `OTS ${otherSpeaker}, favoring ${line.character}.`
              : `Single on ${line.character}.`,
            dialogue: line.text,
            transitionOut: inferTransitionOut(line.text, isLastLine),
            notes: otherSpeaker
              ? `Over-the-shoulder from ${otherSpeaker}'s perspective.`
              : "Single shot -- no reverse needed.",
          });
        }
      }
    }
  }

  // ---- 4. Wire up transition chains ----------------------------------------

  for (let i = 0; i < shots.length; i++) {
    if (i > 0 && !shots[i].transitionIn) {
      shots[i].transitionIn = shots[i - 1].transitionOut ?? "CUT";
    }
    if (!shots[i].transitionOut && i < shots.length - 1) {
      shots[i].transitionOut = "CUT";
    }
  }

  return shots;
}
