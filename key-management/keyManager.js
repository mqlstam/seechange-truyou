const crypto = require('crypto');
const fs = require('fs');

class KeyManager {
  constructor() {
    this.keys = new Map();
  }

  generateKeyPair(streamId) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    this.keys.set(streamId, { publicKey, privateKey });

    // Sla de keys op in een beveiligde omgeving (niet in plaintext voor productie!)
    fs.writeFileSync(`keys/${streamId}_public.pem`, publicKey.export({ type: 'pkcs1', format: 'pem' }));
    fs.writeFileSync(`keys/${streamId}_private.pem`, privateKey.export({ type: 'pkcs1', format: 'pem' }));

    return { publicKey, privateKey };
  }

  getKeyPair(streamId) {
    return this.keys.get(streamId);
  }
}

module.exports = new KeyManager();