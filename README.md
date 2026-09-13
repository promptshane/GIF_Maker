# GIF Maker

**Live: <https://promptshane.github.io/GIF_Maker/>**

A personal, install-to-home-screen GIF maker for iPhone. Import photos or a
video, edit, preview, pick a quality, generate a real `.gif`, see its exact size,
and save it to Photos.

Everything runs in the browser. There is no backend, no account, and no upload —
media never leaves the device.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (also served on your LAN)
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server, exposed on the local network so you can open it on a phone |
| `npm run build` | Type-check and produce a static bundle in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Type-check the app and the tests |
| `npm test` | Unit tests (Vitest, Node) |
| `npm run test:e2e` | Browser tests (Playwright: WebKit at iPhone size, plus Chromium) |
| `npm run qr -- <url>` | Print a scannable QR code for any URL (e.g. the deployed site) |
| `npm run fixtures` | Regenerate the test media with ffmpeg |
| `npm run icons` | Regenerate the PWA icons |

### Trying it on your phone during development

`npm run dev` binds to `0.0.0.0` and prints a **QR code** for its LAN address —
scan it with the iPhone Camera app while both devices are on the same Wi-Fi. The
QR uses Vite's own resolved URL, so it stays correct whatever port the server
ends up on.

One caveat: **the Web Share API and the service worker need a secure context.**
`http://` on a LAN IP is not one, so on a plain dev URL:

- the **Save / Share** button is hidden (the iOS share sheet is unavailable), and
- there is no service worker, so no offline support and no real installation.

Saving still works via **press and hold the GIF → Add to Photos**, and everything
else behaves normally — it is fine for trying the editor, but not the full app.

For the complete experience, deploy over HTTPS (below) and QR that URL instead:

```bash
npm run qr -- https://<your-site>/
```

To test sharing and installation *before* deploying, put the dev server behind an
HTTPS tunnel (`cloudflared tunnel --url http://localhost:5173`, `ngrok http
5173`, or similar) and open the `https://` address.

