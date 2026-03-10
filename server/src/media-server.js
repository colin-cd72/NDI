const NodeMediaServer = require('node-media-server');

function createMediaServer() {
  const config = {
    logType: 1, // 0:no log, 1:error, 2:normal, 3:debug
    rtmp: {
      port: parseInt(process.env.RTMP_PORT) || 1935,
      chunk_size: 60000,
      gop_cache: true, // Cache last GOP so late-joining viewers get an immediate keyframe
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: parseInt(process.env.HTTP_FLV_PORT) || 8000,
      allow_origin: '*',
      mediaroot: './media'
    },
    trans: {
      ffmpeg: '/usr/bin/ffmpeg',
      tasks: [{
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=1:hls_list_size=3:hls_flags=delete_segments]',
        hlsKeep: false
      }]
    }
  };

  const nms = new NodeMediaServer(config);
  const streamKey = process.env.STREAM_KEY || 'default-key';

  nms.on('prePublish', (id, StreamPath, args) => {
    console.log('[RTMP] prePublish:', id, StreamPath);
    // StreamPath format: /live/STREAMKEY_sourceid
    // Validate the stream key prefix
    const pathKey = StreamPath.split('/')[2]; // e.g., "STREAMKEY_source1"
    if (!pathKey || !pathKey.startsWith(streamKey)) {
      console.log('[RTMP] Rejected: invalid stream key');
      const session = nms.getSession(id);
      if (session) session.reject();
    }
  });

  nms.on('postPublish', (id, StreamPath) => {
    console.log('[RTMP] Stream started:', StreamPath);
  });

  nms.on('donePublish', (id, StreamPath) => {
    console.log('[RTMP] Stream ended:', StreamPath);
  });

  return nms;
}

module.exports = { createMediaServer };
