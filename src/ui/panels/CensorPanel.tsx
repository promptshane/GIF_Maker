import { Field, Segmented } from '../common';
import { useStore } from '../../state/store';
import { TimeRangeField } from './TimeRangeField';
import { censorRectAt } from '../../render/timeline';
import { formatDuration } from '../../lib/format';
import type { CensorEffect, CensorShape } from '../../state/types';

const EFFECTS: Array<{ value: CensorEffect; label: string }> = [
  { value: 'blur', label: 'Blur' },
  { value: 'pixelate', label: 'Pixelate' },
];

const SHAPES: Array<{ value: CensorShape; label: string }> = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Circle' },
];

export function CensorPanel({
  playheadMs,
  durationMs,
}: {
  playheadMs: number;
  durationMs: number;
}) {
  const censors = useStore((state) => state.censors);
  const selectedId = useStore((state) => state.selectedOverlayId);
  const addCensor = useStore((state) => state.addCensor);
  const updateCensor = useStore((state) => state.updateCensor);
  const removeCensor = useStore((state) => state.removeCensor);
  const selectOverlay = useStore((state) => state.selectOverlay);
  const setCensorRect = useStore((state) => state.setCensorRect);
  const addKeyframe = useStore((state) => state.addCensorKeyframe);
  const removeKeyframe = useStore((state) => state.removeCensorKeyframe);

  const selected = censors.find((region) => region.id === selectedId) ?? null;
  const rect = selected ? censorRectAt(selected, playheadMs) : null;

  return (
    <>
      <Field label="Add">
        <div className="chips">
          <button type="button" className="chip-btn" onClick={() => addCensor('blur', 'rect')}>
            + Blur box
          </button>
          <button type="button" className="chip-btn" onClick={() => addCensor('pixelate', 'rect')}>
            + Pixelate box
          </button>
          <button type="button" className="chip-btn" onClick={() => addCensor('blur', 'circle')}>
            + Blur circle
          </button>
        </div>
      </Field>

      {censors.length === 0 ? (
        <div className="empty-note">
          Add a region, then drag it over what you want hidden. Drag the corner handle to resize.
        </div>
      ) : (
        <Field label="Regions" value={`${censors.length}`}>
          {censors.map((region, index) => (
            <div
              key={region.id}
              className={`list-card${region.id === selectedId ? ' selected' : ''}`}
            >
              <div className="list-card-head">
                <button
                  type="button"
                  className="title"
                  style={{ textAlign: 'left' }}
                  onClick={() => selectOverlay(region.id)}
                >
                  {index + 1}. {region.effect === 'blur' ? 'Blur' : 'Pixelate'}{' '}
                  {region.shape === 'circle' ? 'circle' : 'box'}
                  {region.keyframes.length > 1 ? ` · ${region.keyframes.length} keyframes` : ''}
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  style={{ flex: 'none', width: 72 }}
                  onClick={() => removeCensor(region.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </Field>
      )}

      {selected && rect && (
        <>
          <Field label="Effect">
            <Segmented
              ariaLabel="Censor effect"
              options={EFFECTS}
              value={selected.effect}
              onChange={(effect) => updateCensor(selected.id, { effect })}
            />
          </Field>

          <Field label="Shape">
            <Segmented
              ariaLabel="Censor shape"
              options={SHAPES}
              value={selected.shape}
              onChange={(shape) => updateCensor(selected.id, { shape })}
            />
          </Field>

          <Field label="Strength" value={`${Math.round(selected.strength * 100)}%`}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(selected.strength * 100)}
              aria-label="Censor strength"
              onChange={(event) =>
                updateCensor(selected.id, { strength: Number(event.target.value) / 100 })
              }
            />
          </Field>

          <Field label="Size" value={`${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}%`}>
            <input
              type="range"
              min={2}
              max={150}
              value={Math.round(rect.w * 100)}
              aria-label="Censor width"
              onChange={(event) =>
                setCensorRect(selected.id, playheadMs, {
                  ...rect,
                  w: Number(event.target.value) / 100,
                })
              }
            />
            <input
              type="range"
              min={2}
              max={150}
              value={Math.round(rect.h * 100)}
              aria-label="Censor height"
              onChange={(event) =>
                setCensorRect(selected.id, playheadMs, {
                  ...rect,
                  h: Number(event.target.value) / 100,
                })
              }
            />
          </Field>

          <Field label="Follow movement" value={`${selected.keyframes.length} keyframe${selected.keyframes.length === 1 ? '' : 's'}`}>
            <div className="chips">
              <button
                type="button"
                className="chip-btn"
                style={{ background: 'var(--accent)', color: '#fff' }}
                onClick={() => addKeyframe(selected.id, playheadMs)}
              >
                + Keyframe at {formatDuration(playheadMs)}
              </button>
            </div>
            <div className="hint">
              Scrub the preview, add a keyframe, then drag the region to its new position. Position
              and size are interpolated between keyframes.
            </div>
            {selected.keyframes.length > 1 && (
              <div className="chips" style={{ marginTop: 8 }}>
                {selected.keyframes.map((key) => (
                  <button
                    key={key.t}
                    type="button"
                    className="chip-btn"
                    onClick={() => removeKeyframe(selected.id, key.t)}
                    aria-label={`Remove keyframe at ${formatDuration(key.t)}`}
                  >
                    {formatDuration(key.t)} ✕
                  </button>
                ))}
              </div>
            )}
          </Field>

          <TimeRangeField
            range={selected.range}
            durationMs={durationMs}
            playheadMs={playheadMs}
            onChange={(range) => updateCensor(selected.id, { range })}
          />
        </>
      )}
    </>
  );
}
