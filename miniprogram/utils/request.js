const config = require('./config');

/**
 * 封装 wx.request：
 * - baseURL 集中在 utils/config.js
 * - 自动携带 Authorization: Bearer <token>（token 存于 storage）
 * - 401 时清理登录态并跳转登录页
 * - 返回 Promise，resolve 响应体，reject Error(message)
 */
function request(options) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('token');
    const header = Object.assign(
      { 'Content-Type': 'application/json' },
      options.header || {}
    );
    if (token) {
      header['Authorization'] = 'Bearer ' + token;
    }

    wx.request({
      url: config.baseURL + options.url,
      method: options.method || 'GET',
      data: options.data || {},
      header,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('user');
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error('登录已过期，请重新登录'));
        } else {
          const msg =
            (res.data && (res.data.message || res.data.error)) ||
            '请求失败(' + res.statusCode + ')';
          reject(new Error(msg));
        }
      },
      fail() {
        reject(new Error('网络异常，请确认后端服务已启动'));
      }
    });
  });
}

function get(url, data) {
  return request({ url, method: 'GET', data });
}

function post(url, data) {
  return request({ url, method: 'POST', data });
}

function put(url, data) {
  return request({ url, method: 'PUT', data });
}

/** 出错时统一 toast 提示 */
function toastError(err) {
  wx.showToast({
    title: (err && err.message) || '操作失败',
    icon: 'none',
    duration: 2000
  });
}

module.exports = { request, get, post, put, toastError };
