import 'dotenv/config';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

/**
 * Script-aware audio post-production mixer for mini-drama episodes.
 *
 * Reads script.json to understand each shot's content (dialogue, SFX cues,
 * shot type, characters) and uses that to determine:
 * - Native audio volume (higher for dialogue, lower for ambient-only)
 * - Which ambient layers to activate (rain, crowd, quiet night)
 * - Fade envelopes at shot boundaries
 *
 * No hardcoded shot numbers -- everything is derived from script metadata.
 */

interface ScriptShot {
  shotNumber: number;
  type: string;
  duration: string;
  description: string;
  characters: string[];
  dialogue: { character: string; line: string; delivery: string } | null;
  sfx: string;
  transition: string;
  panelDescription?: string;
}

interface EpisodeScript {
  episode: number;
  title: string;
  shots: ScriptShot[];
}

interface ShotAudioConfig {
  shotNumber: number;
  file: string;
  duration: number;
  startTime: number;
  nativeVolume: number;
  fadeIn: number;
  fadeOut: number;
  ambientLayers: { rain: number; crowd: number; quietNight: number };
  reason: string; // human-readable description of why these settings were chosen
}

function getVideoDuration(path: string): number {
  return parseFloat(
    execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`, { encoding: 'utf-8' }).trim(),
  );
}

function run(cmd: string) {
  execSync(cmd, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
}

// ── SFX keyword detection ──

function sfxHas(sfx: string, ...keywords: string[]): boolean {
  const lower = sfx.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

function descHas(desc: string, ...keywords: string[]): boolean {
  const lower = desc.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/**
 * Determine audio config for a shot based on its script metadata.
 * Uses sfx cues, shot type, dialogue presence, and description to decide
 * which ambient layers to activate and how much native audio to keep.
 */
function classifyShot(shot: ScriptShot, isLastShot: boolean, prevShot?: ScriptShot, nextShot?: ScriptShot): Omit<ShotAudioConfig, 'file' | 'duration' | 'startTime'> {
  const sfx = shot.sfx || '';
  const desc = (shot.description || '') + ' ' + (shot.panelDescription || '');
  const hasDialogue = !!shot.dialogue;
  const type = shot.type || '';

  let nativeVolume = 0.6;
  let fadeIn = 0.15;
  let fadeOut = 0.15;
  const ambientLayers = { rain: 0, crowd: 0, quietNight: 0 };
  const reasons: string[] = [];

  // ── Rain detection ──
  const hasRain = sfxHas(sfx, 'rain', 'wet', 'puddle', 'drizzle') || descHas(desc, 'rain', 'wet pavement', 'rain-soaked');
  if (hasRain) {
    ambientLayers.rain = 0.25;
    reasons.push('rain');
  }

  // ── Crowd/urban detection ──
  const hasCrowd = sfxHas(sfx, 'crowd', 'vendor', 'chatter', 'bustle', 'market') || descHas(desc, 'crowd', 'market', 'vendor', 'bustle');
  if (hasCrowd) {
    ambientLayers.crowd = 0.25;
    reasons.push('crowd');
  }

  // ── Action/chase detection -- duck ambient, boost native for impact ──
  const isAction = sfxHas(sfx, 'running', 'footsteps', 'sprint', 'chase', 'punch', 'grab', 'scrambl') || descHas(desc, 'sprint', 'chase', 'runs', 'grabs', 'catches', 'punches');
  if (isAction) {
    nativeVolume = 0.7;
    // Reduce rain during action so it doesn't compete -- gradual fade, not hard cut
    if (ambientLayers.rain > 0) ambientLayers.rain = Math.min(ambientLayers.rain, 0.12);
    if (ambientLayers.crowd > 0) ambientLayers.crowd = Math.min(ambientLayers.crowd, 0.08);
    reasons.push('action');
  }

  // ── Dialogue detection -- highest native volume, lowest ambient ──
  if (hasDialogue) {
    nativeVolume = 0.85;
    // Pull ambient way down so voices are clear
    if (ambientLayers.rain > 0) ambientLayers.rain = Math.min(ambientLayers.rain, 0.08);
    if (ambientLayers.crowd > 0) ambientLayers.crowd = Math.min(ambientLayers.crowd, 0.05);
    ambientLayers.quietNight = 0.12;
    reasons.push('dialogue');
  }

  // ── Close-up / intimate -- quiet ambient, moderate native ──
  if (type === 'close-up' && !hasDialogue) {
    nativeVolume = 0.5;
    ambientLayers.quietNight = Math.max(ambientLayers.quietNight, 0.15);
    if (ambientLayers.rain > 0) ambientLayers.rain = Math.min(ambientLayers.rain, 0.2);
    reasons.push('close-up');
  }

  // ── Establishing / wide -- lower native, let ambient paint the space ──
  if (type === 'establishing') {
    nativeVolume = 0.5;
    if (ambientLayers.rain > 0) ambientLayers.rain = Math.max(ambientLayers.rain, 0.3);
    reasons.push('establishing');
  }

  // ── Insert / title card -- fade everything down ──
  if (type === 'insert' || descHas(desc, 'title card')) {
    nativeVolume = 0.3;
    ambientLayers.rain = Math.min(ambientLayers.rain, 0.1);
    ambientLayers.crowd = 0;
    ambientLayers.quietNight = Math.min(ambientLayers.quietNight || 0.1, 0.1);
    fadeOut = 1.5;
    reasons.push('title/insert');
  }

  // ── Quiet/contemplation -- no crowd, quiet ambience ──
  const isQuiet = sfxHas(sfx, 'silence', 'heartbeat', 'distant', 'fading') || descHas(desc, 'contemplat', 'wistful', 'watches', 'walks away', 'disappear');
  if (isQuiet && !hasDialogue && !isAction) {
    nativeVolume = 0.45;
    ambientLayers.crowd = 0;
    ambientLayers.quietNight = Math.max(ambientLayers.quietNight, 0.2);
    if (ambientLayers.rain > 0) ambientLayers.rain = Math.min(ambientLayers.rain, 0.2);
    reasons.push('contemplative');
  }

  // ── Smoothing: if previous shot had rain and this one doesn't, add a low residual ──
  if (prevShot && !hasRain) {
    const prevHasRain = sfxHas(prevShot.sfx || '', 'rain', 'wet') || descHas(prevShot.description || '', 'rain', 'rain-soaked');
    if (prevHasRain && ambientLayers.rain === 0) {
      ambientLayers.rain = 0.05; // residual to prevent hard cut
      reasons.push('rain-residual');
    }
  }

  // ── Smoothing: if next shot has crowd but this one doesn't, add lead-in ──
  if (nextShot) {
    const nextHasCrowd = sfxHas(nextShot.sfx || '', 'crowd', 'vendor', 'chatter') || descHas(nextShot.description || '', 'crowd', 'market');
    if (nextHasCrowd && ambientLayers.crowd === 0 && !isQuiet) {
      ambientLayers.crowd = 0.05; // subtle lead-in
      reasons.push('crowd-leadin');
    }
  }

  return {
    shotNumber: shot.shotNumber,
    nativeVolume,
    fadeIn,
    fadeOut,
    ambientLayers,
    reason: reasons.join(', ') || 'default',
  };
}

// ── Main ──

const episodeDir = resolve(process.argv[2] || 'output/neon-hearts/episodes/episode-001');
const sceneDir = join(episodeDir, 'scene-001');
const audioDir = join(episodeDir, 'audio');
const tmpDir = join(episodeDir, '.tmp-audio-mix');

// Load script
const scriptPath = join(episodeDir, 'script.json');
if (!existsSync(scriptPath)) {
  console.error(`Script not found: ${scriptPath}`);
  process.exit(1);
}
const script: EpisodeScript = JSON.parse(readFileSync(scriptPath, 'utf-8'));
console.log(`Episode ${script.episode}: "${script.title}" (${script.shots.length} shots in script)`);

if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

// ── Discover shot files and match to script ──
const shotFiles: string[] = [];
for (let i = 1; i <= 50; i++) {
  const f = join(sceneDir, `shot-${String(i).padStart(3, '0')}.mp4`);
  if (existsSync(f)) shotFiles.push(f);
}
console.log(`Found ${shotFiles.length} video files\n`);

// ── Classify each shot using script metadata ──
let cumulative = 0;
const shots: ShotAudioConfig[] = shotFiles.map((f, idx) => {
  const shotNum = idx + 1;
  const dur = getVideoDuration(f);
  const start = cumulative;
  cumulative += dur;

  const scriptShot = script.shots.find(s => s.shotNumber === shotNum);
  if (!scriptShot) {
    console.warn(`  Shot ${shotNum}: no script entry found, using defaults`);
    return {
      shotNumber: shotNum, file: f, duration: dur, startTime: start,
      nativeVolume: 0.6, fadeIn: 0.15, fadeOut: 0.15,
      ambientLayers: { rain: 0.2, crowd: 0, quietNight: 0.1 },
      reason: 'no-script',
    };
  }

  const prevScript = script.shots.find(s => s.shotNumber === shotNum - 1);
  const nextScript = script.shots.find(s => s.shotNumber === shotNum + 1);
  const isLast = shotNum === shotFiles.length;

  const config = classifyShot(scriptShot, isLast, prevScript, nextScript);
  return { ...config, file: f, duration: dur, startTime: start };
});

const totalDuration = cumulative;

// Print classification table
console.log('Shot classification:');
console.log('─'.repeat(90));
console.log('Shot  Type          Native  Rain  Crowd  Quiet  Reason');
console.log('─'.repeat(90));
for (const shot of shots) {
  const scriptShot = script.shots.find(s => s.shotNumber === shot.shotNumber);
  const type = (scriptShot?.type || '?').padEnd(12);
  const dlg = scriptShot?.dialogue ? ' [DLG]' : '';
  console.log(
    `  ${String(shot.shotNumber).padStart(2)}  ${type}  ${(shot.nativeVolume * 100).toFixed(0).padStart(4)}%  ${(shot.ambientLayers.rain * 100).toFixed(0).padStart(4)}%  ${(shot.ambientLayers.crowd * 100).toFixed(0).padStart(5)}%  ${(shot.ambientLayers.quietNight * 100).toFixed(0).padStart(5)}%  ${shot.reason}${dlg}`,
  );
}
console.log('─'.repeat(90));
console.log(`Total: ${totalDuration.toFixed(2)}s\n`);

// ── Step 1: Extract and process native audio per shot ──
console.log('Step 1: Extracting and processing native audio...');
const processedAudio: string[] = [];

for (const shot of shots) {
  const outPath = join(tmpDir, `native-${String(shot.shotNumber).padStart(3, '0')}.wav`);

  const fadeInFilter = shot.fadeIn > 0 ? `afade=t=in:st=0:d=${shot.fadeIn},` : '';
  const fadeOutFilter = shot.fadeOut > 0 ? `afade=t=out:st=${Math.max(0, shot.duration - shot.fadeOut)}:d=${shot.fadeOut},` : '';

  run(
    `ffmpeg -y -i "${shot.file}" ` +
    `-af "${fadeInFilter}${fadeOutFilter}volume=${shot.nativeVolume}" ` +
    `-ar 44100 -ac 2 "${outPath}"`,
  );

  processedAudio.push(outPath);
}
console.log(`  Processed ${processedAudio.length} clips`);

// ── Step 2: Concatenate native audio ──
console.log('\nStep 2: Concatenating native audio...');
const concatList = join(tmpDir, 'native-concat.txt');
writeFileSync(concatList, processedAudio.map(f => `file '${f}'`).join('\n'), 'utf-8');

const nativeMixPath = join(tmpDir, 'native-full.wav');
run(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c copy "${nativeMixPath}"`);

// ── Step 3: Create ambient layers with per-shot volume envelopes ──
console.log('\nStep 3: Building ambient layers...');

const rainFile = join(audioDir, 'ambient-rain-heavy.mp3');
const crowdFile = join(audioDir, 'ambient-crowd.mp3');
const quietFile = join(audioDir, 'ambient-quiet-night.mp3');

function createAmbientLayer(srcFile: string, layerKey: 'rain' | 'crowd' | 'quietNight', outName: string): string | null {
  if (!existsSync(srcFile)) {
    console.log(`  ${outName}: SKIPPED (file not found)`);
    return null;
  }

  const hasAnyVolume = shots.some(s => s.ambientLayers[layerKey] > 0);
  if (!hasAnyVolume) {
    console.log(`  ${outName}: SKIPPED (no shots use this layer)`);
    return null;
  }

  const outPath = join(tmpDir, `${outName}.wav`);

  const volFilters = shots
    .map(shot => {
      const vol = shot.ambientLayers[layerKey];
      const start = shot.startTime;
      const end = shot.startTime + shot.duration;
      return `volume=${vol}:enable='between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})'`;
    })
    .join(',');

  run(
    `ffmpeg -y -stream_loop -1 -i "${srcFile}" ` +
    `-af "${volFilters},afade=t=in:st=0:d=1,afade=t=out:st=${(totalDuration - 2).toFixed(3)}:d=2" ` +
    `-t ${totalDuration.toFixed(3)} -ar 44100 -ac 2 "${outPath}"`,
  );

  console.log(`  ${outName}: OK (${totalDuration.toFixed(1)}s)`);
  return outPath;
}

const rainLayer = createAmbientLayer(rainFile, 'rain', 'layer-rain');
const crowdLayer = createAmbientLayer(crowdFile, 'crowd', 'layer-crowd');
const quietLayer = createAmbientLayer(quietFile, 'quietNight', 'layer-quiet');

// ── Step 4: Mix all layers together ──
console.log('\nStep 4: Final mix...');

const layers = [nativeMixPath, rainLayer, crowdLayer, quietLayer].filter(Boolean) as string[];
const finalAudioPath = join(tmpDir, 'final-mix.wav');

if (layers.length === 1) {
  run(`cp "${layers[0]}" "${finalAudioPath}"`);
} else {
  const inputs = layers.map(f => `-i "${f}"`).join(' ');
  const inputLabels = layers.map((_, i) => `[${i}:a]`).join('');
  run(
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${inputLabels}amix=inputs=${layers.length}:duration=first:dropout_transition=2" ` +
    `-ar 44100 -ac 2 "${finalAudioPath}"`,
  );
}

console.log(`  Mixed ${layers.length} layers -> final-mix.wav`);

// ── Step 5: Mux final audio onto concatenated video ──
console.log('\nStep 5: Muxing audio onto video...');

const normVideoFiles: string[] = [];
for (const shot of shots) {
  const normPath = join(tmpDir, `vidnorm-${String(shot.shotNumber).padStart(3, '0')}.mp4`);
  run(`ffmpeg -y -i "${shot.file}" -c:v libx264 -preset fast -crf 18 -r 24 -an "${normPath}"`);
  normVideoFiles.push(normPath);
}

const videoConcatList = join(tmpDir, 'video-concat.txt');
writeFileSync(videoConcatList, normVideoFiles.map(f => `file '${f}'`).join('\n'), 'utf-8');

const videoOnlyConcat = join(tmpDir, 'video-only.mp4');
run(`ffmpeg -y -f concat -safe 0 -i "${videoConcatList}" -c copy "${videoOnlyConcat}"`);

// Derive output filename from episode number
const epNum = String(script.episode).padStart(3, '0');
const outputPath = join(episodeDir, `episode-${epNum}-final-nosubs.mp4`);
run(
  `ffmpeg -y -i "${videoOnlyConcat}" -i "${finalAudioPath}" ` +
  `-map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`,
);

console.log(`  Output: ${outputPath}`);

// ── Step 6: Burn subtitles ──
const srtPath = join(episodeDir, 'subtitles.srt');
const finalOutput = join(episodeDir, `episode-${epNum}-final.mp4`);

if (existsSync(srtPath)) {
  console.log('\nStep 6: Burning subtitles...');
  const escapedSrt = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:');
  run(
    `ffmpeg -y -i "${outputPath}" ` +
    `-vf "subtitles='${escapedSrt}':force_style='FontName=D-DIN Condensed,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=0.8,Shadow=0,Alignment=2,MarginV=100,Spacing=0.5'" ` +
    `-c:v libx264 -preset fast -crf 18 -c:a copy "${finalOutput}"`,
  );
  console.log(`  Subtitles burned -> ${basename(finalOutput)}`);
} else {
  run(`cp "${outputPath}" "${finalOutput}"`);
}

// ── Cleanup ──
console.log('\nCleaning up temp files...');
rmSync(tmpDir, { recursive: true, force: true });

const finalDur = getVideoDuration(finalOutput);
const finalSize = execSync(`ls -lh "${finalOutput}"`, { encoding: 'utf-8' }).split(/\s+/)[4];
console.log(`\nDone! ${finalOutput} (${finalDur.toFixed(1)}s, ${finalSize})`);
