import { useState } from 'react';
import { useStore } from './state/store';
import { useFramePlan } from './state/hooks';
import { ImportScreen } from './ui/ImportScreen';
import { EditScreen } from './ui/EditScreen';
import { ExportSheet } from './ui/ExportSheet';
import { BusyVeil, ErrorBanner } from './ui/common';

export default function App() {
  const step = useStore((state) => state.step);
  const busy = useStore((state) => state.busy);
  const error = useStore((state) => state.error);
  const setError = useStore((state) => state.setError);
  const reset = useStore((state) => state.reset);
  const immersive = useStore((state) => state.immersive);
  const plan = useFramePlan();
  const [exportOpen, setExportOpen] = useState(false);

  const editing = step !== 'import';

  return (
    <div className={`app${immersive ? ' immersive' : ''}`}>
      {/* Hidden in immersive mode so the preview owns the whole screen. */}
      {!immersive && (
        <header className="topbar">
          <span className="brandmark" aria-hidden="true" />
          <h1>GIF Maker</h1>
          {editing && (
            <>
              <button
                type="button"
                className="topbar-cta"
                onClick={() => setExportOpen(true)}
                disabled={plan.frames.length === 0}
              >
                Export GIF
              </button>
              <button
                type="button"
                className="icon-only"
                aria-label="Start over"
                title="Start over"
                onClick={() => {
                  if (confirm('Discard this project and start over?')) {
                    setExportOpen(false);
                    reset();
                  }
                }}
              >
                ↺
              </button>
            </>
          )}
        </header>
      )}

      {error && (
        <ErrorBanner message={error.message} hint={error.hint} onDismiss={() => setError(null)} />
      )}

      {step === 'import' ? <ImportScreen /> : <EditScreen />}

      <ExportSheet open={exportOpen} onClose={() => setExportOpen(false)} />
      {busy && <BusyVeil label={busy.label} progress={busy.progress} />}
    </div>
  );
}
