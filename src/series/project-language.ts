import type { SeriesState } from './types.js';

export interface ProjectLanguage {
  projectNoun: string;
  projectNounLower: string;
  scriptNoun: string;
  scriptNounLower: string;
  segmentNoun: string;
  segmentNounLower: string;
  containerNoun: string;
  containerNounLower: string;
  defaultScriptTitle: string;
  defaultDuration: string;
  targetDurationGuidance: string;
  openingGuidance: string;
  endingGuidance: string;
  structureGuidance: string;
  closingShotGuidance: string;
  locationGuidance: string;
  namingGuidance: string;
}

export function getProjectLanguage(series: Pick<SeriesState, 'name' | 'projectType'>): ProjectLanguage {
  if (series.projectType === 'film') {
    return {
      projectNoun: 'Film', projectNounLower: 'film',
      scriptNoun: 'Film script', scriptNounLower: 'film script',
      segmentNoun: 'Part', segmentNounLower: 'part',
      containerNoun: 'film', containerNounLower: 'film',
      defaultScriptTitle: series.name,
      defaultDuration: '300s',
      targetDurationGuidance: 'Target the duration requested in the concept. If none is given, plan a coherent 3-5 minute film.',
      openingGuidance: 'Open with a compelling visual hook appropriate to the film.',
      endingGuidance: 'End with a complete final beat or the specific ending requested; do not manufacture an episodic cliffhanger.',
      structureGuidance: 'Use as many scenes, locations, and emotional turns as the film needs. Keep each shot focused on one intention.',
      closingShotGuidance: 'Include a title card only if the concept requests one or it serves the film; do not force an episodic end card.',
      locationGuidance: 'Define and reuse every location the requested film requires.',
      namingGuidance: 'This project is a film. Never call it an episode or series in the title, synopsis, or generated prose. The JSON keys `episode` and `seriesName` are legacy storage fields only.',
    };
  }

  return {
    projectNoun: 'Series', projectNounLower: 'series',
    scriptNoun: 'Episode script', scriptNounLower: 'episode script',
    segmentNoun: 'Episode', segmentNounLower: 'episode',
    containerNoun: 'series', containerNounLower: 'series',
    defaultScriptTitle: 'First episode',
    defaultDuration: '60s',
    targetDurationGuidance: 'Target 58-75 seconds total duration.',
    openingGuidance: 'Open with a visual hook in the first 3 seconds.',
    endingGuidance: 'End on a beat that makes viewers want the next episode.',
    structureGuidance: 'Use one scene, one location, and one emotional note.',
    closingShotGuidance: 'End with a 3-second title card insert using a FADE transition.',
    locationGuidance: 'A single location is the default for this short episode; introduce another only when the story requires it.',
    namingGuidance: 'This project is episodic; use series and episode terminology.',
  };
}

export function buildScriptWorkshopPrompt(
  series: Pick<SeriesState, 'name' | 'projectType' | 'concept' | 'genre' | 'setting'>,
  part: number,
  concept: string,
): string {
  const language = getProjectLanguage(series);
  return [
    `You are a screenwriter for the ${language.projectNounLower} "${series.name}".`,
    language.namingGuidance,
    `Project concept: ${series.concept}`,
    `Genre: ${series.genre}`,
    `Setting: ${series.setting}`,
    `Write ${language.segmentNoun} ${part} of the ${language.projectNounLower}.`,
    language.targetDurationGuidance,
    language.openingGuidance,
    language.endingGuidance,
    language.structureGuidance,
    language.closingShotGuidance,
    language.locationGuidance,
    `Requested concept: ${concept}`,
  ].join('\n');
}
