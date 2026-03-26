export class CanvasCompositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private screenVideo: HTMLVideoElement;
  private cameraVideo: HTMLVideoElement | null = null;
  private intervalId: number | null = null;
  private stream: MediaStream;

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

    // Match canvas to screen resolution
    const settings = screenTrack.getSettings();
    this.canvas.width = settings.width || 1920;
    this.canvas.height = settings.height || 1080;

    // Start render loop (setInterval, not rAF -- must work in background tabs)
    this.stream = this.canvas.captureStream(30);
    this.intervalId = window.setInterval(this.render, 33);
  }

  private render = () => {
    const { canvas, ctx, screenVideo, cameraVideo } = this;

    if (screenVideo.readyState < 2) return;

    // Draw screen full-canvas
    ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

    // Draw camera overlay in bottom-left
    if (cameraVideo && cameraVideo.readyState >= 2) {
      const pipWidth = Math.round(canvas.width * 0.2);
      const pipHeight = Math.round(pipWidth * (9 / 16));
      const margin = 24;
      const x = margin;
      const y = canvas.height - pipHeight - margin;
      const radius = 12;

      // Rounded rectangle clip + draw
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, pipWidth, pipHeight, radius);
      ctx.clip();
      ctx.drawImage(cameraVideo, x, y, pipWidth, pipHeight);
      ctx.restore();

      // Violet border
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x, y, pipWidth, pipHeight, radius);
      ctx.stroke();
    }
  };

  getStream(): MediaStream {
    return this.stream;
  }

  destroy() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
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
