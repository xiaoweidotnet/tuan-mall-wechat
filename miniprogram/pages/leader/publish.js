const { get, post, toastError } = require('../../utils/request');
const util = require('../../utils/util');

const EMPTY_PRODUCT = {
  title: '',
  description: '',
  price: '',
  original_price: '',
  stock: '',
  limit_per_user: '',
  images: [],
  detail_images: []
};

Page({
  data: {
    // 当前选中的开团商品（从商品库选择或 ?product_id=N 预选）
    selectedProduct: null,
    // 商品库选择弹层
    showProductPicker: false,
    pickerProducts: [],
    pickerLoading: false,
    // 内联新建商品表单（创建成功后商品自动进入商品库）
    showProductForm: false,
    product: Object.assign({}, EMPTY_PRODUCT, { images: [], detail_images: [] }),
    // 团购设置
    endDate: '',
    endTime: '',
    targetQuantity: '',
    methods: [
      { value: 'express', label: '快递配送', checked: true },
      { value: 'pickup', label: '自提', checked: false }
    ],
    isSeckill: false,
    seckillDate: '',
    seckillTime: '',
    // 满减（只填一档，可选）
    ruleThreshold: '',
    ruleReduction: '',
    submitting: false
  },

  onLoad(options) {
    // 从商品管理"去开团"进入：等同预选该商品
    if (options && options.product_id) {
      this.loadProduct(Number(options.product_id));
    }
  },

  onShow() {
    util.requireLogin();
  },

  /** 商品展示数据装饰：价格文案、首图、库存文案 */
  decorateProduct(p) {
    const images = Array.isArray(p.images) ? p.images : [];
    return Object.assign({}, p, {
      priceText: util.fenToYuan(p.price),
      originalPriceText: p.original_price ? util.fenToYuan(p.original_price) : '',
      thumb: images.length ? util.resolveImageUrl(images[0]) : '',
      stockText: p.stock > 0 ? '库存 ' + p.stock : '库存不限'
    });
  },

  async loadProduct(productId) {
    try {
      const p = await get('/products/' + productId);
      this.setData({ selectedProduct: this.decorateProduct(p) });
    } catch (err) {
      toastError(err);
    }
  },

  /** 打开商品库弹层：加载我的在售商品 */
  async onOpenPicker() {
    this.setData({ showProductPicker: true, pickerLoading: true });
    try {
      const res = await get('/products');
      const all = Array.isArray(res) ? res : res.list || res.products || [];
      const user = wx.getStorageSync('user') || {};
      // 只看我的在售商品；若后端已做过滤则全部展示
      const mine = all.filter(
        (p) =>
          p.status === 'on' &&
          (!user.id || !p.owner_id || p.owner_id === user.id)
      );
      this.setData({
        pickerProducts: mine.map((p) => this.decorateProduct(p)),
        pickerLoading: false
      });
    } catch (err) {
      this.setData({ pickerLoading: false });
      toastError(err);
    }
  },

  onClosePicker() {
    this.setData({ showProductPicker: false });
  },

  noop() {},

  onPickProduct(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.pickerProducts.find((item) => item.id === id);
    if (!p) return;
    this.setData({
      selectedProduct: p,
      showProductPicker: false,
      showProductForm: false
    });
  },

  onRemoveSelected() {
    this.setData({ selectedProduct: null });
  },

  onNewProduct() {
    this.setData({
      showProductForm: true,
      product: Object.assign({}, EMPTY_PRODUCT, { images: [], detail_images: [] })
    });
  },

  onProductInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['product.' + field]: e.detail.value });
  },

  /** 商品图片 / 详情图：点 + 选图上传后追加 */
  async onAddImage(e) {
    const field = e.currentTarget.dataset.field; // 'images' | 'detail_images'
    const list = this.data.product[field] || [];
    if (list.length >= 9) {
      wx.showToast({ title: '最多 9 张', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '上传中', mask: true });
    try {
      const url = await util.uploadImage();
      this.setData({ ['product.' + field]: list.concat(url) });
    } catch (err) {
      // 用户取消选图不提示
      if (err && err.errMsg && err.errMsg.indexOf('cancel') > -1) return;
      toastError(err);
    } finally {
      wx.hideLoading();
    }
  },

  onRemoveImage(e) {
    const field = e.currentTarget.dataset.field;
    const index = e.currentTarget.dataset.index;
    const list = (this.data.product[field] || []).slice();
    list.splice(index, 1);
    this.setData({ ['product.' + field]: list });
  },

  onFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  onEndDate(e) {
    this.setData({ endDate: e.detail.value });
  },

  onEndTime(e) {
    this.setData({ endTime: e.detail.value });
  },

  onSeckillDate(e) {
    this.setData({ seckillDate: e.detail.value });
  },

  onSeckillTime(e) {
    this.setData({ seckillTime: e.detail.value });
  },

  onMethodToggle(e) {
    const idx = e.currentTarget.dataset.index;
    const key = 'methods[' + idx + '].checked';
    this.setData({ [key]: !this.data.methods[idx].checked });
  },

  onSeckillToggle(e) {
    this.setData({ isSeckill: e.detail.value });
  },

  buildISO(date, time) {
    if (!date || !time) return '';
    return date + 'T' + time + ':00+08:00';
  },

  validate() {
    // 已选商品无需校验商品表单；否则校验内联新建表单
    if (!this.data.selectedProduct) {
      if (!this.data.showProductForm) return '请选择商品或新建商品';
      const p = this.data.product;
      if (!p.title.trim()) return '请填写商品名称';
      if (!p.price || isNaN(util.yuanToFen(p.price)) || util.yuanToFen(p.price) <= 0)
        return '请填写正确的价格（元）';
      if (p.original_price && isNaN(util.yuanToFen(p.original_price)))
        return '划线价格式不正确';
      const stock = parseInt(p.stock, 10);
      if (isNaN(stock) || stock < 0) return '请填写正确的库存';
    }
    if (!this.data.endDate || !this.data.endTime) return '请选择截团时间';
    if (!this.data.methods.some((m) => m.checked)) return '请至少选择一种履约方式';
    if (this.data.isSeckill && (!this.data.seckillDate || !this.data.seckillTime))
      return '请选择秒杀开始时间';
    if (
      (this.data.ruleThreshold && !this.data.ruleReduction) ||
      (!this.data.ruleThreshold && this.data.ruleReduction)
    )
      return '满减门槛和减免金额需同时填写';
    return '';
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const errMsg = this.validate();
    if (errMsg) {
      wx.showToast({ title: errMsg, icon: 'none' });
      return;
    }

    const p = this.data.product;
    this.setData({ submitting: true });
    try {
      let productId;
      let groupTitle;

      // 1. 新建商品（已选商品时跳过；新建的商品自动进入商品库）
      if (this.data.selectedProduct) {
        productId = this.data.selectedProduct.id;
        groupTitle = this.data.selectedProduct.title;
      } else {
        const productPayload = {
          title: p.title.trim(),
          description: p.description.trim(),
          price: util.yuanToFen(p.price),
          original_price: p.original_price ? util.yuanToFen(p.original_price) : 0,
          stock: parseInt(p.stock, 10),
          limit_per_user: parseInt(p.limit_per_user, 10) || 0,
          images: p.images,
          detail_images: p.detail_images
        };
        const productRes = await post('/products', productPayload);
        const product = productRes.product || productRes;
        productId = product.id;
        groupTitle = p.title.trim();
      }

      // 2. 开团
      const rules = [];
      if (this.data.ruleThreshold && this.data.ruleReduction) {
        rules.push({
          threshold: util.yuanToFen(this.data.ruleThreshold),
          reduction: util.yuanToFen(this.data.ruleReduction)
        });
      }
      const groupPayload = {
        product_id: productId,
        title: groupTitle,
        end_at: this.buildISO(this.data.endDate, this.data.endTime),
        target_quantity: parseInt(this.data.targetQuantity, 10) || 0,
        delivery_methods: this.data.methods
          .filter((m) => m.checked)
          .map((m) => m.value),
        is_seckill: this.data.isSeckill ? 1 : 0,
        seckill_start_at: this.data.isSeckill
          ? this.buildISO(this.data.seckillDate, this.data.seckillTime)
          : null,
        full_reduction_rules: rules
      };
      await post('/groups', groupPayload);

      wx.showToast({ title: '开团成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/leader/groups' });
      }, 1200);
    } catch (err) {
      toastError(err);
      this.setData({ submitting: false });
    }
  }
});
