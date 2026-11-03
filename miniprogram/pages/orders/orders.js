const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    orders: [],
    loading: true
  },

  onShow() {
    if (!util.requireLogin()) return;
    this.loadOrders();
  },

  onPullDownRefresh() {
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  async loadOrders() {
    try {
      const res = await get('/orders', { role: 'buyer' });
      const list = (Array.isArray(res) ? res : res.list || res.orders || []).map(
        (o) => this.decorate(o)
      );
      this.setData({ orders: list, loading: false });
    } catch (err) {
      this.setData({ loading: false });
      toastError(err);
    }
  },

  decorate(o) {
    return Object.assign({}, o, {
      statusText: util.orderStatusText(o.status),
      payText: util.fenToYuan(o.pay_amount),
      totalText: util.fenToYuan(o.total_amount),
      createdText: util.formatTime(o.created_at),
      isPickup: o.delivery_method === 'pickup'
    });
  },

  async doAction(url, confirmText) {
    const doIt = async () => {
      try {
        await post(url);
        wx.showToast({ title: '操作成功', icon: 'success' });
        this.loadOrders();
      } catch (err) {
        toastError(err);
      }
    };
    if (confirmText) {
      wx.showModal({
        title: '提示',
        content: confirmText,
        success: (res) => {
          if (res.confirm) doIt();
        }
      });
    } else {
      doIt();
    }
  },

  onPay(e) {
    this.doAction('/orders/' + e.currentTarget.dataset.id + '/pay');
  },

  onCancel(e) {
    this.doAction(
      '/orders/' + e.currentTarget.dataset.id + '/cancel',
      '确定取消该订单吗？'
    );
  },

  onRefund(e) {
    this.doAction(
      '/orders/' + e.currentTarget.dataset.id + '/refund',
      '确定申请退款吗？'
    );
  },

  onConfirmReceipt(e) {
    this.doAction(
      '/orders/' + e.currentTarget.dataset.id + '/confirm-receipt',
      '确认已收到货？'
    );
  }
});
