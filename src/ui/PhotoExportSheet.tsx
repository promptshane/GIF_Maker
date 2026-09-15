import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './common';
import { useStore } from '../state/store';
import { useFramePlan, usePreviewProvider, useRenderSettings } from '../state/hooks';
import { renderPhotoBlob } from '../export/photo';
import { formatBytes } from '../lib/format';

interface Result {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

const PHOTO_FILENAME = 'edited-photo.jpg';

export function PhotoExportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const quality = useStore((state) => state.photoQuality);
  const provider = usePreviewProvider();
  const settings = useRenderSettings();
  const plan = useFramePlan();
  const source = plan.frames[0]?.source ?? null;
  const [result, setResult] = useState<Result | null>(null);
  const resultRef = useRef<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !provider || !source) return;
    let active = true;
    setError(null);
    setResult((previous) => {
      if (previous) URL.revokeObjectURL(previous.url);
      resultRef.current = null;
      return null;
    });
    void renderPhotoBlob(provider, source, settings, quality)
      .then((output) => {
        if (!active) return;
        const next = { ...output, url: URL.createObjectURL(output.blob) };
        resultRef.current = next;
        setResult(next);
      })
      .catch(() => active && setError('The photo could not be prepared.'));
    return () => {
      active = false;
    };
  }, [open, provider, source, settings, quality]);

  useEffect(
    () => () => {
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      resultRef.current = null;
    },
    [],
  );

  const file = useMemo(
    () => (result ? new File([result.blob], PHOTO_FILENAME, { type: 'image/jpeg' }) : null),
    [result],
  );
  const shareable = file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: 'Edited photo' });
    } catch (shareError) {
      if (!(shareError instanceof DOMException && shareError.name === 'AbortError')) {
        setError('Sharing was not possible here. Use Download instead.');
      }
    }
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy="photo-export-title">
      <h2 id="photo-export-title">Save Photo</h2>
      <p className="sheet-sub">This is the same JPEG shown in the live editor preview.</p>

      {!result && !error && <div className="empty-note">Preparing your photo…</div>}
      {error && <div className="banner" role="alert">{error}</div>}
      {result && (
        <>
          <img className="result-preview" src={result.url} alt="Edited photo export preview" />
          <div className="result-card">
            <div className="result-size">{formatBytes(result.blob.size)}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 2 }}>
              {quality}% quality · {result.width} × {result.height}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
            {shareable && <button type="button" className="cta" onClick={() => void share()}>Save / Share</button>}
            <a
              className="cta"
              href={result.url}
              download={PHOTO_FILENAME}
              style={{
                display: 'grid',
                placeItems: 'center',
                textDecoration: 'none',
                background: shareable ? 'var(--bg-input)' : undefined,
                color: shareable ? 'var(--text)' : undefined,
              }}
            >
              Download .jpg
            </a>
          </div>
        </>
      )}
    </Sheet>
  );
}
