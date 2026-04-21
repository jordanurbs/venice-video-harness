/**
 * THE GRAND PLUTONIAN — central config
 *
 * Single source of truth for palette, characters, shotlist, VO, and audio cues.
 * Every stage script (01..05) imports from here.
 */

import { resolve } from "node:path";

// ---- Project paths --------------------------------------------------------

export const PROJECT_DIR = resolve("output/grand-plutonian");
export const CHARACTERS_DIR = resolve(PROJECT_DIR, "characters");
export const SHOTS_DIR = resolve(PROJECT_DIR, "shots");
export const AUDIO_DIR = resolve(PROJECT_DIR, "audio");
export const BUILD_DIR = resolve(PROJECT_DIR, "build");
export const ARCHIVE_DIR = resolve(PROJECT_DIR, "archive");
export const JOURNAL_PATH = resolve(PROJECT_DIR, "BUILD_JOURNAL.md");

// ---- Models (locked for non-NA region; Seedance 2.0 family) --------------

export const MODELS = {
  imageGen: "seedream-v5-lite",
  imageEdit: "seedream-v5-lite-edit",
  i2vAtmosphere: "seedance-2-0-image-to-video",
  r2vCharacter: "seedance-2-0-reference-to-video",
  r2vMultiCharacter: "kling-o3-standard-reference-to-video", // 3+ char fallback
  ttsModel: "tts-kokoro",
  ttsVoice: "bm_george", // deep, deadpan British male
  musicModel: "elevenlabs-music",
  sfxModel: "elevenlabs-sound-effects-v2",
} as const;

// ---- Aesthetic bible ------------------------------------------------------

/**
 * Front-loaded style block. Per CLAUDE.md learning #2, this MUST appear at the
 * START of every prompt, not buried at the end. Keep it tight (<60 words for
 * Seedance prompts per learning #20, but image prompts can be slightly longer).
 */
export const STYLE_BLOCK = `
WES ANDERSON SPACE-AGE PASTEL: locked symmetric composition, dead-center subjects,
flat tableau staging, soft even pastel lighting (no hard shadows), painterly storybook
quality, 35mm film grain, low contrast, dusty-pink and plum and cream and brass color
palette with one cold deep-blue accent for the void of space, brass Art-Nouveau fixtures,
embroidered pink-and-mauve velvet, miniature-set dollhouse feel, dry deadpan
sincerity, cinematic 16:9.
`.trim().replace(/\s+/g, " ");

export const NEGATIVE_BLOCK = `
photorealistic, photograph, photo, hyper-realistic, gritty, modern, contemporary,
cinematic lens flare, motion blur, asymmetric composition, off-center subject,
saturated colors, neon, cyberpunk, bokeh, shallow depth of field, dutch angle, handheld.
`.trim().replace(/\s+/g, " ");

// ---- Palette (for reference; baked into STYLE_BLOCK) ---------------------

export const PALETTE = {
  dustyPink: "#E8B4C0",
  plum: "#5C3A4E",
  cream: "#F4E8D0",
  brass: "#C9A961",
  voidBlue: "#2A3950",
};

// ---- Characters -----------------------------------------------------------

export interface CharacterSpec {
  slug: string;          // dir name under characters/
  name: string;          // display name (used in panel/video prompts)
  shortName: string;     // for the @Image / panel call-outs
  age: string;
  gender: "male" | "female";
  description: string;   // single paragraph; goes after STYLE_BLOCK in ref prompts
  wardrobe: string;      // separately quotable
  seed: number;          // anchor seed for reproducibility across angles
}

