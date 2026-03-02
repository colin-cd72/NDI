class NDIPlayer {
  constructor(videoElement) {
    this.video = videoElement;
    this.player = null;
    this.currentSource = null;
  }

  play(flvUrl, sourceName) {
    this.stop();

    if (!mpegts.isSupported()) {
      console.error('mpegts.js is not supported in this browser');
      return false;
    }

    this.currentSource = sourceName;
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
    this.video.hidden = true;
    this.currentSource = null;
  }

  isPlaying() {
    return this.player !== null;
  }

  getCurrentSource() {
    return this.currentSource;
  }
}
