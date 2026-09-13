import { useEffect, useState } from 'react';
import { Field, Segmented, Switch } from '../common';
import { useStore } from '../../state/store';
import type { CanvasPreset, FitMode } from '../../state/types';

const PRESETS: Array<{ value: CanvasPreset; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: 'square', label: '1:1' },
  { value: 'portrait', label: '4:5' },
  { value: 'landscape', label: '16:9' },
  { value: 'custom', label: 'Custom' },
];

const FITS: Array<{ value: FitMode; label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: 'fill', label: 'Fill' },
  { value: 'crop', label: 'Crop' },
];

const FIT_HINTS: Record<FitMode, string> = {
  fit: 'The whole image is visible. Empty space uses the background colour.',
  fill: 'Scaled up to fill the frame and centre-cropped automatically.',
  crop: 'You choose the area. Tap “Reframe on image”, then drag it, pinch it, or pull any corner.',
};

export function FramePanel({
  cropping,
  onToggleCrop,
}: {
  cropping: boolean;
  onToggleCrop: (value: boolean) => void;
}) {
  const canvas = useStore((state) => state.canvas);
  const setCanvasPreset = useStore((state) => state.setCanvasPreset);
  const setCanvasSize = useStore((state) => state.setCanvasSize);
  const setLockAspect = useStore((state) => state.setLockAspect);
  const setFitMode = useStore((state) => state.setFitMode);
  const setBackground = useStore((state) => state.setBackground);
  const resetCrop = useStore((state) => state.resetCrop);

  return (
    <>
      <Field label="Output size" value={`${canvas.width} × ${canvas.height}`}>
        <Segmented
          ariaLabel="Output size preset"
          options={PRESETS}
          value={canvas.preset}
          onChange={setCanvasPreset}
        />
      </Field>

      <Field label="Width / height">
        <div className="row">
          <DimensionInput
            label="Output width"
            value={canvas.width}
            onCommit={(width) => setCanvasSize(width, canvas.height, 'width')}
          />
          <span style={{ color: 'var(--text-faint)' }}>×</span>
          <DimensionInput
            label="Output height"
            value={canvas.height}
            onCommit={(height) => setCanvasSize(canvas.width, height, 'height')}
          />
        </div>
        <Switch checked={canvas.lockAspect} onChange={setLockAspect} label="Lock aspect ratio" />
      </Field>

      <Field label="Framing">
        <Segmented ariaLabel="Framing mode" options={FITS} value={canvas.fitMode} onChange={setFitMode} />
        <div className="hint">{FIT_HINTS[canvas.fitMode]}</div>
      </Field>

      {canvas.fitMode === 'crop' && (
        <Field label="Reframe">
          <div className="icon-row">
            <button
              type="button"
              className="icon-btn"
              aria-pressed={cropping}
              style={cropping ? { background: 'var(--accent)', color: '#fff' } : undefined}
              onClick={() => onToggleCrop(!cropping)}
            >
              {cropping ? 'Done reframing' : 'Reframe on image'}
            </button>
            <button type="button" className="icon-btn" onClick={resetCrop}>
              Reset
            </button>
          </div>
        </Field>
      )}

      {canvas.fitMode === 'fit' && (
        <Field label="Background">
          <div className="row">
            <input
              type="color"
              aria-label="Background colour"
              value={canvas.background}
              onChange={(event) => setBackground(event.target.value)}
            />
            <div className="chips grow">
              {['#000000', '#ffffff', '#1e1e29', '#b64cf0'].map((color) => (
                <button
                  key={color}
                  type="button"
                  className="chip-btn"
                  aria-pressed={canvas.background === color}
                  aria-label={`Background ${color}`}
                  style={{ background: color, minWidth: 44, border: '1px solid var(--line-strong)' }}
                  onClick={() => setBackground(color)}
                />
              ))}
            </div>
          </div>
        </Field>
      )}
    </>
  );
}

/**
 * A size field that commits when you leave it (or press Enter), not on every
 * keystroke. Applying half-typed values live meant "7" on the way to "720" was
 * clamped to the 16px minimum — and with the aspect locked, that rounded the
 * other side to 16 as well and quietly turned a 16:9 output into a square.
 */
function DimensionInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = Number(text);
    if (Number.isFinite(next) && next > 0) onCommit(next);
    else setText(String(value));
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={16}
      max={2048}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
