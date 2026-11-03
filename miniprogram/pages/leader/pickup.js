const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    points: [],
    loading: true,
    name: '',
    address: '',
    contact: '',
    submitting: false
  },

  onShow() {
    if (!util.requireLogin()) return;
    this.loadPoints();
  },

  onPullDownRefresh() {
    this.loadPoints().finally(() => wx.stopPullDownRefresh());
  },

  async loadPoints() {
    try {
      const res = await get('/pickup-points');
      const list = Array.isArray(res) ? res : res.list || res.pickup_points || [];
      this.setData({ points: list, loading: false });
    } catch (err) {
      this.setData({ loading: false });
      toastError(err);
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  async onAdd() {
    if (this.data.submitting) return;
    const { name, address, contact } = this.data;
    if (!name.trim() || !address.trim() || !contact.trim()) {
      wx.showToast({ title: '请填写完整自提点信息', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await post('/pickup-points', {
        name: name.trim(),
        address: address.trim(),
        contact: contact.trim()
      });
      wx.showToast({ title: '已添加', icon: 'success' });
      this.setData({ name: '', address: '', contact: '', submitting: false });
      this.loadPoints();
    } catch (err) {
      toastError(err);
      this.setData({ submitting: false });
    }
  }
});
