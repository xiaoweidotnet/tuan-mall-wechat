const { put, toastError } = require('../../utils/request');
const util = require('../../utils/util');

/** wx.showModal 的 Promise 封装（兼容未 promisify 的基础库） */
function showModal(options) {
  return new Promise((resolve) => {
    wx.showModal(Object.assign({}, options, { success: resolve, fail: () => resolve({ confirm: false }) }));
  });
}

Page({
  data: {
    user: null,
    nickname: '',
    avatarUrl: '', // 预览用：本地临时路径或完整 url
    avatarUploaded: '', // 已上传/已存在的服务端头像（/uploads/... 或 http(s)）
    saving: false,
    fromMine: false // 从"我的-编辑资料"进入时保存后返回，而非回首页
  },

  onLoad() {
    if (!wx.getStorageSync('token')) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const user = wx.getStorageSync('user') || {};
    this.setData({
      user,
      nickname: user.nickname || '',
      avatarUrl: user.avatar_url ? util.resolveImageUrl(user.avatar_url) : '',
      avatarUploaded: user.avatar_url || '',
      // 页面栈里还有其他页面 → 从"我的"进入，保存后返回
      fromMine: getCurrentPages().length > 1
    });
  },

  /** 微信头像填写能力回调：detail.avatarUrl 是本地临时路径，保存时再上传 */
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    this.setData({ avatarUrl: url, avatarUploaded: '' });
  },

  /** 相册兜底：旧基础库没有 chooseAvatar，或用户想主动换图 */
  async onPickFromAlbum() {
    wx.showLoading({ title: '上传中', mask: true });
    try {
      const url = await util.uploadImage();
      this.setData({ avatarUrl: url, avatarUploaded: url });
    } catch (err) {
      // 用户取消选图不提示
      if (err && err.errMsg && err.errMsg.indexOf('cancel') > -1) return;
      toastError(err);
    } finally {
      wx.hideLoading();
    }
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onSave() {
    if (this.data.saving) return;
    const nickname = this.data.nickname.trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    if (nickname.length > 20) {
      wx.showToast({ title: '昵称最多 20 字', icon: 'none' });
      return;
    }
    // 头像不强制，但引导设置
    if (!this.data.avatarUrl) {
      const { confirm } = await showModal({
        title: '提示',
        content: '还未设置头像，确定继续吗？'
      });
      if (!confirm) return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    try {
      // chooseAvatar 拿到的是本地临时路径，先上传拿服务端地址
      let avatarUrl = this.data.avatarUploaded;
      if (this.data.avatarUrl && !avatarUrl) {
        avatarUrl = await util.uploadImageFile(this.data.avatarUrl);
      }
      const res = await put('/users/me', { nickname, avatar_url: avatarUrl || '' });
      const user = res.user || Object.assign({}, this.data.user, { nickname, avatar_url: avatarUrl });
      wx.setStorageSync('user', user);
      getApp().globalData.user = user;

      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => {
        if (this.data.fromMine) {
          wx.navigateBack();
        } else {
          wx.switchTab({ url: '/pages/index/index' });
        }
      }, 800);
    } catch (err) {
      wx.hideLoading();
      toastError(err);
      this.setData({ saving: false });
    }
  }
});
