import { CameraSize, LayoutMode, BackgroundMode } from '../types';
import bgLibraryUrl from '../assets/bg-library.webp';

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

  // Frame-rate gating. Driven by the actual source frame rate so we never
  // produce frames the encoder can't consume (the cause of the 1s-on/1s-off
  // backpressure freeze).
  private targetFps = 30;
  private frameInterval = 1000 / 30;
  private lastRenderTs = 0;
  // Toggle that halves the segmenter rate when blur is on. The EMA smoother
  // hides the reused mask -- visually identical, half the CPU/GPU cost.
  private segmenterTick = false;
  // Worker that drives the render tick. Workers attached to media-active
  // tabs are NOT throttled by Page Visibility (rAF IS), so this is what
  // keeps the canvas redrawing even when the recorder tab is backgrounded.
  // Falls back to rAF if Worker construction fails.
  private tickWorker: Worker | null = null;
  private workerBlobUrl: string | null = null;

  // Live-adjustable state
  private pipX: number = PIP_MARGIN;
  private pipY: number = 0; // set on ready
  private cameraSize: CameraSize = 'medium';
  private layoutMode: LayoutMode = 'pip';
  private backgroundMode: BackgroundMode = 'none';

  // Background segmentation helpers
  private segmenter: Segmenter | null = null;
  private segmenterLoading = false;
  // Virtual-background image (library scene). Loaded lazily when the
  // 'library' mode is active; until it decodes we fall back to a blurred
  // camera base so the person is never composited onto a blank frame.
  private bgImage: HTMLImageElement | null = null;
  private bgImageReady = false;
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
    opts: { cameraSize?: CameraSize; backgroundMode?: BackgroundMode; layoutMode?: LayoutMode } = {}
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
    this.backgroundMode = opts.backgroundMode ?? 'none';
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

    const sourceFps = screenTrack.getSettings().frameRate ?? 30;
    this.targetFps = Math.min(sourceFps, 30);
    this.frameInterval = 1000 / this.targetFps;
    this.stream = this.canvas.captureStream(this.targetFps);

    if (this.backgroundMode !== 'none') {
      void this.loadSegmenter();
    }
    if (this.backgroundMode === 'library') {
      this.loadBackgroundImage();
    }

    this.startTickWorker();
  }

  /**
   * Spawn a Web Worker that fires a tick message every frameInterval ms.
   * The main thread runs render() on each tick. Workers attached to media-
   * active tabs are NOT throttled when the host tab loses focus, so the
   * canvas keeps being redrawn even when the recorder tab is backgrounded
   * (this was the cause of "frozen frames after ~2 minutes" -- the rAF
   * fallback path drops to ~1 Hz on hidden tabs).
   *
   * If Worker construction fails (very old browser, sandbox restriction),
   * fall back to the existing scheduleRaf() path. Recording still works,
   * just with the original tab-background-freeze limitation.
   */
  private startTickWorker() {
    const workerCode = `let iv;self.onmessage=(e)=>{if(e.data.cmd==='start'){iv=setInterval(()=>self.postMessage(0),e.data.intervalMs)}else if(e.data.cmd==='stop'){clearInterval(iv);iv=undefined}};`;
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.workerBlobUrl = URL.createObjectURL(blob);
      this.tickWorker = new Worker(this.workerBlobUrl);
      this.tickWorker.onmessage = () => {
        if (this.destroyed) return;
        this.render(performance.now());
      };
      this.tickWorker.onerror = (e) => {
        console.error('[compositor] tick worker error, falling back to rAF:', e);
        if (this.tickWorker) {
          try { this.tickWorker.terminate(); } catch { /* ignore */ }
          this.tickWorker = null;
        }
        if (this.workerBlobUrl) {
          URL.revokeObjectURL(this.workerBlobUrl);
          this.workerBlobUrl = null;
        }
        if (!this.destroyed) this.scheduleRaf();
      };
      this.tickWorker.postMessage({ cmd: 'start', intervalMs: this.frameInterval });
      console.info('[compositor] tick worker started at', this.frameInterval.toFixed(2), 'ms interval');
    } catch (err) {
      console.error('[compositor] failed to start tick worker, using rAF fallback:', err);
      if (this.workerBlobUrl) {
        URL.revokeObjectURL(this.workerBlobUrl);
        this.workerBlobUrl = null;
      }
      this.tickWorker = null;
      this.scheduleRaf();
    }
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

  setBackgroundMode(mode: BackgroundMode) {
    this.backgroundMode = mode;
    if (mode !== 'none' && !this.segmenter && !this.segmenterLoading) {
      void this.loadSegmenter();
    }
    if (mode === 'library' && !this.bgImage) {
      this.loadBackgroundImage();
    }
  }

  private loadBackgroundImage() {
    if (this.bgImage) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { this.bgImageReady = true; };
    img.onerror = (e) => { console.warn('Failed to load library background image:', e); };
    img.src = bgLibraryUrl;
    this.bgImage = img;
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

  private render = (ts: number) => {
    if (this.destroyed) return;
    // Burst-recovery guard: if the main thread was blocked and multiple
    // worker ticks queued up, cap actual rendering to the target rate.
    // (The worker keeps ticking; we just skip extra renders this frame.)
    // Tolerance of frameInterval * 0.8 avoids rejecting slightly-early ticks.
    if (ts - this.lastRenderTs < this.frameInterval * 0.8) {
      // No reschedule needed -- worker (or rAF fallback) drives the next tick.
      if (!this.tickWorker) this.scheduleRaf();
      return;
    }
    this.lastRenderTs = ts;
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

    // If we're running on the rAF fallback (worker failed to start), keep
    // scheduling. Otherwise the worker drives the next tick.
    if (!this.tickWorker) this.scheduleRaf();
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

    if (this.backgroundMode !== 'none' && this.segmenter) {
      this.drawCameraWithVirtualBg(cam, x, y, pipW, pipH);
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
    if (this.backgroundMode !== 'none' && this.segmenter) {
      this.drawCameraWithVirtualBg(cam, 0, 0, canvas.width, canvas.height);
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

  /** Draws a still image into the (0,0,w,h) box of a context using cover-fit. */
  private drawImageCoverFit(targetCtx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) { return; }
    const targetRatio = w / h;
    const sourceRatio = iw / ih;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (sourceRatio > targetRatio) {
      sw = ih * targetRatio;
      sx = (iw - sw) / 2;
    } else {
      sh = iw / targetRatio;
      sy = (ih - sh) / 2;
    }
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  /**
   * Composites the camera with a replaced background (blur or library image).
   * The segmenter masks the person; the base layer behind them is either a
   * blurred copy of the camera ('blur' mode) or the library scene ('library'
   * mode). The masking/feathering/EMA path is identical for both -- only the
   * base layer differs.
   */
  private drawCameraWithVirtualBg(cam: HTMLVideoElement, x: number, y: number, w: number, h: number) {
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

    // 1. Base layer behind the person. Library image when in 'library' mode
    //    and the image has decoded; otherwise a blurred copy of the camera
    //    (this also serves as the 'library' fallback until the image loads).
    blurCtx.clearRect(0, 0, w, h);
    if (this.backgroundMode === 'library' && this.bgImageReady && this.bgImage) {
      this.drawImageCoverFit(blurCtx, this.bgImage, w, h);
    } else {
      const blurRadius = Math.max(12, Math.round(Math.min(w, h) * 0.04));
      blurCtx.filter = `blur(${blurRadius}px)`;
      blurCtx.drawImage(cam, sx, sy, sw, sh, 0, 0, w, h);
      blurCtx.filter = 'none';
    }

    // 2. Sharp camera
    camCtx.globalCompositeOperation = 'source-over';
    camCtx.filter = 'none';
    camCtx.clearRect(0, 0, w, h);
    camCtx.drawImage(cam, sx, sy, sw, sh, 0, 0, w, h);

    // 3. Run segmenter on every other render. The EMA smoother already
    // averages temporal noise, so reusing the previous mask for one frame
    // is visually invisible and halves segmenter CPU/GPU cost.
    this.segmenterTick = !this.segmenterTick;
    const runSegmenter = this.segmenterTick || !this.prevAlphaArr;

    let result: ReturnType<Segmenter['segmentForVideo']> | undefined;
    let mask: NonNullable<ReturnType<Segmenter['segmentForVideo']>['categoryMask']> | undefined;
    if (runSegmenter) {
      try {
        result = segmenter.segmentForVideo(cam, performance.now());
      } catch (e) {
        console.warn('Segmenter failed on frame:', e);
        ctx.drawImage(camCanvas, x, y, w, h);
        return;
      }
      mask = result?.categoryMask;
      if (!mask) {
        ctx.drawImage(camCanvas, x, y, w, h);
        result?.close?.();
        return;
      }
    } else if (!this.prevAlphaArr) {
      // No prior mask to reuse -- fall back to plain camera this frame.
      ctx.drawImage(camCanvas, x, y, w, h);
      return;
    }

    // 4. Build EMA-smoothed alpha mask at the model's native resolution.
    //    Multiclass model: 0 = background, 1-5 = foreground (hair/body/face/clothes/others).
    //    When the segmenter was skipped this frame, reuse the stored
    //    prevAlphaArr without updating it.
    const mw = mask ? mask.width : this.prevAlphaW;
    const mh = mask ? mask.height : this.prevAlphaH;
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw;
      maskCanvas.height = mh;
    }

    if (mask) {
      const maskData = mask.getAsUint8Array();
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
    } else {
      // Re-paint the stored alpha buffer from prevAlphaArr (segmenter skipped).
      const prev = this.prevAlphaArr!;
      const imgData = maskCtx.createImageData(mw, mh);
      const pixels = imgData.data;
      for (let i = 0; i < prev.length; i++) {
        const j = i * 4;
        pixels[j] = 255;
        pixels[j + 1] = 255;
        pixels[j + 2] = 255;
        pixels[j + 3] = prev[i];
      }
      maskCtx.putImageData(imgData, 0, 0);
    }

    // 5. Apply mask to sharp camera with destination-in + Gaussian blur on the
    //    drawImage call. The blur scales with target size so the feather looks
    //    consistent whether PIP or fullscreen. A soft feather blends the edge
    //    into the (soft, bokeh) image background; we do NOT erode the mask --
    //    erosion bit into the face. Any residual halo is hidden by the blurred
    //    background.
    const featherPx = Math.max(2, Math.round(Math.min(w, h) * 0.008));
    camCtx.globalCompositeOperation = 'destination-in';
    camCtx.filter = `blur(${featherPx}px)`;
    camCtx.drawImage(maskCanvas, 0, 0, mw, mh, 0, 0, w, h);
    camCtx.filter = 'none';
    camCtx.globalCompositeOperation = 'source-over';

    // 6. Composite: blurred base, then sharp person on top.
    ctx.drawImage(blurCanvas, x, y, w, h);
    ctx.drawImage(camCanvas, x, y, w, h);

    mask?.close?.();
    result?.close?.();
  }

  getStream(): MediaStream {
    return this.stream;
  }

  destroy() {
    this.destroyed = true;
    // Stop + terminate the tick worker (if active) and revoke its Blob URL
    // to avoid leaking a URL handle per recording.
    if (this.tickWorker) {
      try { this.tickWorker.postMessage({ cmd: 'stop' }); } catch { /* ignore */ }
      try { this.tickWorker.terminate(); } catch { /* ignore */ }
      this.tickWorker = null;
    }
    if (this.workerBlobUrl) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
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
