const util = require('../../utils/util');

Page({
  data: {
    user: null
  },

  onShow() {
    if (!util.requireLogin()) return;
    const raw = wx.getStorageSync('user') || null;
    this.setData({
      user: raw ? Object.assign({}, raw, { avatar_display: util.resolveImageUrl(raw.avatar_url) }) : null
    });
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  onLogout() {
    wx.showModal({
      title: '提示',
      content: '确定退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('user');
          getApp().globalData.user = null;
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  }
});
