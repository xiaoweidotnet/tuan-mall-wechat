const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB（解码后）

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

module.exports = function uploadsRouter() {
  const router = express.Router();
  ensureUploadDir();

  router.post('/', (req, res) => {
    const { data, ext } = req.body || {};
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'data is required (base64 string)' });
    }
    if (!ALLOWED_EXTS.includes(ext)) {
      return res.status(400).json({ error: `ext must be one of ${ALLOWED_EXTS.join('/')}` });
    }
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) {
      return res.status(400).json({ error: 'data must be a valid base64 string' });
    }
    if (buf.length > MAX_SIZE) {
      return res.status(413).json({ error: 'image too large (max 5MB)' });
    }
    const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    res.status(201).json({ url: `/uploads/${filename}` });
  });

  return router;
};

module.exports.UPLOAD_DIR = UPLOAD_DIR;
