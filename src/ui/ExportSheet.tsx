import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './common';
import { useStore } from '../state/store';
import { useFramePlan } from '../state/hooks';
import { QUALITY_ORDER, QUALITY_PROFILES } from '../export/quality';
import { formatBytes, formatBytesShort, formatDuration } from '../lib/format';

type ShareState = { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'saved' };

const GIF_FILENAME = 'gif-maker.gif';

/** iOS shows the share sheet (with "Save Image") only when files can be shared. */
function canShareFile(file: File): boolean {
  return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

export function ExportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const quality = useStore((state) => state.quality);
  const setQuality = useStore((state) => state.setQuality);
  const generate = useStore((state) => state.generate);
  const cancelExport = useStore((state) => state.cancelExport);
  const runEstimate = useStore((state) => state.runEstimate);
  const clearResult = useStore((state) => state.clearResult);
  const exporting = useStore((state) => state.exporting);
  const estimating = useStore((state) => state.estimating);
  const estimate = useStore((state) => state.estimate);
  const progress = useStore((state) => state.progress);
  const result = useStore((state) => state.result);
  const plan = useFramePlan();
  const canvas = useStore((state) => state.canvas);

  const [share, setShare] = useState<ShareState>({ kind: 'idle' });

  useEffect(() => {
    if (!open) setShare({ kind: 'idle' });
  }, [open]);

  const file = useMemo(
    () => (result ? new File([result.blob], GIF_FILENAME, { type: 'image/gif' }) : null),
    [result],
  );
  const shareable = file ? canShareFile(file) : false;

  const onShare = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: 'GIF' });
      setShare({ kind: 'saved' });
    } catch (error) {
      // The user dismissing the share sheet is not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShare({
        kind: 'error',
        message: 'Sharing was not possible here. Use Download, or press and hold the GIF above.',
      });
    }
  };

  const percent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <Sheet open={open} onClose={onClose} labelledBy="export-title">
      <h2 id="export-title">{result ? 'Your GIF' : 'Export GIF'}</h2>
      <p className="sheet-sub">
        {result
          ? 'Save it to Photos, or try another quality.'
          : `${plan.frames.length} frames · ${canvas.width}×${canvas.height} · ${formatDuration(plan.durationMs)}`}
      </p>

      {result ? (
        <>
          <img className="result-preview" src={result.url} alt="Exported GIF preview" />
          <div className="result-card">
            <div className="result-size">{formatBytes(result.bytes)}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 2 }}>
              {QUALITY_PROFILES[result.quality].label} quality
            </div>
            <div className="result-grid">
              <div>
                <div className="k">Resolution</div>
                <div className="v">
                  {result.width} × {result.height}
                </div>
              </div>
              <div>
                <div className="k">Frame rate</div>
                <div className="v">{result.fps} FPS</div>
              </div>
              <div>
                <div className="k">Duration</div>
                <div className="v">{formatDuration(result.durationMs)}</div>
              </div>
              <div>
                <div className="k">Frames</div>
                <div className="v">{result.frameCount}</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
            {shareable && (
              <button type="button" className="cta" onClick={onShare}>
                Save / Share
              </button>
            )}
            <a
              className="cta"
              href={result.url}
              download={GIF_FILENAME}
              style={{
                display: 'grid',
                placeItems: 'center',
                textDecoration: 'none',
                background: shareable ? 'var(--bg-input)' : undefined,
                color: shareable ? 'var(--text)' : undefined,
              }}
            >
              Download .gif
            </a>
            <button
              type="button"
              className="ghost-btn"
              style={{ minHeight: 44 }}
              onClick={() => {
                clearResult();
                setShare({ kind: 'idle' });
              }}
            >
              Change quality and regenerate
            </button>
          </div>

          {share.kind === 'error' && <div className="hint" style={{ color: 'var(--danger)' }}>{share.message}</div>}
          <div className="hint">
            On iPhone: tap <strong>Save / Share</strong> then <strong>Save Image</strong> to put the
            animated GIF in Photos. You can also press and hold the GIF above and choose{' '}
            <strong>Add to Photos</strong>.
          </div>
        </>
      ) : (
        <>
          <div className="quality-list">
            {QUALITY_ORDER.map((level) => {
              const profile = QUALITY_PROFILES[level];
              return (
                <button
                  key={level}
                  type="button"
                  className="quality-opt"
                  aria-pressed={quality === level}
                  onClick={() => setQuality(level)}
                >
                  <div className="grow">
                    <div className="q-name">{profile.label}</div>
                    <div className="q-blurb">{profile.blurb}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {plan.truncated && (
            <div className="hint" style={{ color: 'var(--danger)' }}>
              This timeline is longer than one GIF can hold and has been cut short. Lower the frame
              rate, shorten the clip, or speed it up to fit it all in.
            </div>
          )}

          <div className="hint">
            Quality changes colours and compression only. Your size, frame rate, duration and crop
            stay exactly as you set them.
          </div>

          <div style={{ marginTop: 14 }}>
            {estimate ? (
              <div className="hint" style={{ marginTop: 0 }}>
                Estimated size:{' '}
                <strong style={{ color: 'var(--text)' }}>
                  {formatBytesShort(estimate.lowBytes)} – {formatBytesShort(estimate.highBytes)}
                </strong>{' '}
                (measured by encoding {estimate.sampledFrames} of {estimate.totalFrames} frames).
              </div>
            ) : (
              <button
                type="button"
                className="ghost-btn"
                style={{ minHeight: 44, width: '100%' }}
                disabled={estimating || exporting}
                onClick={() => void runEstimate()}
              >
                {estimating ? 'Estimating…' : 'Estimate size first'}
              </button>
            )}
          </div>

          {exporting && (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="hint" style={{ marginTop: 0 }}>
                  {progress?.phase === 'finishing'
                    ? 'Writing the GIF…'
                    : `Rendering frame ${progress?.done ?? 0} of ${progress?.total ?? 0}…`}
                </span>
                <button
                  type="button"
                  className="ghost-btn"
                  style={{ flex: 'none' }}
                  onClick={cancelExport}
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          <button
            type="button"
            className="cta"
            style={{ marginTop: 14 }}
            disabled={exporting || plan.frames.length === 0}
            onClick={() => void generate()}
          >
            {exporting ? 'Generating…' : 'Generate GIF'}
          </button>
        </>
      )}
    </Sheet>
  );
}
