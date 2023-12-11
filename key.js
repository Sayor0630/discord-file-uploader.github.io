const crypto = require('crypto');

// Generate a 32-byte key using SHA-256 hash of your original key
const originalKey = 'YOUR_ENCRYPTION_KEY';
const key = crypto.createHash('sha256').update(originalKey).digest();

console.log(key.toString('hex')); // Print the generated key in hexadecimal format