export const CHARACTERS: CharacterSpec[] = [
  {
    slug: "wexley",
    name: "Sir Wexley Pemberton-Quinn",
    shortName: "Wexley",
    age: "67",
    gender: "male",
    description:
      "A 67-year-old former bond trader of refined British bearing, trim silver hair parted on the left, neat silver moustache, tortoiseshell horn-rimmed glasses, deep sad pale-blue eyes, slightly jowled, faintly amused mouth, sun-spotted hands. He carries himself with patrician stillness.",
    wardrobe:
      "A smoking jacket the dusty color of dried rosé wine with plum quilted lapels, a cream silk ascot at the throat, brass cufflinks, slate-grey trousers, oxblood velvet slippers, a leather portfolio of asset-backed securities tucked under one arm.",
    seed: 770101,
  },
  {
    slug: "constance",
    name: "Mlle. Constance Vermeer",
    shortName: "Constance",
    age: "34",
    gender: "female",
    description:
      "A 34-year-old deposed central banker of a small European principality, severe platinum-blonde bob cut sharply at the jawline, very pale ivory skin, narrow grey-green eyes, expressionless red-stained lips, posture of a chess piece. She speaks rarely and only via pocket-watch glance.",
    wardrobe:
      "A floor-length mauve travel cape buttoned at the collar with a single brass clasp, a high-collared cream blouse, a thin gold pocket watch on a long chain, plum kid-leather gloves, a small flat hat the color of crushed violets pinned at an exact angle.",
    seed: 770202,
  },
  {
    slug: "conductor",
    name: "Conductor Nikolai Bostromsky",
    shortName: "Conductor",
    age: "53",
    gender: "male",
    description:
      "A 53-year-old train conductor of the Eastern European old school, salt-and-pepper hair under his cap, a perfectly waxed twin-tip moustache, ruddy weathered cheeks, very small bright dark eyes, professional bearing, three paper tickets fanned crisply between his teeth.",
    wardrobe:
      "A navy double-breasted conductor's tunic with two columns of brass buttons, gold braid at the cuffs, white cotton gloves, a tall navy pillbox cap with a brass insignia (a stylized sunburst over a key), a brass pocket-watch chain across his chest.",
    seed: 770303,
  },
  {
    slug: "teddy",
    name: "Theodore Atwood",
    shortName: "Teddy",
    age: "31",
    gender: "male",
    // NOTE (2026-04-17, revision 2): Earlier adult-rewrite still produced a
    // Disney/Pixar-style illustration (round face, huge eyes, bowl haircut,
    // airbrushed cartoon skin) that clashed with the painterly-photograph look
    // of Wexley/Constance/Conductor. Teddy's Shot 5 read visibly cartoon-ish.
    // Rewritten with the same detail-vocabulary used for other characters:
    // specific adult features, photograph-adjacent descriptors, no "youthful"
    // or "round" or "very large eyes" phrasing that pulls seedream into
    // kids-book-illustration territory. Same wardrobe and silhouette preserved.
    description:
      "A 32-year-old adult man of slight wiry build, pale ivory complexion with faint dark undereye shadows, narrow intelligent dark-brown eyes, neat side-parted chestnut-brown hair, a thin clean-shaven jaw with a faint blue stubble shadow, high cheekbones, small unsmiling mouth, a faint dusting of freckles across the bridge of the nose, and the solemn formal posture of a perpetual doctoral candidate. Detailed adult features, photograph-adjacent painterly rendering matching the other principal characters.",
    wardrobe:
      "A crisp mustard-yellow short-trouser suit with brass buttons (worn as a personal sartorial eccentricity), mustard knee socks, polished brown lace-up oxfords, a small striped bowtie of plum and cream, a miniature monogrammed leather valise (initials T.A.) at his side, a wax-sealed letter clutched in both hands inscribed in copperplate 'TO BE OPENED ON PLUTO'.",
    seed: 770404,
  },
];

export function getCharacter(slug: string): CharacterSpec {
  const c = CHARACTERS.find(c => c.slug === slug);
  if (!c) throw new Error(`Unknown character slug: ${slug}`);
  return c;
}

// ---- Reference angles (4 per character) -----------------------------------

