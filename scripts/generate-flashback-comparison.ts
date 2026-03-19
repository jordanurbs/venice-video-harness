/**
 * Compare how the "frontier flashback" scene looks under
 * Clean Dystopia vs Baroque Digital aesthetics.
 *
 * Scene 8: Open frontier, golden hour, lone figure on horseback,
 * vast landscape, no fences, no walls. "A hundred years ago."
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

const API_KEY = process.env.VENICE_API_KEY;
if (!API_KEY) throw new Error("VENICE_API_KEY not set in .env");

const SAMPLES_DIR = resolve("output/erik-voorhees-manifesto/aesthetic-samples");
mkdirSync(SAMPLES_DIR, { recursive: true });

const BASE_SCENE = `A vast open frontier landscape at golden hour. A single figure on horseback silhouetted at the horizon line. Tall golden grass stretches endlessly in every direction. No fences, no walls, no buildings. Warm sepia-gold light, amber sky. Wind moves through the grass. Total freedom made visible. 16:9 cinematic widescreen composition.`;

interface Sample {
  name: string;
  label: string;
  prompt: string;
  seed: number;
}

const samples: Sample[] = [
  {
    name: "flashback-clean-dystopia",
    label: "Clean Dystopia — warm flashback rupture",
    seed: 200001,
    prompt: `${BASE_SCENE} Shot in a warm analog film style that contrasts starkly with a sterile white minimalist world. Rich golden warmth, heavy Kodak Ektachrome grain, slightly faded colors like a memory. Soft lens diffusion. The warmth feels almost unbearably beautiful after clinical white corridors. This is a memory of freedom projected on a cracked screen inside a pristine dystopia. Warm amber light, soft focus edges, nostalgic and aching. Cinematic photography.`
  },
  {
    name: "flashback-baroque",
    label: "Baroque Digital — classical oil painting frontier",
    seed: 200002,
    prompt: `${BASE_SCENE} Classical baroque oil painting style. Luminous golden-hour light rendered in thick oil paint with visible brushstrokes. Hudson River School meets Caravaggio — vast romantic American landscape in the tradition of Albert Bierstadt and Thomas Cole. Rich amber and gold impasto highlights, deep umber shadows in the grass. The lone horseback figure rendered small against the sublime landscape. Heavy paint texture, glazed sky, museum-quality fine art. Ornate gilt frame implied. This is freedom as an old master painting.`
  },
  {
    name: "flashback-clean-dystopia-on-screen",
    label: "Clean Dystopia — the reveal (frontier shown on cracked screen inside white corridor)",
    seed: 200003,
    prompt: `Inside a pristine sterile white minimalist corridor with pure white walls and floors, a large cracked monitor screen displays a warm golden frontier landscape with a horseback rider at sunset. The screen is the only source of color and warmth in the entire frame — everything else is clinical white. The warm golden image bleeds slightly onto the white walls around the screen. A man in a dark rumpled suit stands before the screen, his back to us, staring at this memory of freedom. THX-1138 meets Black Mirror aesthetic. Stark contrast between cold white reality and warm golden memory. 16:9 cinematic composition.`
  }
];

async function generateSample(sample: Sample): Promise<void> {
  console.log(`\n  Generating: ${sample.label}...`);

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
    return;
  }

  const data = (await response.json()) as { images: string[] };
  const b64 = data.images[0];

  const outPath = resolve(SAMPLES_DIR, `${sample.name}.png`);
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`    Saved: ${outPath}`);
}

async function main() {
  console.log("Generating flashback comparison samples...\n");

  for (const s of samples) {
    await generateSample(s);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\nDone!");
}

main().catch(console.error);
