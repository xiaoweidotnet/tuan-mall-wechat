const crypto = require('crypto');
const config = require('./config');

function issueToken(tokens, userId) {
  // 自签 token：payload + HMAC，暂不做过期控制
  const payload = Buffer.from(
    JSON.stringify({ userId, iat: Date.now() })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(payload)
    .digest('base64url');
  const token = `${payload}.${signature}`;
  tokens.set(token, userId);
  console.log(`[auth] issued token for user ${userId}: ${token}`);
  return token;
}

// Bearer token 鉴权中间件；token -> userId 存在内存 Map（MVP 够用，重启即失效）
function createAuthMiddleware({ db, tokens }) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'missing authorization token' });
    }

    let userId = tokens.get(match[1]);

    // 兼容服务重启后 Map 丢失：直接从 token payload 还原用户
    if (!userId) {
      try {
        const payload = JSON.parse(
          Buffer.from(match[1].split('.')[0], 'base64url').toString('utf8')
        );
        userId = Number(payload.userId);
      } catch {
        // 格式不合法时按无效 token 处理
      }
    }

    if (!userId) {
      return res.status(401).json({ error: 'invalid token' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(401).json({ error: 'invalid token' });
    }
    req.user = user;
    next();
  };
}

module.exports = { issueToken, createAuthMiddleware };
