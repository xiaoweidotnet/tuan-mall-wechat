const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    id: null,
    group: null,
    priceText: '0.00',
    originalPriceText: '',
    sold: 0,
    stock: 0,
    limitPerUser: 0,
    rulesText: '',
    countdownText: '',
    seckillNotStart: false,
    seckillStartText: '',

    // 下单面板
    quantity: 1,
    maxQuantity: 99,
    deliveryMethods: [],
    deliveryMethod: '',
    address: { name: '', phone: '', detail: '' },
    pickupPoints: [],
    pickupIndex: -1,

    // 金额预览
    totalText: '0.00',
    reductionText: '',
    payText: '0.00',

    submitting: false
  },

  timer: null,

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

  async loadDetail() {
    try {
      const res = await get('/groups/' + this.data.id);
      const g = res.group || res;
      // 兼容两种返回：product 嵌套对象 或 商品字段平铺在 group 上
      const product = g.product || {
        description: g.description,
        images: g.images,
        price: g.price,
        original_price: g.original_price,
        stock: g.stock,
        limit_per_user: g.limit_per_user
      };
      g.product = product;
      // 商品图片 / 详情图统一为数组并拼成完整可访问 url
      product.images = (Array.isArray(product.images) ? product.images : []).map(
        util.resolveImageUrl
      );
      product.detail_images = (
        Array.isArray(product.detail_images) ? product.detail_images : []
      ).map(util.resolveImageUrl);
      const price = g.price != null ? g.price : product.price;
      const originalPrice =
        g.original_price != null ? g.original_price : product.original_price;
      const stock = g.stock != null ? g.stock : product.stock || 0;
      const limitPerUser =
        g.limit_per_user != null ? g.limit_per_user : product.limit_per_user || 0;
      const rules = g.full_reduction_rules || [];

      let maxQuantity = 999;
      if (stock > 0) maxQuantity = Math.min(maxQuantity, stock);
      if (limitPerUser > 0) maxQuantity = Math.min(maxQuantity, limitPerUser);
      if (maxQuantity < 1) maxQuantity = 1;

      const methods = Array.isArray(g.delivery_methods)
        ? g.delivery_methods
        : ['express'];

      this.setData({
        group: g,
        priceText: util.fenToYuan(price),
        originalPriceText: originalPrice ? util.fenToYuan(originalPrice) : '',
        sold:
          g.sold_quantity != null
            ? g.sold_quantity
            : g.sold != null
            ? g.sold
            : 0,
        stock,
        limitPerUser,
        rulesText: rules
          .map(
            (r) =>
              '满' + util.fenToYuan(r.threshold) + '减' + util.fenToYuan(r.reduction)
          )
          .join('，'),
        maxQuantity,
        deliveryMethods: methods,
        deliveryMethod: methods[0] || 'express',
        countdownText: g.status === 'active' ? util.formatCountdown(g.end_at) : '',
        seckillStartText: g.is_seckill && g.seckill_start_at
          ? util.formatTime(g.seckill_start_at)
          : ''
      });
      this.priceFen = price || 0;
      this.rules = rules;
      this.updateAmount();
      this.checkSeckill();
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

  checkSeckill() {
    const g = this.data.group;
    if (!g || !g.is_seckill || !g.seckill_start_at) return;
    const notStart = new Date(g.seckill_start_at).getTime() > Date.now();
    this.setData({ seckillNotStart: notStart });
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      const g = this.data.group;
      if (!g) return;
      this.setData({
        countdownText: g.status === 'active' ? util.formatCountdown(g.end_at) : ''
      });
      this.checkSeckill();
    }, 1000);
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
      this.updateAmount();
    }
  },

  onPlus() {
    if (this.data.quantity < this.data.maxQuantity) {
      this.setData({ quantity: this.data.quantity + 1 });
      this.updateAmount();
    } else {
      wx.showToast({ title: '已达购买上限', icon: 'none' });
    }
  },

  onQuantityInput(e) {
    let q = parseInt(e.detail.value, 10);
    if (isNaN(q) || q < 1) q = 1;
    if (q > this.data.maxQuantity) q = this.data.maxQuantity;
    this.setData({ quantity: q });
    this.updateAmount();
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

  /** 金额预览：满减为前端预估，实际以后端计算为准 */
  updateAmount() {
    const total = this.priceFen * this.data.quantity;
    let reduction = 0;
    const rules = (this.rules || [])
      .slice()
      .sort((a, b) => b.threshold - a.threshold);
    for (const r of rules) {
      if (total >= r.threshold) {
        reduction = r.reduction;
        break;
      }
    }
    this.setData({
      totalText: util.fenToYuan(total),
      reductionText: reduction ? util.fenToYuan(reduction) : '',
      payText: util.fenToYuan(Math.max(total - reduction, 0))
    });
  },

  async submitOrder() {
    const g = this.data.group;
    if (!g || this.data.submitting) return;

    if (this.data.seckillNotStart) {
      wx.showToast({ title: '秒杀还未开始', icon: 'none' });
      return;
    }

    const payload = {
      quantity: this.data.quantity,
      delivery_method: this.data.deliveryMethod
    };

    if (this.data.deliveryMethod === 'express') {
      const { name, phone, detail } = this.data.address;
      if (!name.trim() || !phone.trim() || !detail.trim()) {
        wx.showToast({ title: '请填写完整收货地址', icon: 'none' });
        return;
      }
      payload.address = { name: name.trim(), phone: phone.trim(), detail: detail.trim() };
    } else {
      if (this.data.pickupIndex < 0 || !this.data.pickupPoints[this.data.pickupIndex]) {
        wx.showToast({ title: '请选择自提点', icon: 'none' });
        return;
      }
      payload.pickup_point_id = this.data.pickupPoints[this.data.pickupIndex].id;
    }

    this.setData({ submitting: true });
    try {
      // 1. 创建订单
      const res = await post('/groups/' + g.id + '/orders', payload);
      const order = res.order || res;
      // 2. 直接调 mock 支付
      await post('/orders/' + order.id + '/pay');
      wx.showToast({ title: '支付成功', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/orders/orders' });
      }, 1200);
    } catch (err) {
      toastError(err);
      this.setData({ submitting: false });
    }
  }
});