export const REFERENCE_ANGLES = [
  {
    key: "front",
    filename: "front.png",
    suffix:
      "front-facing portrait waist-up, looking directly at camera, perfectly centered, soft pastel studio lighting, plain pastel-cream backdrop, character reference sheet",
  },
  {
    key: "three-quarter",
    filename: "three-quarter.png",
    suffix:
      "three-quarter view portrait waist-up, 45 degree angle, soft pastel studio lighting, plain pastel-cream backdrop, character reference sheet",
  },
  {
    key: "profile",
    filename: "profile.png",
    suffix:
      "side-profile portrait waist-up, 90 degree angle, soft pastel studio lighting, plain pastel-cream backdrop, character reference sheet",
  },
  {
    key: "full-body",
    filename: "full-body.png",
    suffix:
      "full-body shot head-to-toe, standing dead center facing camera, hands at sides, soft pastel studio lighting, plain pastel-cream backdrop, character reference sheet",
  },
] as const;

// ---- Shotlist -------------------------------------------------------------

export type Routing =
  | { kind: "i2v" }                          // Seedance 2.0 i2v, no chars
  | { kind: "r2v"; characters: string[] }    // Seedance 2.0 R2V, 1-2 chars
  | { kind: "r2v-multi"; characters: string[] }; // Kling O3 R2V, 3+ chars

export interface ShotSpec {
  num: number;
  duration: "5s";
  panelPrompt: string;                       // for image generation
  videoPrompt: string;                       // for video generation
  routing: Routing;
  /** Optional title-card overlay burned in at assembly. */
  titleOverlay?: { text: string; sub?: string; position: "top" | "center" | "bottom" };
  notes?: string;
}