---

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Build | **Vite 8** + TypeScript | Fast, first-class Web Worker and code-splitting support, static output |
| UI | **React 19** | Small surface here; the app is mostly canvas work |
| State | **zustand** | ~1KB, no provider tree, and the store is plain functions that are easy to test |
| GIF encoding | **[gifenc](https://github.com/mattdesl/gifenc)** | Genuinely fast pure-JS quantiser + LZW writer, no wasm, no worker assumptions, MIT |
| HEIC fallback | **[heic-to](https://github.com/hoppergee/heic-to)** (lazy) | libheif-in-wasm, only downloaded if a browser refuses a HEIC file |
| PWA | **vite-plugin-pwa** (Workbox) | Manifest generation and a precached app shell |
| Tests | **Vitest** + **Playwright** + **ffmpeg** | Logic in Node, real workflows in a real browser, output verified by decoding the actual GIF |

Runtime dependencies total four packages. There is no CSS framework — the
stylesheet is ~700 lines of hand-written CSS with design tokens.

### Why these media libraries

**gifenc for encoding.** The realistic options were `gif.js` (old, worker-bound,
NeuQuant), `modern-gif`, and `gifenc`. gifenc won on speed and on being a
*library* rather than a framework: it exposes `quantize`, `applyPalette` and a
`GIFEncoder` that writes frames one at a time, which is exactly the shape needed
for streaming frames out of a phone's memory. What it does *not* provide —
dithering, inter-frame delta compression — is implemented here in
[`src/export/gifCore.ts`](src/export/gifCore.ts), which is what makes the quality
presets mean something.

**No ffmpeg.wasm.** It would add ~25MB and a memory profile that iOS Safari
handles badly, to do a job the browser's own video decoder already does. Frames
are read by seeking a `<video>` element instead. ffmpeg *is* used, but only on
the developer machine, to build test fixtures and to verify exported GIFs.

**No WebCodecs.** `VideoDecoder` needs a separate MP4/MOV demuxer, and iOS
Safari's support is uneven across the container/codec combinations the Photos app
produces. Seeking is deterministic, needs no user gesture, and works on anything
the browser can play at all — which is the same bar the app already sets.

**heic-to, lazily.** Safari on iOS and macOS decodes HEIC natively, so on the
target device this never loads. It is a ~3MB chunk fetched only when an `<img>`
refuses a `.heic` file (i.e. on Chrome/Firefox desktop), and it is deliberately
excluded from the service worker's install-time precache.

---

## Architecture

```
src/
├── state/        types, zustand store, memoised selectors, local preferences
├── media/        import + decode: photos, HEIC, video seeking, frame caches
├── render/       geometry, the frame plan (timeline), the canvas compositor
├── export/       quality presets, GIF encoder core, worker, orchestration
├── ui/           screens, panels, gestures, preview player
└── types/        ambient declarations for gifenc
```

### The frame plan

Everything downstream is driven by one pure function per source type in
[`src/render/timeline.ts`](src/render/timeline.ts). It turns the project into a
list of `{ timeMs, delayMs, source }` frames:

- **Photos** are sampled on the frame-rate grid but *snapped to each photo's
  exact boundary*, so a 0.35s photo stays 0.35s even at 10 FPS. The extra
  in-photo samples exist so timed stickers and keyframed censors can animate;
  `mergeStaticFrames` then collapses runs that are provably identical, so a
  five-photo slideshow encodes as five GIF frames rather than seventy-five.
- **Video** maps output frames back onto source timestamps. Speed scales the
  source advance per frame; direction chooses the traversal order.
- **Boomerang** emits the forward pass then the reverse pass with *both*
  endpoints dropped. Keeping them would show the first and last frames twice in
  a row, which reads as a stutter at the turnaround and again at the loop point.

The plan is pure and heavily unit-tested, and the preview and the exporter both
consume it — so what loops on screen is the same sequence that gets encoded.

### Preview vs. export

They share [`composeFrame`](src/render/compose.ts). The only differences are
resolution and where the source pixels come from:

- **Preview** plays from a cache of decoded, downscaled video frames
  (`VideoPreviewCache`). Seeking a `<video>` costs tens to hundreds of
  milliseconds per frame, which cannot drive a live preview. The cache covers the
  *trim range* at a fixed density, so changing frame rate, speed, direction,
  crop, canvas size, stickers or censors needs **no rebuild** — only a trim
  change does. Its size adapts to a memory budget (frames are dropped before
  resolution is reduced).
- **Export** seeks the real video at full output resolution, one frame at a
  time, handing each to the encoder and releasing it immediately. Peak memory is
  a handful of frames, not the whole animation.

The preview canvas is capped at a 640px long edge. Every element of the render is
proportional to canvas size, so it stays a faithful scaled copy.

### Censor regions

Blur radius and pixel block size are set by the **strength** slider as a
fraction of the canvas's shorter side — never of the region. Resizing a region
to cover more of a face does not also make its blur softer or its blocks
coarser, and the preview and the export agree because both scale with their own
canvas.

Pixelation averages each block properly. A single `drawImage` that shrinks by a
large factor point-samples in WebKit, which would give each block the colour of
one source pixel — visibly shimmering on video. The region is instead shrunk to
`blocks × 2ᵏ` and then halved `k` times, so every step is a grid-aligned 2×2
average and every block is the true mean of its own pixels.

Position and size can be adjusted from the panel as well as by dragging: a
nudge pad moves the region 1% of the canvas per tap (hold to repeat), and ±
steppers do the same for width and height. Only the selected region draws an
outline; deselect it and the stage shows exactly what the GIF will contain.

### Crop

The crop rectangle lives in normalised source space and is locked to the output
aspect. Two functions keep it honest:

- `normaliseCrop` is for edits *at* the current aspect: width is authoritative,
  height follows, and the centre is preserved. The renderer runs it again
  against whatever image it is drawing, so a project of mixed-aspect photos can
  never stretch.
- `refitCrop` is for when the output aspect *changes*: the smallest rectangle
  of the new aspect that contains everything the old one showed, then shrunk
  only if it overflows the source. Width-authoritative refitting can only ever
  shrink, and a few preset changes used to ratchet the crop into a tight zoom
  that nothing but Reset could undo.

The reframe editor has a handle on each corner; dragging one resizes against
the opposite corner, which stays put. Typed output sizes commit on blur/Enter,
and a locked aspect scales the pair into range together — applying "7" on the
way to "720" used to clamp both sides to the 16px minimum and quietly make the
output square.

**Trimming does not rebuild the cache.** Dragging a trim handle shows the exact
frame under it, decoded straight from the video with latest-wins seeking (a new
target replaces the pending one rather than queueing behind it). The cache only
covers the *current* trim range, so it could not show where a new trim point
lands anyway. Rebuilding is deferred until playback actually needs it — otherwise
every nudge of a handle blocks on a decode pass and fine-tuning is impossible.

### Encoding

[`src/export/gifCore.ts`](src/export/gifCore.ts) implements a streaming writer on
top of gifenc:

1. **One shared palette** for the whole animation, derived from frames sampled
   across the *entire* timeline (rendered cheaply from the preview cache, so it
   costs no extra seeks). This is what `ffmpeg`'s `palettegen` does for GIF, and
   it is also what makes step 3 work.
2. **A precomputed nearest-colour lookup table.** Built once per palette, so
   every pixel mapping — dithered or not — is a single array read. This was the
   difference between ~900ms and ~12ms per frame.
3. **Inter-frame delta compression.** Pixels matching what is already on screen
   are written as the transparent index with disposal *"do not dispose"*, so the
   previous frame shows through. Runs of one index compress extremely well under
   LZW. The comparison is against the accumulated *displayed* buffer, not the
   previous ideal frame, so nothing drifts over a long animation.
4. **Floyd–Steinberg dithering** with a serpentine scan (gifenc has none of its
   own), applied at a per-preset strength.

Encoding runs in a module Web Worker
([`gif.worker.ts`](src/export/gif.worker.ts)) with an ack-per-frame protocol that
applies backpressure, so the main thread never renders more than two frames ahead
of the encoder and the UI keeps painting. If workers are unavailable the same
code runs in-process, yielding to the event loop between frames.

### Quality presets

The presets change **colour and compression only**. Dimensions, frame rate,
duration and crop are never touched.

| Preset | Palette | Dithering | Unchanged-pixel tolerance |
| --- | --- | --- | --- |
| Low | 48 colours | off | loose |
| Medium | 96 colours | 0.55 | moderate |
| High | 192 colours | 0.85 | exact only |
| Extra High | 255 colours | 1.0 | exact only |

### Estimated size

The estimate is a real measurement, not a formula: a contiguous run of about
seven frames is genuinely encoded with the exact settings that will be used, the
one-off first-frame cost is separated from the per-frame delta cost, and the rest
is extrapolated. It is presented as a range because content later in the clip can
compress differently. There is no target-size feature and none is planned.

---

## Deploying

This repo already deploys itself. Pushing to `main` runs
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
type-checks, runs the unit suite, builds, and publishes to GitHub Pages at
<https://promptshane.github.io/GIF_Maker/>.

To deploy somewhere else, the build is fully static — `dist/` can go on any host:

```bash
npm run build                      # relative base: works in any subdirectory
BASE_PATH=/my-sub-path/ npm run build   # absolute base, if a host needs one
```

| Host | How |
| --- | --- |
| **GitHub Pages** | Already wired up. The workflow sets `BASE_PATH=/<repo>/` because a project site is served from a subdirectory |
| **Netlify** | Drag `dist/` onto the dashboard, or connect the repo with build `npm run build` and publish directory `dist` |
| **Vercel** | Import the repo; the Vite preset is detected |
| **Cloudflare Pages** | Build `npm run build`, output `dist` |
| **Anything else** | Copy `dist/`. Configure the server to fall back to `index.html` for unknown paths |

`base` defaults to `'./'` so the build works from any subdirectory without
configuration. GitHub Pages gets an explicit absolute base instead, which keeps
the service worker's scope and the manifest's `start_url` unambiguous.

**HTTPS is required** for the service worker, installation, and the iOS share
sheet. Every host above provides it.

---

## Putting it on your iPhone

Scan this, or run `npm run qr -- https://promptshane.github.io/GIF_Maker/` to
print it in the terminal:

```
https://promptshane.github.io/GIF_Maker/
```

1. Open that URL in **Safari** (not Chrome — only Safari can install to the Home
   Screen on iOS).
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Launch it from the Home Screen. It opens standalone, without Safari's
   chrome, and uses the full screen including the area around the notch.

The app shell is precached, so it opens and the editor works with no network.
(Media is always local anyway.)

### Saving a GIF to Photos

After **Generate GIF**:

- **Save / Share** opens the iOS share sheet via the Web Share API. Choose
  **Save Image** and the animated GIF lands in Photos, animation intact.
- **Download .gif** saves through Safari's downloads (Files app) — useful on
  desktop, and the fallback wherever file sharing is unavailable.
- **Press and hold the GIF shown in the sheet** and choose **Add to Photos**.
  This works even when the Web Share API does not.

The share button only appears when the browser reports it can actually share the
file (`navigator.canShare({ files })`), so it is never a dead button. The
download link is always present.

---

## Browser limitations worth knowing

These are properties of the platform, handled explicitly rather than hidden:

- **GIF cannot play faster than 50 FPS.** Frame delays are stored in
  centiseconds, and every mainstream browser rewrites a delay of 0 or 1cs to
  10cs for compatibility with very old files. 2cs (20ms) is the shortest delay
  that plays as written. The frame-rate control therefore tops out at 50 rather
  than offering a 60 that would silently play 20% slow; a 60 remembered from an
  earlier build is mapped down to 50 on load.
- **Frame rates that do not divide 100 jitter slightly.** 24 FPS is 41.67ms,
  which is not a whole number of centiseconds. Delays are rounded with the error
  carried forward, so the *average* rate and the total duration stay correct.
- **Canvas blur filters need Safari 18+.** `CanvasRenderingContext2D.filter`
  arrived in Safari 18.0. It is feature-detected; older WebKit falls back to a
  three-pass downscale/upscale blur, which looks close and uses only universally
  supported APIs.
- **Video codecs are the browser's, not ours.** iPhone `.mov`/`.mp4` (H.264 and
  HEVC) plays in Safari. Some codecs — AV1, certain HEVC profiles — are not
  decodable everywhere; the app reports which file failed and why instead of
  producing an empty GIF.
- **HEIC** decodes natively in Safari. Elsewhere the wasm converter is fetched on
  demand; if that also fails you are told to re-save as JPEG.
- **Memory.** Imported photos are downscaled to a 2048px long edge (a 12MP iPhone
  photo is ~48MB decoded, and a dozen would crash mobile Safari). Output is
  capped at 2048px, presets cap at 720px, and timelines are capped at 1500
  frames — when a timeline is cut short the UI says so rather than silently
  dropping the end.
- **Video exports are seek-bound, not encode-bound.** Reading a frame means
  seeking the `<video>` element, which the browser does at its own pace — on a
  desktop that is roughly 130ms per frame against ~35ms to encode one. A
  120-frame export therefore takes tens of seconds, more on a phone, and the
  progress bar counts real frames so you can see where it is. Photo GIFs have no
  seeking and export almost instantly. There is a **Cancel** button throughout.
- **Web Share** needs a secure context and a browser that accepts files. The
  download and long-press paths are always available.
- **Nothing is persisted but preferences.** Frame rate, quality, output
  dimensions, framing mode, background and the default photo duration are kept in
  `localStorage`. Per-clip *edits* — trim, direction, speed, crop, stickers,
  censor regions — deliberately are not, so every new project starts clean.
  Imported media is held in memory for the session and released on "Start over"
  or when the tab closes.
- **Full screen is an in-app mode, not the Fullscreen API.** iOS Safari only
  grants native fullscreen to `<video>` elements, so the expand button hides
  every piece of chrome instead. That behaves identically in the installed PWA,
  where there is no browser UI to escape anyway.

---

## Testing

```bash
npm test          # unit
npm run test:e2e  # browser (builds first, runs WebKit at iPhone 13 size + Chromium)
```

The e2e suite drives the real UI in a real browser and then **decodes the GIF it
produced with ffprobe/ffmpeg**, so assertions are about the actual file, not about
what the interface claims. Covered:

| Suite | What it proves |
| --- | --- |
| `photos.spec.ts` | Import, reorder, duplicate, delete, per-photo durations, "apply to all", export. Asserts the encoded Graphic Control Extension delays are exactly `[1500, 300]` for a 1.5s + 0.3s pair, and that a corrupt file is reported rather than swallowed |
| `video.spec.ts` | Trim by dragging, speed, frame rate (real frame counts), 50 FPS being the top of the control, cropping changing the exported pixels while leaving dimensions alone with the opposite corner pinned, a preset round-trip leaving the crop exactly where it was, and a typed width keeping the locked aspect |
| `direction.spec.ts` | Forward/reverse traversal verified by tracking the moving block across every decoded frame; boomerang produces exactly `2N-2` frames, peaks in the middle, and repeats no frame at the turnaround or the loop point |
| `overlays.spec.ts` | An emoji reaching the exported pixels, moving when dragged, and a time-ranged emoji appearing in only part of the GIF. Blur and pixelate each introducing colours that do not exist in the source, differing from one another, and responding to the strength control |
| `censor-keyframes.spec.ts` | A region with two keyframes tracking a moving subject, verified at the start, middle and end of the clip |
| `censor-editing.spec.ts` | Nudge moving a region by exactly one step in each direction, steppers resizing one side about the centre, deselecting hiding every outline, and the measured pixel block size staying put when the region doubles |
| `quality.spec.ts` | Four presets producing four different files in ascending size, with identical dimensions/frames; the displayed MB matching the real byte count; and the pre-encode estimate bracketing the true size |
| `mobile.spec.ts` | No horizontal overflow and no page scroll at iPhone size across every panel, 44px touch targets, touch drag editing, and the PWA manifest, icons, iOS meta tags and service worker |

Unit tests cover the frame plan (durations, merging, direction, speed, frame
rate, centisecond rounding, truncation), censor keyframe interpolation, censor
strength mapping, crop and placement geometry (including the aspect-change
round trip and locked-aspect sizing), and the encoder itself — including an ffmpeg round-trip that
decodes each quality level and checks the pixels land where they should.

Test fixtures are generated by ffmpeg (`npm run fixtures`) and are not committed.
The e2e suite picks H.264 or VP9 depending on what the browser under test can
decode, since Playwright's open-source builds ship without proprietary codecs.

---

## Deliberately not in V1

- **Enhanced FPS / frame interpolation.** Choosing a frame rate above the source
  resamples existing frames; it does not invent intermediate motion, and the app
  never claims otherwise. The seam for adding it is `buildVideoPlan` in
  `timeline.ts`: it maps output frames to source *timestamps*, so an
  interpolating frame provider could satisfy a request for a timestamp between
  two real frames without any other part of the app changing.
- **Subject cutout / background removal.** Not started — no placeholder UI, no
  dead code. It would slot in as a stage in `composeFrame`, between drawing the
  source and drawing the censors.
- **Automatic object tracking** for censor regions. Manual keyframes with linear
  interpolation are implemented and reliable; tracking would replace how
  keyframes are produced, not how they are used.
- **Target file size** ("make this under 5 MB"). Explicitly out of scope: size is
  a result of duration, dimensions, frame rate, content and quality.
