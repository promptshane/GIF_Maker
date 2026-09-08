import { useRef } from 'react';
import { useStore } from '../state/store';

export function ImportScreen() {
  const photoInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);
  const importPhotos = useStore((state) => state.importPhotos);
  const importVideo = useStore((state) => state.importVideo);

  return (
    <div className="import">
      <div className="import-hero">
        <h2>Make a GIF</h2>
        <p>From photos or a video clip. Everything happens on your device.</p>
      </div>

      <button type="button" className="pick" onClick={() => photoInput.current?.click()}>
        <span className="pick-icon" aria-hidden="true">
          🖼️
        </span>
        <span className="grow">
          <span className="pick-title">Photos</span>
          <span className="pick-sub">Pick one or more. Reorder and time each one.</span>
        </span>
      </button>

      <button type="button" className="pick" onClick={() => videoInput.current?.click()}>
        <span className="pick-icon" aria-hidden="true">
          🎬
        </span>
        <span className="grow">
          <span className="pick-title">Video</span>
          <span className="pick-sub">Trim, reframe, set speed and direction.</span>
        </span>
      </button>

      <p className="fineprint">
        Photos and videos never leave this device — there is no server and nothing is uploaded.
        Imported media is held in memory for this session only.
      </p>

      {/* `accept` steers the iOS picker; HEIC is included explicitly because
          iOS reports it under several MIME types. */}
      <input
        ref={photoInput}
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