export const SHOTLIST: ShotSpec[] = [
  // ── Shot 1 ── Establishing locomotive ────────────────────────────────────
  {
    num: 1,
    duration: "5s",
    panelPrompt: [
      "A perfectly symmetric wide profile-side view of an ornate brass-and-dusty-pink",
      "Art-Nouveau steam locomotive of the early 1900s redesigned for outer space:",
      "polished brass dome, pink-and-cream lacquered body panels, plum velvet curtains",
      "in lit oval portholes, golden filigree along the running boards, no smokestack",
      "but a row of small brass rocket nozzles at the rear, pulling six matching sleeper",
      "carriages behind it. The train glides through a starfield from left to right,",
      "perfectly horizontal, dead-center in the frame. A small pale Pluto and its moon",
      "Charon visible on the right horizon line. Wide cinematic 16:9 aspect, painterly",
      "miniature feel, Wes Anderson tableau, no human figures.",
    ].join(" "),
    videoPrompt: [
      "Slow steady forward dolly. The pastel space locomotive glides smoothly left-to-right",
      "through the starfield, perfectly horizontal, brass nozzles emitting tiny puffs of",
      "warm-cream vapor. Pluto on the horizon line grows imperceptibly larger. Camera does",
      "not tilt, does not pan. Symmetric framing held the entire time.",
    ].join(" "),
    routing: { kind: "i2v" },
    titleOverlay: {
      text: "CHAPTER ONE",
      sub: "THE DEPARTURE",
      position: "center",
    },
  },

  // ── Shot 2 ── Dining car, all 4 characters ──────────────────────────────
  {
    num: 2,
    duration: "5s",
    panelPrompt: [
      "Perfectly symmetric wide-angle interior of a luxury train dining car redesigned",
      "for outer space. Four passengers seated dead center facing camera at one long",
      "table covered in dusty-pink linen with a single tall brass candelabra in the",
      "exact middle. From left to right: a 67-year-old refined gentleman in a dried-rosé",
      "smoking jacket and tortoiseshell glasses (Wexley); a 34-year-old severe platinum-bob",
      "woman in a mauve cape (Constance); a 53-year-old conductor in navy tunic and",
      "pillbox cap holding three tickets in his teeth (Conductor); a 31-year-old slight-statured",
      "adult man with a youthful round clean-shaven face, side-parted bowl haircut, wearing a crisp",
      "mustard-yellow short-trouser suit and knee socks as personal eccentricity, holding a wax-sealed envelope (Teddy). Four oval",
      "portholes behind them, each showing a different planet (Earth, Mars, Jupiter,",
      "Saturn) at the same exact size. Brass sconces, embroidered plum-velvet wall panels.",
      "Wide cinematic 16:9, dead-center symmetric Wes Anderson tableau composition.",
    ].join(" "),
    videoPrompt: [
      "Locked dead-center symmetric tableau. All four passengers stare deadpan into the",
      "lens, motionless except for one tiny synchronized blink at the 2-second mark. The",
      "candelabra's flames flicker very slightly. Behind them the four planets rotate",
      "almost imperceptibly. Camera does not move. No music.",
    ].join(" "),
    // NOTE: was r2v-multi (Kling O3) but Kling O3 standard R2V caps elements at 3
    // and we have 4 characters. The panel already shows all 4 perfectly composed,
    // so within a single 5s shot we can rely on i2v animation alone — no identity
    // drift risk inside a 5-second clip with no cuts. See BUILD_JOURNAL.
    routing: { kind: "i2v" },
  },

  // ── Shot 3 ── Wexley alone in compartment ───────────────────────────────
  {
    num: 3,
    duration: "5s",
    panelPrompt: [
      "Perfectly symmetric medium shot, dead-center. A refined elderly gentleman",
      "(Wexley) sits motionless in a private train sleeping compartment upholstered in deep",
      "plum velvet embroidered with brass-thread filigree. He balances a worn oxblood-leather",
      "document portfolio across his knees, gripped firmly with both hands; the front cover of",
      "the portfolio is embossed with a large prominent gold-and-orange Bitcoin logo (the",
      "circular Bitcoin symbol with the letter B and two vertical strokes through it,",
      "rendered as a beveled gold-foil emblem on the leather, dead-center on the portfolio,",
      "instantly recognizable). A pink-shaded brass reading lamp glows above his shoulder.",
      "Behind him an oval porthole shows the deep blue void of space and a single distant",
      "star. Cream antimacassar on the headrest behind him. Wes Anderson tableau, painterly,",
      "low contrast, 16:9.",
    ].join(" "),
    videoPrompt: [
      "Locked symmetric medium shot of @Image1 sitting motionless in the plum-velvet",
      "compartment, clutching the oxblood leather portfolio embossed with a prominent",
      "gold-and-orange Bitcoin logo on its front cover. Camera tilts slowly down to the",
      "Bitcoin logo on the portfolio for one full second, holding on it, then tilts slowly",
      "back up to his deadpan face. He does not move. The reading lamp glows steadily.",
    ].join(" "),
    routing: { kind: "r2v", characters: ["wexley"] },
  },

  // ── Shot 4 ── Constance hands watch to Conductor ────────────────────────
  {
    num: 4,
    duration: "5s",
    panelPrompt: [
      "Perfectly symmetric medium two-shot at a brass ticket podium inside a train",
      "vestibule. On the left, a young woman with a sharp platinum-blonde bob and a",
      "mauve travel cape (Constance) holds out a gold pocket-watch on a long chain.",
      "On the right, a moustachioed train conductor in a navy double-breasted tunic",
      "and brass-buttoned pillbox cap (Conductor) reaches with a white-gloved hand",
      "to receive the watch. The pocket-watch hangs glittering at the exact dead",
      "center of the frame between them. Both faces calm and deadpan, looking at",
      "each other across the watch. An arched brass-trimmed corridor recedes",
      "symmetrically behind them into a soft pink vanishing point. Wes Anderson",
      "tableau, low contrast, 16:9.",
    ].join(" "),
    videoPrompt: [
      "Locked symmetric two-shot. @Image1 (the platinum-bob woman in mauve cape) and",
      "@Image2 (the conductor in navy tunic and pillbox cap) stand motionless at the",
      "brass podium. The gold pocket watch passes between their gloved hands at the",
      "exact center of the frame in a slow handover. Both faces remain deadpan. Neither",
      "speaks. Camera does not move.",
    ].join(" "),
    routing: { kind: "r2v", characters: ["constance", "conductor"] },
  },

  // ── Shot 5 ── Teddy in observation lounge ───────────────────────────────
  {
    num: 5,
    duration: "5s",
    panelPrompt: [
      "Perfectly symmetric WIDE establishing shot of the empty interior of a luxury",
      "train observation lounge. Dead-center composition. A single empty pink-velvet",
      "bench sits in the exact dead center of the room, in front of a vast curved",
      "panoramic viewing window filling the entire back wall. Through the curved",
      "panoramic window, the planet Pluto looms enormous and pale grey-pink, filling",
      "two-thirds of the back wall, surface craters faintly visible. Tall brass",
      "railings frame the window. Polished dark-wood floor reflects the pale Pluto-light.",
      "Embroidered plum-velvet wall panels with brass-thread filigree on either side.",
      "A small monogrammed leather travel valise rests on the floor beside the bench.",
      "Wes Anderson dollhouse tableau, painterly, low contrast, vast quiet empty room",
      "facing a planet, no people present, 16:9.",
    ].join(" "),
    videoPrompt: [
      "Locked symmetric medium shot of @Image1 (the small boy in mustard suit) sitting",
      "perfectly still on the pink bench, holding the wax-sealed letter in both hands.",
      "Pluto behind him fills the window. He blinks exactly once at the 3-second mark,",
      "very slowly. The pale glow of Pluto pulses subtly. Camera does not move.",
    ].join(" "),
    routing: { kind: "r2v", characters: ["teddy"] },
  },

  // ── Shot 6 ── Title card ────────────────────────────────────────────────
  {
    num: 6,
    duration: "5s",
    panelPrompt: [
      "Perfectly symmetric wide rear three-quarter view of the same brass-and-dusty-pink",
      "Art-Nouveau space locomotive and its sleeper carriages from Shot 1, now seen",
      "receding away from camera into the dark side of Pluto. The rear lantern of the",
      "last carriage glows a warm soft pink. Pluto fills the upper two-thirds of the",
      "frame, vast and pale grey-pink with darker craters. A single small star above",
      "Pluto. Wide cinematic 16:9, painterly, deep void-blue background, no human",
      "figures, dead-center composition.",
    ].join(" "),
    videoPrompt: [
      "Slow steady push-out (camera reverses very slowly). The pastel space train recedes",
      "smoothly toward Pluto's dark side, growing tinier in perfect center frame. The",
      "rear lantern's warm pink glow fades very gradually. Pluto does not move. No",
      "human figures. No music — just the hum of the train.",
    ].join(" "),
    routing: { kind: "i2v" },
    titleOverlay: {
      text: "THE GRAND PLUTONIAN",
      sub: "THIS WINTER — A FILM ABOUT LEAVING",
      position: "center",
    },
  },
];

