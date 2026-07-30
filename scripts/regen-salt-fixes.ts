#!/usr/bin/env npx tsx
/**
 * Regenerate the 7 offending Salt Book generations identified in
 * ../salt-book-qa-findings.md (R1-R7).
 *
 * Model: seedance-2-0-enhanced-reference-to-video (same as original gens)
 * Output: ../fixes-r2/<name>.mp4
 *
 * Usage:
 *   npx tsx scripts/regen-salt-fixes.ts            # queue + poll all
 *   npx tsx scripts/regen-salt-fixes.ts R1 R3      # only specific fixes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Load .env
const envPath = resolve('.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
const API_KEY = process.env.VENICE_API_KEY;
if (!API_KEY) { console.error('VENICE_API_KEY missing'); process.exit(1); }

const BASE = 'https://api.venice.ai/api/v1';
const MODEL = 'seedance-2-0-enhanced-reference-to-video';
// Directory of ≤1024px JPEG reference images named <ref>.jpg (see refs arrays below).
// Override with SALT_REF_DIR; defaults to the QA workspace used during production.
const REF_DIR = process.env.SALT_REF_DIR
  ?? '/var/folders/jl/dpj5x7p17vxb02jjj0xww2pr0000gn/T/opencode/saltqa/regen-refs';
const OUT_DIR = resolve(process.env.SALT_OUT_DIR ?? '../fixes-r2');
mkdirSync(OUT_DIR, { recursive: true });

function refUri(name: string): string {
  const p = join(REF_DIR, `${name}.jpg`);
  return `data:image/jpeg;base64,${readFileSync(p).toString('base64')}`;
}

const STYLE = 'Salt-Bleach aesthetic: Mediterranean white-noir, 35mm anamorphic, Kodak Portra 400 pushed, overexposed, chalky, bone white and faded turquoise, terracotta shadow. Harsh blinding midday sun, no shadows. The light is hostile, not beautiful.';

// Film-stock names trigger Seedance film-burn corner flares. Use this variant
// for any job that has shown burn artifacts (proven fix: R3-v5).
const STYLE_CLEAN = 'Salt-Bleach aesthetic: Mediterranean white-noir, overexposed, chalky, bone white and faded turquoise, terracotta shadow. Harsh blinding midday sun, no shadows. The light is hostile, not beautiful. Clean pristine frame from edge to edge — absolutely no film burn, no light leaks, no orange or red flares at any frame edge or corner, no vignetting. ALL transitions between shots are instant HARD CUTS — never dissolves, never cross-fades, never superimpositions, never double-exposures.';

// Body staging: matches the shot1 establishing wide (salt-quarry-body-staging.png)
const BODY_STAGING = 'The dead body lies FACE DOWN, ON HIS STOMACH, his BACK to the sky and the BACK of his head toward camera, in the CENTER of the wide flat white stone plaza, well away from any edge or drop — the tiered marble block walls rise on both sides and the sea gap is far in the background, exactly as staged in the body-staging reference image. His face is pressed against the stone and is NEVER visible in any shot — we only ever see the back of his head, never his eyes, never his nose, never his mouth. The body is NEVER lying on its back, NEVER supine, NEVER rolls over, never turns, never shows its face — in every single shot he is on his stomach. He wears mustard-yellow work clothes and shoes, arms at his sides, no blood.';

// Voice direction: the rest of the film's dialogue came out in standard
// American English, so every dialogue gen must match (user QA note, R1-v3).
const ACCENT = 'VOICE DIRECTION (critical): Both actors are AMERICAN. All spoken dialogue is in English with a plain, neutral AMERICAN accent — flat Midwestern American pronunciation, like classic 1950s Hollywood film-noir actors. Absolutely NO Greek accent, NO Mediterranean accent, no foreign or accented English of any kind. Varda\'s voice: low, dry, weary American baritone. Costas\'s voice: younger, clear, earnest American tenor.';

const PAGE = 'a single charred journal page: yellowed aged paper, blackened curling burnt edges, small careful handwritten Greek text';

interface Job {
  id: string;
  out: string;
  duration: string;
  refs: string[]; // ref names in @Image order
  prompt: string;
}

const JOBS: Job[] = [
  {
    id: 'R1', out: 'gen4-fix.mp4', duration: '10s',
    refs: ['varda', 'costas', 'page-only', 'quarry-body'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses, face is a void behind the lenses), @Image2 as Officer Costas (late 20s, neat dark police uniform, curious and methodical), @Image3 as the charred journal page prop — ${PAGE}, @Image4 as the location AND body staging: the dead man in mustard-yellow clothes face down in the center of the wide white marble quarry plaza, tiered block walls on both sides, sea gap in the background — the body position and the location must match this image exactly. ${STYLE_CLEAN} This is a multi-shot sequence with five distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: ${BODY_STAGING} The body never moves from that center position. The dead man is completely INERT and does absolutely nothing in every shot — his hands are EMPTY, limp, and motionless, they NEVER touch, hold, or fold anything. The charred page is ALWAYS up in the air in Detective Varda's LIVING hands — it is NEVER on the ground, NEVER lying on the stone, never on a stone block, never under, near, or beside the dead man's hands or body, never anywhere except lifted in Varda's hands, until Varda slides it into his own jacket pocket in shot 4. Varda's hands are recognizable by his GREY LINEN JACKET SLEEVES and clean white shirt cuffs — the dead man's arms wear MUSTARD-YELLOW sleeves with rope around the wrists, and those yellow sleeves and roped wrists must NOT appear in any close-up of the page. The page looks exactly like @Image3 in every shot: a normal notebook-page size piece of yellowed paper with BLACKENED BURNT curling edges and Greek handwriting — never a clean white sheet, never a board, never a clipboard, never oversized, held at a natural reading distance. There is only ONE page. Varda's dark sunglasses never come off. Varda crouches beside the body for shots 1-3, stands for shots 4-5. ${ACCENT}

SHOT 1 of 5 (75mm lens, static camera): Costas standing on the white quarry plaza, looking down at Varda with curiosity. He wears his dark police uniform. He speaks in clear American-accented English — asks what Varda has found. Open, inquisitive expression. The dead body face down in the center of the plaza at the edge of frame, back of the head only.

CUT TO:

SHOT 2 of 5 (75mm lens, static camera): Varda crouching beside the face-down body in the center of the flat white plaza, holding the charred page UP at chest height in both hands, well above the ground. Fedora, dark sunglasses. He answers in a flat American accent — measured, careful: "A page. From a notebook." He gives nothing away. The page stays lifted in his hands, never lowered toward the body. The dead man's face is against the stone, not visible, his yellow-sleeved arms limp at his sides.

CUT TO:

SHOT 3 of 5 (75mm lens, static camera, tight on Costas's face and shoulders): Costas again, framed from the chest up — no body, no page in this shot. Dark police uniform. He asks — what does it say? He is trying to read Varda and failing.

CUT TO:

SHOT 4 of 5 (100mm lens, static camera, close-up on hands at chest height): Detective Varda is STANDING now. Close-up on HIS two hands held at chest height in front of his grey linen jacket — grey linen sleeves, clean white shirt cuffs, a living man's steady hands. Nothing else is in frame: no ground, no body, no yellow sleeves, no rope. His hands fold the charred page in half, carefully, deliberately — the same yellowed page with blackened edges from @Image3 — then slide it into the inner breast pocket of his grey linen jacket. The page disappears into the linen. A practiced, smooth lie of omission.

CUT TO:

SHOT 5 of 5 (75mm lens, static camera): Varda standing, empty-handed now, beside the body on the flat quarry floor. Sunglasses still on, face a void. He speaks in a flat American accent: "I'll need to read it properly. In the light." We cannot read him at all.

Audio throughout: Low sparse dialogue in standard American English — both voices have neutral American accents, no Greek accent. Professional tones. The dry rasp of the page being folded. Constant wind, distant gulls. No score. The silence between lines matters more than the words.`,
  },
  {
    id: 'R2', out: 'gen6-fix.mp4', duration: '15s',
    refs: ['varda', 'quarry-clean', 'hand-on-paper'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses — the barrier we read behind), @Image2 as the quarry location: an empty white cut-marble quarry plaza, tiered block walls on both sides, a gap opening to turquoise sea — the floor is COMPLETELY BARE white stone, no furniture, no equipment, no objects, no people on it, @Image3 as the charred journal page prop — ${PAGE}. ${STYLE} This is a multi-shot sequence with six distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: The quarry floor is completely empty bare white stone in every shot — NO furniture, NO crates, NO equipment, NO debris anywhere. Varda carries NOTHING in his hands or under his arms except one single folded charred page which he takes OUT of his jacket pocket in shot 3. There is NO book, NO notebook, NO journal anywhere in this sequence — only the one folded charred page matching @Image3: yellowed paper, blackened burnt edges, Greek handwriting. Varda's dark sunglasses never come off. He is alone.

SHOT 1 of 6 (50mm lens, static camera): A young police officer in dark uniform walks away from camera toward the quarry entrance, departing across the bare white stone. Varda stands still in midground, empty-handed, watching him go.

CUT TO:

SHOT 2 of 6 (40mm lens, static camera, wide): Varda alone in the vast empty white quarry plaza exactly as in @Image2, a small figure on bare stone, hands empty at his sides. Wind moves his linen jacket. One man, white stone in every direction, nothing else.

CUT TO:

SHOT 3 of 6 (100mm lens, static camera, close-up): Varda's hand reaches into his inner jacket pocket and takes out a single folded charred page — yellowed, blackened edges. He unfolds it with both hands. Deliberate, private. This is not for anyone else.

CUT TO:

SHOT 4 of 6 (100mm lens, static camera, close-up): Varda reading the single unfolded page held in both hands. Behind the sunglasses — nothing. His lips move barely, reading the Greek silently. He lingers.

CUT TO:

SHOT 5 of 6 (100mm lens, static camera, close-up): Varda's face above the page. He knows this handwriting. A muscle shifts in his jaw. The recognition is physical, not facial. His hands holding the page go completely still.

CUT TO:

SHOT 6 of 6 (75mm lens, slow tilt up): Varda folds the page once, slips it back into his jacket, and looks up. The camera tilts up with his gaze to the sky — white, bleached, featureless, pure overexposed white. Hold on white. The image blows out.

Audio throughout: Footsteps receding on stone. Constant wind. Gulls. Dry paper being unfolded and refolded. Varda's breathing, barely audible. No score. The final tilt to white: wind only, then nothing.`,
  },
  {
    id: 'R3', out: 'gen10-fix.mp4', duration: '12s',
    refs: ['varda', 'costas', 'ferry-dock', 'hand-on-paper'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses), @Image2 as Officer Costas (late 20s, neat dark police uniform), @Image3 as the ferry dock location: long white stone jetty with a small ferry boat moored, turquoise water, white village on the hillside, @Image4 as the charred journal page prop — ${PAGE}. Salt-Bleach aesthetic: Mediterranean white-noir, overexposed, chalky, bone white and faded turquoise, terracotta shadow. Harsh blinding midday sun, no shadows. The light is hostile, not beautiful. Clean pristine frame from edge to edge — absolutely no film burn, no light leaks, no orange or red flares at any frame edge or corner, no vignetting. This is a multi-shot sequence with five distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: The dead man is MANOLIS, 61, the ferryman — he wears DARK NAVY-BLUE fisherman's work clothes and has grey hair (NOT yellow or mustard clothing). He lies FACE DOWN on the white stone of the jetty in every shot — his face is pressed against the stone and is NEVER visible, we only ever see the back of his grey-haired head. The body NEVER rolls over, never turns, never shows its face. Arms at his sides, placed with care, no blood. The charred page matches @Image4 exactly: yellowed paper, blackened burnt edges, Greek handwriting — it is NEVER white, never clean. Only VARDA touches the page — Costas never holds it. Varda's dark sunglasses never come off.

SHOT 1 of 5 (40mm lens, static camera, wide): The ferry dock. The body of Manolis — an older man in dark navy work clothes — face down on the white stone jetty, face against the stone, only the back of his grey head visible. A small crowd of fishermen and old men stands back at a respectful distance, squinting in the harsh sun. Varda and Costas stand over the body.

CUT TO:

SHOT 2 of 5 (75mm lens, static camera): Varda crouches beside the face-down body. The dead man's face stays pressed against the stone — we see only the back of his grey head. Varda lifts the dead man's hand gently and slides out the charred page tucked beneath it — yellowed, blackened edges. His movements are heavy with knowledge.

CUT TO:

SHOT 3 of 5 (100mm lens, static camera, close-up): The charred page in Varda's hands — yellowed aged paper, burnt black curling edges, Greek handwriting. He reads it. His jaw tightens. The only dark object in a white world.

CUT TO:

SHOT 4 of 5 (75mm lens, static camera, over Varda's shoulder): Costas standing over him, asks: "Same?" Varda, still crouched with the page in his hands, replies flatly: "Same. Same handwriting."

CUT TO:

SHOT 5 of 5 (50mm lens, static camera): Varda stands, folds the charred page, puts it in his jacket pocket, and looks at the crowd of islanders watching — weathered fishermen, old men. Some of them look back at him. He holds their gaze.

Audio throughout: Harbor sounds — water lapping the jetty, halyards clinking, low murmur of the crowd. Sparse low dialogue. Wind constant. Gulls. No score.`,
  },
  {
    id: 'R4', out: 'gen15-fix.mp4', duration: '12s',
    refs: ['varda', 'costas', 'olive-grove', 'hand-on-paper'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses), @Image2 as Officer Costas (late 20s, neat dark police uniform), @Image3 as the olive grove location: ancient twisted olive trees on dry ground, a low rectangular white stone foundation of an old olive press with a round millstone, sea beyond, @Image4 as the charred journal page prop — ${PAGE}. ${STYLE} This is a multi-shot sequence with five distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: There IS a dead body in this scene: VASILIS, 55, the olive grove owner — a heavyset man in earth-brown work clothes and a work vest. He lies FACE DOWN on the flat white stone of the old olive press foundation, arms at his sides, arranged with care, no blood. The charred page matches @Image4: yellowed paper, blackened burnt edges, Greek handwriting — never white, never clean. Varda's dark sunglasses never come off. There is no table, no typewriter, no furniture — this is an outdoor olive grove.

SHOT 1 of 5 (40mm lens, static camera, wide): The olive grove. The body of Vasilis in brown work clothes, face down on the white stone olive press foundation. A frightened crowd of villagers has gathered among the olive trees — women crossing themselves, men talking in low voices. Bigger, louder than before. Fear on the island.

CUT TO:

SHOT 2 of 5 (50mm lens, handheld tracking): Varda pushes through the crowd of villagers, Costas behind him. The crowd parts. Varda reaches the stone foundation and the body.

CUT TO:

SHOT 3 of 5 (75mm lens, static camera): Varda crouches beside the body on the stone foundation. He lifts the dead man's hand and takes the charred page from beneath it — yellowed, blackened burnt edges. He reads it. His face goes grey behind the sunglasses.

CUT TO:

SHOT 4 of 5 (75mm lens, static camera): Costas standing over him: "Third one." Varda, still crouched, the charred page in his hands: "Third one." Flat, hollow.

CUT TO:

SHOT 5 of 5 (100mm lens, static camera, close-up): Varda stands and faces Costas, folding the charred page away into his jacket. He speaks with quiet intensity: "Give me three days. If I haven't closed it, call Piraeus." Costas holds his gaze, then nods once.

Audio throughout: Crowd murmur, a woman's low prayer, cicadas in the olive trees, wind. Sparse tense dialogue. No score.`,
  },
  {
    id: 'R5', out: 'gen19-fix.mp4', duration: '12s',
    refs: ['varda', 'harbor-wide', 'dock-nets'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses), @Image2 as the small Aegean harbor: white stucco houses with blue shutters climbing the hillside, stone quay, turquoise water, @Image3 as the dock corner where a fisherman mends nets: dark nets spread on white stone, cork floats, a wooden crate. ${STYLE} This is a multi-shot sequence with five distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: Varda is EMPTY-HANDED in every shot — he carries NOTHING: no book, no journal, no papers, nothing under his arms, hands free or in pockets. Varda's dark sunglasses never come off. In the night shots the village is dark with a few amber window lights. In the dawn shots the light is pale, cold, early. The fisherman's usual spot on the dock is EMPTY — nets and crate remain but no man, and his boat is GONE from the mooring.

SHOT 1 of 5 (50mm lens, static camera): Night. Varda sits in his parked car on a dark village street, seen in profile through the side window, watching a house. Amber light from a distant window. He waits. He does not move.

CUT TO:

SHOT 2 of 5 (75mm lens, static camera, from inside the car): Night. Varda's silhouette at the wheel, the dashboard instruments glowing faintly. Through the windscreen the dark whitewashed street. Hours are passing. The wind never stops.

CUT TO:

SHOT 3 of 5 (40mm lens, static camera, wide): Dawn, pale cold light. Varda's car drives slowly along the harbor quay past moored boats, headlights still on.

CUT TO:

SHOT 4 of 5 (50mm lens, static camera): Dawn. Varda gets out of the stopped car at the dock, empty-handed, and walks a few steps toward the water. The fisherman's usual spot: nets and the wooden crate lie abandoned on the white stone. No one is there. The mooring is empty — the boat is gone.

CUT TO:

SHOT 5 of 5 (75mm lens, slow push-in): Varda stands at the edge of the empty dock, hands at his sides, staring at the empty water where the boat should be. He knows where the man has gone. Hold on his stillness against the pale dawn sea.

Audio throughout: Night wind, distant dog bark, the car engine ticking as it cools. Then dawn: gulls waking, water lapping, halyards. No dialogue. No score. The empty mooring is the loudest thing in the scene.`,
  },
  {
    id: 'R6', out: 'gen11-fix.mp4', duration: '12s',
    refs: ['police-station', 'varda', 'hand-on-paper'],
    prompt: `@Image1 as the small island police station interior: two wooden desks, a pale green filing cabinet, a map of the island on the wall, white walls, @Image2 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses), @Image3 as the charred journal page prop — ${PAGE}. ${STYLE} — but this scene is INTERIOR, NIGHT: the window shutters are closed and dark, the room is lit by a single BARE HANGING LIGHT BULB casting hard warm light and deep shadows. This is a multi-shot sequence with six distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: It is NIGHT — the window is dark, the only light is the bare bulb overhead. TWO charred pages lie side by side on the desk in every desk shot — both matching @Image3: yellowed paper, blackened burnt edges, Greek handwriting. Varda keeps his sunglasses ON even at night. On the desk: the two charred pages, a magnifying glass, a dusty old folder, and an old black-and-white group photograph of six young gendarmes in uniform from 1947.

SHOT 1 of 6 (40mm lens, static camera, wide): The dark police station at night. Varda sits alone at the desk under the bare hanging bulb. Two charred pages lie side by side on the desk before him. Dark shuttered window behind.

CUT TO:

SHOT 2 of 6 (100mm lens, static camera, close-up): The two charred pages side by side on the wooden desk under hard bulb light — both yellowed with blackened burnt edges and Greek handwriting. Varda's hand moves a magnifying glass slowly over the text, comparing them.

CUT TO:

SHOT 3 of 6 (50mm lens, static camera): Varda pulls a dusty folder from the bottom drawer of the filing cabinet and returns to the desk. He opens it under the bulb.

CUT TO:

SHOT 4 of 6 (100mm lens, static camera, insert): Inside the folder: an old black-and-white photograph — six young men in gendarmerie uniforms, 1947, squinting in front of a truck. Varda's fingers turn the photo over: faded pencil names on the back.

CUT TO:

SHOT 5 of 6 (75mm lens, static camera): Varda writes a short list of names in a small pocket notebook, then crosses out lines one by one with the pen. He stops. His hand goes flat on the desk. Stillness.

CUT TO:

SHOT 6 of 6 (50mm lens, static camera): Varda stands, pockets the notebook, and walks out of frame. The bare bulb swings slightly in the draft from the door, the light swaying across the two charred pages left on the desk.

Audio throughout: Night quiet — the bulb's faint electric hum, wind pressing at the shutters, paper handled dryly, pen scratches. A chair scrapes. Footsteps. The door. No score.`,
  },
  {
    id: 'R7', out: 'gen21-fix.mp4', duration: '15s',
    refs: ['varda', 'stavros', 'quarry-cliff', 'tin-box'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses), @Image2 as Stavros the fisherman (early 30s, weathered, calm, fisherman's cap, faded grey-blue cotton work shirt), @Image3 as the quarry cliff edge: white cut stone dropping away to turquoise sea far below, @Image4 as the rusted tin box containing three charred journal pages — yellowed paper, blackened burnt edges, Greek handwriting. ${STYLE} This is a multi-shot sequence with six distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: The tin box and the three charred pages are handled ONLY by Varda — Stavros NEVER touches the tin box, never takes the pages, never holds them. Stavros holds his own separate item: a complete leather-bound journal, intact, not burned. The charred pages match @Image4: yellowed, blackened burnt edges. Varda's dark sunglasses stay ON through every shot. Both men stand facing each other about three meters apart on the white stone near the cliff edge, sea far below behind them, in every shot.

SHOT 1 of 6 (50mm lens, static camera, two-shot): Varda and Stavros face each other on the white stone at the cliff edge, sea far below. Stavros holds a worn leather journal against his chest. Varda reaches into his jacket and takes out a small rusted tin box.

CUT TO:

SHOT 2 of 6 (100mm lens, static camera, close-up on hands): Varda's hands open the rusted tin box. Inside: three charred pages — yellowed paper, blackened burnt edges, Greek handwriting. He lifts them out carefully and holds them out toward Stavros. His hand trembles slightly.

CUT TO:

SHOT 3 of 6 (75mm lens, static camera, on Stavros): Stavros looks at the offered pages. His face is calm, ordinary, unreadable. He does not move. He does not take them. He speaks: "Keep them. They are yours. Your share of the guilt."

CUT TO:

SHOT 4 of 6 (75mm lens, static camera, on Varda): Varda lowers his hand with the three charred pages, still holding them. Behind the sunglasses, nothing — but his shoulders drop a fraction. The weight of fifteen years.

CUT TO:

SHOT 5 of 6 (75mm lens, static camera, on Stavros): Stavros holds up his own leather journal — complete, intact, unburned. "I have the rest." He bends and sets the journal down on the white stone between them, then straightens.

CUT TO:

SHOT 6 of 6 (40mm lens, static camera, wide two-shot): The journal lies on the white stone between the two men. Stavros turns and walks away toward the quarry path, into the white light. Varda stands motionless, the three charred pages still in his hand, the sea far below.

Audio throughout: Wind, strong at the cliff edge. Gulls far below. Sparse, quiet dialogue — Stavros's voice level and calm. The dry rustle of old paper in the wind. No score. The silence after "your share of the guilt" holds.`,
  },
  {
    id: 'R8', out: 'gen3-fix.mp4', duration: '10s',
    refs: ['varda', 'page-only', 'quarry-body'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses — we never see his eyes, we read his body), @Image2 as the charred journal page prop — ${PAGE} — IMPORTANT: @Image2 defines ONLY what the page LOOKS like (its size, paper, burnt edges, handwriting); it does NOT define where the page is — in this film the page is NEVER lying on the ground, never on the stone, it exists ONLY in Varda's raised hands. @Image3 as the location AND body staging: the dead man in mustard-yellow clothes face down in the center of the wide white marble quarry plaza, tiered block walls on both sides, sea gap in the background — the body position and the location must match this image exactly. ${STYLE_CLEAN} This is a multi-shot sequence with five distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: ${BODY_STAGING} The body stays in the CENTER of the plaza in every shot — never near the edge of the platform, never near a drop-off. The dead man is completely INERT and does absolutely nothing in every shot — his hands are limp and motionless, they NEVER hold, grip, or move anything. Varda's hands are recognizable by his GREY LINEN JACKET SLEEVES and clean white shirt cuffs — the dead man's arms wear MUSTARD-YELLOW sleeves, and those yellow sleeves must NOT appear in any close-up of the page. From the moment Varda picks the page up in shot 1, the page STAYS LIFTED IN HIS HANDS for the entire rest of the sequence — it is NEVER put back down, NEVER lying on the ground or on the stone, NEVER beside or under the dead man's hand again. His fingers grip it naturally at a readable distance — the page is a normal notebook-page size, held at chest height, never pressed up against the camera lens, never filling the whole frame, never floating or separated from his hands. There is only ONE page and it is ALWAYS the charred page from @Image2 — yellowed paper, BLACKENED BURNT curling edges, Greek handwriting — never a clean sheet, never an envelope, never an unburned page. The blackened burnt edges are ALWAYS clearly visible from EVERY angle and EVERY distance, including from behind the page and in wide shots — the page silhouette is always ragged and burnt-black at the border, never a clean straight-edged rectangle. Varda's dark sunglasses never come off.

SHOT 1 of 5 (50mm lens, static camera, profile angle): Varda crouches beside the dead man, who lies ON HIS STOMACH, back to the sky, the back of his head to camera, face pressed invisible against the stone, in the center of the white stone plaza. Varda wears his salt-greyed linen suit, fedora, and dark sunglasses. He reaches toward the dead man's limp hand and picks up the charred page lying beside it. Slow, deliberate. His movements are heavy with knowledge. The tiered marble walls rise in the background.

CUT TO:

SHOT 2 of 5 (100mm lens, static camera): Varda's face — behind the dark sunglasses, completely unreadable. The sunglasses are on — we cannot see his eyes. He has seen something. His own hands go completely still. The tell is in the hands, not the face.

CUT TO:

SHOT 3 of 5 (135mm lens, static camera, INSERT close-up): Close-up of the charred page held in Varda's hand — grey linen sleeve, white shirt cuff, a living man's steady fingers gripping the yellowed paper with blackened, curling edges and handwritten Greek text. The page is held at a natural reading distance, filling about half the frame. This is the only dark object in the entire frame — white stone all around it.

CUT TO:

SHOT 4 of 5 (100mm lens, static camera): Varda crouched, reading the page held at chest height in his hands. Behind the sunglasses — nothing visible, the sunglasses are still on. But his lips move, barely, reading the Greek silently. He lingers on the words.

CUT TO:

SHOT 5 of 5 (100mm lens, static camera): Varda's hands — grey linen sleeves, white cuffs — holding the page at chest height. His fingers grip the yellowed paper with its blackened edges. The hands go completely still. A long beat. The hands know what the face will not admit. The recognition is physical, in the stillness.

Audio throughout: Minimal sound — Varda's movements on stone, the dry page being handled. Wind as constant bed. No dialogue. No score. The silence is weighted and deliberate.`,
  },
  {
    id: 'R9', out: 'gen5-fix.mp4', duration: '10s',
    refs: ['varda', 'costas', 'quarry-body'],
    prompt: `@Image1 as Detective Nikos Varda (mid-40s, salt-greyed linen suit, fedora, dark sunglasses), @Image2 as Officer Costas (late 20s, neat dark police uniform, black bound notebook), @Image3 as the location AND body staging: the dead man in mustard-yellow clothes face down in the center of the wide white marble quarry plaza, tiered block walls on both sides, sea gap in the background — the body position and the location must match this image exactly. ${STYLE_CLEAN} This is a multi-shot sequence with five distinct shots separated by hard cuts. CRITICAL CONTINUITY RULES: ${BODY_STAGING} The body stays in the CENTER of the plaza in every shot where it appears — same position as @Image3, never near the platform edge. Varda wears dark sunglasses in every shot — they never come off. Varda wears his salt-greyed linen suit and fedora throughout. Costas wears his dark police uniform and carries a small black BOUND notebook (hardcover, stitched — NOT spiral-bound) throughout. Costas writes in GREEK — the handwriting on the notebook page is Greek letters. ${ACCENT}

SHOT 1 of 5 (50mm lens, static camera, two-shot): Varda and Costas crouching together over the face-down body in the center of the white stone plaza — the body in the same central position as the staging reference, tiered marble walls behind. Costas examines the dead man's wrists, gently turning them to see ligature marks. They speak in low voices. Professional, methodical. The dead man's face stays against the stone.

CUT TO:

SHOT 2 of 5 (100mm lens, static camera, insert): Costas's small black bound notebook — his hand writing methodically in neat GREEK handwriting with a fountain pen. The pen moves across the cream page. He records what they've found.

CUT TO:

SHOT 3 of 5 (50mm lens, static camera): Costas stands, looks around the vast white quarry plaza, notebook in hand. He asks — "Why here? Why the quarry?" — asking the space itself, not just Varda. The quarry offers no answer. The body face down in the center of the plaza behind him.

CUT TO:

SHOT 4 of 5 (40mm lens, static camera, from behind Varda): Varda, seen from behind, looks out across the quarry plaza toward the gap where the turquoise sea shows far below. He wears his fedora, the dark sunglasses' arms visible. He does not answer Costas's question. His silence is the answer.

CUT TO:

SHOT 5 of 5 (75mm lens, static camera, profile): Varda in profile, still looking out over the white stone. He speaks flatly, dismissively — "Get the M.E. I'll wait." He wants to be alone with what he knows.

Audio throughout: Low dialogue in standard American English — both voices have neutral American accents, no Greek accent. Professional tones. Costas's pen on paper. Wind constant. Gulls distant. The quarry's natural stone reverb. The silence after "I'll wait" is deliberate and heavy.`,
  },
];

async function queueJob(job: Job): Promise<string> {
  const body = {
    model: MODEL,
    prompt: job.prompt,
    duration: job.duration,
    aspect_ratio: '21:9',
    resolution: '720p', // matches existing 1470x630 footage; 1080p ~2.5x cost
    audio: true,
    // Seedance loves adding film-burn/light-leak flares at frame corners when
    // the prompt mentions film stocks. Suppress explicitly.
    negative_prompt: 'film burn, light leak, orange flare, red flare at frame edges, corner glow, vignette flare, lens flare artifact, low resolution, worst quality, defects',
    reference_image_urls: job.refs.map(refUri),
    // Seedance face-media consent attestation (all refs are AI-generated by
    // this account via Venice image models — we hold full rights).
    consents: {
      seedance: {
        confirmed_terms_and_privacy: true,
        confirmed_legal_right: true,
        confirmed_screening_acknowledged: true,
      },
    },
  };
  const res = await fetch(`${BASE}/video/queue`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`[${job.id}] queue failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  const data = await res.json() as { queue_id: string };
  return data.queue_id;
}

async function poll(job: Job, queueId: string): Promise<void> {
  const outPath = join(OUT_DIR, job.out);
  for (let attempt = 0; attempt < 180; attempt++) {
    await new Promise(r => setTimeout(r, 15_000));
    const res = await fetch(`${BASE}/video/retrieve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, queue_id: queueId }),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('video/mp4') || ct.includes('octet-stream')) {
      writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
      console.log(`[${job.id}] DONE -> ${outPath}`);
      await fetch(`${BASE}/video/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, queue_id: queueId }),
      }).catch(() => {});
      return;
    }
    if (res.ok) {
      const s = await res.json() as { status: string };
      if (s.status === 'FAILED' || s.status === 'ERROR') throw new Error(`[${job.id}] generation failed: ${JSON.stringify(s)}`);
      process.stdout.write(`[${job.id}] ${s.status} (poll ${attempt + 1})   \r`);
    } else {
      console.warn(`[${job.id}] poll ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
  throw new Error(`[${job.id}] timed out (queue ${queueId})`);
}

async function main() {
  const only = process.argv.slice(2);
  const jobs = only.length ? JOBS.filter(j => only.includes(j.id)) : JOBS;
  console.log(`Regenerating: ${jobs.map(j => j.id).join(', ')} -> ${OUT_DIR}`);

  // Queue all first (parallel), then poll all.
  const queued: Array<{ job: Job; queueId: string }> = [];
  for (const job of jobs) {
    try {
      const queueId = await queueJob(job);
      console.log(`[${job.id}] queued: ${queueId}`);
      queued.push({ job, queueId });
    } catch (err) {
      console.error(String(err));
    }
  }
  const results = await Promise.allSettled(queued.map(({ job, queueId }) => poll(job, queueId)));
  let ok = 0, bad = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++;
    else { bad++; console.error(`\n${queued[i].job.id}: ${r.reason}`); }
  });
  console.log(`\n=== ${ok} succeeded, ${bad} failed ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
