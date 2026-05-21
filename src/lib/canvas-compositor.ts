import { CameraSize, LayoutMode } from '../types';

const SIZE_MULTIPLIERS: Record<CameraSize, number> = {
  small: 0.18,
  medium: 0.25,
  large: 0.32,
};

const PIP_MARGIN = 24;
const PIP_BORDER_COLOR = '#8b5cf6';
const PIP_BORDER_WIDTH = 3;
const PIP_RADIUS = 12;

type Segmenter = {
  segmentForVideo: (video: HTMLVideoElement, ts: number) => {
    categoryMask?: { getAsUint8Array: () => Uint8Array; width: number; height: number; close?: () => void };
    confidenceMasks?: Array<{ getAsUint8Array: () => Uint8Array; width: number; height: number; close?: () => void }>;
    close?: () => void;
  };
};

export class CanvasCompositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private screenVideo: HTMLVideoElement;
  private cameraVideo: HTMLVideoElement | null = null;
  private stream: MediaStream;
  private rafId: number | null = null;
  private destroyed = false;
  private ready: Promise<void>;

  // Live-adjustable state
  private pipX: number = PIP_MARGIN;
  private pipY: number = 0; // set on ready
  private cameraSize: CameraSize = 'medium';
  private layoutMode: LayoutMode = 'pip';
  private blurBackground = false;

  // Background segmentation helpers
  private segmenter: Segmenter | null = null;
  private segmenterLoading = false;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private camCanvas: HTMLCanvasElement;
  private camCtx: CanvasRenderingContext2D;
  private blurCanvas: HTMLCanvasElement;
  private blurCtx: CanvasRenderingContext2D;

  // Temporal smoothing (EMA) for the alpha mask -- prevents edge shimmer.
  // 0..1, higher = more responsive but less smooth. 0.5 is the sweet spot.
  private static readonly MASK_EMA_WEIGHT = 0.5;
  private prevAlphaArr: Uint8Array | null = null;
  private prevAlphaW = 0;
  private prevAlphaH = 0;

  constructor(
    screenTrack: MediaStreamTrack,
    cameraTrack: MediaStreamTrack | null,
    opts: { cameraSize?: CameraSize; blurBackground?: boolean; layoutMode?: LayoutMode } = {}
  ) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true })!;
    this.camCanvas = document.createElement('canvas');
    this.camCtx = this.camCanvas.getContext('2d')!;
    this.blurCanvas = document.createElement('canvas');
    this.blurCtx = this.blurCanvas.getContext('2d')!;

    this.cameraSize = opts.cameraSize ?? 'medium';
    this.blurBackground = opts.blurBackground ?? false;
    this.layoutMode = opts.layoutMode ?? 'pip';

    this.screenVideo = document.createElement('video');
    this.screenVideo.srcObject = new MediaStream([screenTrack]);
    this.screenVideo.muted = true;
    this.screenVideo.playsInline = true;
    this.screenVideo.play();

    if (cameraTrack) {
      this.cameraVideo = document.createElement('video');
      this.cameraVideo.srcObject = new MediaStream([cameraTrack]);
      this.cameraVideo.muted = true;
      this.cameraVideo.playsInline = true;
      this.cameraVideo.play();
    }

    this.ready = new Promise<void>((resolve) => {
      const apply = () => {
        const vw = this.screenVideo.videoWidth;
        const vh = this.screenVideo.videoHeight;
        const settings = screenTrack.getSettings();
        this.canvas.width = Math.max(vw, settings.width || 1920);
        this.canvas.height = Math.max(vh, settings.height || 1080);

        // Default PIP position: bottom-left with margin
        const { width: pipW, height: pipH } = this.computePipSize();
        this.pipX = PIP_MARGIN;
        this.pipY = this.canvas.height - pipH - PIP_MARGIN;
        void pipW;
        resolve();
      };

      if (this.screenVideo.videoWidth > 0) {
        apply();
      } else {
        this.screenVideo.onloadedmetadata = () => apply();
      }
    });

    this.stream = this.canvas.captureStream(60);

    if (this.blurBackground) {
      void this.loadSegmenter();
    }

    this.scheduleRaf();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  get width(): number { return this.canvas.width; }
  get height(): number { return this.canvas.height; }
  get pipSize(): { width: number; height: number } { return this.computePipSize(); }
  getPipPosition(): { x: number; y: number } { return { x: this.pipX, y: this.pipY }; }
  getLayoutMode(): LayoutMode { return this.layoutMode; }

  setPipPosition(x: number, y: number) {
    const { width: w, height: h } = this.computePipSize();
    this.pipX = Math.max(0, Math.min(x, this.canvas.width - w));
    this.pipY = Math.max(0, Math.min(y, this.canvas.height - h));
  }

  setCameraSize(size: CameraSize) {
    const oldSize = this.computePipSize();
    this.cameraSize = size;
    const newSize = this.computePipSize();
    // Keep the PIP center stable when resizing
    this.pipX = this.pipX + (oldSize.width - newSize.width) / 2;
    this.pipY = this.pipY + (oldSize.height - newSize.height) / 2;
    // Re-clamp
    this.setPipPosition(this.pipX, this.pipY);
  }

  setLayoutMode(mode: LayoutMode) {
    this.layoutMode = mode;
  }

  setBlurBackground(enabled: boolean) {
    this.blurBackground = enabled;
    if (enabled && !this.segmenter && !this.segmenterLoading) {
      void this.loadSegmenter();
    }
  }

  private computePipSize(): { width: number; height: number } {
    const w = Math.round(this.canvas.width * SIZE_MULTIPLIERS[this.cameraSize]);
    const h = Math.round(w * (9 / 16));
    return { width: w, height: h };
  }

  private async loadSegmenter() {
    if (this.segmenterLoading || this.segmenter) return;
    this.segmenterLoading = true;
    try {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
      );
      const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          // Multiclass selfie segmenter: 6 classes (0=bg, 1=hair, 2=body-skin,
          // 3=face-skin, 4=clothes, 5=others). We treat anything != 0 as
          // foreground, which keeps hair attached to the head.
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      this.segmenter = segmenter as unknown as Segmenter;
      // Reset EMA state when (re)loading the model
      this.prevAlphaArr = null;
    } catch (e) {
      console.warn('Failed to load segmenter, falling back to plain camera:', e);
    } finally {
      this.segmenterLoading = false;
    }
  }

  private scheduleRaf = () => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.render);
  };

  private render = () => {
    if (this.destroyed) return;
    const { canvas, ctx, screenVideo, cameraVideo } = this;

    if (this.layoutMode === 'face-full' && cameraVideo && cameraVideo.readyState >= 2) {
      this.drawCameraFullScreen(cameraVideo);
    } else if (screenVideo.readyState >= 2) {
      // PIP mode: screen full + camera overlay
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

      if (cameraVideo && cameraVideo.readyState >= 2) {
        this.drawCameraPip(cameraVideo);
      }
    }

    this.scheduleRaf();
  };

  private drawCameraPip(cam: HTMLVideoElement) {
    const { ctx } = this;
    const { width: pipW, height: pipH } = this.computePipSize();
    const x = this.pipX;
    const y = this.pipY;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, pipW, pipH, PIP_RADIUS);
    ctx.clip();

    if (this.blurBackground && this.segmenter) {
      this.drawCameraWithBlur(cam, x, y, pipW, pipH);
    } else {
      this.drawCameraCoverFit(cam, x, y, pipW, pipH);
    }
    ctx.restore();

    ctx.strokeStyle = PIP_BORDER_COLOR;
    ctx.lineWidth = PIP_BORDER_WIDTH;
    ctx.beginPath();
    ctx.roundRect(x, y, pipW, pipH, PIP_RADIUS);
    ctx.stroke();
  }

  private drawCameraFullScreen(cam: HTMLVideoElement) {
    const { ctx, canvas } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.blurBackground && this.segmenter) {
      this.drawCameraWithBlur(cam, 0, 0, canvas.width, canvas.height);
    } else {
      this.drawCameraCoverFit(cam, 0, 0, canvas.width, canvas.height);
    }
  }

  /** Draws the camera into the (x,y,w,h) box using cover-fit (fills the box, may crop sides). */
  private drawCameraCoverFit(cam: HTMLVideoElement, x: number, y: number, w: number, h: number) {
    const cw = cam.videoWidth || 1280;
    const ch = cam.videoHeight || 720;
    const targetRatio = w / h;
    const sourceRatio = cw / ch;

    let sx = 0, sy = 0, sw = cw, sh = ch;
    if (sourceRatio > targetRatio) {
      // Source is wider -> crop sides
      sw = ch * targetRatio;
      sx = (cw - sw) / 2;
    } else {
      // Source is taller -> crop top/bottom
      sh = cw / targetRatio;
      sy = (ch - sh) / 2;
    }
    this.ctx.drawImage(cam, sx, sy, sw, sh, x, y, w, h);
  }

  /** Compute cover-fit source rectangle for camera at target w/h. */
  private coverFitSourceRect(cam: HTMLVideoElement, w: number, h: number) {
    const cw = cam.videoWidth || 1280;
    const ch = cam.videoHeight || 720;
    const targetRatio = w / h;
    const sourceRatio = cw / ch;
    let sx = 0, sy = 0, sw = cw, sh = ch;
    if (sourceRatio > targetRatio) {
      sw = ch * targetRatio;
      sx = (cw - sw) / 2;
    } else {
      sh = cw / targetRatio;
      sy = (ch - sh) / 2;
    }
    return { sx, sy, sw, sh };
  }

  private drawCameraWithBlur(cam: HTMLVideoElement, x: number, y: number, w: number, h: number) {
    const { camCanvas, camCtx, blurCanvas, blurCtx, maskCanvas, maskCtx, ctx, segmenter } = this;
    if (!segmenter) {
      this.drawCameraCoverFit(cam, x, y, w, h);
      return;
    }

    if (camCanvas.width !== w || camCanvas.height !== h) {
      camCanvas.width = w; camCanvas.height = h;
    }
    if (blurCanvas.width !== w || blurCanvas.height !== h) {
      blurCanvas.width = w; blurCanvas.height = h;
    }

    const { sx, sy, sw, sh } = this.coverFitSourceRect(cam, w, h);

    // 1. Blurred base layer
    const blurRadius = Math.max(12, Math.round(Math.min(w, h) * 0.04));
    blurCtx.filter = `blur(${blurRadius}px)`;
    blurCtx.clearRect(0, 0, w, h);
    blurCtx.drawImage(cam, sx, sy, sw, sh, 0, 0, w, h);
    blurCtx.filter = 'none';

    // 2. Sharp camera
    camCtx.globalCompositeOperation = 'source-over';
    camCtx.filter = 'none';
    camCtx.clearRect(0, 0, w, h);
    camCtx.drawImage(cam, sx, sy, sw, sh, 0, 0, w, h);

    // 3. Run segmenter
    let result;
    try {
      result = segmenter.segmentForVideo(cam, performance.now());
    } catch (e) {
      console.warn('Segmenter failed on frame:', e);
      ctx.drawImage(camCanvas, x, y, w, h);
      return;
    }
    const mask = result?.categoryMask;
    if (!mask) {
      ctx.drawImage(camCanvas, x, y, w, h);
      result?.close?.();
      return;
    }

    // 4. Build EMA-smoothed alpha mask at the model's native resolution.
    //    Multiclass model: 0 = background, 1-5 = foreground (hair/body/face/clothes/others).
    const maskData = mask.getAsUint8Array();
    const mw = mask.width;
    const mh = mask.height;
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw;
      maskCanvas.height = mh;
    }

    // Reset EMA state if the mask resolution changed
    if (!this.prevAlphaArr || this.prevAlphaW !== mw || this.prevAlphaH !== mh) {
      this.prevAlphaArr = new Uint8Array(mw * mh);
      this.prevAlphaW = mw;
      this.prevAlphaH = mh;
    }
    const prev = this.prevAlphaArr;
    const w1 = CanvasCompositor.MASK_EMA_WEIGHT;
    const w0 = 1 - w1;

    const imgData = maskCtx.createImageData(mw, mh);
    const pixels = imgData.data;
    for (let i = 0; i < maskData.length; i++) {
      const j = i * 4;
      const newAlpha = maskData[i] !== 0 ? 255 : 0;
      const smoothed = (w1 * newAlpha + w0 * prev[i]) | 0;
      prev[i] = smoothed;
      pixels[j] = 255;
      pixels[j + 1] = 255;
      pixels[j + 2] = 255;
      pixels[j + 3] = smoothed;
    }
    maskCtx.putImageData(imgData, 0, 0);

    // 5. Apply mask to sharp camera with destination-in + Gaussian blur on the
    //    drawImage call. The blur scales with target size so the feather looks
    //    consistent whether PIP or fullscreen.
    const featherPx = Math.max(2, Math.round(Math.min(w, h) * 0.008));
    camCtx.globalCompositeOperation = 'destination-in';
    camCtx.filter = `blur(${featherPx}px)`;
    camCtx.drawImage(maskCanvas, 0, 0, mw, mh, 0, 0, w, h);
    camCtx.filter = 'none';
    camCtx.globalCompositeOperation = 'source-over';

    // 6. Composite: blurred base, then sharp person on top.
    ctx.drawImage(blurCanvas, x, y, w, h);
    ctx.drawImage(camCanvas, x, y, w, h);

    mask.close?.();
    result.close?.();
  }

  getStream(): MediaStream {
    return this.stream;
  }

  destroy() {
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.screenVideo.srcObject = null;
    if (this.cameraVideo) {
      this.cameraVideo.srcObject = null;
    }
    this.stream.getTracks().forEach((t) => t.stop());
    try {
      (this.segmenter as unknown as { close?: () => void } | null)?.close?.();
    } catch {
      // ignore
    }
    this.segmenter = null;
  }
}

export function mergeAudioTracks(tracks: MediaStreamTrack[]): MediaStreamTrack | null {
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return tracks[0];

  const audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();

  tracks.forEach((track) => {
    const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
    source.connect(destination);
  });

  return destination.stream.getAudioTracks()[0] || null;
}
