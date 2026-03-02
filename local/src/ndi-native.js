// NDI SDK wrapper using koffi FFI
// Calls Processing.NDI.Lib.x64.dll directly for discovery and receiving

const koffi = require('koffi');
const path = require('path');

const NDI_DLL = process.env.NDI_RUNTIME_DIR
  ? path.join(process.env.NDI_RUNTIME_DIR, 'Processing.NDI.Lib.x64.dll')
  : 'C:/Program Files/NDI/NDI 6 Tools/Runtime/Processing.NDI.Lib.x64.dll';

let lib;
try {
  lib = koffi.load(NDI_DLL);
} catch (err) {
  console.error('[NDI] Failed to load NDI library:', err.message);
  console.error('[NDI] Ensure NDI 6 Tools Runtime is installed');
  process.exit(1);
}

// ── Struct definitions ──

const NDIlib_source_t = koffi.struct('NDIlib_source_t', {
  p_ndi_name: 'const char *',
  p_url_address: 'const char *'
});

const NDIlib_find_create_t = koffi.struct('NDIlib_find_create_t', {
  show_local_sources: 'bool',
  p_groups: 'const char *',
  p_extra_ips: 'const char *'
});

const NDIlib_recv_create_v3_t = koffi.struct('NDIlib_recv_create_v3_t', {
  source_to_connect_to: NDIlib_source_t,
  color_format: 'int32_t',
  bandwidth: 'int32_t',
  allow_video_fields: 'bool',
  p_ndi_name: 'const char *'
});

const NDIlib_video_frame_v2_t = koffi.struct('NDIlib_video_frame_v2_t', {
  xres: 'int32_t',
  yres: 'int32_t',
  FourCC: 'int32_t',
  frame_rate_N: 'int32_t',
  frame_rate_D: 'int32_t',
  picture_aspect_ratio: 'float',
  frame_format_type: 'int32_t',
  timecode: 'int64_t',
  p_data: 'void *',
  line_stride_in_bytes: 'int32_t',
  p_metadata: 'const char *',
  timestamp: 'int64_t'
});

// ── Constants ──

// NDIlib_recv_color_format_e
const COLOR_FORMAT_BGRX_BGRA = 0;
const COLOR_FORMAT_UYVY_BGRA = 1;
const COLOR_FORMAT_RGBX_RGBA = 2;
const COLOR_FORMAT_UYVY_RGBA = 3;
const COLOR_FORMAT_FASTEST = 100;
const COLOR_FORMAT_BEST = 101;

// NDIlib_recv_bandwidth_e
const BANDWIDTH_METADATA_ONLY = -10;
const BANDWIDTH_AUDIO_ONLY = 10;
const BANDWIDTH_LOWEST = 0;
const BANDWIDTH_HIGHEST = 100;

// NDIlib_frame_type_e
const FRAME_TYPE_NONE = 0;
const FRAME_TYPE_VIDEO = 1;
const FRAME_TYPE_AUDIO = 2;
const FRAME_TYPE_METADATA = 3;
const FRAME_TYPE_ERROR = 4;
const FRAME_TYPE_STATUS_CHANGE = 100;

// NDIlib_FourCC_video_type_e
const FOURCC_UYVY = 0x59565955;
const FOURCC_BGRA = 0x41524742;
const FOURCC_BGRX = 0x58524742;
const FOURCC_RGBA = 0x41424752;
const FOURCC_RGBX = 0x58424752;
const FOURCC_NV12 = 0x3231564E;
const FOURCC_I420 = 0x30323449;

// ── Function bindings ──

const NDIlib_initialize = lib.func('bool NDIlib_initialize()');
const NDIlib_destroy = lib.func('void NDIlib_destroy()');

// Find (discovery)
const NDIlib_find_create_v2 = lib.func('void* NDIlib_find_create_v2(const NDIlib_find_create_t*)');
const NDIlib_find_wait_for_sources = lib.func('bool NDIlib_find_wait_for_sources(void*, uint32_t)');
const NDIlib_find_get_current_sources = lib.func('const NDIlib_source_t* NDIlib_find_get_current_sources(void*, _Out_ uint32_t*)');
const NDIlib_find_destroy = lib.func('void NDIlib_find_destroy(void*)');

// Recv (receiving)
const NDIlib_recv_create_v3 = lib.func('void* NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t*)');
const NDIlib_recv_destroy = lib.func('void NDIlib_recv_destroy(void*)');
const NDIlib_recv_capture_v2 = lib.func('int32_t NDIlib_recv_capture_v2(void*, _Inout_ NDIlib_video_frame_v2_t*, void*, void*, uint32_t)');
const NDIlib_recv_free_video_v2 = lib.func('void NDIlib_recv_free_video_v2(void*, const NDIlib_video_frame_v2_t*)');

// ── Initialize NDI ──

if (!NDIlib_initialize()) {
  console.error('[NDI] Failed to initialize NDI library');
  process.exit(1);
}
console.log('[NDI] NDI SDK initialized via koffi');

// ── Helper: FourCC to FFmpeg pix_fmt ──

function fourccToPixFmt(fourcc) {
  switch (fourcc) {
    case FOURCC_UYVY: return 'uyvy422';
    case FOURCC_BGRA: return 'bgra';
    case FOURCC_BGRX: return 'bgr0';
    case FOURCC_RGBA: return 'rgba';
    case FOURCC_RGBX: return 'rgb0';
    case FOURCC_NV12: return 'nv12';
    case FOURCC_I420: return 'yuv420p';
    default: return 'uyvy422';
  }
}

function fourccBytesPerPixel(fourcc) {
  switch (fourcc) {
    case FOURCC_UYVY: return 2;
    case FOURCC_BGRA:
    case FOURCC_BGRX:
    case FOURCC_RGBA:
    case FOURCC_RGBX: return 4;
    case FOURCC_NV12: return 1.5;
    case FOURCC_I420: return 1.5;
    default: return 2;
  }
}

module.exports = {
  lib,
  koffi,
  // Structs
  NDIlib_source_t,
  NDIlib_find_create_t,
  NDIlib_recv_create_v3_t,
  NDIlib_video_frame_v2_t,
  // Functions
  NDIlib_initialize,
  NDIlib_destroy,
  NDIlib_find_create_v2,
  NDIlib_find_wait_for_sources,
  NDIlib_find_get_current_sources,
  NDIlib_find_destroy,
  NDIlib_recv_create_v3,
  NDIlib_recv_destroy,
  NDIlib_recv_capture_v2,
  NDIlib_recv_free_video_v2,
  // Constants
  COLOR_FORMAT_UYVY_BGRA,
  COLOR_FORMAT_FASTEST,
  COLOR_FORMAT_BEST,
  BANDWIDTH_HIGHEST,
  BANDWIDTH_LOWEST,
  FRAME_TYPE_NONE,
  FRAME_TYPE_VIDEO,
  FRAME_TYPE_AUDIO,
  FRAME_TYPE_ERROR,
  FRAME_TYPE_STATUS_CHANGE,
  FOURCC_UYVY,
  FOURCC_BGRA,
  FOURCC_BGRX,
  FOURCC_NV12,
  FOURCC_I420,
  // Helpers
  fourccToPixFmt,
  fourccBytesPerPixel
};
