// Stream manager: NDI recv → raw frames → FFmpeg (H.264) → RTMP
const { spawn } = require('child_process');
const ndi = require('./ndi-native');

// Use msvcrt memcpy for efficient frame data copying (avoids creating millions of JS objects)
const msvcrt = ndi.koffi.load('msvcrt.dll');
const memcpy = msvcrt.func('void* memcpy(void* dest, const void* src, size_t count)');

// Max frame size for 4K BGRA: 3840*2160*4 = 33MB
const MAX_FRAME_SIZE = 3840 * 2160 * 4;

// Zombie detection: if no video frames for this long, consider the stream dead
const ZOMBIE_TIMEOUT_MS = parseInt(process.env.ZOMBIE_TIMEOUT_MS) || 30000;

// Encoder preference: try GPU first, fall back to CPU
const ENCODER = process.env.ENCODER || 'auto'; // 'auto', 'amf', 'cpu'
let gpuAvailable = null; // null = untested, true/false after first attempt

const activeStreams = new Map(); // sourceId -> { recv, ffmpeg, stopping, ... }

// Callback set by the agent to notify server of stream failures
let onStreamError = null;
function setOnStreamError(cb) { onStreamError = cb; }

function buildEncoderArgs(pixFmt, width, height, fps, rtmpUrl, useGpu) {
  const inputArgs = [
    '-f', 'rawvideo',
    '-pix_fmt', pixFmt,
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
  ];

  const outputArgs = [
    '-g', String(fps),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];

  if (useGpu) {
    return [
      ...inputArgs,
      '-c:v', 'h264_amf',
      '-usage', 'ultralowlatency',
      '-quality', 'speed',
      '-rc', 'cbr',
      '-b:v', '4000k',
      '-maxrate', '4500k',
      '-bufsize', '8000k',
      ...outputArgs
    ];
  }

  // CPU fallback
  return [
    ...inputArgs,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '4000k',
    '-maxrate', '4500k',
    '-bufsize', '8000k',
    ...outputArgs
  ];
}

function startStream(source, streamKey, onReady) {
  if (activeStreams.has(source.id)) {
    console.log(`[Stream] Already streaming source: ${source.name}`);
    if (onReady) onReady();
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
    if (onStreamError) onStreamError(source.id, 'Failed to create NDI receiver');
    return;
  }

  const entry = {
    recv, ffmpeg: null, stopping: false, frameCount: 0,
    frameBuf: Buffer.alloc(MAX_FRAME_SIZE), // per-stream buffer to avoid corruption
    backpressure: false,
    lastFrameTime: Date.now(),
    zombieTimer: null,
    onReady: onReady || null,
    readyFired: false
  };
  activeStreams.set(source.id, entry);

  // Start zombie detection timer
  entry.zombieTimer = setInterval(() => {
    if (Date.now() - entry.lastFrameTime > ZOMBIE_TIMEOUT_MS && !entry.stopping) {
      console.error(`[Stream] Zombie detected for "${source.name}" — no frames for ${ZOMBIE_TIMEOUT_MS / 1000}s`);
      if (onStreamError) onStreamError(source.id, 'No video frames received (source may be offline)');
      cleanupStream(source.id, entry);
    }
  }, ZOMBIE_TIMEOUT_MS);

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
    entry.lastFrameTime = Date.now();

    // Start FFmpeg on first video frame (now we know resolution and format)
    if (!entry.ffmpeg && videoFrame.xres > 0) {
      const pixFmt = ndi.fourccToPixFmt(videoFrame.FourCC);
      const fps = videoFrame.frame_rate_D > 0
        ? (videoFrame.frame_rate_N / videoFrame.frame_rate_D)
        : 30;

      const fpsRound = Math.round(fps);
      const useGpu = ENCODER === 'amf' || (ENCODER === 'auto' && gpuAvailable !== false);
      const encoderName = useGpu ? 'h264_amf (GPU)' : 'libx264 (CPU)';

      console.log(`[Stream] "${source.name}": ${videoFrame.xres}x${videoFrame.yres} @ ${fps.toFixed(2)}fps, format=${pixFmt}, stride=${videoFrame.line_stride_in_bytes}`);
      console.log(`[Stream] Starting FFmpeg [${encoderName}] → ${rtmpUrl}`);

      const args = buildEncoderArgs(pixFmt, videoFrame.xres, videoFrame.yres, fpsRound, rtmpUrl, useGpu);

      entry.ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderrBuf = '';
      entry.ffmpeg.stderr.on('data', (data) => {
        const line = data.toString().trim();
        stderrBuf += line + '\n';
        if (line.includes('frame=') || line.includes('speed=')) {
          if (entry.frameCount % 300 === 0) console.log(`[FFmpeg] ${source.name}: ${line}`);
        } else if (line) {
          console.log(`[FFmpeg] ${source.name}: ${line}`);
        }
      });

      entry.ffmpeg.on('error', (err) => {
        console.error(`[FFmpeg] Process error for ${source.name}:`, err.message);
        if (onStreamError) onStreamError(source.id, `FFmpeg error: ${err.message}`);
        cleanupStream(source.id, entry);
      });

      entry.ffmpeg.on('exit', (code) => {
        console.log(`[FFmpeg] Process exited for ${source.name} with code ${code}`);
        // If GPU encoder failed early, mark it unavailable and let the stream restart with CPU
        if (code !== 0 && !entry.stopping && useGpu && gpuAvailable === null && entry.frameCount < 30) {
          const isAmfError = stderrBuf.includes('amf') || stderrBuf.includes('AMF') || stderrBuf.includes('h264_amf');
          if (isAmfError || entry.frameCount < 5) {
            console.warn('[FFmpeg] GPU encoder (h264_amf) failed, falling back to CPU');
            gpuAvailable = false;
          }
        } else if (code === 0 && useGpu) {
          gpuAvailable = true;
        }
        if (code !== 0 && !entry.stopping) {
          if (onStreamError) onStreamError(source.id, `FFmpeg exited with code ${code}`);
        }
        cleanupStream(source.id, entry);
      });

      entry.ffmpeg.stdin.on('error', () => {
        // FFmpeg stdin closed — will be cleaned up by exit handler
      });

      // Notify that stream is actually running
      if (entry.onReady && !entry.readyFired) {
        entry.readyFired = true;
        if (useGpu && gpuAvailable === null) gpuAvailable = true;
        entry.onReady();
      }
    }

    // Copy raw frame data to per-stream buffer and write to FFmpeg stdin
    if (entry.ffmpeg && entry.ffmpeg.stdin.writable && videoFrame.p_data && !entry.backpressure) {
      const frameSize = videoFrame.line_stride_in_bytes * videoFrame.yres;
      if (frameSize > 0 && frameSize <= MAX_FRAME_SIZE) {
        try {
          memcpy(entry.frameBuf, videoFrame.p_data, frameSize);
          const canContinue = entry.ffmpeg.stdin.write(entry.frameBuf.subarray(0, frameSize));
          if (!canContinue) {
            // Backpressure: stop writing until FFmpeg drains
            entry.backpressure = true;
            entry.ffmpeg.stdin.once('drain', () => { entry.backpressure = false; });
          }
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
    if (onStreamError) onStreamError(source.id, 'NDI receiver error');
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

  if (entry.zombieTimer) {
    clearInterval(entry.zombieTimer);
    entry.zombieTimer = null;
  }

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

module.exports = { startStream, stopStream, stopAll, isStreaming, setOnStreamError };
