Workshop an episode script collaboratively with the user.

1. Ask the user for the episode concept/outline (what happens in this episode?)
2. Draft a shot-by-shot script in the EpisodeScript JSON format
3. Each shot should specify:
   - type (establishing/dialogue/action/reaction/insert/close-up)
   - duration (3s/5s/8s/10s/13s/15s)
   - videoModel ("action" for movement/dialogue, "atmosphere" for establishing/static)
   - description (visual scene description)
   - characters present
   - dialogue (if any)
   - sfx (optional sound effects hint)
   - cameraMovement
   - transition -- affects video generation frame handling:
     - CUT (default): sharp edit, each shot starts from its own panel, ends naturally
     - FADE: gentle transition, chains start frame from previous video
     - DISSOLVE: smooth blend, chains start frame AND targets next panel as end frame
     - MATCH CUT: compositional match, chains start + targets end frame
     - SMASH CUT: abrupt jarring cut, no linking at all
     Use CUT for most shots. Only use DISSOLVE/MATCH CUT when you specifically want the video to morph toward the next panel's composition.
   - dialogue delivery (tone/manner for voice generation, e.g. "in a cold manner", "nervously", "whispering seductively")
4. Total duration should target ~60 seconds
5. Present the script to the user for review/edits
6. Once approved, save to the episode directory:

```
npx tsx src/mini-drama/cli.ts new-series  # (if needed to ensure episode dir exists)
```

Then write the script.json to: output/<series>/episodes/episode-NNN/script.json

The script format:
```json
{
  "episode": 1,
  "title": "The Betrayal",
  "seriesName": "series-name",
  "totalDuration": "60s",
  "shots": [...]
}
```
