import type { TimeRange } from '../../state/types';
import { Field } from '../common';
import { formatDuration } from '../../lib/format';

/**
 * Visibility window for an overlay. Rather than asking for numeric times on a
 * phone, the range is set from the preview playhead — scrub to the moment, then
 * tap "Start here" / "End here".
 */
export function TimeRangeField({
  range,
  durationMs,
  playheadMs,
  onChange,
}: {
  range: TimeRange | null;
  durationMs: number;
  playheadMs: number;
  onChange: (range: TimeRange | null) => void;
}) {
  const active = range !== null;
  const current = range ?? { startMs: 0, endMs: durationMs };

  return (
    <Field
      label="Visible"
      value={active ? `${formatDuration(current.startMs)} – ${formatDuration(current.endMs)}` : 'Whole GIF'}
    >
      <div className="chips">
        <button
          type="button"
          className="chip-btn"
          aria-pressed={!active}
          onClick={() => onChange(null)}
        >
          Whole GIF
        </button>
        <button
          type="button"
          className="chip-btn"
          aria-pressed={active}
          onClick={() => onChange({ startMs: 0, endMs: durationMs })}
        >
          Time range
        </button>
      </div>
      {active && (
        <>
          <div className="chips" style={{ marginTop: 6 }}>
            <button
              type="button"
              className="chip-btn"
              onClick={() =>
                onChange({
                  startMs: Math.min(playheadMs, current.endMs - 10),
                  endMs: current.endMs,
                })
              }
            >
              Start here
            </button>
            <button
              type="button"
              className="chip-btn"
              onClick={() =>
                onChange({
                  startMs: current.startMs,
                  endMs: Math.max(playheadMs + 10, current.startMs + 10),
                })
              }
            >
              End here
            </button>
          </div>
          <div className="hint">
            Scrub the preview to the moment you want, then tap. Playhead:{' '}
            {formatDuration(playheadMs)}.
          </div>
        </>
      )}
    </Field>
  );
}
