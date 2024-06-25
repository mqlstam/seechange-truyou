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
    
    streamKeys.set(streamKey, { 
        publicKey: publicKey,
        privateKey: privateKey,
        expiresAt: Date.now() + STREAM_EXPIRY_TIME 
    });
    socket.emit('streamKey', streamKey);
    console.log(`Sent stream key to client: ${streamKey}`);

    socket.on('streamData', (data) => {
        console.log(`Received stream data chunk of size: ${data.byteLength} bytes`);
        if (!ffmpegProcess) {
            console.log('Initializing FFmpeg process');
            const outputPath = path.join(__dirname, 'media', streamKey);
            if (!fs.existsSync(outputPath)) {
                fs.mkdirSync(outputPath, { recursive: true });
                console.log(`Created output directory: ${outputPath}`);
            }

            ffmpegProcess = spawn('ffmpeg', [
                '-i', 'pipe:0',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-c:a', 'aac',
                '-f', 'hls',
                '-hls_time', '2',
                '-hls_list_size', '5',
                '-hls_flags', 'delete_segments',
                path.join(outputPath, 'index.m3u8')
            ]);

            ffmpegProcess.stderr.on('data', (data) => {
                console.log(`FFmpeg: ${data}`);
            });

            ffmpegProcess.on('error', (err) => {
                console.error('FFmpeg process error:', err);
            });

            ffmpegProcess.on('exit', (code, signal) => {
                console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
            });

            console.log('FFmpeg process started');
        }

        if (ffmpegProcess.stdin.writable) {
            ffmpegProcess.stdin.write(Buffer.from(data));
        } else {
            console.error('FFmpeg stdin is not writable');
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        if (ffmpegProcess) {
            ffmpegProcess.stdin.end();
            ffmpegProcess.kill('SIGINT');
            console.log('FFmpeg process terminated');
        }
        console.log(`Stream ${streamKey} will expire in ${STREAM_EXPIRY_TIME / 1000} seconds`);
    });
});


app.get('/publickey/:streamId', (req, res) => {
    try {
        const streamId = req.params.streamId;
        console.log(`Public key requested for stream: ${streamId}`);
        const streamData = streamKeys.get(streamId);
        if (streamData && streamData.expiresAt > Date.now()) {
            console.log('Stream data found');
            if (!streamData.publicKey) {
                console.error('Public key is missing from stream data');
                return res.status(500).send('Internal Server Error: Public key is missing');
            }
            console.log('Public key found');
            // The public key is already a PEM string, so we just need to format it
            const publicKeyBase64 = streamData.publicKey
                .replace(/-----BEGIN PUBLIC KEY-----/, '')
                .replace(/-----END PUBLIC KEY-----/, '')
                .replace(/\n/g, '');
            console.log('Public key formatted and sent');
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
            return next(err);
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

// Cleanup expired stream keys
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of streamKeys.entries()) {
        if (value.expiresAt <= now) {
            streamKeys.delete(key);
            console.log(`Removed expired stream key: ${key}`);
        }
    }
}, 60000); // Run every minute

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});