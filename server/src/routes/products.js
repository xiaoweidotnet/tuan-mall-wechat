const express = require('express');
const { now } = require('../db');

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function serializeProduct(p) {
  return { ...p, images: parseJson(p.images, []), detail_images: parseJson(p.detail_images, []) };
}

function isImageList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

module.exports = function productsRouter({ db }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    res.json(rows.map(serializeProduct));
  });

  // 商品关键词搜索
  router.get('/search', (req, res) => {
    const keyword = req.query.keyword || '';
    const rows = db
      .prepare(`SELECT * FROM products WHERE title LIKE '%${keyword}%' ORDER BY id DESC`)
      .all();
    res.json(rows.map(serializeProduct));
  });

  router.post('/', (req, res) => {
    const {
      title,
      description = '',
      images = [],
      detail_images = [],
      price,
      original_price = 0,
      stock = 0,
      limit_per_user = 0,
      status = 'on',
    } = req.body || {};
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!isImageList(images) || !isImageList(detail_images)) {
      return res.status(400).json({ error: 'images and detail_images must be arrays of strings' });
    }
    if (!Number.isInteger(price) || price < 0) {
      return res.status(400).json({ error: 'price must be a non-negative integer (cents)' });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'stock must be a non-negative integer' });
    }
    if (!['on', 'off'].includes(status)) {
      return res.status(400).json({ error: "status must be 'on' or 'off'" });
    }
    const info = db
      .prepare(
        `INSERT INTO products
         (owner_id, title, description, images, detail_images, price, original_price, stock, limit_per_user, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        title,
        description,
        JSON.stringify(images),
        JSON.stringify(detail_images),
        price,
        original_price,
        stock,
        limit_per_user,
        status,
        now()
      );
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(serializeProduct(product));
  });

  router.get('/:id', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'product not found' });
    res.json(serializeProduct(product));
  });

  router.put('/:id', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'product not found' });
    if (product.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'only the owner can update the product' });
    }
    const {
      title = product.title,
      description = product.description,
      images = parseJson(product.images, []),
      detail_images = parseJson(product.detail_images, []),
      price = product.price,
      original_price = product.original_price,
      stock = product.stock,
      limit_per_user = product.limit_per_user,
      status = product.status,
    } = req.body || {};
    if (!isImageList(images) || !isImageList(detail_images)) {
      return res.status(400).json({ error: 'images and detail_images must be arrays of strings' });
    }
    if (!Number.isInteger(price) || price < 0) {
      return res.status(400).json({ error: 'price must be a non-negative integer (cents)' });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'stock must be a non-negative integer' });
    }
    if (!['on', 'off'].includes(status)) {
      return res.status(400).json({ error: "status must be 'on' or 'off'" });
    }
    db.prepare(
      `UPDATE products
       SET title = ?, description = ?, images = ?, detail_images = ?, price = ?, original_price = ?,
           stock = ?, limit_per_user = ?, status = ?
       WHERE id = ?`
    ).run(
      title,
      description,
      JSON.stringify(images),
      JSON.stringify(detail_images),
      price,
      original_price,
      stock,
      limit_per_user,
      status,
      product.id
    );
    res.json(serializeProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(product.id)));
  });

  return router;
};
