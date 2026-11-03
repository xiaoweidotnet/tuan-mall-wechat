App({
  globalData: {
    user: null
  },

  onLaunch() {
    const user = wx.getStorageSync('user');
    if (user) {
      this.globalData.user = user;
    }
  },

  getUser() {
    if (!this.globalData.user) {
      this.globalData.user = wx.getStorageSync('user') || null;
    }
    return this.globalData.user;
  }
});
