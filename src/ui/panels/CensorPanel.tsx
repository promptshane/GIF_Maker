import { Field, RepeatButton, Segmented } from '../common';
import { useStore } from '../../state/store';
import { TimeRangeField } from './TimeRangeField';
import { censorRectAt } from '../../render/timeline';
import { clamp } from '../../render/geometry';
import { formatDuration } from '../../lib/format';
import type { CensorEffect, CensorShape } from '../../state/types';

const EFFECTS: Array<{ value: CensorEffect; label: string }> = [
  { value: 'blur', label: 'Blur' },
  { value: 'pixelate', label: 'Pixelate' },
  { value: 'black', label: 'Black' },
];

const SHAPES: Array<{ value: CensorShape; label: string }> = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Circle' },
];

/** One nudge or step, as a fraction of the canvas: ~5px on a 480px output. */
const STEP = 0.01;
const MIN_SIZE = 0.02;
const MAX_SIZE = 1.5;

/** Keeps stepped values stable while still allowing 0.1%-level slider precision. */
const snap = (value: number): number => Math.round(value * 1e4) / 1e4;
const formatSizePercent = (value: number): string => {
  const percent = Math.round(value * 1000) / 10;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
};

export function CensorPanel({
  playheadMs,
  durationMs,
  staticImage = false,
}: {
  playheadMs: number;
  durationMs: number;
  staticImage?: boolean;
}) {
  const censors = useStore((state) => state.censors);
  const selectedId = useStore((state) => state.selectedOverlayId);
  const addCensor = useStore((state) => state.addCensor);
  const updateCensor = useStore((state) => state.updateCensor);
  const removeCensor = useStore((state) => state.removeCensor);
  const duplicateCensor = useStore((state) => state.duplicateCensor);
  const selectOverlay = useStore((state) => state.selectOverlay);
  const setCensorRect = useStore((state) => state.setCensorRect);
  const addKeyframe = useStore((state) => state.addCensorKeyframe);
  const removeKeyframe = useStore((state) => state.removeCensorKeyframe);

  const selected = censors.find((region) => region.id === selectedId) ?? null;
  const rect = selected ? censorRectAt(selected, playheadMs) : null;

  const nudge = (dx: number, dy: number) => {
    if (!selected || !rect) return;
    setCensorRect(selected.id, playheadMs, {
      ...rect,
      x: snap(clamp(rect.x + dx, 0, 1)),
      y: snap(clamp(rect.y + dy, 0, 1)),
    });
  };

  const resize = (patch: { w?: number; h?: number }) => {
    if (!selected || !rect) return;
    setCensorRect(selected.id, playheadMs, {
      ...rect,
      w: snap(clamp(patch.w ?? rect.w, MIN_SIZE, MAX_SIZE)),
      h: snap(clamp(patch.h ?? rect.h, MIN_SIZE, MAX_SIZE)),
    });
  };

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
          <button type="button" className="chip-btn" onClick={() => addCensor('black', 'rect')}>
            + Black bar
          </button>
          <button type="button" className="chip-btn" onClick={() => addCensor('blur', 'circle')}>
            + Blur circle
          </button>
        </div>
      </Field>

      {censors.length === 0 ? (
        <div className="empty-note">
          Add a region, then drag it over what you want hidden. Set its size and fine-tune its
          position with the controls below.
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
                  {index + 1}.{' '}
                  {region.effect === 'blur'
                    ? 'Blur'
                    : region.effect === 'pixelate'
                      ? 'Pixelate'
                      : 'Black'}{' '}
                  {region.shape === 'circle' ? 'circle' : 'box'}
                  {region.keyframes.length > 1 ? ` · ${region.keyframes.length} keyframes` : ''}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ flex: 'none', width: 44 }}
                  onClick={() => duplicateCensor(region.id, playheadMs)}
                  aria-label={`Duplicate region ${index + 1}`}
                  title="Duplicate"
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  style={{ flex: 'none', width: 64 }}
                  onClick={() => removeCensor(region.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {selected && (
            <button
              type="button"
              className="ghost-btn"
              style={{ width: '100%', minHeight: 40 }}
              onClick={() => selectOverlay(null)}
            >
              Deselect
            </button>
          )}
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

          {selected.effect !== 'black' && (
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
          )}

          <Field label="Size" value={`${formatSizePercent(rect.w)} × ${formatSizePercent(rect.h)}`}>
            <div className="size-axis-label">Horizontal</div>
            <div className="stepper-row">
              <RepeatButton
                className="step-btn"
                label="Narrower"
                onPress={() => resize({ w: rect.w - STEP })}
              >
                −
              </RepeatButton>
              <input
                type="range"
                min={2}
                max={150}
                step={0.1}
                value={rect.w * 100}
                aria-label="Censor width"
                onChange={(event) => resize({ w: Number(event.target.value) / 100 })}
              />
              <RepeatButton
                className="step-btn"
                label="Wider"
                onPress={() => resize({ w: rect.w + STEP })}
              >
                +
              </RepeatButton>
            </div>
            <div className="size-axis-label">Vertical</div>
            <div className="stepper-row">
              <RepeatButton
                className="step-btn"
                label="Shorter"
                onPress={() => resize({ h: rect.h - STEP })}
              >
                −
              </RepeatButton>
              <input
                type="range"
                min={2}
                max={150}
                step={0.1}
                value={rect.h * 100}
                aria-label="Censor height"
                onChange={(event) => resize({ h: Number(event.target.value) / 100 })}
              />
              <RepeatButton
                className="step-btn"
                label="Taller"
                onPress={() => resize({ h: rect.h + STEP })}
              >
                +
              </RepeatButton>
            </div>
          </Field>

          <Field
            label="Position"
            value={`${Math.round(rect.x * 100)}%, ${Math.round(rect.y * 100)}%`}
          >
            <div className="nudge-pad">
              <RepeatButton className="step-btn" label="Nudge left" onPress={() => nudge(-STEP, 0)}>
                ←
              </RepeatButton>
              <div className="nudge-stack">
                <RepeatButton className="step-btn" label="Nudge up" onPress={() => nudge(0, -STEP)}>
                  ↑
                </RepeatButton>
                <RepeatButton className="step-btn" label="Nudge down" onPress={() => nudge(0, STEP)}>
                  ↓
                </RepeatButton>
              </div>
              <RepeatButton className="step-btn" label="Nudge right" onPress={() => nudge(STEP, 0)}>
                →
              </RepeatButton>
              <div className="hint nudge-hint">
                Tap to move the region 1% at a time, or hold to keep moving. Drag it on the preview
                for big moves.
              </div>
            </div>
          </Field>

          {!staticImage && <Field label="Follow movement" value={`${selected.keyframes.length} keyframe${selected.keyframes.length === 1 ? '' : 's'}`}>
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
          </Field>}

          {!staticImage && (
            <TimeRangeField
              range={selected.range}
              durationMs={durationMs}
              playheadMs={playheadMs}
              onChange={(range) => updateCensor(selected.id, { range })}
            />
          )}
        </>
      )}
    </>
  );
}
