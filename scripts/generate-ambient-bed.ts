import 'dotenv/config';
import { VeniceClient } from '../src/venice/client.js';
import { generateSoundEffect } from '../src/venice/audio.js';

const prompt = process.argv[2] || 'Steady gentle rain falling on a city street at night, distant urban hum, wet pavement reflections, no thunder, no music, continuous ambient loop';
const outputPath = process.argv[3] || 'output/neon-hearts/episodes/episode-001/audio/ambient-rain-heavy.mp3';
const duration = parseInt(process.argv[4] || '22', 10);

const client = new VeniceClient();

console.log(`Generating ${duration}s ambient bed...`);
console.log(`Prompt: ${prompt}`);

await generateSoundEffect(client, {
  text: prompt,
  durationSeconds: duration,
}, outputPath);

console.log(`Saved to: ${outputPath}`);
