const config = require('./config');
const { post } = require('./request');

/** 金额（分）→ 元字符串，如 12345 → "123.45" */
function fenToYuan(fen) {
  const n = Number(fen) || 0;
  return (n / 100).toFixed(2);
}

/** 元字符串 → 分，如 "12.34" → 1234；非法输入返回 NaN */
function yuanToFen(yuan) {
  const n = Number(yuan);
  if (!isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 剩余时间拆解；已结束返回 null。nowMs 可传服务端校准后的当前时间 */
function countdownParts(endAt, nowMs) {
  const end = new Date(endAt).getTime();
  if (!end) return null;
  let diff = end - (nowMs || Date.now());
  if (diff <= 0) return null;
  const day = Math.floor(diff / 86400000);
  diff %= 86400000;
  const hour = Math.floor(diff / 3600000);
  diff %= 3600000;
  const min = Math.floor(diff / 60000);
  const sec = Math.floor((diff % 60000) / 1000);
  return { day, hour, min, sec };
}

/** 剩余时间文案：>1天 "剩 x天x小时"，否则 "剩 hh:mm:ss"；已结束返回 "已结束" */
function formatCountdown(endAt, nowMs) {
  const parts = countdownParts(endAt, nowMs);
  if (!parts) return '已结束';
  if (parts.day > 0) return '剩 ' + parts.day + '天' + parts.hour + '小时';
  return '剩 ' + pad2(parts.hour) + ':' + pad2(parts.min) + ':' + pad2(parts.sec);
}

/** 倒计时数值：>1天 "x天x小时"，否则 "hh:mm:ss"；已结束返回 "已结束" */
function formatCountdownShort(endAt, nowMs) {
  const parts = countdownParts(endAt, nowMs);
  if (!parts) return '已结束';
  if (parts.day > 0) return parts.day + '天' + parts.hour + '小时';
  return pad2(parts.hour) + ':' + pad2(parts.min) + ':' + pad2(parts.sec);
}

/** 时间展示：毫秒/ISO → "MM-DD HH:mm" */
function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  return (
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

const ORDER_STATUS_TEXT = {
  pending: '待支付',
  paid: '已支付',
  refund_requested: '退款中',
  refunded: '已退款',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消'
};

const GROUP_STATUS_TEXT = {
  active: '进行中',
  succeeded: '已成团',
  failed: '未成团',
  cancelled: '已截团'
};

function orderStatusText(status) {
  return ORDER_STATUS_TEXT[status] || status || '';
}

function groupStatusText(status) {
  return GROUP_STATUS_TEXT[status] || status || '';
}

/** 是否已登录 */
function isLoggedIn() {
  return !!wx.getStorageSync('token');
}

/** 当前用户资料是否完整（昵称非空；微信授权登录的新用户昵称为空，需完善） */
function isProfileComplete() {
  const user = wx.getStorageSync('user');
  return !!(user && typeof user.nickname === 'string' && user.nickname.trim());
}

/** 未登录则跳登录页，资料不完整则跳完善资料页；返回是否可以继续使用页面 */
function requireLogin() {
  if (!isLoggedIn()) {
    wx.reLaunch({ url: '/pages/login/login' });
    return false;
  }
  if (!isProfileComplete()) {
    wx.redirectTo({ url: '/pages/profile/profile' });
    return false;
  }
  return true;
}

/**
 * 图片 url 拼接：后端返回的 /uploads/xxx 是相对路径，需拼上 host
 * （baseURL 为 http://localhost:3000/api，图片在 http://localhost:3000/uploads/xxx）；
 * 已是完整地址（http 开头）或其他情况原样返回。
 */
function resolveImageUrl(url) {
  if (!url) return '';
  if (url.indexOf('/uploads') === 0) {
    return config.baseURL.replace(/\/api\/?$/, '') + url;
  }
  return url;
}

/** 选择一张本地图片，resolve 临时文件路径；用户取消时 reject errMsg 含 cancel */
function chooseLocalImage() {
  return new Promise((resolve, reject) => {
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        success: (res) => resolve(res.tempFiles[0].tempFilePath),
        fail: reject
      });
    } else {
      // 旧基础库兜底
      wx.chooseImage({
        count: 1,
        success: (res) => resolve(res.tempFilePaths[0]),
        fail: reject
      });
    }
  });
}

/** 与后端一致的合法图片扩展名；识别不出时兜底 jpg */
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

function detectImageExt(filePath) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath || '');
  const ext = m ? m[1].toLowerCase() : '';
  return ALLOWED_EXTS.indexOf(ext) > -1 ? ext : 'jpg';
}

/** 把本地临时图片路径上传到 POST /api/uploads，resolve 完整可访问的图片 url */
async function uploadImageFile(filePath) {
  const base64 = wx.getFileSystemManager().readFileSync(filePath, 'base64');
  const res = await post('/uploads', { data: base64, ext: detectImageExt(filePath) });
  return resolveImageUrl(res.url);
}

/** 选图并上传到 POST /api/uploads，resolve 完整可访问的图片 url */
async function uploadImage() {
  const filePath = await chooseLocalImage();
  return uploadImageFile(filePath);
}

module.exports = {
  fenToYuan,
  yuanToFen,
  formatCountdown,
  formatCountdownShort,
  formatTime,
  orderStatusText,
  groupStatusText,
  isLoggedIn,
  isProfileComplete,
  requireLogin,
  resolveImageUrl,
  uploadImage,
  uploadImageFile
};
