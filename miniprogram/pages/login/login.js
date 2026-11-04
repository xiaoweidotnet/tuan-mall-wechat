const { post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;
const RESEND_SECONDS = 60;

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
    loginMode: 'wechat', // wechat | phone
    nickname: '',
    phone: '',
    code: '',
    countdown: 0,
    sending: false,
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

  onUnload() {
    this.clearCountdown();
  },

  /** 切换「微信登录 / 手机号登录」 */
  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode !== 'wechat' && mode !== 'phone') return;
    this.setData({ loginMode: mode });
  },

  onInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value });
  },

  /** 获取短信验证码：手机号格式校验 → 后端发送 → 60 秒倒计时 */
  async onSendCode() {
    if (this.data.sending || this.data.countdown > 0) return;
    const phone = this.data.phone.trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }

    this.setData({ sending: true });
    try {
      await post('/auth/send-code', { phone });
      wx.showToast({ title: '验证码已发送', icon: 'success' });
      this.startCountdown(RESEND_SECONDS);
    } catch (err) {
      toastError(err);
    } finally {
      this.setData({ sending: false });
    }
  },

  startCountdown(seconds) {
    this.clearCountdown();
    this.setData({ countdown: seconds });
    this.countdownTimer = setInterval(() => {
      const next = this.data.countdown - 1;
      if (next <= 0) {
        this.clearCountdown();
        this.setData({ countdown: 0 });
      } else {
        this.setData({ countdown: next });
      }
    }, 1000);
  },

  clearCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  /** 手机号 + 验证码登录；资料不完整时与微信登录一样跳完善资料页 */
  async onPhoneLogin() {
    if (this.data.loading) return;
    const phone = this.data.phone.trim();
    const code = this.data.code.trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    if (!CODE_RE.test(code)) {
      wx.showToast({ title: '请输入 6 位验证码', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    try {
      const res = await post('/auth/phone-login', { phone, code });
      enterApp(res);
    } catch (err) {
      toastError(err);
      this.setData({ loading: false });
    }
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
