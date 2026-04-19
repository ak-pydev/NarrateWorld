// src/camera.js — getUserMedia + frame capture + resize to 512x512 base64 JPEG.

const TARGET_SIZE = 512;
const JPEG_QUALITY = 0.65; // Lower than 0.75 — faster uploads, still clear for Gemini

export class Camera {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} canvasEl
   */
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this._onTrackEnded = null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API not supported in this browser.');
    }
    // Back-facing camera on phones; no audio.
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    // Wait for first frame dims.
    if (this.video.readyState < 2) {
      await new Promise((r) => this.video.addEventListener('loadeddata', r, { once: true }));
    }

    // Watch for tracks ending unexpectedly (user revokes permission,
    // switching apps on iOS, etc.). Dispatch a custom event that app.js
    // can listen for.
    const videoTrack = this.stream.getVideoTracks()[0];
    if (videoTrack) {
      this._onTrackEnded = () => {
        this.video.dispatchEvent(new CustomEvent('camera-lost'));
      };
      videoTrack.addEventListener('ended', this._onTrackEnded);
    }
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.removeEventListener?.('ended', this._onTrackEnded);
        t.stop();
      }
      this.stream = null;
      this._onTrackEnded = null;
    }
    this.video.srcObject = null;
  }

  /** @returns {boolean} Whether the camera stream is active */
  get isActive() {
    if (!this.stream) return false;
    return this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /**
   * Capture the current frame, center-crop to square, resize to 512x512, return
   * raw base64 JPEG (no data: prefix).
   * @returns {string} base64
   */
  captureBase64Jpeg() {
    if (!this.isActive) throw new Error('Camera stream not active.');

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) throw new Error('No video frame yet.');

    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;

    this.canvas.width = TARGET_SIZE;
    this.canvas.height = TARGET_SIZE;
    this.ctx.drawImage(this.video, sx, sy, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);

    const dataUrl = this.canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    // Strip the "data:image/jpeg;base64," prefix.
    const comma = dataUrl.indexOf(',');
    return dataUrl.slice(comma + 1);
  }
}
