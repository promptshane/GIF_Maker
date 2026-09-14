import { useEffect, useState } from 'react';
import { Sheet } from './common';
import { useStore } from '../state/store';
import { defaultProjectName } from '../state/projects';

/**
 * Names and saves the current project to this device. Saving an already
 * saved project overwrites it in place, so the name field doubles as rename.
 */
export function SaveProjectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projectName = useStore((state) => state.projectName);
  const kind = useStore((state) => state.kind);
  const photos = useStore((state) => state.photos);
  const video = useStore((state) => state.video);
  const saveProject = useStore((state) => state.saveProject);
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) setName(projectName ?? defaultProjectName({ kind, photos, video }));
  }, [open, projectName, kind, photos, video]);

  const submit = async () => {
    onClose();
    await saveProject(name);
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy="save-title">
      <h2 id="save-title">{projectName ? 'Save changes' : 'Save project'}</h2>
      <p className="sheet-sub">
        Kept on this device only, with the original media and every edit, so you can come back to
        it later. Nothing is uploaded.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          value={name}
          aria-label="Project name"
          placeholder="Project name"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        <button type="submit" className="cta" style={{ marginTop: 14 }}>
          {projectName ? 'Save changes' : 'Save'}
        </button>
      </form>
      <div className="hint">
        Saved projects appear on the home screen. They live in this browser's storage, so
        clearing website data removes them — the exported GIF is the safe copy.
      </div>
    </Sheet>
  );
}
