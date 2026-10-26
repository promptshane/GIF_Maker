/** Detect faces in the displayed image, never uploading photo pixels.
 * The MediaPipe runtime and model are fetched on demand, only when requested. */
export interface DetectedFace { x: number; y: number; w: number; h: number }

const VERSION = '1.1.1';
const ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

type Box = { originX: number; originY: number; width: number; height: number };
interface Detector {
  detect: (image: HTMLCanvasElement) => { detections: Array<{ boundingBox?: Box }> };
  close: () => void;
}
interface FaceVisionModule {
  FilesetResolver: {
    forVisionTasks: (path: string) => Promise<unknown>;
  };
  FaceDetector: {
    createFromOptions: (files: unknown, options: unknown) => Promise<Detector>;
  };
}

export async function detectFaces(image: HTMLCanvasElement): Promise<DetectedFace[]> {
  if (!image.width || !image.height) return [];
  // Version-pinned URLs preserve a stable runtime/model combination. Vite
  // intentionally leaves this optional module out of the normal app bundle.
  const moduleUrl = `${ROOT}/vision_bundle.mjs`;
  const vision = await import(/* @vite-ignore */ moduleUrl) as FaceVisionModule;
  const files = await vision.FilesetResolver.forVisionTasks(`${ROOT}/wasm`);
  const detector = await vision.FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.5,
  });
  try {
    return detector.detect(image).detections.flatMap(({ boundingBox }) => {
      if (!boundingBox) return [];
      const { originX, originY, width, height } = boundingBox;
      if (!(width > 0 && height > 0)) return [];
      return [{
        x: (originX + width / 2) / image.width,
        y: (originY + height / 2) / image.height,
        w: width / image.width,
        h: height / image.height,
      }];
    });
  } finally {
    detector.close();
  }
}
