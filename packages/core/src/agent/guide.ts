// ---------------------------------------------------------------------------
// The core operating rules, shipped inside the binary.
//
// AGENTS.md is 84KB — 55 rules and 31 anti-patterns. A repo-resident agent
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
      'generate-videos renders up to 3 units at once (--concurrency N; 1 renders one at a time), and each line a unit prints starts with its id, e.g. [unit-004]. A unit that starts from the previous clip\'s last frame waits for it. After a failure no new unit starts; units already queued are billed and finish first.',
    ],
  },
  {
    title: 'Gates are human decisions',
    points: [
      'approve-script and qa-approve are explicit human sign-offs, not steps an agent clears on its own.',
      '--skip-approval and --skip-qa do not make the script approved or the QA cleared; they only bypass the check. They are not the fix. Ask the human to approve.',
      'qa-approve reads the QA report: criticals or unchecked shots block approval. --force is the operator saying they reviewed the panels themselves.',
      'qa-approve binds the approval to the panels on disk (a hash per panel plus a digest of its prompt, references and image model). If a panel is regenerated or those settings change afterwards, generate-videos refuses that shot until qa-approve runs again.',
    ],
  },
  {
    title: 'QA the rendered video, not just the panels',
    points: [
      'Panel QA runs BEFORE rendering and cannot catch cross-unit drift: each generation unit re-interprets the character references independently, so the same character can render as three different people across units while every unit passes in isolation.',
      'After generate-videos, run qa-videos. It scans for head-glitch flashes and boundary jumps (free), then vision-checks per-unit identity against the sheets and cross-unit identity across hero frames (one call).',
      'A failing video-qa-report.json blocks assemble-episode. Fix the drifting units; --skip-video-qa only bypasses the check for an operator who watched the footage.',
      'qa-videos also checks the cuts themselves (neighbour continuity): one vision call per cut, counted before any is made, with a checklist (vehicle, people in both shots, props, facing, action, light) and the reference images of the vehicles and props. A different vehicle, person or prop, or a reversed facing, is critical; a reply that does not answer the checklist leaves the cut unchecked, which blocks too. Default: the cuts between generations (--continuity joins|all|off). Only a cut the script marks continuous (and whose clip before is the script\'s previous shot) is judged in full; a time cut, or a join the script does not state within one known location, is never critical, and a new scene or a change of location without a stated join is not judged. A clip not on disk leaves the cuts beside it unchecked. For a film edited elsewhere, pass --cut-list <cut list or EDL>; mark its scene changes with newScene or location. It also warns when an on-camera line is cut before it falls silent.',
      'The continuity judge matters: on known breaks claude-opus-5 caught a boat swap and a facing flip that kimi-k3 missed. Every run names the judge; pick a stronger vision model with --model, within the project\'s privacy tier.',
      'When units drift: harvest-anchor a clean frame from a unit that PASSED into the character\'s reference stack (anchor.png outranks the sheets), then re-render only the drifting units and re-run qa-videos.',
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
      'The plate is the stage: the video model draws what a location plate shows, not what the shot text asks. Every shot names its plateView (the view it is staged on) and stagedOn, plus continuity (from: continuous / later / new-scene, and the endState). On a location whose plates are fixed, the workshop plan check blocks a shot whose action touches something the plates cannot show (by default only a shot on an unknown location blocks); it re-plans once, and workshop --approve refuses blocks or unread plates without --force.',
      'Prefer native model dialogue (Seedance 2.0, HappyHorse 1.1 with voice-donor references) over exact TTS lip-sync.',
      'Keep a continuous run in ONE generation and cut it afterwards: mark its shots continuity.from "continuous" and the montage planner keeps them together even across a change of place. One generation holds the vehicle, the props and the facing across cuts; separate generations swap them. With plateView set, a montage sends only each shot\'s staged view of a place, not all four. Write a state change into the shot (the doors close, the vehicle pulls away) or split there, because one generation carries the first plate\'s state forward.',
      'Re-take whole units, never one shot of a continuous run: `generate-videos --retake <shots>` re-renders the unit that holds them and cuts it again, and renders nothing else.',
      'Before rendering, plan the generations: `plan-generations -p <project> -e <n>` builds a continuity ledger, asks the intelligence model to package the shots (a reason per unit and per split, shot notes for state changes), validates the answer by shot id, audits the references and quotes each unit. It writes generation-plan.proposed.json/.md. A person reads it and approves it (`plan-generations --approve "<name>"`, a human decision like qa-approve). generate-videos renders an approved plan while the shots and settings that decide its packaging are unchanged, and refuses once they change: plan again, or pass --ignore-plan to render by rules for one run.',
    ],
  },
  {
    title: 'Modes of operation — the linear pipeline is not the only path',
    points: [
      'Default path: the gated pipeline (`venice-video pipeline`) — aesthetic → cast → episode → script → approve → storyboard → QA → render → assemble. Use it for a finished, identity-locked cut.',
      'Loop mode (`venice-video loop -p <project> -e <n> --mode <looping|production>`): once a shot script exists, render the whole plan continuously and watch it as a live browser loop that hot-swaps fresh takes. It SKIPS the storyboard/QA gates and writes only under episodes/episode-NNN/loop/, so it never touches the canonical cut. LOOPING = creative flow, lower quality (Turbo 480P, disposable); PRODUCTION = gather usable, identity-locked takes (Max R2V @768P). --mode is REQUIRED non-interactively; --budget caps spend (default $2). This is not in the `pipeline` stage list — it is under `branches`.',
      'Loop mode plays AND renders at the same time — it does NOT pre-generate everything. The browser loops the takes that already exist while the worker keeps generating new ones, swapping each shot\'s newer take in on the loop\'s NEXT pass (never mid-clip). Two things make a running loop LOOK pre-generated when it is not: (a) it PAUSES when it hits --budget or you click Pause in the UI, and then just replays what is on disk — raise --budget or pass --unbounded to keep it generating; (b) --max-takes is a per-shot ring buffer (default 3, older takes pruned), not a total, so once every shot has its cap the change per cycle is subtle.',
      'Which mode evolves while you watch: LOOPING (Turbo, 480P) renders faster than it plays, so the video visibly changes as you watch. PRODUCTION/create renders each shot slowly on Max R2V — it is for GATHERING keeper takes, not a continuously-evolving watch, and on a short or few-shot plan it can look static even while running because one take takes longer to render than a full loop cycle takes to play. If the user wants to "watch it keep changing", pick LOOPING and a higher/unbounded budget.',
      'Stream mode (`venice-video stream -p <project> -e <n> --writer <model> [--direction "..."]`): an INFINITE, live-authored story — not a loop. The writer model authors one beat at a time; beat 1 renders t2v, every later beat i2v off the previous last frame. Needs only series.json. TWO things to do before starting: (1) ASK the operator which model writes the beats — it is the voice of the whole story, bills from beat 1, and its speed sets the lag behind playback; a non-interactive new stream with no --writer is a hard error (--writer default = deepseek-v4-flash-0731-fast, the fastest reliable writer in the bakeoff; kimi-k3 is 3x slower). Both the writer and the video family are dropdowns in the Stream tab; the default MiniMax H3 Max renders slower than playback (higher quality) — only the cheaper/lower-quality Turbo lane nearly keeps pace. (2) Put the camera rule in --direction if the show has human faces: end every beat wide, never on a face close-up (MiniMax i2v dies on a face-filled start frame; the engine also enforces this in the writer prompt and falls back to a t2v soft reset after 2 chained failures). The command registers its episode in series.json so the Stream tab can show it.',
      'Three video lanes, chosen per shot by the router (see the venice-video-model-routing skill): t2v (prompt only), i2v (animate a supplied START image via image_url — establishing/atmosphere shots, or chaining off a previous last frame), R2V (identity anchored to a reference stack — the default for character shots). "i2v" means a supplied first frame; "R2V" means reference_image_urls, not a start frame — do not conflate them.',
      'To animate a single image you already have (plain i2v, no project), the routing skill\'s bundled `scripts/venice-video.py --image <file> --model <...-image-to-video>` is the standalone path; the project pipeline is for multi-shot, consistency-first work.',
      'Fix an object in a rendered shot (a wrong flag, a stray prop, a hand doing the wrong thing) by editing its first frame and re-generating it, never with a tracked patch on moving footage: `stage-ref -p <project> -e <n> --shot <id> --from-shot <id> --prompt "..."` edits the frame on two models, a person picks one, and the next generate-videos re-renders that shot i2v from the pick. When the problem is in a reference (a plate\'s boat, a lowered gangway), use `--from-plate <view>` instead: the pick replaces that view in the shot\'s references. A person picks; an agent never picks for them. generate-videos refuses and lists (exiting non-zero) a staged shot it cannot render from its pick; until it renders, status, qa-videos and assemble-episode treat its old clip as not rendered. A pick inside a montage splits the run (the neighbours keep their clips: a unit whose clips are all on disk is skipped): stage-ref prints the units that change.',
    ],
  },
  {
    title: 'Where the full knowledge lives',
    points: [
      'AGENTS.md — 55 rules and 31 production anti-patterns, shipped in the package.',
      '.agents/skills/ — venice-api, venice-video-model-routing, character-consistency, shot-composition, burn-in-subtitles, video-editing, and more.',
      '.agents/commands/ — 20 step-by-step playbooks; .agents/agents/ — 10 sub-agent roles.',
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
  lines.push('Full rules: AGENTS.md · Playbooks: .agents/commands/ · Knowledge: .agents/skills/');
  lines.push('');
  for (const section of AGENT_GUIDE) {
    lines.push(`## ${section.title}`);
    for (const point of section.points) lines.push(`  - ${point}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
