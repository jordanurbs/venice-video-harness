Add a character to a mini-drama series with reference images.

Ask the user for:
1. Character name
2. Gender (male/female)
3. Age description (e.g., "mid 20s")
4. Physical description (hair, eyes, distinguishing features)
5. Default wardrobe
6. Voice description (pitch, timbre, accent, cadence, personality in voice)

Character design requirements (enforced automatically):
- Women: beautiful, elegant, hourglass figure, classy cleavage, skin showing, detailed features
- Men: extremely handsome, strong jawline, styled appearance, detailed features

Voice descriptions should be specific and detailed (this anchors the video model's voice generation for consistency):
- Example: "low, silky contralto, unhurried deliberate pacing, faintly breathy, hints of European accent, speaks with quiet intensity"
- Cover: pitch/register, timbre/texture, pacing/cadence, accent, personality

Run:
```
npx tsx src/mini-drama/cli.ts add-character -p output/<series> --name "<NAME>" --gender <gender> --age "<age>" --description "<description>" --wardrobe "<wardrobe>" --voice-desc "<voice description>"
```

This generates 4 reference images (front, three-quarter, profile, full-body) and saves them to the character directory.

After creation, show the reference images to the user for approval. Then suggest running audition-voices.
