class NDIPlayer {
  constructor(videoElement) {
    this.video = videoElement;
    this.player = null;
    this.currentSource = null;
    this.useNativeHls = this._detectNativeHls();
  }

  _detectNativeHls() {
    // iOS Safari and some macOS Safari support HLS natively but not MSE for FLV
    const video = document.createElement('video');
    const canPlayHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';
    const hasMse = typeof window.MediaSource !== 'undefined';
    // Use native HLS if browser supports it but doesn't have MSE (iOS)
    // or if mpegts.js reports unsupported
    if (canPlayHls && !hasMse) return true;
    // Also use native HLS on iOS even if MSE is partially supported
    if (canPlayHls && /iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
    return false;
  }

  play(flvUrl, sourceName) {
    this.stop();
    this.currentSource = sourceName;

    if (this.useNativeHls) {
      return this._playHls(flvUrl, sourceName);
    }
    return this._playFlv(flvUrl, sourceName);
  }

  _playHls(flvUrl, sourceName) {
    // Convert FLV URL to HLS URL
    // FLV: https://host/live/KEY_sourceId.flv
    // HLS: https://host/live/KEY_sourceId/index.m3u8
    const hlsUrl = flvUrl.replace(/\.flv$/, '/index.m3u8');

    this.video.src = hlsUrl;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.hidden = false;

    const playPromise = this.video.play();
    if (playPromise) {
      playPromise.catch(err => {
        console.error('HLS play error:', err);
      });
    }

    return true;
  }

  _playFlv(flvUrl, sourceName) {
    if (!mpegts.isSupported()) {
      console.error('mpegts.js is not supported in this browser');
      return false;
    }

    this.player = mpegts.createPlayer({
      type: 'flv',
      isLive: true,
      url: flvUrl
    }, {
      enableWorker: true,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      lazyLoadMaxDuration: 3,
      deferLoadAfterSourceOpen: false
    });

    this.player.attachMediaElement(this.video);
    this.player.load();
    this.player.play();

    this.video.hidden = false;

    this.player.on(mpegts.Events.ERROR, (type, detail, info) => {
      console.error('Player error:', type, detail, info);
    });

    this.player.on(mpegts.Events.STATISTICS_INFO, (stats) => {
      // Could display bitrate, fps etc in overlay
    });

    return true;
  }

  stop() {
    if (this.player) {
      this.player.pause();
      this.player.unload();
      this.player.detachMediaElement();
      this.player.destroy();
      this.player = null;
    }
    // Stop native HLS playback
    if (this.video.src) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.video.hidden = true;
    this.currentSource = null;
  }

  isPlaying() {
    return this.player !== null || !!this.video.src;
  }

  getCurrentSource() {
    return this.currentSource;
  }
}
