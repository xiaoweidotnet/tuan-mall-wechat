const { get, post, put, toastError } = require('../../utils/request');
const util = require('../../utils/util');

const EMPTY_FORM = {
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
    products: [],
    loading: true,
    // 新建/编辑表单（页内表单区，editingId 为空表示新建）
    showForm: false,
    editingId: null,
    form: Object.assign({}, EMPTY_FORM),
    submitting: false
  },

  onShow() {
    if (!util.requireLogin()) return;
    this.loadProducts();
  },

  onPullDownRefresh() {
    this.loadProducts().finally(() => wx.stopPullDownRefresh());
  },

  async loadProducts() {
    try {
      const res = await get('/products');
      const all = Array.isArray(res) ? res : res.list || res.products || [];
      const user = wx.getStorageSync('user') || {};
      // 只看我的商品；若后端已做过滤则全部展示
      const mine = all.filter(
        (p) => !user.id || !p.owner_id || p.owner_id === user.id
      );
      this.setData({
        products: mine.map((p) => this.decorate(p)),
        loading: false
      });
    } catch (err) {
      this.setData({ loading: false });
      toastError(err);
    }
  },

  decorate(p) {
    const images = Array.isArray(p.images) ? p.images : [];
    return Object.assign({}, p, {
      priceText: util.fenToYuan(p.price),
      originalPriceText: p.original_price ? util.fenToYuan(p.original_price) : '',
      statusText: p.status === 'on' ? '已上架' : '已下架',
      thumb: images.length ? util.resolveImageUrl(images[0]) : ''
    });
  },

  onNewProduct() {
    this.setData({
      showForm: true,
      editingId: null,
      form: Object.assign({}, EMPTY_FORM, { images: [], detail_images: [] })
    });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.products.find((item) => item.id === id);
    if (!p) return;
    this.setData({
      showForm: true,
      editingId: id,
      form: {
        title: p.title || '',
        description: p.description || '',
        price: util.fenToYuan(p.price),
        original_price: p.original_price ? util.fenToYuan(p.original_price) : '',
        stock: p.stock != null ? String(p.stock) : '',
        limit_per_user: p.limit_per_user != null ? String(p.limit_per_user) : '',
        images: (Array.isArray(p.images) ? p.images : []).map(util.resolveImageUrl),
        detail_images: (Array.isArray(p.detail_images) ? p.detail_images : []).map(
          util.resolveImageUrl
        )
      }
    });
  },

  onCancelForm() {
    this.setData({ showForm: false, editingId: null });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  /** 商品图片 / 详情图：点 + 选图上传后追加 */
  async onAddImage(e) {
    const field = e.currentTarget.dataset.field; // 'images' | 'detail_images'
    const list = this.data.form[field] || [];
    if (list.length >= 9) {
      wx.showToast({ title: '最多 9 张', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '上传中', mask: true });
    try {
      const url = await util.uploadImage();
      this.setData({ ['form.' + field]: list.concat(url) });
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
    const list = (this.data.form[field] || []).slice();
    list.splice(index, 1);
    this.setData({ ['form.' + field]: list });
  },

  validate() {
    const f = this.data.form;
    if (!f.title.trim()) return '请填写商品名称';
    if (!f.price || isNaN(util.yuanToFen(f.price)) || util.yuanToFen(f.price) <= 0)
      return '请填写正确的价格（元）';
    if (f.original_price && isNaN(util.yuanToFen(f.original_price)))
      return '划线价格式不正确';
    const stock = parseInt(f.stock, 10);
    if (isNaN(stock) || stock < 0) return '请填写正确的库存';
    return '';
  },

  async onSubmitForm() {
    if (this.data.submitting) return;
    const errMsg = this.validate();
    if (errMsg) {
      wx.showToast({ title: errMsg, icon: 'none' });
      return;
    }
    const f = this.data.form;
    const payload = {
      title: f.title.trim(),
      description: f.description.trim(),
      price: util.yuanToFen(f.price),
      original_price: f.original_price ? util.yuanToFen(f.original_price) : 0,
      stock: parseInt(f.stock, 10),
      limit_per_user: parseInt(f.limit_per_user, 10) || 0,
      images: f.images,
      detail_images: f.detail_images
    };
    this.setData({ submitting: true });
    try {
      if (this.data.editingId) {
        await put('/products/' + this.data.editingId, payload);
      } else {
        await post('/products', payload);
      }
      wx.showToast({
        title: this.data.editingId ? '已保存' : '已创建',
        icon: 'success'
      });
      this.setData({ showForm: false, editingId: null, submitting: false });
      this.loadProducts();
    } catch (err) {
      toastError(err);
      this.setData({ submitting: false });
    }
  },

  async onToggleStatus(e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    const next = status === 'on' ? 'off' : 'on';
    try {
      await put('/products/' + id, { status: next });
      wx.showToast({
        title: next === 'on' ? '已上架' : '已下架',
        icon: 'success'
      });
      this.loadProducts();
    } catch (err) {
      toastError(err);
    }
  },

  goPublish(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/leader/publish?product_id=' + id });
  }
});
