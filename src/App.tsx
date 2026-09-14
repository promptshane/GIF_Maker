import { useState } from 'react';
import { useStore } from './state/store';
import { useFramePlan, useProjectDirty } from './state/hooks';
import { ImportScreen } from './ui/ImportScreen';
import { EditScreen } from './ui/EditScreen';
import { ExportSheet } from './ui/ExportSheet';
import { SaveProjectSheet } from './ui/SaveProjectSheet';
import { BusyVeil, ErrorBanner } from './ui/common';

export default function App() {
  const step = useStore((state) => state.step);
  const busy = useStore((state) => state.busy);
  const error = useStore((state) => state.error);
  const setError = useStore((state) => state.setError);
  const reset = useStore((state) => state.reset);
  const immersive = useStore((state) => state.immersive);
  const projectsSupported = useStore((state) => state.projectsSupported);
  const projectId = useStore((state) => state.projectId);
  const dirty = useProjectDirty();
  const plan = useFramePlan();
  const [exportOpen, setExportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  const editing = step !== 'import';
  // Saved and unchanged reads as a quiet "Saved"; anything else invites a tap.
  const saveLabel = projectId && !dirty ? 'Saved' : 'Save';

  return (
    <div className={`app${immersive ? ' immersive' : ''}`}>
      {/* Hidden in immersive mode so the preview owns the whole screen. */}
      {!immersive && (
        <header className="topbar">
          <span className="brandmark" aria-hidden="true" />
          <h1>GIF Maker</h1>
          {editing && (
            <>
              {projectsSupported && (
                <button
                  type="button"
                  className={`topbar-save${projectId && !dirty ? ' saved' : ''}${dirty ? ' dirty' : ''}`}
                  onClick={() => setSaveOpen(true)}
                  disabled={plan.frames.length === 0}
                  aria-label={dirty ? 'Save project (unsaved changes)' : 'Save project'}
                >
                  {saveLabel}
                </button>
              )}
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
                  const prompt = dirty
                    ? 'This project has unsaved changes. Discard them and start over?'
                    : projectId
                      ? 'Close this project and start over? It stays saved on this device.'
                      : 'Discard this project and start over?';
                  if (confirm(prompt)) {
                    setExportOpen(false);
                    setSaveOpen(false);
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
      <SaveProjectSheet open={saveOpen} onClose={() => setSaveOpen(false)} />
      {busy && <BusyVeil label={busy.label} progress={busy.progress} />}
    </div>
  );
}
