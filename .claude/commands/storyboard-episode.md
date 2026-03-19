Generate storyboard panel images for an episode.

Run:
```
npx tsx src/mini-drama/cli.ts storyboard-episode -p output/<series> -e <episode_number>
```

This reads the episode's script.json and generates a panel image (9:16 vertical) for each shot using Venice AI. The user should review the panels before proceeding to video generation.

Show each generated panel to the user inline. If any panels need regeneration, they can be re-run individually.
