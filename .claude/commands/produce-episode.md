Full production pipeline for an episode: storyboard -> video -> assembly.

Run:
```
npx tsx src/mini-drama/cli.ts produce-episode -p output/<series> -e <episode_number>
```

This runs all three steps automatically:
1. Generate storyboard panels from script
2. Generate video clips with native audio
3. Assemble final episode with subtitles

The episode script must already exist (use /workshop-episode first).

For more control, run each step individually:
- /storyboard-episode (review panels before video gen)
- /generate-episode-videos
- /assemble-episode
