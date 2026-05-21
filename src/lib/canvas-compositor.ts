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
  private removeBackground = false;

  // Background removal helpers
  private segmenter: Segmenter | null = null;
  private segmenterLoading = false;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private camCanvas: HTMLCanvasElement;
  private camCtx: CanvasRenderingContext2D;

  constructor(
    screenTrack: MediaStreamTrack,
    cameraTrack: MediaStreamTrack | null,
    opts: { cameraSize?: CameraSize; removeBackground?: boolean } = {}
  ) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true })!;
    this.camCanvas = document.createElement('canvas');
    this.camCtx = this.camCanvas.getContext('2d')!;

    this.cameraSize = opts.cameraSize ?? 'medium';
    this.removeBackground = opts.removeBackground ?? false;

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

    if (this.removeBackground) {
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

  setRemoveBackground(enabled: boolean) {
    this.removeBackground = enabled;
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
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      this.segmenter = segmenter as unknown as Segmenter;
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

    if (this.removeBackground && this.segmenter) {
      this.drawCameraWithMask(cam, x, y, pipW, pipH);
    } else {
      ctx.drawImage(cam, x, y, pipW, pipH);
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
    // Fill the canvas (cover, center-crop) with the camera
    if (this.removeBackground && this.segmenter) {
      this.drawCameraWithMask(cam, 0, 0, canvas.width, canvas.height);
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

  private drawCameraWithMask(cam: HTMLVideoElement, x: number, y: number, w: number, h: number) {
    const { camCanvas, camCtx, maskCanvas, maskCtx, ctx, segmenter } = this;
    if (!segmenter) {
      this.drawCameraCoverFit(cam, x, y, w, h);
      return;
    }

    // 1. Render the cover-fit camera into the camCanvas at the target dimensions
    if (camCanvas.width !== w || camCanvas.height !== h) {
      camCanvas.width = w;
      camCanvas.height = h;
    }
    camCtx.clearRect(0, 0, w, h);
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
    camCtx.drawImage(cam, sx, sy, sw, sh, 0, 0, w, h);

    // 2. Run segmenter on the raw camera frame
    let result;
    try {
      result = segmenter.segmentForVideo(cam, performance.now());
    } catch (e) {
      console.warn('Segmenter failed on frame:', e);
      ctx.drawImage(camCanvas, x, y);
      return;
    }

    const mask = result?.categoryMask;
    if (!mask) {
      ctx.drawImage(camCanvas, x, y);
      result?.close?.();
      return;
    }

    // 3. Convert mask to alpha channel on the maskCanvas at camera resolution
    const maskData = mask.getAsUint8Array();
    const mw = mask.width;
    const mh = mask.height;
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw;
      maskCanvas.height = mh;
    }

    const imgData = maskCtx.createImageData(mw, mh);
    // selfie_segmenter mask: 0 = person, 255 = background
    for (let i = 0; i < maskData.length; i++) {
      const j = i * 4;
      const isPerson = maskData[i] === 0;
      imgData.data[j] = 255;     // white
      imgData.data[j + 1] = 255;
      imgData.data[j + 2] = 255;
      imgData.data[j + 3] = isPerson ? 0 : 255; // background opaque white, person transparent
    }
    maskCtx.putImageData(imgData, 0, 0);

    // 4. Composite: draw camera, then draw mask (white where background) on top
    ctx.drawImage(camCanvas, x, y, w, h);
    ctx.drawImage(maskCanvas, x, y, w, h);

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
