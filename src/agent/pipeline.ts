// ---------------------------------------------------------------------------
// Self-describing pipeline.
//
// `venice-video --help` is a flat list of 40+ commands with no ordering. An
// agent that has not read AGENTS.md cannot tell that `generate-videos` comes
// after a QA gate, or that two steps are gated on an explicit approval. That
// missing order is the single largest cause of poor output.
//
// This is the pipeline stated as data: the ordered stages, the artifact each
// produces, the gate (if any) that must clear first, and the literal command
// that advances it. `venice-video pipeline [--json]` prints it, so the order
// travels inside the binary and cannot be left out of a published tarball.
//
// It mirrors the on-disk state machine in `src/session/status.ts`
// (`classifyEpisode` + the project-level prerequisites). When you change a
// gate there, change the matching stage here — a stale map is worse than none.
// ---------------------------------------------------------------------------

export interface PipelineStage {
  /** Stable id an agent can branch on. */
  id: string;
  /** One-line human name. */
  name: string;
  /** Scope: a project-level prerequisite, or a per-episode step. */
  scope: 'project' | 'episode';
  /** What running this stage produces on disk. */
  produces: string;
  /**
   * The gate that must clear before this stage can run, if any. Gates are
   * explicit human decisions and are NOT bypassable by an agent — the
   * `--skip-*` flags exist for a human who accepts the risk, and do not make
   * the underlying condition true.
   */
  gate?: string;
  /** Literal command that advances this stage. `<...>` marks a value to fill. */
  command: string;
}

/**
 * The canonical order. Project prerequisites gate everything downstream, then
 * each episode walks its own steps. Two gates — `approve-script` and
 * `qa-approve` — are explicit human sign-offs.
 */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  {
    id: 'aesthetic',
    name: 'Lock the visual system',
    scope: 'project',
    produces: 'series.aesthetic (style + palette + seed)',
    command: 'explore-aesthetic -p <project>   # then: set-aesthetic -p <project> --style <n>',
  },
  {
    id: 'cast',
    name: 'Add and lock characters',
    scope: 'project',
    produces: 'characters/<slug>/ reference angles',
    command: 'add-character -p <project> --name "<NAME>" --gender <f|m>',
  },
  {
    id: 'episode',
    name: 'Create an episode',
    scope: 'project',
    produces: 'an episode entry in series.json',
    command: 'new-episode -p <project> -t "<title>"',
  },
  {
    id: 'script',
    name: 'Draft the script',
    scope: 'episode',
    produces: 'script.json (shots, dialogue, locations)',
    command: 'workshop-episode -p <project> -e <n> --concept "<what happens>"',
  },
  {
    id: 'approve-script',
    name: 'Approve the script',
    scope: 'episode',
    produces: 'script-approved.json',
    gate: 'A human must approve the script. --skip-approval does not approve it.',
    command: 'approve-script -p <project> -e <n>',
  },
  {
    id: 'storyboard',
    name: 'Generate storyboard panels',
    scope: 'episode',
    produces: 'scene-001/shot-NNN.png',
    command: 'storyboard-episode -p <project> -e <n>',
  },
  {
    id: 'qa-storyboard',
    name: 'QA the panels',
    scope: 'episode',
    produces: 'qa-report.json',
    command: 'qa-storyboard -p <project> -e <n>',
  },
  {
    id: 'qa-approve',
    name: 'Approve QA',
    scope: 'episode',
    produces: 'qa-approved.json',
    gate: 'A human must clear the QA gate. --skip-qa does not clear it.',
    command: 'qa-approve -p <project> -e <n>',
  },
  {
    id: 'render',
    name: 'Render the shots (billed at queue time)',
    scope: 'episode',
    produces: 'scene-001/shot-NNN.mp4',
    command: 'generate-videos -p <project> -e <n>',
  },
  {
    id: 'qa-videos',
    name: 'QA the rendered units (cross-unit identity, head glitches)',
    scope: 'episode',
    produces: 'video-qa-report.json',
    command: 'qa-videos -p <project> -e <n>',
  },
  {
    id: 'assemble',
    name: 'Assemble the final cut',
    scope: 'episode',
    produces: 'episode-NNN-final.mp4',
    gate: 'A failing video-qa-report.json blocks assembly. --skip-video-qa does not fix the units.',
    command: 'assemble-episode -p <project> -e <n>',
  },
];

export function pipelineAsJson(): { version: 1; stages: readonly PipelineStage[] } {
  return { version: 1, stages: PIPELINE_STAGES };
}

export function formatPipeline(): string {
  const lines: string[] = [];
  lines.push('Venice Video production pipeline (run in order):');
  lines.push('');
  PIPELINE_STAGES.forEach((stage, index) => {
    const step = String(index + 1).padStart(2, ' ');
    const scope = stage.scope === 'project' ? 'project' : 'episode';
    lines.push(`${step}. ${stage.name}  [${scope}]`);
    lines.push(`      produces  ${stage.produces}`);
    if (stage.gate) lines.push(`      gate      ${stage.gate}`);
    lines.push(`      run       ${stage.command}`);
    lines.push('');
  });
  lines.push('`venice-video status -p <project>` reports where a project stands and the next command.');
  lines.push('Gates are human decisions. Never use --skip-approval / --skip-qa to get past them.');
  return lines.join('\n');
}
