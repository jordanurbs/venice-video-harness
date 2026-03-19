/**
 * Generate side-by-side comparison panels:
 *
 * Panel A: Clean Dystopia present → Warm Analog flashback
 * Panel B: Clean Dystopia present → Baroque Oil flashback
 *
 * Each panel shows 3 frames left-to-right simulating the transition:
 * 1. The white corridor (present)
 * 2. The transition beat (dissolve moment)
 * 3. The frontier (past)
 */

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

const API_KEY = process.env.VENICE_API_KEY;
if (!API_KEY) throw new Error("VENICE_API_KEY not set in .env");

const SAMPLES_DIR = resolve("output/erik-voorhees-manifesto/aesthetic-samples");
mkdirSync(SAMPLES_DIR, { recursive: true });

// Character description for consistency
const MAN_DESC = `a man in his mid-30s with short brown hair and a close-trimmed beard wearing a dark rumpled suit`;

interface Sample {
  name: string;
  label: string;
  prompt: string;
  seed: number;
}

const samples: Sample[] = [
  // === PAIR A: Clean Dystopia → Warm Analog ===
  {
    name: "pair-a-1-present",
    label: "A1: Clean Dystopia — corridor (present)",
    seed: 300001,
    prompt: `${MAN_DESC} walks through a pristine sterile white minimalist corridor. Pure white walls, white floor, white ceiling. Soft ambient light from everywhere, no shadows. Other figures in gray uniforms stand motionless at glass desks along the corridor, their heads obscured by swirls of dark smoke. Everything is impossibly clean and orderly. The man is the only dark element in the frame. THX-1138 meets Black Mirror. Ultra-clean dystopian minimalism. 16:9 cinematic widescreen.`
  },
  {
    name: "pair-a-2-transition",
    label: "A2: Dissolve — white corridor fading into golden landscape",
    seed: 300002,
    prompt: `A double-exposure dissolve transition. The left half of the frame shows a pristine white minimalist corridor with glass desks fading out, and the right half shows a vast golden prairie landscape at sunset fading in. The two images overlap in the center creating a ghostly blend of clinical white architecture and warm golden grassland. A man in a dark suit is visible in both layers, walking. The white is giving way to amber and gold. Film dissolve effect, 16:9 cinematic widescreen composition.`
  },
  {
    name: "pair-a-3-flashback-analog",
    label: "A3: Warm Analog — frontier (past)",
    seed: 300003,
    prompt: `A vast open frontier landscape at golden hour. A single figure on horseback silhouetted at the far horizon line. Endless tall golden grass stretches in every direction, swaying in wind. No fences, no walls, no buildings, no technology. Warm rich amber and sepia-gold tones. Shot on vintage Kodak Ektachrome film stock with heavy warm grain, soft focus at edges, slightly faded colors like a treasured old photograph. Gentle lens diffusion, nostalgic warmth. This is a memory of freedom — analog, tactile, human. 16:9 cinematic widescreen.`
  },

  // === PAIR B: Clean Dystopia → Baroque Oil ===
  {
    name: "pair-b-1-present",
    label: "B1: Clean Dystopia — corridor (present, same as A1)",
    seed: 300001,
    prompt: `${MAN_DESC} walks through a pristine sterile white minimalist corridor. Pure white walls, white floor, white ceiling. Soft ambient light from everywhere, no shadows. Other figures in gray uniforms stand motionless at glass desks along the corridor, their heads obscured by swirls of dark smoke. Everything is impossibly clean and orderly. The man is the only dark element in the frame. THX-1138 meets Black Mirror. Ultra-clean dystopian minimalism. 16:9 cinematic widescreen.`
  },
  {
    name: "pair-b-2-transition",
    label: "B2: Dissolve — white corridor fading into oil painting",
    seed: 300012,
    prompt: `A double-exposure dissolve transition. The left half of the frame shows a pristine white minimalist corridor fading out, and the right half shows a classical oil painting of a golden prairie landscape at sunset fading in. The two images overlap in the center — clean digital white dissolving into thick oil paint brushstrokes and rich amber pigment. A man in a dark suit visible in the white half, a horseback figure in the painting half. The clinical gives way to the classical. Film dissolve effect, 16:9 cinematic widescreen.`
  },
  {
    name: "pair-b-3-flashback-baroque",
    label: "B3: Baroque Oil — frontier (past)",
    seed: 300013,
    prompt: `A vast open frontier landscape at golden hour. A single figure on horseback silhouetted at the far horizon line. Endless tall golden grass stretches in every direction. No fences, no walls, no buildings. Classical baroque oil painting style in the tradition of Albert Bierstadt and the Hudson River School. Luminous golden amber light rendered in thick visible oil paint brushstrokes. Rich impasto highlights on the grass, glazed umber shadows. Dramatic romantic landscape painting. Heavy paint texture, canvas weave visible. Museum-quality fine art. The sublime American frontier as an old master painting. 16:9 cinematic widescreen.`
  }
];

