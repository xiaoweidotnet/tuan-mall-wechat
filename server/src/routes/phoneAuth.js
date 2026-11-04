const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { issueToken } = require('../auth');
const { now } = require('../db');

const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;
const HOUR_MS = 60 * 60 * 1000;

// 默认值可通过 createApp({ smsLimits }) 覆盖（测试用来缩短有效期/放宽间隔）
const DEFAULT_LIMITS = {
  codeTtlMs: 5 * 60 * 1000, // 验证码 5 分钟有效
  sendIntervalMs: 60 * 1000, // 同一手机号 60 秒内只能发一次
  phoneHourlyLimit: 5, // 同一手机号每小时最多 5 条
  ipHourlyLimit: 20, // 同一 IP 每小时最多 20 条
};

/** 验证码只存 HMAC，避免数据库泄露后直接拿到可用验证码 */
function hashCode(phone, code) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${phone}:${code}`)
    .digest('hex');
}

/** req.ip 在 IPv4-mapped IPv6（::ffff:127.0.0.1）下归一化，便于按 IP 限流 */
function clientIp(req) {
  return String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function createPhoneAuthRouter({ db, tokens, sms, isProfileComplete, limits = {} }) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const router = express.Router();

  // 发送短信验证码：格式校验 → 手机号/IP 限流 → 落库（哈希）→ provider 发送
  router.post('/send-code', async (req, res, next) => {
    try {
      const phone = typeof (req.body || {}).phone === 'string' ? req.body.phone.trim() : '';
      if (!PHONE_RE.test(phone)) {
        return res.status(400).json({ error: '手机号格式不正确' });
      }

      const ip = clientIp(req);
      const nowMs = Date.now();
      const since = new Date(nowMs - HOUR_MS).toISOString();

      // 同一手机号的最小发送间隔
      const latest = db
        .prepare('SELECT created_at FROM sms_codes WHERE phone = ? ORDER BY id DESC LIMIT 1')
        .get(phone);
      if (latest) {
        const elapsed = nowMs - Date.parse(latest.created_at);
        if (elapsed < cfg.sendIntervalMs) {
          const retryAfter = Math.max(1, Math.ceil((cfg.sendIntervalMs - elapsed) / 1000));
          return res.status(429).json({
            error: `验证码发送过于频繁，请 ${retryAfter} 秒后重试`,
            retry_after: retryAfter,
          });
        }
      }

      // 同一手机号 / 同一 IP 的每小时发送次数限制
      const phoneCount = db
        .prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE phone = ? AND created_at > ?')
        .get(phone, since).n;
      if (phoneCount >= cfg.phoneHourlyLimit) {
        return res.status(429).json({ error: '该手机号获取验证码次数过多，请稍后再试' });
      }
      if (ip) {
        const ipCount = db
          .prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE ip = ? AND created_at > ?')
          .get(ip, since).n;
        if (ipCount >= cfg.ipHourlyLimit) {
          return res.status(429).json({ error: '当前网络获取验证码次数过多，请稍后再试' });
        }
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const info = db
        .prepare(
          `INSERT INTO sms_codes (phone, code_hash, ip, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          phone,
          hashCode(phone, code),
          ip,
          now(),
          new Date(nowMs + cfg.codeTtlMs).toISOString()
        );

      try {
        await sms.sendVerificationCode({ phone, code });
      } catch (err) {
        // 发送失败不占用限流额度，也不留下一个用户永远收不到的验证码
        db.prepare('DELETE FROM sms_codes WHERE id = ?').run(info.lastInsertRowid);
        console.error('[auth] 短信验证码发送失败:', err.message);
        return res.status(502).json({ error: '短信发送失败，请稍后重试' });
      }

      res.json({
        sent: true,
        expires_in: Math.floor(cfg.codeTtlMs / 1000),
        provider: sms.name,
      });
    } catch (err) {
      next(err);
    }
  });

  // 手机号 + 验证码登录：校验并作废验证码 → 按手机号找/建用户 → 签发同格式 token
  router.post('/phone-login', (req, res, next) => {
    try {
      const body = req.body || {};
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      const code = body.code === undefined || body.code === null ? '' : String(body.code).trim();

      if (!PHONE_RE.test(phone)) {
        return res.status(400).json({ error: '手机号格式不正确' });
      }
      if (!CODE_RE.test(code)) {
        return res.status(400).json({ error: '验证码格式不正确' });
      }

      const row = db
        .prepare(
          'SELECT * FROM sms_codes WHERE phone = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1'
        )
        .get(phone);
      if (!row) {
        return res.status(400).json({ error: '验证码错误或已失效' });
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        return res.status(400).json({ error: '验证码已过期，请重新获取' });
      }
      if (row.code_hash !== hashCode(phone, code)) {
        return res.status(400).json({ error: '验证码错误' });
      }

      // 一次性使用：条件更新防止并发重复消费
      const usedAt = now();
      const consumed = db
        .prepare('UPDATE sms_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(usedAt, row.id);
      if (consumed.changes !== 1) {
        return res.status(400).json({ error: '验证码已失效，请重新获取' });
      }
      // 同一手机号其它未使用的旧验证码一并作废
      db.prepare('UPDATE sms_codes SET used_at = ? WHERE phone = ? AND used_at IS NULL').run(
        usedAt,
        phone
      );

      let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      if (!user) {
        // users.openid 为 NOT NULL：手机号用户用 phone_ 前缀占位，保持与微信用户同一张表
        const info = db
          .prepare(
            'INSERT INTO users (openid, phone, nickname, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run(`phone_${phone}`, phone, '', '', usedAt);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      }

      const token = issueToken(tokens, user.id);
      res.status(201).json({ token, user, profile_completed: isProfileComplete(user) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPhoneAuthRouter, PHONE_RE, CODE_RE };
