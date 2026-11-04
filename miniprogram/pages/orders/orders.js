const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

const SECKILL_STATUS_TEXT = {
  pending: '待支付',
  paid: '待发货',
  cancelled: '已取消',
  refunded: '已退款'
};

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
      // 秒杀订单与普通订单合并展示；秒杀接口异常不影响普通订单
      const [res, seckillRes] = await Promise.all([
        get('/orders', { role: 'buyer' }),
        get('/seckill/orders').catch(() => [])
      ]);
      const normal = (Array.isArray(res) ? res : res.list || res.orders || []).map(
        (o) => this.decorate(o)
      );
      const seckill = (Array.isArray(seckillRes) ? seckillRes : []).map((o) =>
        this.decorateSeckill(o)
      );
      const list = normal
        .concat(seckill)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      this.setData({ orders: list, loading: false });
    } catch (err) {
      this.setData({ loading: false });
      toastError(err);
    }
  },

  decorate(o) {
    return Object.assign({}, o, {
      kind: 'group',
      titleText: o.group_title || (o.group && o.group.title) || '',
      statusText: util.orderStatusText(o.status),
      payText: util.fenToYuan(o.pay_amount),
      totalText: util.fenToYuan(o.total_amount),
      createdText: util.formatTime(o.created_at),
      isPickup: o.delivery_method === 'pickup'
    });
  },

  decorateSeckill(o) {
    const deadline =
      o.status === 'pending' ? util.formatCountdownShort(o.expires_at) : '';
    return Object.assign({}, o, {
      kind: 'seckill',
      isSeckill: true,
      titleText: o.activity_title || '秒杀商品',
      statusText: SECKILL_STATUS_TEXT[o.status] || util.orderStatusText(o.status),
      payText: util.fenToYuan(o.pay_amount),
      totalText: util.fenToYuan(o.pay_amount),
      createdText: util.formatTime(o.created_at),
      isPickup: o.delivery_method === 'pickup',
      payDeadlineText: deadline ? '请在 ' + deadline + ' 内完成支付，超时自动取消' : ''
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

  orderBase(kind) {
    return (kind === 'seckill' ? '/seckill' : '') + '/orders/';
  },

  onPay(e) {
    const { id, kind } = e.currentTarget.dataset;
    this.doAction(this.orderBase(kind) + id + '/pay');
  },

  onCancel(e) {
    const { id, kind } = e.currentTarget.dataset;
    this.doAction(this.orderBase(kind) + id + '/cancel', '确定取消该订单吗？');
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
