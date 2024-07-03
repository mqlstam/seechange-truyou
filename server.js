const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { generateKeyPair, hashSegment, signHash } = require("./crypto-utils");
const os = require("os");
const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");
const { PassThrough } = require("stream");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const streamKeys = new Map();
const STREAM_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

// Stream health monitoring
const streamHealth = new Map();

// Chat data structure
const chatMessages = [];
const viewers = new Map();

// MongoDB connection
const mongoURI =
  "mongodb+srv://prevfcode:5OgL8arYulfuFpVr@cluster0.euilskk.mongodb.net/FitnessManagementApp?retryWrites=true&w=majority";
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });

const connection = mongoose.connection;
let gfs;

connection.once("open", () => {
  console.log("MongoDB connected");
  gfs = new GridFSBucket(connection.db, {
    bucketName: "uploads",
  });
});

function updateStreamHealth(streamKey, status) {
  streamHealth.set(streamKey, {
    status,
    lastUpdate: Date.now(),
  });
}

app.get("/streamer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "streamer.html"));
});

app.get("/viewer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

app.use("/media", express.static(path.join(__dirname, "media")));

function generateStreamKey() {
  return crypto.randomBytes(8).toString("hex");
}

io.on("connection", (socket) => {
  let ffmpegProcess;
  let streamKey = generateStreamKey();
  let { publicKey, privateKey } = generateKeyPair();
  let isFFmpegRunning = false;
  let inputBuffer = Buffer.alloc(0);

  streamKeys.set(streamKey, {
    publicKey,
    privateKey,
    expiresAt: Date.now() + STREAM_EXPIRY_TIME,
  });

  socket.emit("streamKey", streamKey);

  function startFFmpeg() {
    const passThroughStream = new PassThrough();
    const outputPath = path.join(__dirname, "media", streamKey); // zoeken naar pad directory

    if (!fs.existsSync(outputPath)) {
      // als niet bestaat dan aanmaken
      fs.mkdirSync(outputPath, { recursive: true });
    }

    // Determine available hardware acceleration
    let hwAccel = "";
    if (os.platform() === "linux") {
      if (fs.existsSync("/dev/nvidia0")) {
        hwAccel = "h264_nvenc";
      } else if (fs.existsSync("/dev/dri/renderD128")) {
        hwAccel = "h264_vaapi";
      }
    } else if (os.platform() === "win32") {
      hwAccel = "h264_qsv";
    }

    ffmpegProcess = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-c:v",
      hwAccel ? hwAccel : "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-crf",
      // "30",
      "75",
      "-g",
      "240",
      "-keyint_min",
      "240",
      "-sc_threshold",
      "0",
      "-b:v",
      "500k",

      // "50k",
      "-maxrate",
      "600k",
      "-bufsize",
      "800k",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      // "8k",
      "-ar",
      "44100",
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_list_size",
      "10",
      "-hls_flags",
      "delete_segments+omit_endlist+append_list+discont_start",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      path.join(outputPath, "segment%d.m4s"),
      path.join(outputPath, "playlist.m3u8"),
    ]);

    isFFmpegRunning = true;

    // Pipe FFmpeg output to GridFS
    const uploadStream = gfs.openUploadStream(streamKey);
    ffmpegProcess.stdout.pipe(uploadStream);

    ffmpegProcess.stderr.on("data", (data) => {
      // Log FFmpeg output if needed
      // console.log(`FFmpeg: ${data}`);
    });

    ffmpegProcess.on("error", (err) => {
      console.error("FFmpeg error:", err);
      isFFmpegRunning = false;
      socket.emit(
        "streamError",
        "An error occurred while processing the stream."
      );
    });

    ffmpegProcess.on("exit", (code, signal) => {
      console.log(
        `FFmpeg process exited with code ${code} and signal ${signal}`
      );
      isFFmpegRunning = false;
      if (code !== 0 && code !== null) {
        socket.emit("streamError", "The streaming process ended unexpectedly.");
      }
    });

    return passThroughStream;
  }

  function writeToFFmpeg(data) {
    if (
      ffmpegProcess &&
      ffmpegProcess.stdin &&
      !ffmpegProcess.stdin.destroyed
    ) {
      const success = ffmpegProcess.stdin.write(data);
      if (!success) {
        ffmpegProcess.stdin.once("drain", () => {
          // Handle backpressure
        });
      }
    } else {
      socket.emit("streamError", "Unable to process stream data.");
    }
  }

  socket.on("streamData", (data) => {
    if (!isFFmpegRunning) {
      startFFmpeg();
    }

    writeToFFmpeg(Buffer.from(data));
    updateStreamHealth(streamKey, "active");
  });

  socket.on("chatMessage", (message) => {
    const chatMessage = {
      streamKey,
      message,
      timestamp: new Date(),
    };
    chatMessages.push(chatMessage);
    io.emit("chatMessage", chatMessage);
  });

  socket.on("joinStream", (key) => {
    if (!viewers.has(key)) {
      viewers.set(key, new Set());
    }
    viewers.get(key).add(socket.id);
  });

  socket.on("disconnect", () => {
    if (ffmpegProcess) {
      ffmpegProcess.stdin.end();
      ffmpegProcess.kill("SIGINT");
    }
    isFFmpegRunning = false;
    updateStreamHealth(streamKey, "ended");

    // Remove viewer from viewers list
    viewers.forEach((value, key) => {
      value.delete(socket.id);
    });
  });
});

app.get("/publickey/:streamId", (req, res) => {
  try {
    const streamId = req.params.streamId;
    const streamData = streamKeys.get(streamId);
    if (streamData && streamData.expiresAt > Date.now()) {
      const publicKeyPem = streamData.publicKey;
      const publicKeyBase64 = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/, "")
        .replace(/-----END PUBLIC KEY-----/, "")
        .replace(/\n/g, "");
      res.send(publicKeyBase64);
    } else {
      res.status(404).send("Stream not found or expired");
    }
  } catch (error) {
    console.error("Error fetching public key:", error);
    res.status(500).send("Internal Server Error");
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
const IP_ADDRESS = "0.0.0.0"; // This allows connections from any IP

server.listen(PORT, IP_ADDRESS, () => {
  console.log(`Server running on http://${IP_ADDRESS}:${PORT}`);
});
