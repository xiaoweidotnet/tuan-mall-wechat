const { get, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    groups: [],
    seckillList: [],
    loading: true
  },

  timer: null,
  // 服务端时间校准：serverOffset = 服务端当前时间 - 本机当前时间
  serverOffset: 0,

  onShow() {
    if (!util.requireLogin()) return;
    this.loadGroups();
    this.loadSeckill();
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  onPullDownRefresh() {
    Promise.all([this.loadGroups(), this.loadSeckill()]).finally(() =>
      wx.stopPullDownRefresh()
    );
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

  async loadSeckill() {
    try {
      const res = await get('/seckill/activities');
      const list = (Array.isArray(res) ? res : res.list || []).filter(
        (a) => a.status === 'not_started' || a.status === 'ongoing'
      );
      if (list.length && list[0].server_time) {
        this.serverOffset = Date.parse(list[0].server_time) - Date.now();
      }
      this.setData({ seckillList: list.map((a) => this.decorateSeckill(a)) });
    } catch (err) {
      // 秒杀活动加载失败不阻塞团购列表
    }
  },

  serverNow() {
    return Date.now() + this.serverOffset;
  },

  decorateSeckill(a) {
    const product = a.product || {};
    const images = Array.isArray(product.images) ? product.images : [];
    const now = this.serverNow();
    let countdownText = '';
    let countdownTarget = '';
    let countdownPrefix = '';
    if (a.status === 'not_started') {
      countdownPrefix = '距开始 ';
      countdownTarget = a.start_at;
      countdownText = countdownPrefix + util.formatCountdownShort(a.start_at, now);
    } else if (a.status === 'ongoing') {
      countdownPrefix = '距结束 ';
      countdownTarget = a.end_at;
      countdownText = countdownPrefix + util.formatCountdownShort(a.end_at, now);
    }
    return {
      id: a.id,
      title: a.title || product.title || '',
      cover: images.length ? util.resolveImageUrl(images[0]) : '',
      priceText: util.fenToYuan(a.seckill_price),
      originalPriceText: product.price ? util.fenToYuan(product.price) : '',
      status: a.status,
      statusText: a.status === 'not_started' ? '即将开始' : '抢购中',
      buttonText: a.status === 'not_started' ? '即将开始' : '立即抢购',
      remainingStock: a.remaining_stock || 0,
      limitPerUser: a.limit_per_user || 0,
      countdownText,
      countdownTarget,
      countdownPrefix
    };
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
      const seckillList = this.data.seckillList.map((item) => ({
        ...item,
        countdownText: item.countdownTarget
          ? item.countdownPrefix +
            util.formatCountdownShort(item.countdownTarget, this.serverNow())
          : ''
      }));
      this.setData({ groups, seckillList });
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
  },

  goSeckill(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/seckill/detail?id=' + id });
  }
});
