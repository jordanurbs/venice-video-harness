import { useState } from 'react';
import { archiveMedia, mediaUrl, runCommand } from '../api';
import type { AngleArt, JobRequest, ProjectState } from '../types';
import { RunButton } from './shared';

/**
 * Regenerate one reference angle, with the prompt editable. The prompt box
 * seeds from the angle's .prompt.json sidecar (exactly what generated the
 * current image); leaving it untouched re-rolls with the default build.
 */
function RegenerateDialog({
  slug,
  title,
  angle,
  buildRequest,
  onClose,
}: {
  slug: string;
  title: string;
  angle: AngleArt;
  buildRequest: (angle: string, prompt?: string) => JobRequest;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(angle.prompt ?? '');
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const request = buildRequest(angle.angle, edited && prompt.trim() ? prompt.trim() : undefined);
    const result = await runCommand(slug, request);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog" onClick={ev => ev.stopPropagation()}>
        <h3>Regenerate — {title} · {angle.angle}</h3>
        {angle.image && (
          <img
            src={mediaUrl(slug, angle.image)}
            style={{ width: '100%', borderRadius: 8, marginBottom: 10, background: '#000' }}
          />
        )}
        <div className="form-grid">
          <label>
            Prompt
            <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
              {angle.prompt
                ? edited ? 'custom — used verbatim' : 'current prompt — edit to override'
                : 'no sidecar found — leave blank for the default build'}
            </div>
          </label>
          <textarea
            style={{ minHeight: 140 }}
            value={prompt}
            placeholder="Leave blank to re-roll with the default prompt build"
            onChange={ev => {
              setPrompt(ev.target.value);
              setEdited(true);
            }}
          />
        </div>
        <div className="dim small" style={{ marginTop: 6 }}>
          The current image is archived, not overwritten. Billed image pass.
        </div>
        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="action" onClick={submit}>Regenerate</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Add extra coverage of a location beyond the canonical wide/medium/detail
 * ladder — a named custom angle with a required prompt describing the view.
 * The slot allocator feeds every generated angle to the video model
 * automatically (canonical first, then customs, within the model's budget).
 */
function AddAngleDialog({
  slug,
  location,
  onClose,
}: {
  slug: string;
  location: { name: string; slug: string };
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const result = await runCommand(slug, {
      command: 'generate-location-references',
      options: {
        location: location.slug,
        angles: name.trim(),
        prompt: prompt.trim(),
      },
      flags: ['force'],
    });
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog" onClick={ev => ev.stopPropagation()}>
        <h3>Add angle — {location.name}</h3>
        <div className="form-grid">
          <label>Angle name</label>
          <input
            autoFocus
            placeholder='e.g. "reverse-angle", "behind-the-desk", "night"'
            value={name}
            onChange={ev => setName(ev.target.value)}
          />
          <label>View prompt</label>
          <textarea
            style={{ minHeight: 100 }}
            placeholder="Describe this view of the SAME space — camera position, what's visible, framing (e.g. 'reverse angle from behind the desk, facing the entrance door and the rain-streaked window'). The series style, location description, lighting, and locked layout are added automatically."
            value={prompt}
            onChange={ev => setPrompt(ev.target.value)}
          />
        </div>
        <div className="dim small" style={{ marginTop: 6 }}>
          Saved as {name.trim() ? `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png` : '<name>.png'} beside
          wide/medium/detail, and included as an extra location reference on
          every shot in this location. Billed image pass.
        </div>
        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="action" disabled={!name.trim() || !prompt.trim()} onClick={submit}>
            Generate angle
          </button>
        </div>
      </div>
    </div>
  );
}

/** Thumbnail strip: one tile per angle with a regenerate action. */
function AngleStrip({
  slug,
  title,
  angles,
  busy,
  buildRequest,
}: {
  slug: string;
  title: string;
  angles: AngleArt[];
  busy: boolean;
  buildRequest: (angle: string, prompt?: string) => JobRequest;
}) {
  const [editing, setEditing] = useState<AngleArt | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const archive = async (angle: AngleArt) => {
    if (!angle.image) return;
    if (!window.confirm(`Remove the ${angle.angle} reference for ${title}? It is archived in place (recoverable), and stops feeding generations immediately.`)) return;
    setArchiveError(null);
    const result = await archiveMedia(slug, angle.image);
    if (result.error) setArchiveError(result.error);
    // Success needs no handling: the watcher's state-changed push refreshes the strip.
  };

  return (
    <div className="angle-strip">
      {angles.map(angle => (
        <div className={angle.stale ? 'angle-tile stale' : 'angle-tile'} key={angle.angle}>
          {angle.image ? (
            <div className="angle-media">
              <img src={mediaUrl(slug, angle.image)} loading="lazy" />
              {angle.stale && <span className="stale-badge" title="The description changed after this was generated — it depicts the old look.">stale</span>}
              <button
                className="angle-x"
                disabled={busy}
                title="Remove this reference (archived, recoverable)"
                onClick={() => archive(angle)}
              >
                ×
              </button>
            </div>
          ) : (
            <div className="angle-missing">not generated</div>
          )}
          <div className="angle-bar">
            <span className="angle-name">{angle.angle}</span>
            <button
              className="ghost angle-regen"
              disabled={busy}
              onClick={() => setEditing(angle)}
              title={angle.image ? 'Regenerate this angle' : 'Generate this angle'}
            >
              {angle.image ? 'regen' : 'generate'}
            </button>
          </div>
        </div>
      ))}
      {archiveError && <div className="error-banner" style={{ flexBasis: '100%' }}>{archiveError}</div>}
      {editing && (
        <RegenerateDialog
          slug={slug}
          title={title}
          angle={editing}
          buildRequest={buildRequest}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AddCharacterForm({ slug, busy }: { slug: string; busy: boolean }) {
  const [kind, setKind] = useState<'person' | 'object'>('person');
  const [name, setName] = useState('');
  const [gender, setGender] = useState('female');
  const [age, setAge] = useState('');
  const [description, setDescription] = useState('');

  const isObject = kind === 'object';
  // Props ride the character system with base-traits overriding the human
  // defaults (the harness convention for objects, e.g. the canopy-run drone).
  // The clean-plate phrasing counters prop-ref contamination (anti-pattern 22):
  // the reference must show the object alone, or the video model re-stages
  // the reference's whole composition into every shot that uses it.
  const objectBaseTraits = [
    'inanimate object, prop',
    description.trim() || name.trim(),
    'shown alone on a neutral background, clean product-plate framing, no people, no hands, no faces, no scene furniture',
  ].join('; ');

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Add character or prop</h2>
      <div className="form-grid">
        <label>Kind</label>
        <select value={kind} onChange={ev => setKind(ev.target.value as 'person' | 'object')}>
          <option value="person">Person</option>
          <option value="object">Object / prop (recurring hero item)</option>
        </select>
        <label>Name</label>
        <input
          value={name}
          onChange={ev => setName(ev.target.value)}
          placeholder={isObject ? 'e.g. THE PHONE' : ''}
        />
        {!isObject && (
          <>
            <label>Gender</label>
            <select value={gender} onChange={ev => setGender(ev.target.value)}>
              <option value="female">female</option>
              <option value="male">male</option>
              <option value="other">other</option>
            </select>
            <label>Age</label>
            <input placeholder="mid 20s" value={age} onChange={ev => setAge(ev.target.value)} />
          </>
        )}
        <label>Description</label>
        <textarea
          value={description}
          onChange={ev => setDescription(ev.target.value)}
          placeholder={isObject
            ? 'Exact look of the object: era, materials, color, wear, distinguishing marks'
            : ''}
        />
      </div>
      {isObject && (
        <div className="dim small" style={{ marginBottom: 10 }}>
          References render as clean plates — the object alone on a neutral
          background — so the video model can't re-stage the reference's
          surroundings into your shots.
        </div>
      )}
      <RunButton
        slug={slug}
        disabled={busy || !name.trim() || (isObject && !description.trim())}
        confirm="add-character generates billed reference images. Continue?"
        request={{
          command: 'add-character',
          options: isObject
            ? {
                name: name.trim(),
                gender: 'other',
                age: 'n/a',
                description: description.trim(),
                wardrobe: 'n/a',
                'base-traits': objectBaseTraits,
              }
            : {
                name: name.trim(),
                gender,
                ...(age.trim() ? { age: age.trim() } : {}),
                ...(description.trim() ? { description: description.trim() } : {}),
              },
        }}
      >
        Add + generate references
      </RunButton>
    </div>
  );
}

function AddLocationForm({ slug, busy }: { slug: string; busy: boolean }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lighting, setLighting] = useState('');
  const [anchors, setAnchors] = useState('');
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Add location</h2>
      <div className="form-grid">
        <label>Name</label>
        <input value={name} onChange={ev => setName(ev.target.value)} />
        <label>Description</label>
        <textarea value={description} onChange={ev => setDescription(ev.target.value)} />
        <label>Lighting notes</label>
        <input value={lighting} onChange={ev => setLighting(ev.target.value)} />
        <label>Spatial anchors</label>
        <textarea
          placeholder="3-5 named landmarks and their fixed relative positions"
          value={anchors}
          onChange={ev => setAnchors(ev.target.value)}
        />
      </div>
      <RunButton
        slug={slug}
        disabled={busy || !name.trim() || !description.trim()}
        confirm="add-location generates billed reference images. Continue?"
        request={{
          command: 'add-location',
          options: {
            name: name.trim(),
            description: description.trim(),
            ...(lighting.trim() ? { lighting: lighting.trim() } : {}),
            ...(anchors.trim() ? { 'spatial-anchors': anchors.trim() } : {}),
          },
        }}
      >
        Add + generate references
      </RunButton>
    </div>
  );
}

function LocationCard({
  slug,
  location,
  busy,
}: {
  slug: string;
  location: ProjectState['locations'][number];
  busy: boolean;
}) {
  const [addingAngle, setAddingAngle] = useState(false);
  const locationOptions = (angle: string, prompt?: string) => ({
    command: 'generate-location-references',
    options: {
      location: location.slug,
      angles: angle,
      ...(prompt ? { prompt } : {}),
    },
    flags: ['force'],
  });
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <b>{location.name}</b>
        <span style={{ flex: 1 }} />
        {location.art.length === 0 && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm={`Generate wide/medium/detail references for ${location.name}? This is a billed image pass.`}
            request={{
              command: 'generate-location-references',
              options: { location: location.slug },
            }}
          >
            Generate all references
          </RunButton>
        )}
        <button className="ghost" disabled={busy} onClick={() => setAddingAngle(true)}>
          + Add angle
        </button>
      </div>
      <AngleStrip
        slug={slug}
        title={location.name}
        angles={location.angles}
        busy={busy}
        buildRequest={locationOptions}
      />
      {addingAngle && (
        <AddAngleDialog slug={slug} location={location} onClose={() => setAddingAngle(false)} />
      )}
    </div>
  );
}

export function CastView({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const missingRefs =
    state.characters.some(character => character.art.length === 0) ||
    state.locations.some(location => location.art.length === 0);

  const staleEntities = [
    ...state.characters.filter(character => character.angles.some(angle => angle.stale)).map(character => character.name),
    ...state.locations.filter(location => location.angles.some(angle => angle.stale)).map(location => location.name),
  ];

  return (
    <div>
      {missingRefs && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <b>References missing.</b>
          <span className="dim small" style={{ marginLeft: 6 }}>
            Storyboarding is blocked until every character and location below
            has reference images — generate them from the buttons on each card.
          </span>
        </div>
      )}

      {staleEntities.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn, #b98a2e)' }}>
          <b>Stale references: {staleEntities.join(', ')}.</b>
          <span className="dim small" style={{ marginLeft: 6 }}>
            Their descriptions changed after these images were generated (a
            workshop revision, most likely) — the art depicts the old look.
            Regenerate the marked angles, or remove them with the × and let
            the next generation pass recreate them.
          </span>
        </div>
      )}

      <h2>Characters</h2>
      {state.characters.map(character => {
        const characterOptions = (angle: string, prompt?: string) => ({
          command: 'add-character',
          options: {
            name: character.name,
            gender: character.gender ?? 'other',
            ...(character.age ? { age: character.age } : {}),
            ...(character.description ? { description: character.description } : {}),
            ...(character.wardrobe ? { wardrobe: character.wardrobe } : {}),
            angles: angle,
            ...(prompt ? { prompt } : {}),
          },
        });
        return (
          <div className="card" key={character.dir}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <b>{character.name}</b>
              {character.voiceLocked && <span className="dim small">voice ✓</span>}
              <span style={{ flex: 1 }} />
              {character.art.length === 0 && (
                <RunButton
                  slug={slug}
                  disabled={busy}
                  confirm={`Generate all reference images for ${character.name}? This is a billed image pass.`}
                  request={{
                    command: 'add-character',
                    options: {
                      name: character.name,
                      gender: character.gender ?? 'other',
                      ...(character.age ? { age: character.age } : {}),
                      ...(character.description ? { description: character.description } : {}),
                      ...(character.wardrobe ? { wardrobe: character.wardrobe } : {}),
                    },
                  }}
                >
                  Generate all references
                </RunButton>
              )}
            </div>
            <AngleStrip
              slug={slug}
              title={character.name}
              angles={character.angles}
              busy={busy}
              buildRequest={characterOptions}
            />
          </div>
        );
      })}
      {state.characters.length === 0 && <div className="dim small">No characters yet.</div>}

      <h2>Locations</h2>
      {state.locations.map(location => (
        <LocationCard key={location.slug} slug={slug} location={location} busy={busy} />
      ))}
      {state.locations.length === 0 && <div className="dim small">No locations yet.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
        <AddCharacterForm slug={slug} busy={busy} />
        <AddLocationForm slug={slug} busy={busy} />
      </div>
    </div>
  );
}
