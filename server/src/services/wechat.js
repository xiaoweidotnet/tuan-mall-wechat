const crypto = require('crypto');
const config = require('../config');

const JSCode2Session_URL = 'https://api.weixin.qq.com/sns/jscode2session';

/**
 * 用 wx.login() 拿到的 code 换 openid / session_key。
 *
 * - 配置了 WECHAT_APPID / WECHAT_SECRET：请求微信 jscode2session 接口（真实授权）。
 * - 未配置：开发兜底，由 code 派生稳定的 mock openid（dev_ 前缀），
 *   保证没有微信密钥时也能跑通「授权 → 完善资料」全流程；控制台会 warn。
 *
 * 出错时抛 Error（message 已含可读原因），由调用方转成 HTTP 错误码。
 */
async function code2Session(code) {
  const appid = process.env.WECHAT_APPID || config.wechat.appid;
  const secret = process.env.WECHAT_SECRET || config.wechat.secret;

  if (!appid || !secret || secret.startsWith('DEMO_FAKE_')) {
    const derived = crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16);
    console.warn(
      '[wechat] 未配置 WECHAT_APPID/WECHAT_SECRET，使用开发兜底 openid（dev_' + derived + '）'
    );
    return { openid: `dev_${derived}`, session_key: '', devFallback: true };
  }

  const url =
    `${JSCode2Session_URL}?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code';

  // 联调时打印完整请求地址（含 appid/secret/js_code），方便排查微信侧错误
  if (config.debug) {
    console.log('[wechat] jscode2session request:', url);
  }

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    throw new Error(`微信服务网络异常: ${err.message}`);
  }

  if (!data || data.errcode) {
    const errmsg = (data && data.errmsg) || 'unknown error';
    const err = new Error(`微信登录失败(${(data && data.errcode) || 'unknown'}): ${errmsg}`);
    err.wechatError = true;
    throw err;
  }

  return { openid: data.openid, session_key: data.session_key };
}

module.exports = { code2Session };
