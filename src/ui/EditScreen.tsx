import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type EditTool } from '../state/store';
import { useFramePlan, usePreviewProvider, useRenderSettings } from '../state/hooks';
import { usePreviewPlayer } from './usePreviewPlayer';
import { useSourceScrub } from './useSourceScrub';
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
  { id: 'timing', label: 'Edit', icon: '⏱' },
  { id: 'stickers', label: 'Emoji', icon: '😀' },
  { id: 'censor', label: 'Censor', icon: '🫥' },
  { id: 'canvas', label: 'Frame', icon: '⛶' },
];

export function EditScreen() {
  const tool = useStore((state) => state.tool);
  const setTool = useStore((state) => state.setTool);
  const fitMode = useStore((state) => state.canvas.fitMode);
  const crop = useStore((state) => state.crop);
  const setCrop = useStore((state) => state.setCrop);
  const stickers = useStore((state) => state.stickers);
  const censors = useStore((state) => state.censors);
  const selectedId = useStore((state) => state.selectedOverlayId);
  const selectOverlay = useStore((state) => state.selectOverlay);
  const updateSticker = useStore((state) => state.updateSticker);
  const setCensorRect = useStore((state) => state.setCensorRect);
  const reader = useStore((state) => state.reader);
  const trimScrub = useStore((state) => state.trimScrub);
  const setTrimScrub = useStore((state) => state.setTrimScrub);
  const cacheStale = useStore((state) => state.cacheStale);
  const ensurePreviewCache = useStore((state) => state.ensurePreviewCache);
  const immersive = useStore((state) => state.immersive);
  const setImmersive = useStore((state) => state.setImmersive);

  const plan = useFramePlan();
  const settings = useRenderSettings();
  const provider = usePreviewProvider();
  // While a trim handle is being dragged the preview shows that exact decoded
  // source frame instead of a cached one.
  const scrub = useSourceScrub(reader, trimScrub);
  const player = usePreviewPlayer(plan, settings, provider, scrub);

  const [cropping, setCropping] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Reframing needs the *uncropped* source, so the crop editor sizes itself to
  // the source aspect while the preview uses the output aspect.
  const sourceFrame: FrameImage | null = useMemo(() => {
    if (scrub.frame) return scrub.frame;
    const index = frameIndexAt(plan, player.timeMs);
    const frame = index >= 0 ? plan.frames[index] : null;
    if (!frame || !provider?.getSync) return null;
    return provider.getSync(frame.source);
  }, [plan, player.timeMs, provider, scrub.frame]);

  const previewAspect = settings.width / settings.height;
  const cropAspect = sourceFrame ? sourceFrame.width / sourceFrame.height : previewAspect;
  const box = useFitBox(stageRef, cropping ? cropAspect : previewAspect, immersive ? 8 : 24);

  useEffect(() => {
    if (fitMode !== 'crop' && cropping) setCropping(false);
  }, [fitMode, cropping]);

  // Scrubbing a trim handle or reframing against a moving image is unusable;
  // freeze on the frame being inspected.
  const setPlaying = player.setPlaying;
  useEffect(() => {
    if (cropping || trimScrub !== null) setPlaying(false);
  }, [cropping, trimScrub, setPlaying]);

  /**
   * Playback is what actually needs the frame cache, so this is where a
   * deferred rebuild is paid for — not on every trim adjustment.
   */
  const startPlayback = useCallback(async () => {
    if (cacheStale) await ensurePreviewCache();
    setTrimScrub(null);
    setPlaying(true);
  }, [cacheStale, ensurePreviewCache, setTrimScrub, setPlaying]);

  const onTogglePlay = useCallback(() => {
    if (player.playing) setPlaying(false);
    else void startPlayback();
  }, [player.playing, setPlaying, startPlayback]);

  const stageMode: StageMode =
    tool === 'stickers' ? 'stickers' : tool === 'censor' ? 'censor' : 'view';

  const transport = (
    <>
      <button
        type="button"
        className="play-btn"
        onClick={onTogglePlay}
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
          setPlaying(false);
          // Scrubbing the output timeline is a deliberate "show me the result",
          // so it is worth paying for the cache here.
          if (cacheStale) void ensurePreviewCache();
          setTrimScrub(null);
          player.seek(Number(event.target.value));
        }}
      />
      <span className="transport-time">
        {formatDuration(player.timeMs)} / {formatDuration(plan.durationMs)}
      </span>
    </>
  );

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
            mode={immersive ? 'view' : stageMode}
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

        <button
          type="button"
          className="stage-btn stage-btn-expand"
          onClick={() => setImmersive(!immersive)}
          aria-label={immersive ? 'Exit full screen' : 'View full screen'}
          aria-pressed={immersive}
        >
          {immersive ? '✕' : '⤢'}
        </button>

        {/* Read-only facts about the output, floated over the preview so they
            cost no layout height. */}
        <div className="stage-meta">
          <span>{settings.width}×{settings.height}</span>
          <span>{plan.fps} FPS</span>
          <span>{plan.frames.length} frames</span>
          <span>{formatDuration(plan.durationMs)}</span>
          {plan.truncated && <span className="warn">cut short — lower the FPS</span>}
        </div>

        {immersive && <div className="stage-transport">{transport}</div>}
      </div>

      {!immersive && (
        <>
          <div className="transport">{transport}</div>

          <div className="tool-panel">
            {tool === 'timing' && <TimingPanel />}
            {tool === 'stickers' && (
              <StickerPanel playheadMs={player.timeMs} durationMs={plan.durationMs} />
            )}
            {tool === 'censor' && (
              <CensorPanel playheadMs={player.timeMs} durationMs={plan.durationMs} />
            )}
            {tool === 'canvas' && <FramePanel cropping={cropping} onToggleCrop={setCropping} />}
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
                  // Keep the selection meaningful for the tab just opened.
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
        </>
      )}
    </>
  );
}
