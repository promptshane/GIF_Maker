import { useRef, useState } from 'react';
import { Field, Segmented } from '../common';
import { useStore } from '../../state/store';
import type { Direction } from '../../state/types';
import { MAX_GIF_FPS } from '../../render/timeline';
import { formatTimecode } from '../../lib/format';
import { useGesture } from '../gestures';
import { clamp } from '../../render/geometry';
import { loadPrefs } from '../../state/prefs';

const FPS_OPTIONS = [10, 15, 20, 24, 30, 60];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'forward', label: 'Forward' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'boomerang', label: 'Boomerang' },
];

export function TimingPanel() {
  const kind = useStore((state) => state.kind);
  return (
    <>
      {kind === 'video' ? <VideoTiming /> : <PhotoTiming />}
      <FpsField />
      {kind === 'photos' && <PhotoDurationField />}
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
  const ensurePreviewCache = useStore((state) => state.ensurePreviewCache);
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
          onCommit={() => void ensurePreviewCache()}
        />
        <div className="row" style={{ justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)' }}>
          <span>{formatTimecode(settings.trimStart)}</span>
          <span>of {formatTimecode(video.duration)}</span>
          <span>{formatTimecode(settings.trimEnd)}</span>
        </div>
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

      <Field label="Speed" value={`${settings.speed}×`}>
        <div className="chips">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className="chip-btn"
              aria-pressed={settings.speed === speed}
              onClick={() => setSpeed(speed)}
            >
              {speed}×
            </button>
          ))}
        </div>
      </Field>
    </>
  );
}

/**
 * Two-grip trim rail. Grips are 34px wide with generous hit areas so they stay
 * usable with a thumb, and the range is committed on release so the preview
 * cache is rebuilt once rather than on every pixel of movement.
 */
function TrimRail({
  duration,
  start,
  end,
  onChange,
  onCommit,
}: {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
  onCommit: () => void;
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
    onMove: (info) => onChange(Math.min(toTime(info.clientX), end - 0.05), end),
    onEnd: onCommit,
  });
  useGesture(endRef, {
    onMove: (info) => onChange(start, Math.max(toTime(info.clientX), start + 0.05)),
    onEnd: onCommit,
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
  const [selectedIndex, setSelectedIndex] = useState(0);

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

      <div style={{ marginTop: 14 }}>
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
          onChange={(event) =>
            useStore.getState().setPhotoDuration(selected.id, Number(event.target.value))
          }
        />
      </div>
    </Field>
  );
}

function PhotoDurationField() {
  const setAll = useStore((state) => state.setAllPhotoDurations);
  const photos = useStore((state) => state.photos);
  const [value, setValue] = useState(() => loadPrefs().photoDurationMs);

  const total = photos.reduce((sum, photo) => sum + photo.durationMs, 0);

  return (
    <Field label="Set every photo" value={`${(value / 1000).toFixed(2)}s each`}>
      <input
        type="range"
        min={100}
        max={5000}
        step={50}
        value={value}
        aria-label="Duration for every photo"
        onChange={(event) => setValue(Number(event.target.value))}
      />
      <div className="chips" style={{ marginTop: 4 }}>
        {[200, 300, 500, 800, 1000, 2000].map((ms) => (
          <button key={ms} type="button" className="chip-btn" onClick={() => setValue(ms)}>
            {(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s
          </button>
        ))}
        <button
          type="button"
          className="chip-btn"
          style={{ background: 'var(--accent)', color: '#fff' }}
          onClick={() => setAll(value)}
        >
          Apply to all
        </button>
      </div>
      <div className="hint">Current total: {(total / 1000).toFixed(2)}s across {photos.length} photos.</div>
    </Field>
  );
}
