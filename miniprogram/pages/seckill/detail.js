const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

const STATUS_TEXT = {
  not_started: '即将开始',
  ongoing: '抢购中',
  sold_out: '已抢光',
  ended: '已结束',
  terminated: '已结束'
};

const STATUS_TIP = {
  not_started: '活动尚未开始，倒计时结束后即可抢购',
  sold_out: '已抢光，本场活动库存已售完',
  ended: '本场活动已结束',
  terminated: '活动已提前结束'
};

const BUTTON_TEXT = {
  not_started: '即将开始',
  sold_out: '已抢光',
  ended: '已结束',
  terminated: '已结束'
};

// 服务端返回英文错误码，页面展示明确的中文原因
const ERROR_TEXT = {
  NOT_STARTED: '活动还未开始，请稍候',
  ENDED: '活动已结束',
  SOLD_OUT: '已抢光',
  NOT_PURCHASABLE: '活动已结束，无法购买',
  LIMIT_EXCEEDED: '已达到限购数量',
  PRODUCT_OFF: '商品已下架',
  INVALID_QUANTITY: '购买数量不正确',
  ACTIVITY_NOT_FOUND: '活动不存在或已下线'
};

function genRequestId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

Page({
  data: {
    id: null,
    activity: null,
    product: {},
    priceText: '0.00',
    originalPriceText: '',
    remainingStock: 0,
    limitPerUser: 0,
    payTimeoutMinutes: 15,
    startText: '',
    endText: '',
    status: '',
    statusText: '',
    statusTip: '',
    countdownLabel: '',
    countdownText: '',
    canBuy: false,
    buttonText: '不可购买',
    disabled: true,

    // 抢购面板
    quantity: 1,
    maxQuantity: 1,
    deliveryMethods: ['express', 'pickup'],
    deliveryMethod: 'express',
    address: { name: '', phone: '', detail: '' },
    pickupPoints: [],
    pickupIndex: -1,

    submitting: false
  },

  timer: null,
  // 服务端时间校准：serverOffset = 服务端当前时间 - 本机当前时间
  serverOffset: 0,

  onLoad(options) {
    if (!util.requireLogin()) return;
    this.setData({ id: options.id });
    this.loadDetail();
    this.loadPickupPoints();
  },

  onShow() {
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  onPullDownRefresh() {
    this.loadDetail().finally(() => wx.stopPullDownRefresh());
  },

  serverNow() {
    return Date.now() + this.serverOffset;
  },

  async loadDetail() {
    try {
      const res = await get('/seckill/activities/' + this.data.id);
      const activity = res.activity || res;
      const product = res.product || activity.product || {};
      product.images = (Array.isArray(product.images) ? product.images : []).map(
        util.resolveImageUrl
      );

      this.serverOffset = activity.server_time
        ? Date.parse(activity.server_time) - Date.now()
        : 0;

      const remaining = activity.remaining_stock != null ? activity.remaining_stock : 0;
      const limit = activity.limit_per_user || 0;
      const maxQuantity = Math.max(1, Math.min(remaining || 1, limit || 1));
      this.setData({
        activity,
        product,
        priceText: util.fenToYuan(activity.seckill_price),
        originalPriceText: product.price ? util.fenToYuan(product.price) : '',
        remainingStock: remaining,
        limitPerUser: limit,
        payTimeoutMinutes: activity.pay_timeout_minutes || 15,
        startText: util.formatTime(activity.start_at),
        endText: util.formatTime(activity.end_at),
        maxQuantity,
        quantity: Math.min(this.data.quantity, maxQuantity)
      });
      this.refreshStatus();
    } catch (err) {
      toastError(err);
    }
  },

  async loadPickupPoints() {
    try {
      const res = await get('/pickup-points');
      const list = Array.isArray(res) ? res : res.list || res.pickup_points || [];
      this.setData({ pickupPoints: list });
    } catch (err) {
      // 自提点加载失败不阻塞页面
    }
  },

  /** 用服务端时间推导当前状态，避免本机时间不准导致按钮状态错误 */
  refreshStatus() {
    const activity = this.data.activity;
    if (!activity) return;
    const now = this.serverNow();
    const start = Date.parse(activity.start_at);
    const end = Date.parse(activity.end_at);
    let status;
    if (activity.lifecycle_status === 'terminated') {
      status = 'terminated';
    } else if (now < start) {
      status = 'not_started';
    } else if (now >= end) {
      status = 'ended';
    } else if (activity.remaining_stock <= 0) {
      status = 'sold_out';
    } else {
      status = 'ongoing';
    }

    const canBuy = status === 'ongoing' && this.data.remainingStock > 0;
    let countdownLabel = '';
    let countdownText = '';
    if (status === 'not_started') {
      countdownLabel = '距开始';
      countdownText = util.formatCountdownShort(activity.start_at, now);
    } else if (status === 'ongoing') {
      countdownLabel = '距结束';
      countdownText = util.formatCountdownShort(activity.end_at, now);
    }

    this.setData({
      status,
      statusText: STATUS_TEXT[status] || '',
      statusTip:
        status === 'ongoing'
          ? this.data.remainingStock > 0
            ? '库存有限，先到先得'
            : '已抢光'
          : STATUS_TIP[status] || '',
      countdownLabel,
      countdownText,
      canBuy,
      disabled: !canBuy,
      buttonText: canBuy ? '立即抢购' : BUTTON_TEXT[status] || '不可购买'
    });
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.refreshStatus(), 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  onMinus() {
    if (this.data.quantity > 1) {
      this.setData({ quantity: this.data.quantity - 1 });
    }
  },

  onPlus() {
    if (this.data.quantity < this.data.maxQuantity) {
      this.setData({ quantity: this.data.quantity + 1 });
    } else {
      wx.showToast({ title: '已达购买上限', icon: 'none' });
    }
  },

  onQuantityInput(e) {
    let quantity = parseInt(e.detail.value, 10);
    if (isNaN(quantity) || quantity < 1) quantity = 1;
    if (quantity > this.data.maxQuantity) quantity = this.data.maxQuantity;
    this.setData({ quantity });
  },

  onMethodChange(e) {
    this.setData({ deliveryMethod: e.currentTarget.dataset.method });
  },

  onAddressInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['address.' + field]: e.detail.value });
  },

  onPickupChange(e) {
    this.setData({ pickupIndex: Number(e.detail.value) });
  },

  buildOrderPayload() {
    const payload = {
      quantity: this.data.quantity,
      request_id: genRequestId(),
      delivery_method: this.data.deliveryMethod
    };
    if (this.data.deliveryMethod === 'express') {
      const { name, phone, detail } = this.data.address;
      if (!name.trim() || !phone.trim() || !detail.trim()) {
        throw new Error('请填写完整收货地址');
      }
      payload.address = { name: name.trim(), phone: phone.trim(), detail: detail.trim() };
    } else {
      const point = this.data.pickupPoints[this.data.pickupIndex];
      if (!point) throw new Error('请选择自提点');
      payload.pickup_point_id = point.id;
    }
    return payload;
  },

  async submitOrder() {
    if (this.data.submitting) return;
    if (!this.data.activity) return;
    if (!this.data.canBuy) {
      wx.showToast({ title: this.data.statusTip || '当前不可购买', icon: 'none' });
      return;
    }

    let payload;
    try {
      payload = this.buildOrderPayload();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      const order = await post(
        '/seckill/activities/' + this.data.activity.id + '/orders',
        payload
      );
      this.setData({ submitting: false });
      // 状态与库存可能已变化，刷新详情
      this.loadDetail();

      const minutes = this.data.payTimeoutMinutes;
      wx.showModal({
        title: '抢购成功',
        content:
          '订单已锁定，请在 ' + minutes + ' 分钟内完成支付，超时将自动取消并释放库存。',
        confirmText: '去支付',
        cancelText: '稍后支付',
        success: (res) => {
          if (res.confirm) {
            this.payOrder(order.id);
          } else {
            wx.switchTab({ url: '/pages/orders/orders' });
          }
        }
      });
    } catch (err) {
      this.setData({ submitting: false });
      wx.showToast({
        title: ERROR_TEXT[err.code] || err.message || '抢购失败，请稍后重试',
        icon: 'none',
        duration: 2500
      });
      // 售罄/限购/活动状态变化：刷新页面状态，方便用户按提示重试
      if (ERROR_TEXT[err.code]) this.loadDetail();
    }
  },

  async payOrder(orderId) {
    try {
      await post('/seckill/orders/' + orderId + '/pay');
      wx.showToast({ title: '支付成功', icon: 'success' });
    } catch (err) {
      toastError(err);
    }
    setTimeout(() => {
      wx.switchTab({ url: '/pages/orders/orders' });
    }, 1200);
  }
});
