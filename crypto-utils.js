const crypto = require('crypto');

function generateKeyPair() {
    try {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem'
            }
        });
        console.log('Key pair generated successfully');
        return { publicKey, privateKey };
    } catch (error) {
        console.error('Error generating key pair:', error);
        throw error;
    }
}

function hashSegment(segmentData) {
    const hash = crypto.createHash('sha256');
    hash.update(segmentData);
    return hash.digest('hex');
}

function signHash(hash, privateKey) {
    const sign = crypto.createSign('SHA256');
    sign.update(Buffer.from(hash, 'hex'));
    return sign.sign(privateKey, 'base64');
}

module.exports = {
    generateKeyPair,
    hashSegment,
    signHash
};