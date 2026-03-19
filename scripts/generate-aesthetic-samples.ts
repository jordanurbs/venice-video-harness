/**
 * Generate aesthetic comparison samples for "WITHOUT PERMISSION"
 *
 * Uses the same representative scene (Scene 2: man with card facing
 * smoke-headed bureaucrat in surveillance corridor) rendered in 6
 * different visual styles.
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

const API_KEY = process.env.VENICE_API_KEY;
if (!API_KEY) throw new Error("VENICE_API_KEY not set in .env");

const PROJECT_DIR = resolve("output/erik-voorhees-manifesto");
const SAMPLES_DIR = resolve(PROJECT_DIR, "aesthetic-samples");
mkdirSync(SAMPLES_DIR, { recursive: true });

// The test scene: Scene 2 - Surveillance Corridor
// A man in a rumpled suit holds his card toward a faceless figure with a
// smoke-swirl head, in an endless corridor of glass desks stretching into fog.

const BASE_SCENE = `A man in his mid-30s with short brown hair and a close-trimmed beard, wearing a dark rumpled suit, holds a payment card toward a faceless bureaucratic figure whose head is a swirl of dark smoke, wearing a gray bureaucratic uniform. Behind them stretches an endless corridor of identical glass desks disappearing into fog. Other faceless smoke-headed figures sit motionless at each station. A card reader emits a small green light. 16:9 cinematic composition.`;

interface AestheticOption {
  name: string;
  shortDescription: string;
  prompt: string;
  seed: number;
}

const aesthetics: AestheticOption[] = [
  {
    name: "01-brutalist-noir",
    shortDescription: "Brutalist Noir — cold concrete, deep shadows, Blade Runner 2049 meets 1984",
    seed: 100001,
    prompt: `${BASE_SCENE} Shot on Kodak Vision3 500T 5219 film stock. Brutalist dystopian noir aesthetic. Cold steel-blue and concrete-gray palette with sickly fluorescent white-blue overhead lighting. Deep noir shadows, hard contrast. Monolithic concrete architecture. Steam rises from floor grates. Heavy film grain, crushed blacks. Anamorphic lens flare on the green card reader light. Cinematic, oppressive, totalitarian atmosphere. Desaturated except for the faint green glow.`
  },
  {
    name: "02-analog-surveillance",
    shortDescription: "Analog Surveillance — CRT scan lines, VHS tracking, security camera aesthetic",
    seed: 100002,
    prompt: `${BASE_SCENE} 1980s analog surveillance camera aesthetic. CRT scan lines and VHS tracking artifacts overlay the image. Grainy, washed-out institutional colors — pale green, dirty beige, faded gray. Overhead fluorescent tubes cast flat, unflattering light with no shadows. Fish-eye lens distortion at edges. Timestamp text overlay in bottom corner. The whole image looks like footage from a government security camera — clinical, impersonal, watching. Low resolution feel, CCTV grain.`
  },
  {
    name: "03-graphic-novel",
    shortDescription: "Graphic Novel — high contrast ink, Sin City meets V for Vendetta, stark black and white with color accents",
    seed: 100003,
    prompt: `${BASE_SCENE} Graphic novel illustration style inspired by Sin City and V for Vendetta. Stark black and white with extremely high contrast. Bold ink lines and heavy crosshatching for shadows. The only color in the entire image is the green glow of the card reader. Dramatic chiaroscuro lighting. Deep blacks, pure whites, no midtones. The smoke of the faceless figure rendered in swirling ink wash. Comic book panel composition. Frank Miller influence. Detailed architectural linework on the corridor.`
  },
  {
    name: "04-soviet-propaganda",
    shortDescription: "Soviet Propaganda Realism — constructivist angles, muted earth tones, political poster geometry",
    seed: 100004,
    prompt: `${BASE_SCENE} Soviet constructivist propaganda poster meets social realism painting. Strong diagonal composition, dramatic low angle. Muted earth tones — rust red, institutional olive, concrete gray, faded gold. The corridor rendered with geometric precision, vanishing point dead center. Flat areas of bold color like a lithograph print. The faceless figures have an imposing monumental quality. Textured like aged paper with fold marks. Heroic/anti-heroic scale — the bureaucracy looms enormous, the man is small. Cyrillic-inspired geometric patterns in the architecture.`
  },
  {
    name: "05-clean-dystopia",
    shortDescription: "Clean Dystopia — Apple-white minimalism, sterile and terrifying, THX-1138 meets Black Mirror",
    seed: 100005,
    prompt: `${BASE_SCENE} Ultra-clean minimalist dystopia. Stark white walls, white floors, white ceiling. Everything is pristine, sterile, and terrifyingly orderly. The man in his dark suit is the only dark element — he stands out against the blinding whiteness. The glass desks are perfectly aligned, spotless. The faceless figures wear identical white uniforms. Soft ambient lighting from everywhere and nowhere — no shadows at all. Apple-store minimalism as totalitarianism. The corridor is impossibly clean. THX-1138 meets Black Mirror. The green card reader light is the only color in the entire frame.`
  },
  {
    name: "06-oil-painting-baroque",
    shortDescription: "Baroque Digital — Caravaggio lighting, oil paint texture, old master chiaroscuro on dystopian subject matter",
    seed: 100006,
    prompt: `${BASE_SCENE} Classical baroque oil painting style with Caravaggio-inspired chiaroscuro lighting. Rich, dark canvas with dramatic spotlight illumination from a single source above. Visible oil paint texture and brushstrokes. Deep amber and burnt sienna shadows, warm candlelight glow on the man's face contrasting with cold blue-gray on the faceless figures. The corridor recedes like a Dutch Golden Age interior perspective study. Renaissance composition and proportions applied to dystopian subject matter. Thick impasto highlights, glazed shadows. Museum-quality fine art aesthetic.`
  }
];

async function generateSample(aesthetic: AestheticOption): Promise<void> {
  console.log(`\n  Generating: ${aesthetic.shortDescription}...`);

  const response = await fetch("https://api.venice.ai/api/v1/image/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "nano-banana-pro",
      prompt: aesthetic.prompt,
      resolution: "1K",
      aspect_ratio: "16:9",
      steps: 30,
      cfg_scale: 7,
      seed: aesthetic.seed,
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

  const outPath = resolve(SAMPLES_DIR, `${aesthetic.name}.png`);
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`    Saved: ${outPath}`);
}

async function main() {
  console.log("Generating 6 aesthetic comparison samples...");
  console.log(`Scene: Surveillance Corridor (man with card, smoke-headed bureaucrat)\n`);

  // Process sequentially to avoid rate limits
  for (const a of aesthetics) {
    await generateSample(a);
    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // Generate comparison HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>WITHOUT PERMISSION — Aesthetic Options</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: 'Helvetica Neue', sans-serif; padding: 2rem; }
    h1 { text-align: center; font-size: 2rem; letter-spacing: 0.3em; text-transform: uppercase; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { text-align: center; font-size: 0.9rem; color: #888; margin-bottom: 3rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(500px, 1fr)); gap: 2rem; max-width: 1400px; margin: 0 auto; }
    .option { background: #151515; border-radius: 8px; overflow: hidden; transition: transform 0.2s; }
    .option:hover { transform: scale(1.02); }
    .option img { width: 100%; display: block; }
    .option .label { padding: 1rem 1.2rem; }
    .option .label h3 { font-size: 1.1rem; margin-bottom: 0.3rem; color: #fff; }
    .option .label p { font-size: 0.85rem; color: #999; line-height: 1.4; }
    .number { display: inline-block; background: #333; color: #fff; width: 1.5rem; height: 1.5rem; text-align: center; line-height: 1.5rem; border-radius: 50%; font-size: 0.75rem; margin-right: 0.5rem; }
  </style>
</head>
<body>
  <h1>Without Permission</h1>
  <p class="subtitle">Aesthetic Options — pick your visual direction</p>
  <div class="grid">
${aesthetics.map((a, i) => `    <div class="option">
      <img src="${a.name}.png" alt="${a.shortDescription}" />
      <div class="label">
        <h3><span class="number">${i + 1}</span>${a.shortDescription.split("—")[0].trim()}</h3>
        <p>${a.shortDescription.split("—")[1]?.trim() || ""}</p>
      </div>
    </div>`).join("\n")}
  </div>
</body>
</html>`;

  writeFileSync(resolve(SAMPLES_DIR, "compare.html"), html);
  console.log(`\nComparison page: ${resolve(SAMPLES_DIR, "compare.html")}`);
  console.log("Done!");
}

main().catch(console.error);
