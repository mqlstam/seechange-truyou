const HLSServer = require('hls-server');
const fs = require('fs');
const path = require('path');
const { hashSegment, signHash } = require('./crypto-utils');
const keyManager = require('./key-management/keyManager');

class CustomHLSServer extends HLSServer {
  constructor(server, opts) {
    super(server, opts);
    this.handleSegmentRequest = this.handleSegmentRequest.bind(this);
  }

  handleSegmentRequest(req, res, next) {
    const streamId = req.params.streamId;
    const segmentPath = path.join(this.getDirectory(), req.url);

    fs.readFile(segmentPath, (err, data) => {
      if (err) {
        return next(err);
      }

      const hash = hashSegment(data);
      const keyPair = keyManager.getKeyPair(streamId);
      if (!keyPair) {
        return next(new Error('Stream key pair not found'));
      }
      const signature = signHash(hash, keyPair.privateKey);

      // Voeg hash en handtekening toe aan de segment headers
      res.setHeader('X-Segment-Hash', hash);
      res.setHeader('X-Segment-Signature', signature);

      res.writeHead(200, {
        'Content-Type': 'video/MP2T',
        'Content-Length': data.length
      });
      res.end(data);
    });
  }

  getDirectory() {
    return this.opts.dir;
  }
}

module.exports = CustomHLSServer;