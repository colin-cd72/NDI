const NodeMediaServer = require('node-media-server');

function createMediaServer() {
  const config = {
    logType: 1, // 0:no log, 1:error, 2:normal, 3:debug
    rtmp: {
      port: parseInt(process.env.RTMP_PORT) || 1935,
      chunk_size: 60000,
      gop_cache: false, // Disable GOP cache for lower latency
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: parseInt(process.env.HTTP_FLV_PORT) || 8000,
      allow_origin: '*',
      mediaroot: './media'
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