async function generateSample(sample: Sample): Promise<string> {
  console.log(`  Generating: ${sample.label}...`);

  const response = await fetch("https://api.venice.ai/api/v1/image/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "nano-banana-pro",
      prompt: sample.prompt,
      resolution: "1K",
      aspect_ratio: "16:9",
      steps: 30,
      cfg_scale: 7,
      seed: sample.seed,
      hide_watermark: true,
      safe_mode: false,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`    FAILED (${response.status}): ${err}`);
    return "";
  }

  const data = (await response.json()) as { images: string[] };
  const b64 = data.images[0];

  const outPath = resolve(SAMPLES_DIR, `${sample.name}.png`);
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`    Saved: ${outPath}`);
  return outPath;
}

async function main() {
  console.log("Generating side-by-side transition comparisons...\n");

  // Generate all 6 images (but pair-b-1 uses same seed as pair-a-1, so skip it)
  const paths: Record<string, string> = {};
  for (const s of samples) {
    // Skip duplicate (same seed/prompt will produce same image)
    if (s.name === "pair-b-1-present") {
      paths[s.name] = resolve(SAMPLES_DIR, "pair-a-1-present.png");
      console.log(`  Skipping B1 (same as A1)\n`);
      continue;
    }
    paths[s.name] = await generateSample(s);
    await new Promise(r => setTimeout(r, 500));
  }

  // Build HTML comparison
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>WITHOUT PERMISSION — Transition Comparison</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: 'Helvetica Neue', sans-serif; padding: 2rem; }
    h1 { text-align: center; font-size: 1.8rem; letter-spacing: 0.3em; text-transform: uppercase; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { text-align: center; font-size: 0.85rem; color: #888; margin-bottom: 2.5rem; }
    .pair { max-width: 1400px; margin: 0 auto 3rem; }
    .pair h2 { font-size: 1.2rem; margin-bottom: 0.3rem; color: #fff; }
    .pair .desc { font-size: 0.85rem; color: #999; margin-bottom: 1rem; }
    .strip { display: flex; gap: 4px; }
    .strip img { flex: 1; height: auto; border-radius: 4px; }
    .labels { display: flex; gap: 4px; margin-top: 0.5rem; }
    .labels span { flex: 1; text-align: center; font-size: 0.75rem; color: #666; }
    .arrow { display: flex; align-items: center; justify-content: center; padding: 0.5rem 0; }
    .arrow span { font-size: 1.5rem; color: #444; }
    hr { border: none; border-top: 1px solid #222; margin: 2rem 0; }
  </style>
</head>
<body>
  <h1>Transition Comparison</h1>
  <p class="subtitle">How does the "time travel" from present dystopia to past freedom feel?</p>

  <div class="pair">
    <h2>A. Clean Dystopia → Warm Analog Photography</h2>
    <p class="desc">The flashback as faded Ektachrome — a tactile, grainy memory. Maximum contrast with the sterile present.</p>
    <div class="strip">
      <img src="pair-a-1-present.png" alt="Present" />
      <img src="pair-a-2-transition.png" alt="Dissolve" />
      <img src="pair-a-3-flashback-analog.png" alt="Past" />
    </div>
    <div class="labels">
      <span>PRESENT — white corridor</span>
      <span>DISSOLVE</span>
      <span>PAST — analog warmth</span>
    </div>
  </div>

  <hr />

  <div class="pair">
    <h2>B. Clean Dystopia → Baroque Oil Painting</h2>
    <p class="desc">The flashback as a gilt-framed oil painting — classical, sublime, museum-quality. Elegant contrast.</p>
    <div class="strip">
      <img src="pair-a-1-present.png" alt="Present" />
      <img src="pair-b-2-transition.png" alt="Dissolve" />
      <img src="pair-b-3-flashback-baroque.png" alt="Past" />
    </div>
    <div class="labels">
      <span>PRESENT — white corridor</span>
      <span>DISSOLVE</span>
      <span>PAST — baroque oil painting</span>
    </div>
  </div>
</body>
</html>`;

  writeFileSync(resolve(SAMPLES_DIR, "transition-compare.html"), html);
  console.log(`\nComparison page: ${resolve(SAMPLES_DIR, "transition-compare.html")}`);
  console.log("Done!");
}

main().catch(console.error);
