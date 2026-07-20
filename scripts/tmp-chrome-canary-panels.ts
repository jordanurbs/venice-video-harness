// One-off: suffix-aware panel generation for chrome-canary episode 2 rework.
// Replicates storyboard-episode passes 1-3 but keys files by shotKey()
// (suffix-aware) and only touches an explicit list of shots.
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VeniceClient } from '../src/venice/client.js';
import { generateImage, generateWithReferences } from '../src/venice/generate.js';
import { writeImageProvenance } from '../src/venice/provenance.js';
import { buildImagePrompt } from '../src/mini-drama/prompt-builder.js';
import { refineWithReferences, refineStyleConsistency } from '../src/mini-drama/panel-fixer.js';
import { multiEditImage, loadImageAsDataUri } from '../src/venice/multi-edit.js';
import { loadSeries, loadEpisodeScript, getEpisodeDir, getCharacterDir } from '../src/series/manager.js';
import { shotKey } from '../src/mini-drama/shot-paths.js';
import type { CharacterReference } from '../src/venice/types.js';

const PROJECT = '/Users/venetian42069/projects/sites/learn-venice/output/the-chrome-canary-trailer';
const EPISODE = 2;
const TARGETS = process.argv.slice(2); // e.g. 009 013 013b 004b ...

async function main() {
  if (TARGETS.length === 0) throw new Error('pass shot keys, e.g. 009 013b 004b');
  const series = await loadSeries(resolve(PROJECT));
  if (!series) throw new Error('series not found');
  const script = await loadEpisodeScript(series, EPISODE);
  if (!script) throw new Error('script not found');
  const sceneDir = join(getEpisodeDir(series, EPISODE), 'scene-001');
  const client = new VeniceClient(process.env.VENICE_API_KEY!);
  const cfgScale = 10;
  const storyboardAR = series.storyboardAspectRatio ?? '16:9';
  const editModel = 'seedream-v5-lite-edit' as const;

  const wanted = script.shots.filter(s =>
    TARGETS.includes(shotKey(`${s.shotNumber}${(s as { shotIdSuffix?: string }).shotIdSuffix ?? ''}`)));
  console.log(`Generating ${wanted.length} panels: ${wanted.map(s => shotKey(`${s.shotNumber}${(s as { shotIdSuffix?: string }).shotIdSuffix ?? ''}`)).join(', ')}`);

  // style anchor for non-character panels (matches CLI: first char shot's panel)
  const anchorSrc = join(sceneDir, 'shot-004.png');
  const styleAnchorPath = join(sceneDir, '.style-anchor-oneoff.png');
  if (existsSync(anchorSrc)) await copyFile(anchorSrc, styleAnchorPath);

  for (const shot of wanted) {
    const key = shotKey(`${shot.shotNumber}${(shot as { shotIdSuffix?: string }).shotIdSuffix ?? ''}`);
    const imgPath = join(sceneDir, `shot-${key}.png`);
    if (existsSync(imgPath)) {
      const archive = imgPath.replace(/\.png$/, `-replaced-${Date.now()}.png`);
      await rename(imgPath, archive);
      console.log(`  [${key}] archived existing -> ${archive}`);
    }

    const imagePrompt = buildImagePrompt(shot, series);
    const hasChars = shot.characters && shot.characters.length > 0;
    const panelModel = series.videoDefaults.imageDefaults?.generationModel ?? 'nano-banana-pro';

    let imgBuffer: Buffer | undefined;
    if (hasChars) {
      const charRefs = shot.characters.map(name => {
        const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
        if (!char) return null;
        const frontPath = join(getCharacterDir(series, char.name), 'front.png');
        if (!existsSync(frontPath)) return null;
        return { name: char.name, role: char.description.slice(0, 80), base64Image: readFileSync(frontPath).toString('base64') };
      }).filter(Boolean) as CharacterReference[];
      if (charRefs.length > 0) {
        const result = await generateWithReferences(client, {
          model: panelModel, prompt: imagePrompt.prompt, negative_prompt: imagePrompt.negativePrompt,
          resolution: '1K', aspect_ratio: storyboardAR, steps: 30, cfg_scale: cfgScale,
          seed: imagePrompt.seed, safe_mode: false, hide_watermark: true,
          referenceImages: charRefs, faceSlots: Math.min(charRefs.length, 2),
        });
        imgBuffer = Buffer.from(result.base64, 'base64');
      }
    }
    if (!imgBuffer) {
      const response = await generateImage(client, {
        model: panelModel, prompt: imagePrompt.prompt, negative_prompt: imagePrompt.negativePrompt,
        resolution: '1K', aspect_ratio: storyboardAR, steps: 30, cfg_scale: cfgScale,
        seed: imagePrompt.seed, safe_mode: false, hide_watermark: true,
      });
      imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
    }
    await writeFile(imgPath, imgBuffer);
    await writeImageProvenance(imgPath, panelModel, [], { hasFace: !!hasChars });
    console.log(`  [${key}] pass 1 saved (${panelModel})`);

    // Pass 2
    if (hasChars) {
      try {
        await refineWithReferences(client, series, imgPath, shot, editModel);
        console.log(`  [${key}] pass 2 character-refined`);
      } catch (err) { console.warn(`  [${key}] pass 2 refine FAILED: ${err}`); }
    } else if (existsSync(styleAnchorPath) && !shot.skipRefine) {
      try {
        const aestheticStr = [series.aesthetic!.style, series.aesthetic!.palette, series.aesthetic!.lighting].join(', ');
        await refineStyleConsistency(client, imgPath, styleAnchorPath, aestheticStr, editModel, shot.environment);
        console.log(`  [${key}] pass 2 style-refined`);
      } catch (err) { console.warn(`  [${key}] pass 2 style FAILED: ${err}`); }
    }

    // Pass 3: scene-ref injection
    const scenePaths = (shot as { sceneImagePaths?: string[] }).sceneImagePaths ?? [];
    if (scenePaths.length > 0) {
      const refs: string[] = [];
      for (const p of scenePaths.slice(0, 2)) if (existsSync(p)) refs.push(await loadImageAsDataUri(p));
      if (refs.length > 0) {
        const desc = (shot as { sceneRefDescription?: string }).sceneRefDescription;
        const prompt = desc
          ? `${desc} Preserve the scene composition, characters, lighting, and cinematic framing exactly. Do not add text, speech bubbles, or panel borders.`
          : `Integrate the visual elements from the reference image(s) into this scene. Preserve the scene composition, characters, lighting, and cinematic framing exactly. Do not change the overall image. Do not add text, speech bubbles, or panel borders.`;
        try {
          const panelDataUri = await loadImageAsDataUri(imgPath);
          const out = await multiEditImage(client, { model: editModel, prompt, baseImage: panelDataUri, referenceImages: refs });
          await rename(imgPath, imgPath.replace(/\.png$/, '-pre-scene-ref.png'));
          await writeFile(imgPath, out);
          console.log(`  [${key}] pass 3 scene-ref injected`);
        } catch (err) { console.warn(`  [${key}] pass 3 FAILED: ${err}`); }
      }
    }
  }
  console.log('done');
}

main().catch(err => { console.error(err); process.exit(1); });
