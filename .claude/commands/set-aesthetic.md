# /set-aesthetic

Auto-generate aesthetic comparison samples and let the user pick a visual style.

## Behavior

**Do NOT ask the user to describe a style verbally.** Instead, generate visual samples and let them react to images.

### If the user specifies a style (e.g., "set a noir look"):
Run the CLI directly:
```bash
npx tsx src/cli.ts set-aesthetic --project "$project_dir" --style "$style" --palette "$palette" --lighting "$lighting" --lens "$lens" --film "$film"
```

### If the user says "set aesthetic" without specifying a style:
1. Read the ingested project data to understand the screenplay's tone, setting, and genre
2. Design 5-7 diverse aesthetic options that fit the material
3. Write a temporary Node.js (.mjs) script that:
   - Reads the Venice API key from `.env` manually (no dotenv import -- parse the file directly)
   - Calls `POST https://api.venice.ai/api/v1/image/generate` for each aesthetic
   - Uses model `nano-banana-pro`, resolution `1280x720` (16:9), `steps: 30`, `cfg_scale: 7`
   - Uses a representative scene description from the screenplay as the base prompt
   - Appends aesthetic-specific style directives to each prompt
   - Runs 2 requests at a time with 500ms delay between batches
   - Extracts the image from `response.images[0]` (raw base64 string, NOT `.b64_json`)
   - Saves PNGs to `output/<project>/aesthetic-samples/<name>.png`
   - Generates `compare.html` for side-by-side viewing
4. Run the script with `node`
5. Show each generated image to the user inline using the Read tool
6. Describe each aesthetic in a few words
7. Let the user pick one, request hybrids/tweaks, or ask for more options
8. Once chosen, run `set-aesthetic` CLI with the selected parameters

## Aesthetic Template Ideas

Adapt these to the screenplay's genre/setting:

- **Neo-Noir Cyberpunk**: Neon-lit, rain-slicked, deep blues/purples/pinks, volumetric fog, 35mm Kodak Vision3 500T
- **Clean Dystopia**: Sterile white corridors, clinical grays, flat fluorescent, symmetrical, Arri Alexa digital
- **Retro-Futurism (Moebius)**: Bold linework, painted color, teals/oranges, ink and watercolor texture
- **Gritty Anime Realism**: Ghost in the Shell / Akira inspired, muted greens, industrial, cel-shaded hybrid
- **Analog Sci-Fi 70s**: Alien / THX 1138 aesthetic, chunky hardware, amber CRT glow, 16mm Ektachrome
- **SNES Pixel Art**: 16-32 bit pixel art, limited palette, dithering, isometric RPG perspective
- **Wes Anderson Symmetry**: Pastel palette, centered framing, dollhouse aesthetic, Futura typography
- **Soviet Brutalism**: Concrete textures, propaganda poster palette, stark shadows, 35mm Svema film

## Venice API Notes

- Model: `nano-banana-pro` (NOT `fluently-xl` -- retired)
- Max dimension: 1280px. Use 1280x720 for 16:9 panels.
- Response: `{ images: ["raw-base64-string"] }` -- not `{ b64_json }` objects
- Parse `.env` manually in scripts (read file, split lines, match `KEY=VALUE`)

## CLI Arguments
- `--project`: Project output directory (required)
- `--style`: Visual style (default: "Cinematic photography")
- `--palette`: Color palette (default: "warm natural palette")
- `--lighting`: Lighting style (default: "natural lighting with subtle film grain")
- `--lens`: Lens characteristics (default: "anamorphic lens, shallow depth of field")
- `--film`: Film stock (default: "35mm Kodak Vision3 500T")

## Output
- Aesthetic samples saved to `output/<project>/aesthetic-samples/`
- HTML comparison page: `output/<project>/aesthetic-samples/compare.html`
- Chosen aesthetic profile saved to project state
- Next step: run `/storyboard-scene 1` to test with first scene
