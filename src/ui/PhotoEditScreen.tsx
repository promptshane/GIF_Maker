import { useMemo, useRef, useState } from 'react';
import { useStore, type EditTool } from '../state/store';
import { useFramePlan, usePreviewProvider, useRenderSettings } from '../state/hooks';
import { useFitBox } from './gestures';
import { PreviewStage } from './PreviewStage';
import { CensorPanel } from './panels/CensorPanel';
import { PhotoQualityPanel } from './panels/PhotoQualityPanel';
import { usePhotoPreview } from './usePhotoPreview';
import { formatBytesShort } from '../lib/format';
import { detectFaces } from '../media/detectFaces';

const PHOTO_TABS: Array<{ id: EditTool; label: string; icon: string }> = [
  { id: 'censor', label: 'Censor', icon: '🫥' },
  { id: 'quality', label: 'Quality', icon: '◐' },
];

export function PhotoEditScreen() {
  const tool = useStore((state) => state.tool);
  const setTool = useStore((state) => state.setTool);
  const quality = useStore((state) => state.photoQuality);
  const censors = useStore((state) => state.censors);
  const selectedId = useStore((state) => state.selectedOverlayId);
  const selectOverlay = useStore((state) => state.selectOverlay);
  const setCensorRect = useStore((state) => state.setCensorRect);
  const addBrushCensor = useStore((state) => state.addBrushCensor);
  const addFaceCensors = useStore((state) => state.addFaceCensors);
  const immersive = useStore((state) => state.immersive);
  const setImmersive = useStore((state) => state.setImmersive);

  const plan = useFramePlan();
  const settings = useRenderSettings();
  const provider = usePreviewProvider();
  const source = plan.frames[0]?.source ?? null;
  const preview = usePhotoPreview(provider, source, settings, quality);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [censorZoom, setCensorZoom] = useState(1);
  const [brushActive, setBrushActive] = useState(false);
  const [brushSize, setBrushSize] = useState(0.07);
  const [detectingFaces, setDetectingFaces] = useState(false);
  const [faceStatus, setFaceStatus] = useState<string | null>(null);
  const box = useFitBox(stageRef, settings.width / settings.height, immersive ? 8 : 24);

  const autoCensorFaces = async () => {
    const canvas = preview.canvasRef.current;
    if (!canvas || preview.rendering || detectingFaces) {
      setFaceStatus('Image preview is not ready yet.');
      return;
    }
    setDetectingFaces(true);
    setFaceStatus(null);
    try {
      const faces = await detectFaces(canvas);
      if (faces.length) addFaceCensors(faces);
      setFaceStatus(faces.length
        ? `Added blur regions to ${faces.length} face${faces.length === 1 ? '' : 's'}. Review coverage before exporting.`
        : 'No faces detected. You can still add a blur or paint manually.');
    } catch {
      setFaceStatus('Could not load the face detector. Check your connection and try again.');
    } finally {
      setDetectingFaces(false);
    }
  };

  const activeTool = useMemo<EditTool>(() =>
    PHOTO_TABS.some((tab) => tab.id === tool) ? tool : 'censor', [tool]);

  return (
    <>
      <div className="stage" ref={stageRef}>
        <PreviewStage
          canvasRef={preview.canvasRef}
          box={box}
          mode={!immersive && activeTool === 'censor' ? 'censor' : 'view'}
          timeMs={0}
          stickers={[]}
          censors={censors}
          selectedId={selectedId}
          onSelect={selectOverlay}
          onMoveSticker={() => undefined}
          onMoveCensor={(id, rect) => setCensorRect(id, 0, rect)}
          outputWidth={settings.width}
          outputHeight={settings.height}
          previewLabel="Edited photo preview"
          onZoomChange={setCensorZoom}
          brushActive={brushActive}
          brushSize={brushSize}
          onBrushStroke={addBrushCensor}
        />

        <button
          type="button"
          className="stage-btn stage-btn-expand"
          onClick={() => setImmersive(!immersive)}
          aria-label={immersive ? 'Exit full screen' : 'View full screen'}
          aria-pressed={immersive}
        >
          {immersive ? '✕' : '⤢'}
        </button>

        <div className="stage-meta">
          <span>{preview.result ? `${preview.result.width}×${preview.result.height}` : 'Preparing preview'}</span>
          {preview.result && <span>{formatBytesShort(preview.result.bytes)}</span>}
          <span>{quality}% quality</span>
          {preview.rendering && <span>updating…</span>}
        </div>
      </div>

      {!immersive && (
        <>
          <div className="tool-panel photo-tools">
            {activeTool === 'censor' && <CensorPanel playheadMs={0} durationMs={0} staticImage
              zoom={censorZoom} brushActive={brushActive} brushSize={brushSize}
              onToggleBrush={() => setBrushActive((active) => !active)}
              onBrushSizeChange={setBrushSize}
              onDetectFaces={() => { void autoCensorFaces(); }}
              detectingFaces={detectingFaces} faceStatus={faceStatus} />}
            {activeTool === 'quality' && <PhotoQualityPanel bytes={preview.result?.bytes} />}
          </div>

          <nav className="tabs">
            {PHOTO_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`tab${activeTool === tab.id ? ' active' : ''}`}
                aria-pressed={activeTool === tab.id}
                onClick={() => {
                  setTool(tab.id);
                  if (tab.id === 'censor') {
                    const keep = censors.some((region) => region.id === selectedId);
                    selectOverlay(keep ? selectedId : (censors[censors.length - 1]?.id ?? null));
                  }
                }}
              >
                <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </>
      )}
    </>
  );
}
