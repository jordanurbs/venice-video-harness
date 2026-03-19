Generate voice audition samples for a character using Venice TTS.

Pick a sample dialogue line that fits the character's personality and the series tone.

Run:
```
npx tsx src/mini-drama/cli.ts audition-voices -p output/<series> -c "<CHARACTER>" --sample-text "<line>" --count 5
```

This loads Venice TTS voices matching the character's gender, generates sample audio clips, and saves them to the character's voice-samples/ directory.

Present the voice options to the user. Once they choose, run lock-character.
