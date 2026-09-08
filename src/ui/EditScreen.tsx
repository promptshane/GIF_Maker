import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type EditTool } from '../state/store';
import { useFramePlan, usePreviewProvider, useRenderSettings } from '../state/hooks';
import { usePreviewPlayer } from './usePreviewPlayer';
import { useFitBox } from './gestures';
import { PreviewStage, type StageMode } from './PreviewStage';
import { CropEditor } from './CropEditor';
import { FramePanel } from './panels/FramePanel';
import { TimingPanel } from './panels/TimingPanel';
import { StickerPanel } from './panels/StickerPanel';
import { CensorPanel } from './panels/CensorPanel';
import { formatDuration } from '../lib/format';
import { frameIndexAt } from '../render/timeline';
import type { FrameImage } from '../media/frames';

const TABS: Array<{ id: EditTool; label: string; icon: string }> = [
  { id: 'canvas', label: 'Frame', icon: '⛶' },
  { id: 'timing', label: 'Timing', icon: '⏱' },
  { id: 'stickers', label: 'Emoji', icon: '😀' },
  { id: 'censor', label: 'Censor', icon: '🫥' },
];

export function EditScreen({ onExport }: { onExport: () => void }) {
  const tool = useStore((state) => state.tool);
  const setTool = useStore((state) => state.setTool);
  const kind = useStore((state) => state.kind);
  const fitMode = useStore((state) => state.canvas.fitMode);
  const crop = useStore((state) => state.crop);
  const setCrop = useStore((state) => state.setCrop);
  const stickers = useStore((state) => state.stickers);
  const censors = useStore((state) => state.censors);
  const selectedId = useStore((state) => state.selectedOverlayId);
  const selectOverlay = useStore((state) => state.selectOverlay);
  const updateSticker = useStore((state) => state.updateSticker);
  const setCensorRect = useStore((state) => state.setCensorRect);
  const importPhotos = useStore((state) => state.importPhotos);

  const plan = useFramePlan();
  const settings = useRenderSettings();
  const provider = usePreviewProvider();
  const player = usePreviewPlayer(plan, settings, provider);

  const [cropping, setCropping] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const addPhotosInput = useRef<HTMLInputElement | null>(null);

  // Reframing needs the *uncropped* source, so the crop editor sizes itself to
  // the source aspect while the preview uses the output aspect.
  const sourceFrame: FrameImage | null = useMemo(() => {
    const index = frameIndexAt(plan, player.timeMs);
    const frame = index >= 0 ? plan.frames[index] : null;
    if (!frame || !provider?.getSync) return null;
    return provider.getSync(frame.source);
  }, [plan, player.timeMs, provider]);

  const previewAspect = settings.width / settings.height;
  const cropAspect = sourceFrame ? sourceFrame.width / sourceFrame.height : previewAspect;
  const box = useFitBox(stageRef, cropping ? cropAspect : previewAspect);

  useEffect(() => {
    if (fitMode !== 'crop' && cropping) setCropping(false);
  }, [fitMode, cropping]);

  // Reframing against a moving image is unusable; freeze on the current frame.
  useEffect(() => {
    if (cropping) player.setPlaying(false);
  }, [cropping, player]);

  const stageMode: StageMode =
    tool === 'stickers' ? 'stickers' : tool === 'censor' ? 'censor' : 'view';

  return (
    <>
      <div className="stage" ref={stageRef}>
        {cropping ? (
          <CropEditor
            source={sourceFrame}
            crop={crop}
            onChange={setCrop}
            box={box}
            outputWidth={settings.width}
            outputHeight={settings.height}
          />
        ) : (
          <PreviewStage
            canvasRef={player.canvasRef}
            box={box}
            mode={stageMode}
            timeMs={player.timeMs}
            stickers={stickers}
            censors={censors}
            selectedId={selectedId}
            onSelect={selectOverlay}
            onMoveSticker={updateSticker}
            onMoveCensor={(id, rect) => setCensorRect(id, player.timeMs, rect)}
            outputWidth={settings.width}
            outputHeight={settings.height}
          />
        )}
      </div>

      <div className="transport">
        <button
          type="button"
          className="play-btn"
          onClick={player.togglePlay}
          aria-label={player.playing ? 'Pause preview' : 'Play preview'}
        >
          {player.playing ? '❚❚' : '▶'}
        </button>
        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(1, Math.round(plan.durationMs))}
          value={Math.round(player.timeMs)}
          aria-label="Preview position"
          onChange={(event) => {
            player.setPlaying(false);
            player.seek(Number(event.target.value));
          }}
        />
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-dim)',
            fontVariantNumeric: 'tabular-nums',
            minWidth: 78,
            textAlign: 'right',
          }}
        >
          {formatDuration(player.timeMs)} / {formatDuration(plan.durationMs)}
        </span>
      </div>

      <div className="meta-row">
        <span className="chip">
          <strong>{settings.width}×{settings.height}</strong>
        </span>
        <span className="chip">
          <strong>{plan.fps}</strong> FPS
        </span>
        <span className="chip">
          <strong>{plan.frames.length}</strong> frames
        </span>
        <span className="chip">
          <strong>{formatDuration(plan.durationMs)}</strong>
        </span>
        {plan.truncated && (
          <span className="chip" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            Cut short — lower the FPS or shorten it
          </span>
        )}
        {kind === 'photos' && (
          <button
            type="button"
            className="chip"
            style={{ color: 'var(--accent)' }}
            onClick={() => addPhotosInput.current?.click()}
          >
            + Add photos
          </button>
        )}
      </div>

      <div className="tool-panel">
        {tool === 'canvas' && <FramePanel cropping={cropping} onToggleCrop={setCropping} />}
        {tool === 'timing' && <TimingPanel />}
        {tool === 'stickers' && (
          <StickerPanel playheadMs={player.timeMs} durationMs={plan.durationMs} />
        )}
        {tool === 'censor' && (
          <CensorPanel playheadMs={player.timeMs} durationMs={plan.durationMs} />
        )}
      </div>

      <nav className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab${tool === tab.id ? ' active' : ''}`}
            aria-pressed={tool === tab.id}
            onClick={() => {
              setTool(tab.id);
              if (tab.id !== 'canvas') setCropping(false);
              // Keep the selection meaningful for the tab you just opened: a
              // sticker stays selected under Emoji, a region under Censor.
              if (tab.id === 'stickers') {
                const keep = stickers.some((s) => s.id === selectedId);
                selectOverlay(keep ? selectedId : (stickers[stickers.length - 1]?.id ?? null));
              } else if (tab.id === 'censor') {
                const keep = censors.some((c) => c.id === selectedId);
                selectOverlay(keep ? selectedId : (censors[censors.length - 1]?.id ?? null));
              }
            }}
          >
            <span className="tab-icon" aria-hidden="true">
              {tab.icon}
            </span>
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="cta-bar">
        <button type="button" className="cta" onClick={onExport} disabled={plan.frames.length === 0}>
          Export GIF
        </button>
      </div>

      <input
        ref={addPhotosInput}
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
    </>
  );
}
