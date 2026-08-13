import { useCallback, useEffect, useState } from 'react';

interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

interface ModelSettings {
  current: {
    intelligenceModel: string;
    intelligenceVisionModel: string;
    videoFamilyPreference: string;
    actionModel: string;
    atmosphereModel: string;
    characterConsistencyModel: string;
    multiShotModel: string;
    imageGenerationModel: string;
    imageEditModel: string;
  };
  options: {
    intelligence: ModelOption[];
    videoFamily: ModelOption[];
    video: ModelOption[];
    image: ModelOption[];
  };
}

function Row({
  label,
  help,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  help?: string;
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const selected = options.find(option => option.value === value);
  const known = Boolean(selected);
  return (
    <>
      <label>
        {label}
        {help && <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{help}</div>}
      </label>
      <div>
        <select value={known ? value : ''} disabled={disabled} onChange={ev => onChange(ev.target.value)}>
          {!known && <option value="">{value} (unlisted)</option>}
          {options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {selected?.description && (
          <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>{selected.description}</div>
        )}
      </div>
    </>
  );
}

/**
 * Per-project model settings. Every change PUTs immediately and the server
 * re-reads series.json, so what's shown is always what production will use.
 * Picking a video family repoints the three routing models to that family's
 * defaults (same behavior as project creation).
 */
export function SettingsView({ slug, busy }: { slug: string; busy: boolean }) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  const load = useCallback(() => {
    fetch(`/api/projects/${encodeURIComponent(slug)}/settings/models`)
      .then(res => res.json())
      .then(body => {
        if (body.error) setError(body.error);
        else setSettings(body);
      })
      .catch(err => setError(String(err)));
  }, [slug]);

  useEffect(load, [load]);

  const patch = async (change: Record<string, string>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/settings/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        setError(body.error ?? `Save failed (${res.status})`);
      } else {
        setSettings(body);
        setSavedTick(tick => tick + 1);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  if (error && !settings) return <div className="error-banner">{error}</div>;
  if (!settings) return <div className="empty">Loading settings…</div>;

  const { current, options } = settings;
  const disabled = saving || busy;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {busy && (
        <div className="card dim small">
          A job is running — model changes are locked until it finishes so the
          two writes can't clobber each other.
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Intelligence</h2>
        <div className="dim small" style={{ marginBottom: 10 }}>
          The reasoning model that develops the workshop, writes scripts, and
          reads panels during QA. Text-only choices pair automatically with a
          vision model from the same privacy tier.
        </div>
        <div className="form-grid">
          <Row
            label="Model"
            value={current.intelligenceModel}
            options={options.intelligence}
            disabled={disabled}
            onChange={value => patch({ intelligenceModel: value })}
          />
          <label>QA vision model</label>
          <div className="dim small" style={{ paddingTop: 6 }}>
            {current.intelligenceVisionModel}
            {current.intelligenceVisionModel !== current.intelligenceModel
              ? ' (companion — chosen automatically)'
              : ' (same model)'}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Video</h2>
        <div className="dim small" style={{ marginBottom: 10 }}>
          Selecting a family resets the three routing models to that family's
          defaults; adjust any of them individually afterward.
        </div>
        <div className="form-grid">
          <Row
            label="Family"
            value={current.videoFamilyPreference}
            options={options.videoFamily}
            disabled={disabled}
            onChange={value => patch({ videoFamilyPreference: value })}
          />
          <Row
            label="Action model"
            help="Shots with motion and stunts"
            value={current.actionModel}
            options={options.video}
            disabled={disabled}
            onChange={value => patch({ actionModel: value })}
          />
          <Row
            label="Atmosphere model"
            help="Establishing and mood shots"
            value={current.atmosphereModel}
            options={options.video}
            disabled={disabled}
            onChange={value => patch({ atmosphereModel: value })}
          />
          <Row
            label="Character consistency"
            help="Reference-to-video identity anchoring"
            value={current.characterConsistencyModel}
            options={options.video}
            disabled={disabled}
            onChange={value => patch({ characterConsistencyModel: value })}
          />
          <Row
            label="Multi-shot / montage"
            help="Single-pass units spanning several beats"
            value={current.multiShotModel}
            options={options.video}
            disabled={disabled}
            onChange={value => patch({ multiShotModel: value })}
          />
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Image</h2>
        <div className="dim small" style={{ marginBottom: 10 }}>
          Storyboard panels and reference art. The description notes how each
          family's output interacts with Seedance's input gate.
        </div>
        <div className="form-grid">
          <Row
            label="Generation model"
            value={current.imageGenerationModel}
            options={options.image}
            disabled={disabled}
            onChange={value => patch({ imageGenerationModel: value })}
          />
          <label>Edit model</label>
          <div className="dim small" style={{ paddingTop: 6 }}>{current.imageEditModel}</div>
        </div>
      </div>

      <div className="dim small">
        {saving ? 'Saving…' : savedTick > 0 ? 'Saved — production uses these immediately.' : 'Changes save immediately to series.json.'}
      </div>
    </div>
  );
}
