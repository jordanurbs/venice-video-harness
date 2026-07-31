import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScriptWorkshopPrompt, getProjectLanguage } from '../dist/series/project-language.js';

const film = { name: 'Long Horizon', projectType: 'film', concept: 'A long ocean crossing', genre: 'adventure', setting: 'open ocean' };
const series = { name: 'Night Watch', projectType: 'series', concept: 'Night-shift mysteries', genre: 'drama', setting: 'a city hospital' };

test('Film language does not impose episode assumptions', () => {
  const language = getProjectLanguage(film);
  assert.equal(language.scriptNoun, 'Film script');
  assert.equal(language.segmentNoun, 'Part');
  assert.equal(language.defaultDuration, '300s');
  assert.doesNotMatch(language.targetDurationGuidance, /60-second episode/i);
  assert.doesNotMatch(language.endingGuidance, /next episode/i);

  const prompt = buildScriptWorkshopPrompt(film, 1, 'Make it seven minutes with a complete ending');
  assert.match(prompt, /screenwriter for the film/);
  assert.match(prompt, /Never call it an episode or series/);
  assert.match(prompt, /seven minutes/);
  assert.match(prompt, /complete final beat/);
  assert.doesNotMatch(prompt, /want the next episode/);
});

test('Series language preserves episode guidance', () => {
  const language = getProjectLanguage(series);
  assert.equal(language.segmentNoun, 'Episode');
  assert.equal(language.defaultDuration, '60s');
  const prompt = buildScriptWorkshopPrompt(series, 2, 'A patient vanishes');
  assert.match(prompt, /Episode 2/);
  assert.match(prompt, /58-75 seconds/);
  assert.match(prompt, /next episode/);
});
