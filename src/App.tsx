import { useState } from 'react';
import { useStore } from './state/store';
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
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brandmark" aria-hidden="true" />
        <h1>GIF Maker</h1>
        {step !== 'import' && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              if (confirm('Discard this project and start over?')) {
                setExportOpen(false);
                reset();
              }
            }}
          >
            Start over
          </button>
        )}
      </header>

      {error && (
        <ErrorBanner message={error.message} hint={error.hint} onDismiss={() => setError(null)} />
      )}

      {step === 'import' ? <ImportScreen /> : <EditScreen onExport={() => setExportOpen(true)} />}

      <ExportSheet open={exportOpen} onClose={() => setExportOpen(false)} />
      {busy && <BusyVeil label={busy.label} progress={busy.progress} />}
    </div>
  );
}
