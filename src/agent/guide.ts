// ---------------------------------------------------------------------------
// The core operating rules, shipped inside the binary.
//
// AGENTS.md is 84KB — 49 rules and 28 anti-patterns. A repo-resident agent
// reads it from the checkout; an MCP-connected agent reads it from the clone.
// A user who ran `npm install -g venice-video-harness` and talks to a
// persistent assistant (Hermes, OpenClaw) has neither, and until now the only
// installable path shipped no agent knowledge at all.
//
// This is the ~80/20 subset: the rules whose absence loses money or produces
// unusable output. It prints from `venice-video agent-guide`, so it cannot be
// left out of a tarball, and it points at AGENTS.md and the skills for depth.
// Keep it short — a runner with a persistent system prompt may paste it in.
//
// When a rule here changes in AGENTS.md, change it here too; a stale guide that
// contradicts the full rules is worse than a pointer to them.
// ---------------------------------------------------------------------------

export interface GuideSection {
  title: string;
  points: string[];
}

export const AGENT_GUIDE: readonly GuideSection[] = [
  {
    title: 'Find the next step, do not guess',
    points: [
      '`venice-video pipeline --json` lists the ordered stages, their gates, and the command that advances each.',
      '`venice-video status -p <project> --json` reports where a project stands and the exact next command.',
      'Always pass -p <project> (and -e <episode>) explicitly. Do not rely on a selection a human may have set.',
    ],
  },
  {
    title: 'Money is spent at queue time',
    points: [
      'Venice bills when a render is queued, not when it downloads. A lost queue id is money already spent.',
      'Every queued render is recorded to pending-jobs.json before the first poll. If a command is interrupted, re-run the SAME command with the SAME output path — that re-attaches to the paid job instead of paying again.',
      'A killed render (e.g. a command timeout) is usually still running and billed. Do not treat a timeout as a failed render and retry it; re-attach.',
      'Inspect in-flight work with `venice-video queue --json`. Only `queue clear` a record you know is dead.',
    ],
  },
  {
    title: 'Long renders need background invocation',
    points: [
      'generate-videos, assemble-episode, produce-episode, finish, and upscale run 3–10 minutes.',
      'Runners cap foreground commands (Hermes defaults to 180s, hard cap 600s). Run these in the background with completion notification, not in the foreground.',
      'A foreground timeout kills the process but not the Venice job — see the billing rule above.',
    ],
  },
  {
    title: 'Gates are human decisions',
    points: [
      'approve-script and qa-approve are explicit human sign-offs, not steps an agent clears on its own.',
      '--skip-approval and --skip-qa do not make the script approved or the QA cleared; they only bypass the check. They are not the fix. Ask the human to approve.',
    ],
  },
  {
    title: 'Consistency-first generation',
    points: [
      'Prefer 15s shots. Two 15s shots beat five 6s shots on identity stability, motion completion, continuity, and cost.',
      'Front-load style at the START of every prompt; keep Seedance prompts under ~60 words with the 5-part structure (Subject, Action, Camera, Style, Constraints).',
      'Direct the beat, do not decorate it: name one intention and derive camera/light/blocking/performance from it. Do not stack "cinematic / epic / 4k" adjectives.',
      'Re-anchor every separately-rendered shot to the SAME locked references and restate the character invariant traits (including relative size) in every prompt.',
      'State placement explicitly in every prompt: lock each location\'s landmark geography (spatialAnchors) and give every character shot a blocking field (position vs named anchors, screen side, depth, facing/eyeline). Keep screen sides and eyelines constant across a scene unless a movement is scripted.',
      'Prefer native model dialogue (Seedance 2.0, HappyHorse 1.1 with voice-donor references) over exact TTS lip-sync.',
    ],
  },
  {
    title: 'Where the full knowledge lives',
    points: [
      'AGENTS.md — 49 rules and 28 production anti-patterns, shipped in the package.',
      '.claude/skills/ — venice-api, venice-video-model-routing, character-consistency, shot-composition, burn-in-subtitles, video-editing, and more.',
      '.claude/commands/ — 20 step-by-step playbooks; .claude/agents/ — 10 sub-agent roles.',
      'Read the relevant playbook before running a workflow. Validate model capabilities against src/venice/models.ts before an API call.',
    ],
  },
];

export function guideAsJson(): { version: 1; sections: readonly GuideSection[] } {
  return { version: 1, sections: AGENT_GUIDE };
}

export function formatGuide(): string {
  const lines: string[] = [];
  lines.push('Venice Video Harness — core rules for driving this CLI from an agent');
  lines.push('Full rules: AGENTS.md · Playbooks: .claude/commands/ · Knowledge: .claude/skills/');
  lines.push('');
  for (const section of AGENT_GUIDE) {
    lines.push(`## ${section.title}`);
    for (const point of section.points) lines.push(`  - ${point}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
