import { Field } from '../common';
import { useStore } from '../../state/store';
import { getPhotoExportProfile } from '../../export/photo';
import { formatBytesShort } from '../../lib/format';

export function PhotoQualityPanel({ bytes }: { bytes?: number }) {
  const quality = useStore((state) => state.photoQuality);
  const setQuality = useStore((state) => state.setPhotoQuality);
  const canvas = useStore((state) => state.canvas);
  const profile = getPhotoExportProfile(quality, canvas.width, canvas.height);

  return (
    <>
      <Field label="Export quality" value={`${quality}%`}>
        <input
          type="range"
          min={1}
          max={100}
          value={quality}
          aria-label="Photo quality"
          onChange={(event) => setQuality(Number(event.target.value))}
        />
        <div className="quality-scale" aria-hidden="true">
          <span>Smaller · degraded</span>
          <span>Original size</span>
        </div>
      </Field>

      <div className="photo-quality-readout">
        <div>
          <span>Export resolution</span>
          <strong>{profile.width} × {profile.height}</strong>
        </div>
        <div>
          <span>Current file size</span>
          <strong>{bytes ? formatBytesShort(bytes) : 'Updating…'}</strong>
        </div>
      </div>

      <div className="hint">
        This is a live export preview. Lower values reduce both JPEG detail and pixel dimensions;
        100% keeps the current canvas size.
      </div>
    </>
  );
}
