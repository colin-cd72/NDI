// NDI source discovery using the NDI SDK via koffi FFI
const crypto = require('crypto');
const ndi = require('./ndi-native');

let finder = null;
let firstDiscovery = true;

function ensureFinder() {
  if (!finder) {
    finder = ndi.NDIlib_find_create_v2({
      show_local_sources: true,
      p_groups: null,
      p_extra_ips: null
    });
    if (!finder) {
      throw new Error('Failed to create NDI finder');
    }
    console.log('[NDI] Finder created');
  }
  return finder;
}

async function discoverSources() {
  try {
    const f = ensureFinder();

    // On first discovery, wait longer to find more sources
    // On subsequent calls, wait briefly (returns early if no change)
    if (firstDiscovery) {
      for (let i = 0; i < 5; i++) {
        ndi.NDIlib_find_wait_for_sources(f, 2000);
      }
      firstDiscovery = false;
    } else {
      ndi.NDIlib_find_wait_for_sources(f, 500);
    }

    // Get current source list
    const countBuf = [0];
    const sourcesPtr = ndi.NDIlib_find_get_current_sources(f, countBuf);
    const count = countBuf[0];

    if (count === 0 || !sourcesPtr) {
      return [];
    }

    const rawSources = ndi.koffi.decode(sourcesPtr, 'NDIlib_source_t', count);

    return rawSources
      .filter(s => {
        // Skip audio-only sources (e.g., "vMix Audio - Bus A")
        const name = s.p_ndi_name.toLowerCase();
        return !name.includes('audio');
      })
      .map(s => ({
        id: `ndi_${crypto.createHash('md5').update(s.p_ndi_name).digest('hex').slice(0, 12)}`,
        name: s.p_ndi_name,
        urlAddress: s.p_url_address,
        type: 'ndi'
      }));
  } catch (err) {
    console.error('[NDI] Discovery error:', err.message);
    return [];
  }
}

function destroyFinder() {
  if (finder) {
    ndi.NDIlib_find_destroy(finder);
    finder = null;
  }
}

module.exports = { discoverSources, destroyFinder };
