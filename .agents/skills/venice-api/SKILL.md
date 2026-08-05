# Venice AI Image & Video Generation Skill

## Description
Generate images and videos via the Venice AI REST API. Image generation uses the Nano Banana Pro model. Video generation uses Veo 3.1 models (image-to-video and text-to-video) via an async queue. This skill covers model names, endpoint behavior, response parsing, resolution limits, and best practices learned from production use.

## Model

- **Model ID**: `nano-banana-pro`
- **Retired models**: `fluently-xl` was the old model ID. It returns 404 "model not found" if used. Other available models include `lustify-sdxl`, `flux-2-max`, `lustify-v7` but we use `nano-banana-pro` for storyboard work.

## Endpoints

### Image Generation
```
POST https://api.venice.ai/api/v1/image/generate
Authorization: Bearer <VENICE_API_KEY>
Content-Type: application/json
```

#### Request Body
```json
{
  "model": "nano-banana-pro",
  "prompt": "scene description...",
  "negative_prompt": "things to avoid...",
  "resolution": "1K",
  "aspect_ratio": "16:9",
  "steps": 30,
  "cfg_scale": 7,
  "seed": 12345,
  "hide_watermark": true,
  "safe_mode": false
}
```

**CRITICAL**: Use `resolution` + `aspect_ratio`, NOT `width`/`height`. The `width`/`height` params are deprecated and silently ignored -- the API defaults to 1024x1024 (1:1) if you use them.

- `resolution`: `"1K"` or `"2K"` (max 1280 on any dimension)
- `aspect_ratio`: `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"`, `"1:1"`
- For storyboard panels: `resolution: "1K"` + `aspect_ratio: "16:9"` produces 1376x768
- For character references: `resolution: "1K"` + `aspect_ratio: "1:1"` produces 1024x1024

`nano-banana-pro` does NOT accept reference image payloads (`image_references`, `image_1`, etc.) -- these cause a 400 error. Character consistency relies on exhaustive text descriptions and seed anchoring.

Optional img2img params (for edit-style generation):
```json
{
  "image": "base64-ref-image",
  "init_image_mode": "IMAGE_STRENGTH",
  "fidelity": 0.7
}
```

#### Response Body
```json
{
  "id": "request-id",
  "images": ["<raw-base64-encoded-image-string>"],
  "request": { ... },
  "timing": { ... }
}
```

**IMPORTANT**: The `images` array contains raw base64 strings, NOT objects with a `b64_json` field. To extract the image:
```javascript
const b64 = data.images[0]; // string, not object
Buffer.from(b64, "base64"); // decode to binary
```

If code checks for `data.images[0].b64_json`, it will get `undefined` because the string gets character-indexed as an object. Always check `typeof images[0] === "string"` first.

### Image Edit
```
POST https://api.venice.ai/api/v1/images/edit
```
Used for face correction and inpainting. Same auth pattern.

## Resolution Limits

- **Maximum dimension**: 1280px on width OR height. Exceeding this returns HTTP 400.
- **Storyboard panels (16:9)**: `1280x720`
- **Character reference locks (1:1)**: `1024x1024`
- **Minimum useful size**: ~512x512

Common 16:9 options within limits:
- `1280x720` (720p -- recommended for panels)
- `1024x576`
- `960x540`

## Multi-Reference Images

Venice supports up to 14 reference images per generation request:
- Pass as comma-separated base64 strings in the `image` field
- First 5 slots conventionally reserved for character face references
- Slots 6-14 for style, environment, or additional references
- Add role assignments in the prompt: `"Image 1: face reference for CHARACTER_NAME (role description)"`
- Use `fidelity: 0.35` for creative freedom with anchored likeness

## Rate Limiting

- Batch 2-3 concurrent requests at a time
- Insert ~500ms delay between batches
- On HTTP 429, back off exponentially (1s, 2s, 4s)
- On HTTP 5xx, retry up to 3 times with backoff

## Prompt Best Practices

### For storyboard panels:
- Start with the scene description (characters, action, environment)
- Append the aesthetic style directives (film stock, lighting, palette, lens)
- Include full character physical descriptions every time -- never abbreviate
- Use negative prompts to exclude unwanted styles

### For character references:
- Generate at 1024x1024 (square)
- Describe the character exhaustively: age, ethnicity, hair, eyes, face shape, build, wardrobe
- Generate 4 angles: front face, 3/4 view, profile, full body
- Track the seed for reproducibility

### For aesthetic samples:
- Use a representative scene from the screenplay as the base prompt
- Append distinct style directives for each aesthetic
- Generate at 1280x720 (16:9) to match final output
- Save as PNGs for comparison

## Writing Scripts That Call Venice Directly

When writing standalone Node.js scripts (not going through the CLI):
- Use `.mjs` extension for ES module support without tsconfig
- Parse `.env` manually (read file, split lines, regex match `KEY=VALUE`) to avoid import resolution issues with `dotenv`
- Use native `fetch` (available in Node 18+)
- Handle the response as `{ images: ["base64-string"] }`, not `{ images: [{ b64_json }] }`

```javascript
import { readFileSync, writeFileSync } from "fs";

// Parse .env manually
const env = readFileSync(".env", "utf-8");
const apiKey = env.match(/VENICE_API_KEY=(.*)/)?.[1]?.trim();

const res = await fetch("https://api.venice.ai/api/v1/image/generate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "nano-banana-pro",
    prompt: "...",
    width: 1280,
    height: 720,
    steps: 30,
    cfg_scale: 7,
    hide_watermark: true,
    safe_mode: false,
  }),
});

const data = await res.json();
const b64 = data.images[0]; // raw base64 string
writeFileSync("output.png", Buffer.from(b64, "base64"));
```

