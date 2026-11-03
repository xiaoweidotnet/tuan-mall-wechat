const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    groupId: null,
    orders: [],
    loading: true,
    shipOrderId: null,
    trackingNo: ''
  },

  onLoad(options) {
    if (options && options.group_id) {
      this.setData({ groupId: options.group_id });
    }
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
      const res = await get('/orders', { role: 'leader' });
      let list = Array.isArray(res) ? res : res.list || res.orders || [];
      if (this.data.groupId) {
        list = list.filter((o) => String(o.group_id) === String(this.data.groupId));
      }
      this.setData({
        orders: list.map((o) => this.decorate(o)),
        loading: false
      });
    } catch (err) {
      this.setData({ loading: false });
      toastError(err);
    }
  },

  decorate(o) {
    return Object.assign({}, o, {
      statusText: util.orderStatusText(o.status),
      payText: util.fenToYuan(o.pay_amount),
      createdText: util.formatTime(o.created_at),
      isPickup: o.delivery_method === 'pickup',
      addressText: o.address
        ? (o.address.name || '') + ' ' + (o.address.phone || '') + ' ' + (o.address.detail || '')
        : ''
    });
  },

  /** 展开/收起发货单号输入 */
  onShowShipInput(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({
      shipOrderId: this.data.shipOrderId === id ? null : id,
      trackingNo: ''
    });
  },

  onTrackingInput(e) {
    this.setData({ trackingNo: e.detail.value });
  },

  async onShip() {
    const trackingNo = this.data.trackingNo.trim();
    if (!trackingNo) {
      wx.showToast({ title: '请输入快递单号', icon: 'none' });
      return;
    }
    try {
      await post('/orders/' + this.data.shipOrderId + '/ship', {
        tracking_no: trackingNo
      });
      wx.showToast({ title: '已发货', icon: 'success' });
      this.setData({ shipOrderId: null, trackingNo: '' });
      this.loadOrders();
    } catch (err) {
      toastError(err);
    }
  },

  onApproveRefund(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '退款审批',
      content: '同意退款？库存将回补，货款退回买家。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await post('/orders/' + id + '/refund/approve');
          wx.showToast({ title: '已同意退款', icon: 'success' });
          this.loadOrders();
        } catch (err) {
          toastError(err);
        }
      }
    });
  },

  onConfirmPickup(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '自提核销',
      content: '确认买家已取货？核销后订单完成。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await post('/orders/' + id + '/confirm-pickup');
          wx.showToast({ title: '已核销', icon: 'success' });
          this.loadOrders();
        } catch (err) {
          toastError(err);
        }
      }
    });
  }
});
