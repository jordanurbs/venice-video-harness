Add a location to a mini-drama series with reference plates.

Ask the user for:
1. Location name
2. Locked prose description of the environment (architecture, materials, palette, key props)
3. Lighting notes (carried into every panel prompt for this location)
4. Spatial anchors (optional but recommended): 3-5 named landmarks and their fixed relative positions (e.g. "bar counter along the back wall; entrance door opposite it; neon window left of the door")

Run:
```
npx tsx src/mini-drama/cli.ts add-location -p output/<series> --name "<NAME>" --description "<description>" --lighting "<lighting notes>" --spatial-anchors "<locked geography>"
```

This generates exactly 4 wide plates — `north.png`, `south.png`, `east.png`, `west.png` — one per wall/direction, giving 360 degrees of visual information. The `north.png` hero plate is generated from scratch; the south, east, and west plates are derived from it by multi-edit rotation, so all four plates depict the SAME room. The plates save to `output/<series>/locations/<slug>/` with `.prompt.json` sidecars and faceless provenance.

Never generate wide/medium/close-up ladders for locations. Four wide compass plates is the default and the only plate set. (Legacy `wide`/`angle-2/3/4`/`medium`/`detail` files on old projects are still read and can be regenerated via `generate-location-references --angles`.)

After creation, show the plates to the user for approval. Then tag every shot that plays in this location with `"location": "<slug>"` in the episode script — the harness folds the plates into panels, `scene_image_urls` (Kling R2V), and the reference-slot plan (Seedance/HappyHorse) automatically. `workshop-episode` auto-extracts and tags locations on its own.
