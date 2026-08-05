Fix character appearance in a storyboard panel using Venice multi-edit with character references.

Use this after QA flags panels with character consistency issues. Multi-edit takes the panel + character reference images and corrects character appearance without regenerating the entire composition.

## Single character fix:
```
npx tsx src/mini-drama/cli.ts fix-panel -p output/<series> -e <episode> -s <shot> -c "SERA"
```

## Two character fix:
```
npx tsx src/mini-drama/cli.ts fix-panel -p output/<series> -e <episode> -s <shot> -c "MARCUS,SERA"
```

## Custom edit prompt (for specific issues):
```
npx tsx src/mini-drama/cli.ts fix-panel -p output/<series> -e <episode> -s <shot> -c "SERA" --prompt "Change the woman's dress to a deep plunging V-neckline black cocktail dress. Make her extremely busty with generous cleavage. Keep the background unchanged."
```

## Available edit models:
- `nano-banana-pro-edit` (default) -- same family as generation model
- `gpt-image-1-5-edit` -- strong at reference matching
- `grok-imagine-edit` -- alternative option
- `qwen-edit` -- good for precise edits
- `flux-2-max-edit` -- high quality edits

## How it works:
1. Loads the panel PNG as the base image
2. Loads character front.png references as edit layers (up to 2)
3. Constructs an edit prompt from the character's full description + wardrobe
4. Calls Venice multi-edit API: panel + references -> corrected panel
5. Archives the original as `shot-NNN-pre-fix.png`
6. Saves the corrected panel as `shot-NNN.png`

## Two-pass storyboard (alternative):
Instead of fixing after QA, generate with refinement built in:
```
npx tsx src/mini-drama/cli.ts storyboard-episode -p output/<series> -e <episode> --refine
```
This generates panels normally, then runs multi-edit on every panel that has characters.