// ---- Voice-over (single track, ~30s read) --------------------------------

/**
 * Deadpan British male VO. Kokoro `bm_george` chosen for depth and dryness.
 * Target read: ~140 wpm (slightly slow, deliberate). Total ~28-30s.
 *
 * Beat pauses are encoded as ellipses; Kokoro respects them as breath gaps.
 */
/**
 * VO script (revision 4).
 *
 * Lessons learned from rev 3:
 *   - Kokoro reliably renders SINGLE ellipses ("..."). Doubled ellipses
 *     ("......") confuse it and can cause it to TRUNCATE the ending entirely
 *     (rev 3 dropped "a film about being inflated off the planet" silently).
 *   - Use single "..." for breath gaps and commas for sub-phrase rhythm.
 *
 * Each entry below is one caption row. Caption timings in `CAPTIONS` are
 * derived from ffmpeg silencedetect on the rendered VO — never hand-tuned.
 */
export const VO_TEXT = [
  "In the wake of the Big Print...",
  "when seven trillion dollars appeared, very politely, from nowhere...",
  "a small number of refined persons elected to depart...",
  "Not for another country...",
  "For another planet...",
  "The Grand Plutonian Sleeper Express departs Earth-Side Terminal...",
  "nightly at eleven forty-seven...",
  "First class only...",
  "Payments in Bitcoin only...",
  "No fiat accepted...",
  "Dress code, mournful...",
  "This winter... a film about being inflated off the planet.",
].join(" ");

