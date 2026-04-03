export class CanvasCompositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private screenVideo: HTMLVideoElement;
  private cameraVideo: HTMLVideoElement | null = null;
  private stream: MediaStream;
  private rafId: number | null = null;
  private destroyed = false;
  private ready: Promise<void>;

  constructor(
    screenTrack: MediaStreamTrack,
    cameraTrack: MediaStreamTrack | null
  ) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;

    // Screen video element
    this.screenVideo = document.createElement('video');
    this.screenVideo.srcObject = new MediaStream([screenTrack]);
    this.screenVideo.muted = true;
    this.screenVideo.playsInline = true;
    this.screenVideo.play();

    // Camera video element
    if (cameraTrack) {
      this.cameraVideo = document.createElement('video');
      this.cameraVideo.srcObject = new MediaStream([cameraTrack]);
      this.cameraVideo.muted = true;
      this.cameraVideo.playsInline = true;
      this.cameraVideo.play();
    }

    // Wait for video metadata so we get the real capture dimensions,
    // then pick the largest of videoWidth/height vs track settings.
    this.ready = new Promise<void>((resolve) => {
      const apply = () => {
        const vw = this.screenVideo.videoWidth;
        const vh = this.screenVideo.videoHeight;
        const settings = screenTrack.getSettings();
        this.canvas.width = Math.max(vw, settings.width || 1920);
        this.canvas.height = Math.max(vh, settings.height || 1080);
        resolve();
      };

      if (this.screenVideo.videoWidth > 0) {
        apply();
      } else {
        this.screenVideo.onloadedmetadata = () => apply();
      }
    });

    // Capture at 60fps for smooth output
    this.stream = this.canvas.captureStream(60);

    // Render loop via requestAnimationFrame only
    this.scheduleRaf();
  }

  /** Resolves once the canvas dimensions are set from the actual video. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Actual canvas width after initialization. */
  get width(): number {
    return this.canvas.width;
  }

  /** Actual canvas height after initialization. */
  get height(): number {
    return this.canvas.height;
  }

  private scheduleRaf = () => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.render);
  };

  private render = () => {
    if (this.destroyed) return;

    const { canvas, ctx, screenVideo, cameraVideo } = this;

    if (screenVideo.readyState >= 2) {
      // Disable smoothing for screen content -- keeps text and UI sharp
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

      // Draw camera overlay in bottom-left
      if (cameraVideo && cameraVideo.readyState >= 2) {
        // Re-enable smoothing for camera PIP (small overlay benefits from it)
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const pipWidth = Math.round(canvas.width * 0.2);
        const pipHeight = Math.round(pipWidth * (9 / 16));
        const margin = 24;
        const x = margin;
        const y = canvas.height - pipHeight - margin;
        const radius = 12;

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, pipWidth, pipHeight, radius);
        ctx.clip();
        ctx.drawImage(cameraVideo, x, y, pipWidth, pipHeight);
        ctx.restore();

        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(x, y, pipWidth, pipHeight, radius);
        ctx.stroke();
      }
    }

    this.scheduleRaf();
  };

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
