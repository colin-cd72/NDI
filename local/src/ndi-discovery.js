const { execSync } = require('child_process');

let grandiose = null;
try {
  grandiose = require('grandiose');
  console.log('[NDI] Grandiose loaded — full NDI discovery available');
} catch (err) {
  console.log('[NDI] Grandiose not available, using FFmpeg/DirectShow fallback');
}

async function discoverSources() {
  if (grandiose) {
    return discoverWithGrandiose();
  }
  return discoverWithFFmpeg();
}

async function discoverWithGrandiose() {
  try {
    const sources = await grandiose.find({ showLocalSources: true, waitTime: 3000 });
    return sources.map((s, i) => ({
      id: `ndi_${i}`,
      name: s.name,
      urlAddress: s.urlAddress,
      type: 'grandiose'
    }));
  } catch (err) {
    console.error('[NDI] Grandiose discovery error:', err.message);
    return [];
  }
}

function discoverWithFFmpeg() {
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    // List DirectShow devices — FFmpeg outputs to stderr
    const output = execSync(
      `"${ffmpegPath}" -list_devices true -f dshow -i dummy 2>&1`,
      { encoding: 'utf8', timeout: 10000 }
    ).toString();

    const sources = [];
    const lines = output.split('\n');
    let isVideo = false;

    for (const line of lines) {
      // DirectShow section headers
      if (line.includes('DirectShow video devices')) {
        isVideo = true;
        continue;
      }
      if (line.includes('DirectShow audio devices')) {
        isVideo = false;
        continue;
      }

      if (isVideo) {
        // Match device names: [dshow @ ...] "Device Name"
        const match = line.match(/\]\s+"(.+)"/);
        if (match) {
          const name = match[1];
          // Look for NDI-related virtual cameras
          if (name.toLowerCase().includes('ndi')) {
            sources.push({
              id: `dshow_${sources.length}`,
              name: name,
              deviceName: name,
              type: 'dshow'
            });
          }
        }
      }
    }

    // If no NDI-specific devices found, list all video devices
    // (user might have NDI Webcam Video mapped)
    if (sources.length === 0) {
      let isVid = false;
      for (const line of lines) {
        if (line.includes('DirectShow video devices')) {
          isVid = true;
          continue;
        }
        if (line.includes('DirectShow audio devices')) {
          isVid = false;
          continue;
        }
        if (isVid) {
          const match = line.match(/\]\s+"(.+)"/);
          if (match && !match[1].includes('Alternative name')) {
            sources.push({
              id: `dshow_${sources.length}`,
              name: match[1],
              deviceName: match[1],
              type: 'dshow'
            });
          }
        }
      }
    }

    return sources;
  } catch (err) {
    // FFmpeg -list_devices exits with non-zero, but output is in the error
    const output = err.stdout || err.stderr || '';
    if (typeof output === 'string' && output.includes('DirectShow')) {
      // Re-parse from error output
      return parseFFmpegDeviceOutput(output);
    }
    console.error('[NDI] FFmpeg discovery error:', err.message);
    return [];
  }
}

function parseFFmpegDeviceOutput(output) {
  const sources = [];
  const lines = output.split('\n');
  let isVideo = false;

  for (const line of lines) {
    if (line.includes('DirectShow video devices')) {
      isVideo = true;
      continue;
    }
    if (line.includes('DirectShow audio devices')) {
      isVideo = false;
      continue;
    }
    if (isVideo) {
      const match = line.match(/\]\s+"(.+)"/);
      if (match) {
        const name = match[1];
        if (!name.startsWith('@device')) {
          sources.push({
            id: `dshow_${sources.length}`,
            name: name,
            deviceName: name,
            type: 'dshow'
          });
        }
      }
    }
  }

  return sources;
}

module.exports = { discoverSources };
