const { spawn } = require('child_process');

const activeProcesses = new Map(); // sourceId -> { process, streamKey }

function startStream(source, streamKey) {
  if (activeProcesses.has(source.id)) {
    console.log(`[Stream] Already streaming source: ${source.name}`);
    return;
  }

  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const rtmpUrl = process.env.RTMP_URL || 'rtmp://ndi.4tmrw.net:1935/live';
  const fullUrl = `${rtmpUrl}/${streamKey}`;

  let args;

  if (source.type === 'grandiose') {
    // For grandiose: pipe raw frames via stdin (advanced, needs separate handling)
    // For now, use NDI Webcam Video via DirectShow as fallback
    args = buildDShowArgs('NDI Webcam Video 1', fullUrl);
  } else {
    // DirectShow device
    args = buildDShowArgs(source.deviceName || source.name, fullUrl);
  }

  console.log(`[Stream] Starting FFmpeg for "${source.name}" -> ${fullUrl}`);
  console.log(`[Stream] FFmpeg args: ${args.join(' ')}`);

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line.includes('frame=') || line.includes('speed=')) {
      // Periodic status — log occasionally
      if (Math.random() < 0.01) console.log(`[FFmpeg] ${source.name}: ${line}`);
    } else if (line) {
      console.log(`[FFmpeg] ${source.name}: ${line}`);
    }
  });

  proc.on('error', (err) => {
    console.error(`[FFmpeg] Process error for ${source.name}:`, err.message);
    activeProcesses.delete(source.id);
  });

  proc.on('exit', (code) => {
    console.log(`[FFmpeg] Process exited for ${source.name} with code ${code}`);
    activeProcesses.delete(source.id);
  });

  activeProcesses.set(source.id, { process: proc, streamKey });
}

function buildDShowArgs(deviceName, rtmpUrl) {
  return [
    '-f', 'dshow',
    '-rtbufsize', '100M',
    '-i', `video=${deviceName}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '4000k',
    '-maxrate', '4500k',
    '-bufsize', '8000k',
    '-g', '30',           // Keyframe every 30 frames (~1s at 30fps)
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-an',                // No audio for now
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}

function stopStream(sourceId) {
  const entry = activeProcesses.get(sourceId);
  if (!entry) {
    console.log(`[Stream] No active stream for source: ${sourceId}`);
    return;
  }

  console.log(`[Stream] Stopping stream for source: ${sourceId}`);
  try {
    // Send 'q' to stdin for graceful shutdown
    entry.process.stdin.write('q');
  } catch (err) {
    // Force kill if stdin write fails
    entry.process.kill('SIGTERM');
  }

  // Force kill after 5 seconds if still running
  setTimeout(() => {
    if (activeProcesses.has(sourceId)) {
      try {
        entry.process.kill('SIGKILL');
      } catch (err) {
        // Already dead
      }
      activeProcesses.delete(sourceId);
    }
  }, 5000);
}

function stopAll() {
  for (const [id] of activeProcesses) {
    stopStream(id);
  }
}

function isStreaming(sourceId) {
  return activeProcesses.has(sourceId);
}

module.exports = { startStream, stopStream, stopAll, isStreaming };
