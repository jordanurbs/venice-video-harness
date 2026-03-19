Assemble a final episode from video clips, optional audio overrides, music, and subtitles.

Basic assembly:
```
npx tsx src/mini-drama/cli.ts assemble-episode -p output/<series> -e <episode_number>
```

With music generation first:
```
npx tsx src/mini-drama/cli.ts generate-music -p output/<series> -e <episode_number> --prompt "<mood description>"
npx tsx src/mini-drama/cli.ts assemble-episode -p output/<series> -e <episode_number>
```

Optional audio overrides (run before assembly):
```
npx tsx src/mini-drama/cli.ts override-audio -p output/<series> -e <episode_number> --dialogue --sfx
```

Assembly does:
1. Concatenates all shot-NNN.mp4 clips in order
2. Mixes in background music (if music.mp3 exists in audio/) at 15% volume
3. Burns subtitles centered at -150px from bottom (bold white, black outline)
4. Outputs episode-NNN-final.mp4
