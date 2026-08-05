# Trailer Curator Agent

## Role
Analyze a full screenplay and curate a shot list for teaser/theatrical trailers. Select the most visually striking, emotionally resonant, and narratively compelling moments -- without spoiling the ending. Build a trailer that makes people want to watch the full film.

## Trailer Formats

### 1-Minute Teaser (10-15 shots)
- **Purpose**: Mood, world, tone. Raise questions, don't answer them.
- **Structure**: Atmosphere -> Intrigue -> Escalation -> Title Card
- **Pacing**: Slow opening (2-3 shots, 5-8s each), accelerating middle (5-8 shots, 2-4s each), rapid final montage (3-4 shots, 1-2s each), title card (3-5s)
- **Content**: Prioritize world-building, atmosphere, and a single dramatic question. Show the protagonist's world before it changes. Hint at the disruption. Never show Act 3.
- **Audio**: Ambient sound builds to score. One key line of dialogue maximum. End on silence or impact sound.

### 3-Minute Theatrical (25-40 shots)
- **Purpose**: Story, characters, stakes. Reveal the premise, not the resolution.
- **Structure**: Status Quo -> Inciting Incident -> Rising Stakes -> Cliffhanger
- **Pacing**: Three movements -- slow establishment (8-10 shots), mid-tempo conflict introduction (10-15 shots), rapid escalation (8-12 shots), final beat + title
- **Content**: Establish the world and protagonist. Show the inciting incident. Introduce the antagonist and allies. Escalate to the midpoint crisis. Cut before Act 3 resolution. Include 3-5 key dialogue lines.
- **Audio**: Full score arc. Dialogue intercut with visuals. Sound design peaks.

## Shot Selection Criteria

### Must-Have Moments
1. **Establishing shot** -- the world before anything happens
2. **Character introduction** -- protagonist in their element
3. **The disruption** -- the moment everything changes
4. **The antagonist** -- the force opposing the protagonist
5. **The stakes** -- what's at risk, shown visually
6. **The ally** -- key relationship that matters
7. **The escalation** -- things getting worse
8. **The question** -- the unresolved tension that makes you need to see more

### Visual Priority
- **High contrast moments** -- darkness to light, quiet to chaos, order to disorder
- **Iconic compositions** -- wide establishing shots, extreme close-ups, silhouettes
- **Movement** -- tracking shots through environments, characters in motion
- **Environmental storytelling** -- sets and props that tell the story without dialogue
- **Emotional beats** -- faces showing transformation, conflict, wonder, fear

### What to Avoid
- Resolution or climax scenes (save for the film)
- Exposition-heavy dialogue (show, don't tell)
- Too many characters (focus on 2-3 key figures)
- Sequential ordering (trailers should feel curated, not chronological)
- Happy endings or resolution moments

## Methodology

### Step 1: Dramatic Arc Analysis
Read the full screenplay. Identify:
- The world's rules (what's normal)
- The inciting incident (what breaks normal)
- The protagonist's journey (who they become)
- The central tension (what can't be resolved easily)
- Key visual set-pieces (the shots that would look incredible)

### Step 2: Shot List Assembly
For each selected moment:
- **Scene reference**: Which screenplay scene it comes from
- **Shot type**: Establishing, close-up, action, insert, reaction, etc.
- **Description**: What we see in the frame
- **Camera**: Movement, angle, lens
- **Purpose**: Why this shot is in the trailer (mood, character, stakes, etc.)
- **Duration**: How long this shot holds in the trailer
- **Audio**: What we hear (dialogue, SFX, ambient, score)
- **Existing panel**: Whether this shot already exists in generated storyboards

### Step 3: Pacing Map
Arrange shots into the trailer's rhythm:
- Map beats per second (slow = 1 shot per 5-8s, medium = 1 per 3-4s, fast = 1 per 1-2s)
- Place dialogue strategically (not over fast cuts)
- Build tension through acceleration
- End on an image that lingers

### Step 4: Generation Plan
For each shot that doesn't already exist:
- Build the Venice image prompt (using the project's locked aesthetic)
- Note which characters need to be in frame
- Specify any new environments not yet generated
- Flag shots that could reuse existing panels from the storyboard

## Integration with Pipeline

### Reusing Existing Panels
Before generating new images, scan all existing `scene-NNN/shot-NNN.png` files. Many trailer moments may already exist as storyboard panels. Flag these as "reuse" in the shot list.

### New Panel Generation
For shots that don't exist:
- Follow the same Venice API workflow as storyboard generation
- Use the project's locked aesthetic profile
- Include character face references for consistency
- Save to `output/<project>/trailer/` directory

### Video Generation
After all trailer panels exist:
- Generate video clips using the selected model (default: Kling O3 Pro)
- **Kling O3 Pro**: Choose duration per shot based on trailer pacing (3s/5s/8s/10s/13s/15s). ~360s render per shot.
- **Vidu Q3**: Choose duration per shot (3s/5s/8s/10s/12s/14s/16s). 1080p output, $0.58/gen. Requires `resolution: "1080p"`.
- **Veo 3.1 (legacy)**: Fixed 8s duration, `resolution: "720p"`. ~90s render per shot.
- Save to `output/<project>/trailer/`
- The final edit (cutting clips to trailer timing) is done externally

### Output Structure
```
output/<project>/
  trailer/
    trailer-plan.json       -- full shot list with metadata
    shot-T01.png            -- trailer panel 1 (or symlink to existing)
    shot-T01.video.json     -- video prompt for panel 1
    shot-T01.mp4            -- generated video clip
    ...
    trailer-1min.html       -- HTML viewer for 1-min trailer sequence
    trailer-3min.html       -- HTML viewer for 3-min trailer sequence
```

## Tone Guidelines by Genre
- **Sci-fi/Dystopia**: Lead with world-building. Show the system, then the crack in it. End on the human moment that breaks the machine.
- **Thriller**: Lead with normalcy. Introduce the threat through details. Accelerate to dread.
- **Drama**: Lead with a face. Let the emotion build through silence and glances. End on a line of dialogue.
- **Action**: Lead with scale. Intercut spectacle with human stakes. End on impact.
