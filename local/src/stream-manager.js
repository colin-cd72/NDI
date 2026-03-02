// Stream manager: NDI recv → raw frames → FFmpeg (H.264) → RTMP
const { spawn } = require('child_process');
const ndi = require('./ndi-native');

// Use msvcrt memcpy for efficient frame data copying (avoids creating millions of JS objects)
const msvcrt = ndi.koffi.load('msvcrt.dll');
const memcpy = msvcrt.func('void* memcpy(void* dest, const void* src, size_t count)');

// Pre-allocate frame buffer (big enough for 4K BGRA: 3840*2160*4 = 33MB)
const MAX_FRAME_SIZE = 3840 * 2160 * 4;
const frameBuf = Buffer.alloc(MAX_FRAME_SIZE);

const activeStreams = new Map(); // sourceId -> { recv, ffmpeg, stopping }

function startStream(source, streamKey) {
  if (activeStreams.has(source.id)) {
    console.log(`[Stream] Already streaming source: ${source.name}`);
    return;
  }

  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const rtmpUrl = process.env.RTMP_URL || 'rtmp://ndi.4tmrw.net:1935/live';
  const fullUrl = `${rtmpUrl}/${streamKey}`;

  console.log(`[Stream] Starting NDI recv for "${source.name}" (${source.urlAddress})`);

  // Create NDI receiver connected to this source
  const recv = ndi.NDIlib_recv_create_v3({
    source_to_connect_to: {
      p_ndi_name: source.name,
      p_url_address: source.urlAddress || ''
    },
    color_format: ndi.COLOR_FORMAT_UYVY_BGRA,
    bandwidth: ndi.BANDWIDTH_HIGHEST,
    allow_video_fields: false,
    p_ndi_name: 'NDI-Remote-Viewer'
  });

  if (!recv) {
    console.error(`[Stream] Failed to create NDI receiver for "${source.name}"`);
    return;
  }

  const entry = { recv, ffmpeg: null, stopping: false, frameCount: 0 };
  activeStreams.set(source.id, entry);

  console.log(`[Stream] Waiting for first frame from "${source.name}"...`);
  recvLoop(source, entry, ffmpegPath, fullUrl);
}

function recvLoop(source, entry, ffmpegPath, rtmpUrl) {
  if (entry.stopping) return;

  // Allocate a video frame struct for capture
  const videoFrame = {
    xres: 0, yres: 0, FourCC: 0,
    frame_rate_N: 0, frame_rate_D: 0,
    picture_aspect_ratio: 0, frame_format_type: 0,
    timecode: 0n, p_data: null, line_stride_in_bytes: 0,
    p_metadata: null, timestamp: 0n
  };

  // Short timeout (100ms) to avoid blocking the event loop too long
  const frameType = ndi.NDIlib_recv_capture_v2(entry.recv, videoFrame, null, null, 100);

  if (frameType === ndi.FRAME_TYPE_VIDEO) {
    entry.frameCount++;

    // Start FFmpeg on first video frame (now we know resolution and format)
    if (!entry.ffmpeg && videoFrame.xres > 0) {
      const pixFmt = ndi.fourccToPixFmt(videoFrame.FourCC);
      const fps = videoFrame.frame_rate_D > 0
        ? (videoFrame.frame_rate_N / videoFrame.frame_rate_D)
        : 30;

      console.log(`[Stream] "${source.name}": ${videoFrame.xres}x${videoFrame.yres} @ ${fps.toFixed(2)}fps, format=${pixFmt}, stride=${videoFrame.line_stride_in_bytes}`);
      console.log(`[Stream] Starting FFmpeg → ${rtmpUrl}`);

      const fpsRound = Math.round(fps);
      const args = [
        '-f', 'rawvideo',
        '-pix_fmt', pixFmt,
        '-s', `${videoFrame.xres}x${videoFrame.yres}`,
        '-r', String(fpsRound),
        '-i', 'pipe:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '4000k',
        '-maxrate', '4500k',
        '-bufsize', '8000k',
        '-g', String(fpsRound),
        '-keyint_min', String(fpsRound),
        '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-an',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        rtmpUrl
      ];

      entry.ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      entry.ffmpeg.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line.includes('frame=') || line.includes('speed=')) {
          if (entry.frameCount % 300 === 0) console.log(`[FFmpeg] ${source.name}: ${line}`);
        } else if (line) {
          console.log(`[FFmpeg] ${source.name}: ${line}`);
        }
      });

      entry.ffmpeg.on('error', (err) => {
        console.error(`[FFmpeg] Process error for ${source.name}:`, err.message);
        cleanupStream(source.id, entry);
      });

      entry.ffmpeg.on('exit', (code) => {
        console.log(`[FFmpeg] Process exited for ${source.name} with code ${code}`);
        cleanupStream(source.id, entry);
      });

      entry.ffmpeg.stdin.on('error', () => {
        // FFmpeg stdin closed — will be cleaned up by exit handler
      });
    }

    // Copy raw frame data to buffer and write to FFmpeg stdin
    if (entry.ffmpeg && entry.ffmpeg.stdin.writable && videoFrame.p_data) {
      const frameSize = videoFrame.line_stride_in_bytes * videoFrame.yres;
      if (frameSize > 0 && frameSize <= MAX_FRAME_SIZE) {
        try {
          memcpy(frameBuf, videoFrame.p_data, frameSize);
          entry.ffmpeg.stdin.write(frameBuf.subarray(0, frameSize));
        } catch (err) {
          if (entry.frameCount < 5) {
            console.error(`[Stream] Frame write error:`, err.message);
          }
        }
      }
    }

    // Free the NDI video frame
    ndi.NDIlib_recv_free_video_v2(entry.recv, videoFrame);
  } else if (frameType === ndi.FRAME_TYPE_ERROR) {
    console.error(`[Stream] NDI recv error for "${source.name}"`);
    cleanupStream(source.id, entry);
    return;
  }
  // FRAME_TYPE_NONE, FRAME_TYPE_AUDIO, FRAME_TYPE_METADATA — just continue

  // Continue recv loop (yield to event loop between frames)
  if (!entry.stopping) {
    setImmediate(() => recvLoop(source, entry, ffmpegPath, rtmpUrl));
  }
}

function cleanupStream(sourceId, entry) {
  if (!entry || entry.stopping) return;
  entry.stopping = true;
  activeStreams.delete(sourceId);

  if (entry.ffmpeg) {
    try { entry.ffmpeg.stdin.end(); } catch (e) {}
    setTimeout(() => {
      try { entry.ffmpeg.kill('SIGTERM'); } catch (e) {}
    }, 3000);
  }

  if (entry.recv) {
    try { ndi.NDIlib_recv_destroy(entry.recv); } catch (e) {}
  }
}

function stopStream(sourceId) {
  const entry = activeStreams.get(sourceId);
  if (!entry) {
    console.log(`[Stream] No active stream for source: ${sourceId}`);
    return;
  }
  console.log(`[Stream] Stopping stream for source: ${sourceId}`);
  cleanupStream(sourceId, entry);
}

function stopAll() {
  for (const [id] of activeStreams) {
    stopStream(id);
  }
}

function isStreaming(sourceId) {
  return activeStreams.has(sourceId);
}

module.exports = { startStream, stopStream, stopAll, isStreaming };
