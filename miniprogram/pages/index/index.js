const { get, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    groups: [],
    loading: true
  },

  timer: null,

  onShow() {
    if (!util.requireLogin()) return;
    this.loadGroups();
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  onPullDownRefresh() {
    this.loadGroups().finally(() => wx.stopPullDownRefresh());
  },

  async loadGroups() {
    try {
      const res = await get('/groups');
      const list = (Array.isArray(res) ? res : res.list || res.groups || []).map(
        (g) => this.decorate(g)
      );
      this.setData({ groups: list, loading: false });
    } catch (err) {
      this.setData({ loading: false });
      toastError(err);
    }
  },

  decorate(g) {
    const product = g.product || {};
    const images = Array.isArray(product.images) ? product.images : [];
    return Object.assign({}, g, {
      product,
      cover: images.length ? util.resolveImageUrl(images[0]) : '',
      productTitle: product.title || '',
      productDescription: product.description || '',
      stock: g.stock != null ? g.stock : product.stock || 0,
      limitPerUser:
        g.limit_per_user != null ? g.limit_per_user : product.limit_per_user || 0,
      priceText: util.fenToYuan(g.price != null ? g.price : product.price),
      originalPriceText:
        (g.original_price != null ? g.original_price : product.original_price)
          ? util.fenToYuan(
              g.original_price != null ? g.original_price : product.original_price
            )
          : '',
      sold: g.sold_quantity != null ? g.sold_quantity : g.sold != null ? g.sold : 0,
      countdownText: g.status === 'active' ? util.formatCountdown(g.end_at) : '',
      statusText: util.groupStatusText(g.status)
    });
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      const groups = this.data.groups.map((g) => ({
        ...g,
        countdownText: g.status === 'active' ? util.formatCountdown(g.end_at) : ''
      }));
      this.setData({ groups });
    }, 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/group/detail?id=' + id });
  }
});
