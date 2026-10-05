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
  outcomeQuestion: string;
  outcomeHelp: string;
  audienceQuestion: string;
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
      outcomeQuestion: 'When the film ends, what should the audience feel, understand, or still be thinking about?',
      outcomeHelp: 'Example: Feel exhilarated by the launch, understand what the pilot sacrificed, and wonder whether the signal was human.',
      audienceQuestion: 'Who is this film for?',
    };
  }

  if (series.projectType === 'product-video') {
    return {
      projectNoun: 'Product video', projectNounLower: 'product video', scriptNoun: 'Video script', scriptNounLower: 'video script',
      segmentNoun: 'Part', segmentNounLower: 'part', containerNoun: 'video', containerNounLower: 'video', defaultScriptTitle: series.name,
      defaultDuration: '60s', targetDurationGuidance: 'Target the requested campaign runtime.', openingGuidance: 'Open on the audience problem or desired outcome.',
      endingGuidance: 'End with one clear next action.', structureGuidance: 'Build proof from problem to transformation to action.',
      closingShotGuidance: 'Use a final product/brand frame only when it supports the call to action.', locationGuidance: 'Use only the environments needed to demonstrate the product credibly.',
      namingGuidance: 'This is a product video, not an episode.',
      outcomeQuestion: 'After watching, what should the viewer understand, believe, and do next?',
      outcomeHelp: 'Example: Understand the privacy benefit, believe setup is easy, then start a free trial.',
      audienceQuestion: 'Who specifically needs this product or message?',
    };
  }
  if (series.projectType === 'music-video') {
    return {
      projectNoun: 'Music video', projectNounLower: 'music video', scriptNoun: 'Video treatment', scriptNounLower: 'video treatment',
      segmentNoun: 'Movement', segmentNounLower: 'movement', containerNoun: 'music video', containerNounLower: 'music video', defaultScriptTitle: series.name,
      defaultDuration: '240s', targetDurationGuidance: 'Match the track duration and musical structure.', openingGuidance: 'Establish the visual thesis in the opening musical phrase.',
      endingGuidance: 'Land the final musical and visual image together.', structureGuidance: 'Map visual escalation and contrast to sections of the track.',
      closingShotGuidance: 'Do not add an unrelated title card after the music resolves.', locationGuidance: 'Choose locations that support the visual thesis and musical changes.',
      namingGuidance: 'This is a music video, not an episode.',
      outcomeQuestion: 'What emotion or visual idea should the song leave in the viewer?',
      outcomeHelp: 'Example: Turn the song’s loneliness into a feeling of vast, luminous freedom.',
      audienceQuestion: 'Who is the song and video meant to connect with?',
    };
  }
  if (series.projectType === 'screenplay') {
    return {
      ...getProjectLanguage({ ...series, projectType: 'film' }),
      projectNoun: 'Screenplay adaptation', projectNounLower: 'screenplay adaptation',
      outcomeQuestion: 'What must survive from the screenplay for this adaptation to feel true?',
      outcomeHelp: 'Name the essential emotional turn, character relationship, image, or theme—not every scene.',
      audienceQuestion: 'Who should this adaptation connect with?',
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
    outcomeQuestion: 'Why should someone keep watching this series after the first installment?',
    outcomeHelp: 'Name the ongoing promise: the mystery, relationship, transformation, or useful result they return for.',
    audienceQuestion: 'Who should become a regular viewer of this series?',
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
