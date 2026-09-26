import { useRef } from 'react';
import { useStore } from '../state/store';

/** The app's front door: choose a workflow before picking media. */
export function ModeSelectScreen({ onEditVideo }: { onEditVideo: () => void }) {
  const gifPhotos = useRef<HTMLInputElement | null>(null);
  const gifVideo = useRef<HTMLInputElement | null>(null);
  const setAppMode = useStore((state) => state.setAppMode);
  const importPhotos = useStore((state) => state.importPhotos);
  const importVideo = useStore((state) => state.importVideo);

  return (
    <div className="import mode-select">
      <div className="import-hero">
        <div className="hero-mark" aria-hidden="true">✦</div>
        <h2>GIF Maker + Editors</h2>
        <p>Choose what you want to make. Your media stays on this device.</p>
      </div>

      <button type="button" className="mode-card photo" onClick={() => setAppMode('photo')}>
        <span className="mode-card-icon" aria-hidden="true">◫</span>
        <span className="grow">
          <span className="mode-card-title">Edit Photo</span>
          <span className="mode-card-sub">Censor, resize and control export quality.</span>
        </span>
        <span className="mode-arrow" aria-hidden="true">›</span>
      </button>

      <button type="button" className="mode-card video" onClick={onEditVideo}>
        <span className="mode-card-icon" aria-hidden="true">▦</span>
        <span className="grow">
          <span className="mode-card-title">Edit Video</span>
          <span className="mode-card-sub">Extract every frame, edit them with AI, then compare playback.</span>
        </span>
        <span className="mode-arrow" aria-hidden="true">›</span>
      </button>

      <button type="button" className="mode-card gif" onClick={() => setAppMode('gif')}>
        <span className="mode-card-icon" aria-hidden="true">▶</span>
        <span className="grow">
          <span className="mode-card-title">Create GIF</span>
          <span className="mode-card-sub">Turn photos or video into an animated GIF.</span>
        </span>
        <span className="mode-arrow" aria-hidden="true">›</span>
      </button>

      <p className="fineprint">Private by design — nothing is uploaded.</p>

      {/* Kept on the chooser so existing shortcuts and automated workflows can
          still send photos directly into the GIF editor. */}
      <input
        ref={gifPhotos}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void importPhotos(files);
        }}
      />
      <input
        ref={gifVideo}
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
