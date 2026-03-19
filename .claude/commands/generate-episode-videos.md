Generate video clips from storyboard panels for an episode.

Run:
```
npx tsx src/mini-drama/cli.ts generate-videos -p output/<series> -e <episode_number>
```

This processes each shot sequentially with frame chaining:
- Shot 1: panel PNG is the starting frame
- Shot N>1: last frame from previous video is the starting frame (continuity chain)
- Kling V3 Pro: end_image_url targets the next panel for smooth transitions
- All videos include native audio (dialogue, SFX, ambient) -- no background music

Video model selection per shot:
- "action" shots -> Kling V3 Pro (movement, dialogue with gestures)
- "atmosphere" shots -> Veo 3.1 (establishing, static, close-ups)

Every video prompt automatically ends with: "No background music. Only generate dialogue, ambient sound, and sound effects."
