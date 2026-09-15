import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { listProjects, storageEstimate } from '../state/projectsDb';
import type { SavedProjectMeta } from '../state/projects';
import { formatBytesShort, formatDuration } from '../lib/format';
import type { ProjectMode } from '../state/types';

export function ImportScreen({ mode = 'gif' }: { mode?: ProjectMode }) {
  const photoInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);
  const importPhotos = useStore((state) => state.importPhotos);
  const importVideo = useStore((state) => state.importVideo);
  const importPhoto = useStore((state) => state.importPhoto);
  const projectsSupported = useStore((state) => state.projectsSupported);

  return (
    <div className="import">
      <div className="import-hero">
        <h2>{mode === 'photo' ? 'Photo Editor' : 'GIF Maker'}</h2>
        <p>
          {mode === 'photo'
            ? 'Censor and resize a photo, then choose exactly how much quality to keep.'
            : 'From photos or a video clip. Everything happens on your device.'}
        </p>
      </div>

      <button type="button" className="pick" onClick={() => photoInput.current?.click()}>
        <span className="pick-icon" aria-hidden="true">
          🖼️
        </span>
        <span className="grow">
          <span className="pick-title">{mode === 'photo' ? 'Choose a photo' : 'Photos'}</span>
          <span className="pick-sub">
            {mode === 'photo'
              ? 'JPG, PNG, HEIC and other common image formats.'
              : 'Pick one or more. Reorder and time each one.'}
          </span>
        </span>
      </button>

      {mode === 'gif' && <button type="button" className="pick" onClick={() => videoInput.current?.click()}>
        <span className="pick-icon" aria-hidden="true">
          🎬
        </span>
        <span className="grow">
          <span className="pick-title">Video</span>
          <span className="pick-sub">Trim, reframe, set speed and direction.</span>
        </span>
      </button>}

      {projectsSupported && <SavedProjects mode={mode} />}

      <p className="fineprint">
        Photos and videos never leave this device — there is no server and nothing is uploaded.
        Saved projects are kept in this browser's storage on this device only.
      </p>

      {/* `accept` steers the iOS picker; HEIC is included explicitly because
          iOS reports it under several MIME types. */}
      <input
        ref={photoInput}
        type="file"
        accept="image/*,.heic,.heif"
        multiple={mode === 'gif'}
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) {
            if (mode === 'photo') void importPhoto(files[0]);
            else void importPhotos(files);
          }
        }}
      />
      <input
        ref={videoInput}
        type="file"
        accept="video/*,.mov,.mp4,.m4v"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importVideo(file);
        }}
      />
    </div>
  );
}

/**
 * Projects saved on this device, newest first. Opening one re-imports its
 * stored media and restores every edit; deleting asks first, because the
 * media goes with it.
 */
export function SavedProjects({ mode }: { mode: ProjectMode }) {
  const openProject = useStore((state) => state.openProject);
  const deleteProject = useStore((state) => state.deleteProject);
  const [projects, setProjects] = useState<SavedProjectMeta[] | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const refresh = () => {
    listProjects().then(
      (rows) => setProjects(rows.filter((project) => (project.mode ?? 'gif') === mode)),
      () => setProjects([]),
    );
    void storageEstimate().then(setStorage);
  };
  useEffect(refresh, []);

  if (!projects || projects.length === 0) return null;

  return (
    <section className="projects" aria-label="Saved projects">
      <div className="field-label">
        <span>Saved projects</span>
        <span className="value">{projects.length}</span>
      </div>
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          onOpen={() => void openProject(project.id)}
          onDelete={() => {
            if (confirm(`Delete “${project.name}” from this device? Its media goes with it.`)) {
              void deleteProject(project.id).then(refresh);
            }
          }}
        />
      ))}
      {storage && storage.quota > 0 && (
        <div className="hint" style={{ textAlign: 'center' }}>
          Using {formatBytesShort(storage.usage)} of about {formatBytesShort(storage.quota)} available
          to this app.
        </div>
      )}
    </section>
  );
}

function ProjectRow({
  project,
  onOpen,
  onDelete,
}: {
  project: SavedProjectMeta;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!project.thumb) return;
    const url = URL.createObjectURL(project.thumb);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [project.thumb]);

  const what =
    project.kind === 'video'
      ? 'Video'
      : project.mode === 'photo'
        ? 'Edited photo'
        : `${project.photoCount} photo${project.photoCount === 1 ? '' : 's'}`;
  const when = new Date(project.savedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="project-row">
      <button type="button" className="project-open" onClick={onOpen} aria-label={`Open ${project.name}`}>
        <span className="project-thumb" aria-hidden="true">
          {thumbUrl ? <img src={thumbUrl} alt="" /> : project.kind === 'video' ? '🎬' : '🖼️'}
        </span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="pick-title project-name">{project.name}</span>
          <span className="pick-sub">
            {what} · {project.mode === 'photo' ? '' : `${formatDuration(project.durationMs)} · `}
            {formatBytesShort(project.bytes)} · {when}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="icon-only project-delete"
        onClick={onDelete}
        aria-label={`Delete ${project.name}`}
        title="Delete"
      >
        ✕
      </button>
    </div>
  );
}
