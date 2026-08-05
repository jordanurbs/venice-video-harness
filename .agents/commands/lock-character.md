Lock a character with their selected voice.

Run:
```
npx tsx src/mini-drama/cli.ts lock-character -p output/<series> -c "<CHARACTER>" --voice-id "<voice_id>" --voice-name "<voice_name>"
```

This finalizes the character's appearance and voice for the series. The locked voice ID will be used for any Venice TTS overrides in future episodes.
