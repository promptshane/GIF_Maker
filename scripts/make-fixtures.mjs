/**
 * Generates the media the e2e suite imports. Uses ffmpeg so the fixtures are
 * real encoded files (H.264 in MP4, baseline JPEG, PNG) rather than synthetic
 * blobs the browser might treat differently.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
mkdirSync(DIR, { recursive: true });

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error(
    'ffmpeg is required to build the test fixtures (and ffprobe to verify exported GIFs).\n' +
      'Install it with `brew install ffmpeg`, then re-run this command.',
  );
  process.exit(1);
}

const run = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);

// Three photos with distinct dominant colours and different aspect ratios, so
// reordering and per-photo timing are visible in the exported GIF.
const photos = [
  ['photo-red.jpg', '640x480', 'red'],
  ['photo-green.jpg', '480x640', 'green'],
  ['photo-blue.png', '512x512', 'blue'],
];
for (const [name, size, color] of photos) {
  const out = join(DIR, name);
  if (existsSync(out)) continue;
  run(['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1`,
       '-vf', `drawbox=x=40:y=40:w=120:h=120:color=white@1:t=fill`,
       '-frames:v', '1', out]);
}

// A 4 second 640x360 clip: an orange block sweeps left to right over a dark
// background, with a static white marker top-left for orientation. Trim,
// direction, speed and crop changes are all observable in the decoded pixels.
//
// The block is composited with `overlay` rather than `drawbox` because
// drawbox's expression context has no frame-time variable, so an animated
// x position silently renders nothing there.
const video = join(DIR, 'clip.mp4');
if (!existsSync(video)) {
  run([
    '-f', 'lavfi', '-i', 'color=c=0x202040:s=640x360:d=4:r=30',
    '-f', 'lavfi', '-i', 'color=c=0xFF8800:s=80x80:d=4:r=30',
    '-filter_complex',
    '[0][1]overlay=x=40+t*130:y=140,drawbox=x=20:y=20:w=60:h=30:color=0xFFFFFF@1:t=fill',
    '-frames:v', '120',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-movflags', '+faststart',
    video,
  ]);
}

console.log('fixtures ready in', DIR);

// Playwright's open-source Chromium and WebKit builds ship without the
// proprietary H.264 decoder, so the e2e suite also needs a royalty-free clip.
// The app itself is codec-agnostic: it uses whatever the browser can play.
const webm = join(DIR, 'clip.webm');
if (!existsSync(webm)) {
  run(['-i', video, '-c:v', 'libvpx-vp9', '-b:v', '400k', '-pix_fmt', 'yuv420p', '-an', webm]);
}
console.log('webm fixture ready');
