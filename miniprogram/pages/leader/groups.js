const { get, post, put, toastError } = require('../../utils/request');
const util = require('../../utils/util');

Page({
  data: {
    groups: [],
    loading: true,
    // 编辑弹层（仅 active 团购）
    showEdit: false,
    editId: null,
    editForm: {
      endDate: '',
      endTime: '',
      targetQuantity: '',
      methods: [
        { value: 'express', label: '快递配送', checked: false },
        { value: 'pickup', label: '自提', checked: false }
      ],
      ruleThreshold: '',
      ruleReduction: ''
    },
    submitting: false
  },

  onShow() {
    if (!util.requireLogin()) return;
    this.loadGroups();
  },

  onPullDownRefresh() {
    this.loadGroups().finally(() => wx.stopPullDownRefresh());
  },

  async loadGroups() {
    try {
      const res = await get('/groups');
      const all = Array.isArray(res) ? res : res.list || res.groups || [];
      const user = wx.getStorageSync('user') || {};
      // 只看我发起的；若后端已做过滤则全部展示
      const mine = all.filter(
        (g) => !user.id || !g.leader_id || g.leader_id === user.id
      );
      this.setData({
        groups: mine.map((g) => this.decorate(g)),
        loading: false
      });
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
      statusText: util.groupStatusText(g.status),
      priceText: util.fenToYuan(g.price != null ? g.price : product.price),
      sold:
        g.sold_quantity != null ? g.sold_quantity : g.sold != null ? g.sold : 0,
      endText: util.formatTime(g.end_at)
    });
  },

  onClose(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '手动截团',
      content: '截团后将按当前参团情况结算（未达目标将自动退款），确定截团？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await post('/groups/' + id + '/close');
          wx.showToast({ title: '已截团', icon: 'success' });
          this.loadGroups();
        } catch (err) {
          toastError(err);
        }
      }
    });
  },

  goOrders(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/leader/orders?group_id=' + id });
  },

  /** ISO/数据库时间字符串 → {date, time}，如 "2026-07-27T12:00:00+08:00" → {date:'2026-07-27', time:'12:00'} */
  splitDateTime(t) {
    if (!t) return { date: '', time: '' };
    const parts = String(t).split(/[T ]/);
    return {
      date: parts[0] || '',
      time: (parts[1] || '').slice(0, 5)
    };
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    const g = this.data.groups.find((item) => item.id === id);
    if (!g) return;
    const end = this.splitDateTime(g.end_at);
    const delivery = Array.isArray(g.delivery_methods) ? g.delivery_methods : [];
    const rule =
      Array.isArray(g.full_reduction_rules) && g.full_reduction_rules[0]
        ? g.full_reduction_rules[0]
        : null;
    this.setData({
      showEdit: true,
      editId: id,
      editForm: {
        endDate: end.date,
        endTime: end.time,
        targetQuantity: String(g.target_quantity != null ? g.target_quantity : 0),
        methods: [
          { value: 'express', label: '快递配送', checked: delivery.indexOf('express') >= 0 },
          { value: 'pickup', label: '自提', checked: delivery.indexOf('pickup') >= 0 }
        ],
        ruleThreshold: rule ? util.fenToYuan(rule.threshold) : '',
        ruleReduction: rule ? util.fenToYuan(rule.reduction) : ''
      }
    });
  },

  onEditCancel() {
    this.setData({ showEdit: false, editId: null });
  },

  /** 阻止弹层内容点击穿透到遮罩关闭 */
  noop() {},

  onEditInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['editForm.' + field]: e.detail.value });
  },

  onEditEndDate(e) {
    this.setData({ 'editForm.endDate': e.detail.value });
  },

  onEditEndTime(e) {
    this.setData({ 'editForm.endTime': e.detail.value });
  },

  onEditMethodToggle(e) {
    const idx = e.currentTarget.dataset.index;
    const key = 'editForm.methods[' + idx + '].checked';
    this.setData({ [key]: !this.data.editForm.methods[idx].checked });
  },

  async onEditSubmit() {
    if (this.data.submitting) return;
    const f = this.data.editForm;
    if (!f.endDate || !f.endTime) {
      wx.showToast({ title: '请选择截团时间', icon: 'none' });
      return;
    }
    const methods = f.methods.filter((m) => m.checked).map((m) => m.value);
    if (methods.length === 0) {
      wx.showToast({ title: '请至少选择一种履约方式', icon: 'none' });
      return;
    }
    if (
      (f.ruleThreshold && !f.ruleReduction) ||
      (!f.ruleThreshold && f.ruleReduction)
    ) {
      wx.showToast({ title: '满减门槛和减免金额需同时填写', icon: 'none' });
      return;
    }
    const rules = [];
    if (f.ruleThreshold && f.ruleReduction) {
      rules.push({
        threshold: util.yuanToFen(f.ruleThreshold),
        reduction: util.yuanToFen(f.ruleReduction)
      });
    }
    this.setData({ submitting: true });
    try {
      await put('/groups/' + this.data.editId, {
        end_at: f.endDate + 'T' + f.endTime + ':00+08:00',
        target_quantity: parseInt(f.targetQuantity, 10) || 0,
        delivery_methods: methods,
        full_reduction_rules: rules
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ showEdit: false, editId: null, submitting: false });
      this.loadGroups();
    } catch (err) {
      toastError(err);
      this.setData({ submitting: false });
    }
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/leader/publish' });
  }
});
