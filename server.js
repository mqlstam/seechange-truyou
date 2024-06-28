const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { generateKeyPair, hashSegment, signHash } = require('./crypto-utils');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const streamKeys = new Map();
const STREAM_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

// Stream health monitoring
const streamHealth = new Map();

function updateStreamHealth(streamKey, status) {
  streamHealth.set(streamKey, {
    status,
    lastUpdate: Date.now()
  });
}

function getStreamHealth(streamKey) {
  return streamHealth.get(streamKey);
}

app.get('/streamer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'streamer.html'));
});

app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

function generateStreamKey() {
  return crypto.randomBytes(8).toString('hex');
}

io.on('connection', (socket) => {
  let ffmpegProcess;
  let streamKey = generateStreamKey();
  let { publicKey, privateKey } = generateKeyPair();
  let isFFmpegRunning = false;
  let inputBuffer = Buffer.alloc(0);

  streamKeys.set(streamKey, {
    publicKey,
    privateKey,
    expiresAt: Date.now() + STREAM_EXPIRY_TIME
  });

  socket.emit('streamKey', streamKey);

  function startFFmpeg() {
    const outputPath = path.join(__dirname, 'media', streamKey);

    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    ffmpegProcess = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'superfast',
      '-tune', 'zerolatency',
      '-crf', '28',
      '-sc_threshold', '0',
      '-g', '60',
      '-keyint_min', '60',
      '-c:a', 'aac',
      '-ar', '44100',
      '-b:a', '128k',
      '-map', '0:v',
      '-map', '0:a',
      '-map', '0:v',
      '-map', '0:a',
      '-map', '0:v',
      '-map', '0:a',
      '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2',
      '-s:v:1', '1280x720',
      '-b:v:1', '1000k',
      '-maxrate:v:1', '1200k',
      '-bufsize:v:1', '2000k',
      '-s:v:2', '854x480',
      '-b:v:2', '600k',
      '-maxrate:v:2', '800k',
      '-bufsize:v:2', '1200k',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+omit_endlist+append_list+discont_start',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(outputPath, '%v/segment%d.m4s'),
      '-master_pl_name', 'master.m3u8',
      '-hls_init_time', '0',
      path.join(outputPath, '%v/playlist.m3u8')
    ]);

    isFFmpegRunning = true;

    ffmpegProcess.stderr.on('data', (data) => {
      // Log FFmpeg output if needed
    });

    ffmpegProcess.on('error', (err) => {
      isFFmpegRunning = false;
      socket.emit('streamError', 'An error occurred while processing the stream.');
    });

    ffmpegProcess.on('exit', (code, signal) => {
      isFFmpegRunning = false;
      if (code !== 0) {
        socket.emit('streamError', 'The streaming process ended unexpectedly.');
      }
    });

    ffmpegProcess.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') {
        isFFmpegRunning = false;
      }
    });
  }

  function writeToFFmpeg(data) {
    if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
      try {
        const success = ffmpegProcess.stdin.write(data);
        if (!success) {
          ffmpegProcess.stdin.once('drain', () => {
            // Handle backpressure
          });
        }
      } catch (err) {
        if (err.code === 'EPIPE') {
          isFFmpegRunning = false;
        }
      }
    } else {
      socket.emit('streamError', 'Unable to process stream data.');
    }
  }

  socket.on('streamData', (data) => {
    inputBuffer = Buffer.concat([inputBuffer, Buffer.from(data)]);
    
    if (!isFFmpegRunning) {
      startFFmpeg();
    }

    while (inputBuffer.length >= CHUNK_SIZE) {
      const chunk = inputBuffer.slice(0, CHUNK_SIZE);
      inputBuffer = inputBuffer.slice(CHUNK_SIZE);
      writeToFFmpeg(chunk);
    }

    updateStreamHealth(streamKey, 'active');
  });

  socket.on('disconnect', () => {
    if (ffmpegProcess) {
      ffmpegProcess.stdin.end();
      ffmpegProcess.kill('SIGINT');
    }
    isFFmpegRunning = false;
    updateStreamHealth(streamKey, 'ended');
  });
});

app.get('/publickey/:streamId', (req, res) => {
  try {
    const streamId = req.params.streamId;
    const streamData = streamKeys.get(streamId);
    if (streamData && streamData.expiresAt > Date.now()) {
      const publicKeyPem = streamData.publicKey;
      const publicKeyBase64 = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\n/g, '');
      res.send(publicKeyBase64);
    } else {
      res.status(404).send('Stream not found or expired');
    }
  } catch (error) {
    res.status(500).send('Internal Server Error');
  }
});

app.get('/publickey/:streamId', (req, res) => {
  try {
    const streamId = req.params.streamId;
    const streamData = streamKeys.get(streamId);
    if (streamData && streamData.expiresAt > Date.now()) {
      const publicKeyPem = streamData.publicKey;
      const publicKeyBase64 = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\n/g, '');
      res.send(publicKeyBase64);
    } else {
      res.status(404).send('Stream not found or expired');
    }
  } catch (error) {
    console.error('Error fetching public key:', error);
    res.status(500).send('Internal Server Error');
  }
});


// Performance monitoring
setInterval(() => {
  const usage = process.cpuUsage();
  const memUsage = process.memoryUsage();
  console.log(`CPU Usage: ${usage.user + usage.system}ms`);
  console.log(`Memory Usage: ${memUsage.heapUsed / 1024 / 1024}MB`);
}, 60000);

const PORT = process.env.PORT || 3000;
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000; // 2 minutes

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
