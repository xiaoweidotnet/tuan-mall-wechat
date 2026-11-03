const { post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

/** wx.login 的 Promise 封装，resolve { code } */
function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res && res.code) {
          resolve(res);
        } else {
          reject(new Error('微信登录失败，请重试'));
        }
      },
      fail: () => reject(new Error('微信登录失败，请重试'))
    });
  });
}

/** 保存登录态并按资料完整度分流：完整 → 首页，不完整 → 完善资料页 */
function enterApp(res) {
  wx.setStorageSync('token', res.token);
  wx.setStorageSync('user', res.user);
  getApp().globalData.user = res.user;
  if (res.profile_completed === false || !util.isProfileComplete()) {
    wx.redirectTo({ url: '/pages/profile/profile' });
  } else {
    wx.switchTab({ url: '/pages/index/index' });
  }
}

Page({
  data: {
    nickname: '',
    loading: false
  },

  onLoad() {
    if (wx.getStorageSync('token')) {
      // 已登录：资料不完整先去完善，完整则直接进首页
      if (util.isProfileComplete()) {
        wx.switchTab({ url: '/pages/index/index' });
      } else {
        wx.redirectTo({ url: '/pages/profile/profile' });
      }
    }
  },

  onInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  /** 微信授权登录：wx.login 拿 code → 后端换 openid → 按需完善资料 */
  async onWechatLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { code } = await wxLogin();
      const res = await post('/auth/wechat-login', { code });
      enterApp(res);
    } catch (err) {
      toastError(err);
      this.setData({ loading: false });
    }
  },

  /** 开发用模拟登录 */
  async onLogin() {
    const nickname = this.data.nickname.trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const res = await post('/auth/mock-login', { nickname });
      // mock-login 不返回 profile_completed，按昵称是否存在判断
      enterApp(Object.assign({ profile_completed: true }, res));
    } catch (err) {
      toastError(err);
    } finally {
      this.setData({ loading: false });
    }
  }
});
