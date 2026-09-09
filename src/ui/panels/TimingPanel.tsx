import { useEffect, useRef, useState } from 'react';
import { Field, Segmented } from '../common';
import { useStore } from '../../state/store';
import type { Direction } from '../../state/types';
import { MAX_GIF_FPS } from '../../render/timeline';
import { formatTimecode } from '../../lib/format';
import { useGesture } from '../gestures';
import { clamp } from '../../render/geometry';

const FPS_OPTIONS = [10, 15, 20, 24, 30, 60];
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const SPEED_STEP = 0.01;
const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'forward', label: 'Forward' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'boomerang', label: 'Boomerang' },
];

const formatSpeed = (speed: number): string => speed.toFixed(3).replace(/\.?0+$/, '');
const normaliseSpeed = (speed: number): number => clamp(speed, MIN_SPEED, MAX_SPEED);

export function TimingPanel() {
  const kind = useStore((state) => state.kind);
  return (
    <>
      {kind === 'video' ? <VideoTiming /> : <PhotoTiming />}
      <FpsField />
    </>
  );
}

function FpsField() {
  const fps = useStore((state) => state.fps);
  const setFps = useStore((state) => state.setFps);
  return (
    <Field label="Frame rate" value={`${fps} FPS`}>
      <div className="chips">
        {FPS_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className="chip-btn"
            aria-pressed={fps === option}
            onClick={() => setFps(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {fps > MAX_GIF_FPS && (
        <div className="hint">
          The GIF format cannot play faster than {MAX_GIF_FPS} FPS — every browser rewrites shorter
          frame delays. Frames are sampled at {MAX_GIF_FPS} FPS so the speed and length stay correct.
        </div>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------- video

function VideoTiming() {
  const video = useStore((state) => state.video);
  const settings = useStore((state) => state.videoSettings);
  const setTrim = useStore((state) => state.setTrim);
  const setDirection = useStore((state) => state.setDirection);
  const setSpeed = useStore((state) => state.setSpeed);
  const setTrimScrub = useStore((state) => state.setTrimScrub);
  const cacheStale = useStore((state) => state.cacheStale);
  if (!video) return null;

  const selected = settings.trimEnd - settings.trimStart;

  return (
    <>
      <Field label="Trim" value={`${formatTimecode(selected)} selected`}>
        <TrimRail
          duration={video.duration}
          start={settings.trimStart}
          end={settings.trimEnd}
          onChange={setTrim}
          onScrub={setTrimScrub}
        />
        <div className="row" style={{ justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)' }}>
          <span>{formatTimecode(settings.trimStart)}</span>
          <span>of {formatTimecode(video.duration)}</span>
          <span>{formatTimecode(settings.trimEnd)}</span>
        </div>
        {cacheStale && (
          <div className="hint">
            Showing the exact frame under the handle. Press play to build the preview for this range.
          </div>
        )}
      </Field>

      <Field label="Direction">
        <Segmented
          ariaLabel="Playback direction"
          options={DIRECTIONS}
          value={settings.direction}
          onChange={setDirection}
        />
        {settings.direction === 'boomerang' && (
          <div className="hint">
            Plays forward then back. The turnaround frames are not repeated, so there is no pause at
            either end.
          </div>
        )}
      </Field>

      <Field label="Speed" value={`${formatSpeed(settings.speed)}×`}>
        <input
          type="range"
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={SPEED_STEP}
          value={settings.speed}
          aria-label="Playback speed"
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
        <div
          className="row"
          style={{ alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 2 }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{MIN_SPEED}×</span>
          <SpeedNumberInput speed={settings.speed} onChange={setSpeed} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{MAX_SPEED}×</span>
        </div>
      </Field>
    </>
  );
}

function SpeedNumberInput({ speed, onChange }: { speed: number; onChange: (speed: number) => void }) {
  const [draft, setDraft] = useState(formatSpeed(speed));

  useEffect(() => {
    setDraft(formatSpeed(speed));
  }, [speed]);

  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatSpeed(speed));
      return;
    }
    const next = normaliseSpeed(parsed);
    setDraft(formatSpeed(next));
    if (next !== speed) onChange(next);
  };

  return (
    <label
      style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 1 130px', minWidth: 0 }}
    >
      <input
        type="number"
        min={MIN_SPEED}
        max={MAX_SPEED}
        step="any"
        inputMode="decimal"
        value={draft}
        aria-label="Exact playback speed"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        style={{ minWidth: 0, textAlign: 'right' }}
      />
      <span style={{ color: 'var(--text-dim)' }}>×</span>
    </label>
  );
}

/**
 * Two-grip trim rail, sized for a thumb.
 *
 * Dragging a grip reports the timestamp under it so the preview can show that
 * exact source frame. Rebuilding the preview cache is deliberately *not* done
 * here — it happens when playback next needs it, so fine-tuning a trim point
 * never blocks on a decode pass.
 */
function TrimRail({
  duration,
  start,
  end,
  onChange,
  onScrub,
}: {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
  onScrub: (time: number | null) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const toTime = (clientX: number): number => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
  };

  useGesture(startRef, {
    onStart: (info) => onScrub(Math.min(toTime(info.clientX), end - 0.05)),
    onMove: (info) => {
      const next = Math.min(toTime(info.clientX), end - 0.05);
      onChange(next, end);
      onScrub(next);
    },
  });
  useGesture(endRef, {
    onStart: (info) => onScrub(Math.max(toTime(info.clientX), start + 0.05)),
    onMove: (info) => {
      const next = Math.max(toTime(info.clientX), start + 0.05);
      onChange(start, next);
      onScrub(next);
    },
  });

  const left = duration > 0 ? (start / duration) * 100 : 0;
  const right = duration > 0 ? (end / duration) * 100 : 100;

  return (
    <div className="trim-rail" ref={railRef}>
      <div className="trim-track">
        <div className="trim-sel" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
      </div>
      <div
        ref={startRef}
        className="trim-grip"
        style={{ left: `calc(${left}% - 15px)` }}
        role="slider"
        aria-label="Trim start"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={start}
      />
      <div
        ref={endRef}
        className="trim-grip"
        style={{ left: `calc(${right}% - 15px)` }}
        role="slider"
        aria-label="Trim end"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={end}
      />
    </div>
  );
}

// ---------------------------------------------------------------- photos

function PhotoTiming() {
  const photos = useStore((state) => state.photos);
  const reorderPhotos = useStore((state) => state.reorderPhotos);
  const removePhoto = useStore((state) => state.removePhoto);
  const duplicatePhoto = useStore((state) => state.duplicatePhoto);
  const importPhotos = useStore((state) => state.importPhotos);
  const setPhotoDuration = useStore((state) => state.setPhotoDuration);
  const setAllDurations = useStore((state) => state.setAllPhotoDurations);
  const addInput = useRef<HTMLInputElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const total = photos.reduce((sum, photo) => sum + photo.durationMs, 0);

  const index = Math.min(selectedIndex, Math.max(0, photos.length - 1));
  const selected = photos[index];
  if (!selected) return null;

  return (
    <Field label="Photos" value={`${photos.length}`}>
      <div className="strip">
        {photos.map((photo, i) => (
          <button
            key={photo.id}
            type="button"
            className={`strip-item${i === index ? ' selected' : ''}`}
            onClick={() => setSelectedIndex(i)}
            aria-label={`Photo ${i + 1}, ${(photo.durationMs / 1000).toFixed(2)} seconds`}
            aria-pressed={i === index}
          >
            <span className="ord">{i + 1}</span>
            <img src={photo.thumbUrl} alt="" />
            <span className="dur">{(photo.durationMs / 1000).toFixed(2)}s</span>
          </button>
        ))}
      </div>

      <div className="icon-row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => addInput.current?.click()}
          aria-label="Add photos"
        >
          + Add
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={index === 0}
          style={index === 0 ? { opacity: 0.4 } : undefined}
          onClick={() => {
            reorderPhotos(index, index - 1);
            setSelectedIndex(index - 1);
          }}
          aria-label="Move photo earlier"
        >
          ← Move
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={index >= photos.length - 1}
          style={index >= photos.length - 1 ? { opacity: 0.4 } : undefined}
          onClick={() => {
            reorderPhotos(index, index + 1);
            setSelectedIndex(index + 1);
          }}
          aria-label="Move photo later"
        >
          Move →
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => duplicatePhoto(selected.id)}
          aria-label="Duplicate photo"
        >
          Duplicate
        </button>
        <button
          type="button"
          className="icon-btn danger"
          onClick={() => {
            removePhoto(selected.id);
            setSelectedIndex(Math.max(0, index - 1));
          }}
          aria-label="Delete photo"
        >
          Delete
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="field-label">
          <span>Photo {index + 1} duration</span>
          <span className="value">{(selected.durationMs / 1000).toFixed(2)}s</span>
        </div>
        <input
          type="range"
          min={100}
          max={5000}
          step={50}
          value={selected.durationMs}
          aria-label={`Duration of photo ${index + 1}`}
          onChange={(event) => setPhotoDuration(selected.id, Number(event.target.value))}
        />
        <div className="chips">
          {[300, 500, 1000, 2000].map((ms) => (
            <button
              key={ms}
              type="button"
              className="chip-btn"
              onClick={() => setPhotoDuration(selected.id, ms)}
            >
              {(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s
            </button>
          ))}
          <button
            type="button"
            className="chip-btn"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => setAllDurations(selected.durationMs)}
            aria-label="Apply this duration to every photo"
          >
            Apply to all
          </button>
        </div>
        <div className="hint">
          Total {(total / 1000).toFixed(2)}s across {photos.length} photos.
        </div>
      </div>

      <input
        ref={addInput}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void importPhotos(files);
        }}
      />
    </Field>
  );
}
