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
    console.log('Streamer page requested');
    res.sendFile(path.join(__dirname, 'public', 'streamer.html'));
});

app.get('/viewer', (req, res) => {
    console.log('Viewer page requested');
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

function generateStreamKey() {
    const key = crypto.randomBytes(8).toString('hex');
    console.log(`Generated new stream key: ${key}`);
    return key;
}



io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);
    
    let ffmpegProcess;
    let streamKey = generateStreamKey();
    let { publicKey, privateKey } = generateKeyPair();
    let isFFmpegRunning = false;
    let inputBuffer = Buffer.alloc(0);
    let isFirstChunk = true;
    let lastDataReceived = Date.now();
    
    streamKeys.set(streamKey, { 
        publicKey, 
        privateKey, 
        expiresAt: Date.now() + STREAM_EXPIRY_TIME 
    });
    socket.emit('streamKey', streamKey);
    console.log(`Sent stream key to client: ${streamKey}`);


    function startFFmpeg() {
        console.log('Initializing FFmpeg process');
        const outputPath = path.join(__dirname, 'media', streamKey);
        if (!fs.existsSync(outputPath)) {
          fs.mkdirSync(outputPath, { recursive: true });
          console.log(`Created output directory: ${outputPath}`);
        }
      
        ffmpegProcess = spawn('ffmpeg', [
          '-i', 'pipe:0',
          '-c:v', 'libx264',
          '-preset', 'superfast',
          '-tune', 'zerolatency',
          '-sc_threshold', '0',
          '-g', '30',
          '-keyint_min', '30',
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
          '-b:v:1', '1500k',
          '-maxrate:v:1', '1600k',
          '-bufsize:v:1', '2250k',
          '-s:v:2', '854x480',
          '-b:v:2', '800k',
          '-maxrate:v:2', '856k',
          '-bufsize:v:2', '1200k',
          '-f', 'hls',
          '-hls_time', '1',
          '-hls_list_size', '3',
          '-hls_flags', 'delete_segments+omit_endlist+append_list+discont_start',
          '-hls_segment_type', 'fmp4',
          '-hls_fmp4_init_filename', path.join(outputPath, '%v', 'init.mp4'),
          '-hls_segment_filename', path.join(outputPath, '%v', 'segment%d.m4s'),
          '-master_pl_name', path.join(outputPath, 'master.m3u8'),
          '-hls_init_time', '0',
          path.join(outputPath, '%v', 'playlist.m3u8')
        ]);
        
        isFFmpegRunning = true;

        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`FFmpeg: ${data}`);
        });

        ffmpegProcess.on('error', (err) => {
            console.error('FFmpeg process error:', err);
            isFFmpegRunning = false;
            socket.emit('streamError', 'An error occurred while processing the stream.');
        });

        ffmpegProcess.on('exit', (code, signal) => {
            console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
            isFFmpegRunning = false;
            if (code !== 0) {
                socket.emit('streamError', 'The streaming process ended unexpectedly.');
            }
        });

        ffmpegProcess.stdin.on('error', (err) => {
            if (err.code === 'EPIPE') {
                console.log('FFmpeg stdin closed');
                isFFmpegRunning = false;
            } else {
                console.error('FFmpeg stdin error:', err);
            }
        });

        console.log('FFmpeg process started');
    }

    function writeToFFmpeg(data) {
        if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
            try {
                const success = ffmpegProcess.stdin.write(data);
                if (!success) {
                    ffmpegProcess.stdin.once('drain', () => {
                    });
                }
            } catch (err) {
                console.error('Error writing to FFmpeg stdin:', err);
                if (err.code === 'EPIPE') {
                    isFFmpegRunning = false;
                }
            }
        } else {
            console.error('FFmpeg process is not ready to receive data');
            socket.emit('streamError', 'Unable to process stream data.');
        }
    }

    socket.on('streamData', (data) => {
        try {
            console.log(`Received stream data chunk of size: ${data.byteLength} bytes`);
            
            if (isFirstChunk) {
                console.log(`First chunk data (first 100 bytes): ${Buffer.from(data).toString('hex', 0, 100)}`);
                isFirstChunk = false;
            }

            inputBuffer = Buffer.concat([inputBuffer, Buffer.from(data)]);

            if (!isFFmpegRunning) {
                startFFmpeg();
            }

            while (inputBuffer.length >= 4096) {
                const chunk = inputBuffer.slice(0, 4096);
                inputBuffer = inputBuffer.slice(4096);
                writeToFFmpeg(chunk);
            }
        } catch (error) {
            console.error('Error processing stream data:', error);
            socket.emit('streamError', 'An unexpected error occurred while processing the stream.');
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        if (ffmpegProcess) {
            ffmpegProcess.stdin.end();
            ffmpegProcess.kill('SIGINT');
            console.log('FFmpeg process terminated');
        }
        isFFmpegRunning = false;
        console.log(`Stream ${streamKey} will expire in ${STREAM_EXPIRY_TIME / 1000} seconds`);
    });
});


app.get('/publickey/:streamId', (req, res) => {
    try {
        const streamId = req.params.streamId;
        console.log(`Public key requested for stream: ${streamId}`);
        const streamData = streamKeys.get(streamId);
        if (streamData && streamData.expiresAt > Date.now()) {
            console.log('Public key found and sent');
            const publicKeyPem = streamData.publicKey;
            const publicKeyBase64 = publicKeyPem
                .replace(/-----BEGIN PUBLIC KEY-----/, '')
                .replace(/-----END PUBLIC KEY-----/, '')
                .replace(/\n/g, '');
            res.send(publicKeyBase64);
        } else {
            console.log('Stream not found or expired');
            res.status(404).send('Stream not found or expired');
        }
    } catch (error) {
        console.error('Error in /publickey route:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.use('/streams/:streamId', (req, res, next) => {
    const streamId = req.params.streamId;
    const filePath = path.join(__dirname, 'media', streamId, req.path);
    
    console.log(`Stream file requested: ${filePath}`);

    const streamData = streamKeys.get(streamId);
    if (!streamData || streamData.expiresAt <= Date.now()) {
        console.log(`Stream ${streamId} not found or expired`);
        return res.status(410).send('Stream has ended or expired');
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(`Error reading file: ${filePath}`, err);
            return res.status(404).send('File not found');
        }

        const hash = hashSegment(data);
        console.log(`File hash: ${hash}`);
        const signature = signHash(hash, streamData.privateKey);
        console.log(`File signed. Signature (first 20 chars): ${signature.substr(0, 20)}...`);

        res.setHeader('X-Segment-Hash', hash);
        res.setHeader('X-Segment-Signature', signature);

        if (req.path.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        } else if (req.path.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/MP2T');
        }

        res.send(data);
        console.log(`Sent file: ${filePath}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});