/**
 * Caption rows for hardcoded burn-in subtitles. One row per VO phrase, with
 * start/end times in absolute trailer-time (BEFORE the Bitcoin first-frame
 * prepend — that adds the same 0.042s offset to both video and audio so
 * relative sync is preserved).
 *
 * Times are DERIVED from `ffmpeg silencedetect` on the rendered vo.mp3:
 *   ffmpeg -i audio/vo.mp3 -af "silencedetect=noise=-30dB:d=0.18" -f null -
 *
 * Mapping rule:
 *   caption.start = 1.5 (VO adelay in 05-assemble.ts) + vo_segment_start - 0.1 (lead-in)
 *   caption.end   = next caption.start - 0.05 (back-to-back, no gap)
 *   final caption.end = end-of-speech + ~1.5s (linger before title card)
 *
 * Last measured against vo.mp3 duration 27.264s, 13 detected speech segments
 * (2026-04-20).
 */
export const CAPTIONS: Array<{ text: string; start: number; end: number }> = [
  { text: "In the wake of the Big Print...",                        start: 1.72,  end: 3.14 },
  // Seg 2 split mid-phrase (proportional to syllable count) so each caption fits a single line at 38px.
  { text: "when seven trillion dollars appeared,",                  start: 3.19,  end: 4.89 },
  { text: "very politely, from nowhere...",                         start: 4.94,  end: 6.87 },
  { text: "a small number of refined persons elected to depart...", start: 6.92,  end: 10.06 },
  { text: "Not for another country...",                             start: 10.11, end: 11.51 },
  { text: "For another planet...",                                  start: 11.56, end: 12.76 },
  // Seg 6 split mid-phrase (same reason).
  { text: "The Grand Plutonian Sleeper Express",                    start: 12.81, end: 14.60 },
  { text: "departs Earth-Side Terminal...",                         start: 14.65, end: 16.42 },
  { text: "nightly at eleven forty-seven...",                       start: 16.47, end: 18.43 },
  { text: "First class only...",                                    start: 18.48, end: 19.79 },
  { text: "Payments in Bitcoin only...",                            start: 19.84, end: 21.47 },
  { text: "No fiat accepted...",                                    start: 21.52, end: 23.03 },
  { text: "Dress code, mournful...",                                start: 23.08, end: 24.64 },
  { text: "This winter...",                                         start: 24.69, end: 25.69 },
  { text: "a film about being inflated off the planet.",            start: 25.74, end: 30.00 },
];

// ---- Music & SFX cues -----------------------------------------------------

// NOTE (2026-04-17): ElevenLabs rejects prompts naming living composers. An
// earlier version said "in the style of Mark Mothersbaugh and Alexandre Desplat"
// and returned a 422 content-policy violation. Re-worded to describe the vibe
// with generic cinematic adjectives instead.
export const MUSIC_PROMPT = [
  "A solo celesta playing a slow, melancholy, wistful 3/4 waltz in A minor,",
  "joined at the halfway mark by very gentle pizzicato strings and a single",
  "muted French horn long-tone. Sparse, dry, intimate, evocative of a whimsical",
  "and cinematic film score with quiet, contemplative mood, no drums, no percussion,",
  "no electronic elements. Acoustic chamber instruments only. A faintly melancholy",
  "lullaby for a train departing into the void.",
].join(" ");

// ElevenLabs SFX v2 caps duration low and dislikes meta-instructions like
// "loopable bed" / "no music, no voices". Prompt kept under 25 words.
export const SFX_PROMPT = [
  "Inside a vintage train: gentle mechanical hum,",
  "slow rhythmic wheel clacking on rails, faint distant steam hiss, soft wooden carriage reverberation.",
].join(" ");

// ---- Audio mix levels (dB, relative to -0 dBFS source) -------------------

export const MIX = {
  voDb: -3,        // VO sits up front
  musicDb: -16,    // music well underneath
  sfxDb: -22,      // SFX a faint bed
};