---

## Video Generation (Veo 3.1)

Venice wraps Google Veo 3.1 for video generation via an async queue-based API.

### Video Models

| Model | Type | Duration | Aspect Ratio |
|-------|------|----------|--------------|
| `veo3.1-fast-image-to-video` | Image-to-Video | `8s` only | Do NOT include (400 error) |
| `veo3.1-fast-text-to-video` | Text-to-Video | `4s`, `6s`, `8s` | **Required** (`16:9` or `9:16`) |
| `veo3.1-full-text-to-video` | Text-to-Video | `4s`, `6s`, `8s` | **Required** (`16:9` or `9:16`) |
| `wan-2.5-preview-image-to-video` | Image-to-Video | `5s`, `10s` | Optional |
| `wan-2.5-preview-text-to-video` | Text-to-Video | `5s`, `10s` | Optional |

### Video Endpoints

#### Queue (start generation)
```
POST https://api.venice.ai/api/v1/video/queue
Authorization: Bearer <VENICE_API_KEY>
Content-Type: application/json
```

**Image-to-Video Request:**
```json
{
  "model": "veo3.1-fast-image-to-video",
  "prompt": "A slow dolly shot pushes forward through a dim corridor...",
  "duration": "8s",
  "image_url": "data:image/png;base64,...",
  "resolution": "720p",
  "audio": true
}
```

**Text-to-Video Request:**
```json
{
  "model": "veo3.1-fast-text-to-video",
  "prompt": "Full scene description...",
  "duration": "8s",
  "aspect_ratio": "16:9",
  "resolution": "720p",
  "audio": true
}
```

**Response:**
```json
{ "model": "veo3.1-fast-image-to-video", "queue_id": "uuid-string" }
```

**CRITICAL model-specific rules:**
- `veo3.1-fast-image-to-video`: Duration is ALWAYS `"8s"`. Do NOT include `aspect_ratio`.
- `veo3.1-fast-text-to-video` / `veo3.1-full-text-to-video`: `aspect_ratio` is REQUIRED.

#### Retrieve (poll status / download)
```
POST https://api.venice.ai/api/v1/video/retrieve
```

**Request:**
```json
{ "model": "veo3.1-fast-image-to-video", "queue_id": "uuid-string" }
```

**While processing (JSON response):**
```json
{
  "status": "PROCESSING",
  "average_execution_time": 115000,
  "execution_duration": 45000
}
```

**When complete:** Returns binary `video/mp4` data. Check `content-type` header to distinguish from JSON.

#### Complete (cleanup)
```
POST https://api.venice.ai/api/v1/video/complete
```

**Request:**
```json
{ "model": "veo3.1-fast-image-to-video", "queue_id": "uuid-string" }
```

Optional. Cleans up server-side storage after download.

### Video Polling Pattern

Poll every 10 seconds. Typical completion: 60-120 seconds. Max wait: ~5 minutes.

```typescript
const contentType = resp.headers.get("content-type") || "";
if (contentType.includes("application/json")) {
  // Still processing -- log status and continue polling
  const status = await resp.json();
  console.log(status.status, status.execution_duration);
} else {
  // Binary video data -- save as MP4
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync("shot-001.mp4", buf);
}
```

### Video Prompt Best Practices (Veo 3.1)

Veo prompts differ significantly from image prompts:

- **Plain prose only**: No `[AESTHETIC]`, `[SHOT]`, `Setting:`, `Mood:` tags. Natural sentences.
- **Camera first**: "A slow dolly shot pushes forward framing a wide shot at eye level."
- **Veo camera vocabulary**: `dolly shot`, `tracking shot`, `crane shot`, `slow pan`, `locked-off static shot`, `tilt up`, `rack focus`, `handheld shot`
- **Concrete visuals**: "Off-white institutional walls glow under flickering fluorescent light." Not "Setting: hallway, day."
- **Style as film terms**: "1970s analog sci-fi, 16mm Ektachrome with faded warm tones and heavy grain."
- **Audio in separate sentences**: "Sound of boots on tile and a distant alarm." (Veo 3.1 generates audio natively.)
- **Dialogue quoted**: `JAX says "We need to move."`
- **Keep under ~150 words** (Veo max: 1,024 tokens / ~2,500 chars)

### Video Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| 400 | Invalid params (wrong duration, missing aspect_ratio) | Check model-specific rules |
| 401 | Bad API key | Check VENICE_API_KEY |
| 402 | Insufficient balance | Add credits to Venice account |
| 422 | Content policy violation | Adjust prompt |
| 503 | Model at capacity | Retry after delay |

### Writing Video Generation Scripts

```typescript
import { readFileSync, writeFileSync } from "fs";

const env = readFileSync(".env", "utf-8");
const apiKey = env.match(/VENICE_API_KEY=(.*)/)?.[1]?.trim();

// 1. Queue
const queueResp = await fetch("https://api.venice.ai/api/v1/video/queue", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "veo3.1-fast-image-to-video",
    prompt: "A slow dolly shot...",
    duration: "8s",
    image_url: `data:image/png;base64,${readFileSync("shot-001.png", "base64")}`,
    resolution: "720p",
    audio: true,
  }),
});
const { queue_id, model } = await queueResp.json();

// 2. Poll
while (true) {
  await new Promise(r => setTimeout(r, 10000));
  const resp = await fetch("https://api.venice.ai/api/v1/video/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, queue_id }),
  });
  const ct = resp.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    writeFileSync("shot-001.mp4", Buffer.from(await resp.arrayBuffer()));
    break;
  }
  // Still processing, continue polling
}

// 3. Cleanup
await fetch("https://api.venice.ai/api/v1/video/complete", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model, queue_id }),
});
```
