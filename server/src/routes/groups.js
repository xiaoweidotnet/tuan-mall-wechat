const express = require('express');
const { now } = require('../db');
const { soldQuantity, settleGroup, settleAllDue } = require('../services/settlement');

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function serializeProduct(p) {
  if (!p) return null;
  return {
    ...p,
    images: parseJson(p.images, []),
    detail_images: parseJson(p.detail_images, []),
  };
}

function serializeGroup(db, g) {
  return {
    ...g,
    is_seckill: !!g.is_seckill,
    delivery_methods: parseJson(g.delivery_methods, []),
    full_reduction_rules: parseJson(g.full_reduction_rules, []),
    sold_quantity: soldQuantity(db, g.id),
  };
}

function serializeGroupWithProduct(db, g) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(g.product_id);
  return {
    ...serializeGroup(db, g),
    product: serializeProduct(product),
  };
}

const DELIVERY_METHODS = ['express', 'pickup'];

module.exports = function groupsRouter({ db }) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const {
      product_id,
      title,
      start_at,
      end_at,
      target_quantity = 0,
      delivery_methods = ['express'],
      is_seckill = false,
      seckill_start_at = null,
      full_reduction_rules = [],
    } = req.body || {};

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) return res.status(400).json({ error: 'product not found' });
    if (product.status === 'off') {
      return res.status(400).json({ error: 'product is off and cannot be used to start a group' });
    }
    if (!end_at || Number.isNaN(Date.parse(end_at))) {
      return res.status(400).json({ error: 'end_at is required and must be a valid datetime' });
    }
    if (start_at && Number.isNaN(Date.parse(start_at))) {
      return res.status(400).json({ error: 'start_at must be a valid datetime' });
    }
    if (!Number.isInteger(target_quantity) || target_quantity < 0) {
      return res.status(400).json({ error: 'target_quantity must be a non-negative integer' });
    }
    if (
      !Array.isArray(delivery_methods) ||
      delivery_methods.length === 0 ||
      !delivery_methods.every((m) => DELIVERY_METHODS.includes(m))
    ) {
      return res.status(400).json({ error: 'delivery_methods must be a non-empty subset of ["express","pickup"]' });
    }
    if (!Array.isArray(full_reduction_rules)) {
      return res.status(400).json({ error: 'full_reduction_rules must be an array of {threshold, reduction}' });
    }
    if (is_seckill && seckill_start_at && Number.isNaN(Date.parse(seckill_start_at))) {
      return res.status(400).json({ error: 'seckill_start_at must be a valid datetime' });
    }

    const info = db
      .prepare(
        `INSERT INTO groups
         (product_id, leader_id, title, start_at, end_at, target_quantity, status,
          delivery_methods, is_seckill, seckill_start_at, full_reduction_rules, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .run(
        product_id,
        req.user.id,
        title || product.title,
        start_at || now(),
        end_at,
        target_quantity,
        JSON.stringify(delivery_methods),
        is_seckill ? 1 : 0,
        is_seckill ? seckill_start_at : null,
        JSON.stringify(full_reduction_rules),
        now()
      );
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(serializeGroup(db, group));
  });

  // 团长编辑团购，仅 status='active' 时可改；字段缺省保持原值，product_id 不可改
  router.put('/:id', (req, res) => {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'group not found' });
    if (group.leader_id !== req.user.id) {
      return res.status(403).json({ error: 'only the leader can update the group' });
    }
    if (group.status !== 'active') {
      return res.status(400).json({ error: `group is already ${group.status}` });
    }
    const {
      title = group.title,
      start_at = group.start_at,
      end_at = group.end_at,
      target_quantity = group.target_quantity,
      delivery_methods = parseJson(group.delivery_methods, []),
      is_seckill = !!group.is_seckill,
      seckill_start_at = group.seckill_start_at,
      full_reduction_rules = parseJson(group.full_reduction_rules, []),
    } = req.body || {};
    if (!end_at || Number.isNaN(Date.parse(end_at))) {
      return res.status(400).json({ error: 'end_at is required and must be a valid datetime' });
    }
    if (start_at && Number.isNaN(Date.parse(start_at))) {
      return res.status(400).json({ error: 'start_at must be a valid datetime' });
    }
    if (!Number.isInteger(target_quantity) || target_quantity < 0) {
      return res.status(400).json({ error: 'target_quantity must be a non-negative integer' });
    }
    if (
      !Array.isArray(delivery_methods) ||
      delivery_methods.length === 0 ||
      !delivery_methods.every((m) => DELIVERY_METHODS.includes(m))
    ) {
      return res.status(400).json({ error: 'delivery_methods must be a non-empty subset of ["express","pickup"]' });
    }
    if (!Array.isArray(full_reduction_rules)) {
      return res.status(400).json({ error: 'full_reduction_rules must be an array of {threshold, reduction}' });
    }
    if (is_seckill && seckill_start_at && Number.isNaN(Date.parse(seckill_start_at))) {
      return res.status(400).json({ error: 'seckill_start_at must be a valid datetime' });
    }
    db.prepare(
      `UPDATE groups
       SET title = ?, start_at = ?, end_at = ?, target_quantity = ?,
           delivery_methods = ?, is_seckill = ?, seckill_start_at = ?, full_reduction_rules = ?
       WHERE id = ?`
    ).run(
      title,
      start_at,
      end_at,
      target_quantity,
      JSON.stringify(delivery_methods),
      is_seckill ? 1 : 0,
      is_seckill ? seckill_start_at : null,
      JSON.stringify(full_reduction_rules),
      group.id
    );
    res.json(serializeGroup(db, db.prepare('SELECT * FROM groups WHERE id = ?').get(group.id)));
  });

  router.get('/', (req, res) => {
    settleAllDue(db);
    const rows = db.prepare('SELECT * FROM groups ORDER BY id DESC').all();
    res.json(rows.map((g) => serializeGroupWithProduct(db, g)));
  });

  router.get('/:id', (req, res) => {
    settleAllDue(db);
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'group not found' });
    res.json(serializeGroupWithProduct(db, group));
  });

  // 团长手动截团，走与到期惰性结算相同的结算逻辑（无视 end_at）
  router.post('/:id/close', (req, res) => {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'group not found' });
    if (group.leader_id !== req.user.id) {
      return res.status(403).json({ error: 'only the leader can close the group' });
    }
    if (group.status !== 'active') {
      return res.status(400).json({ error: `group is already ${group.status}` });
    }
    const settled = settleGroup(db, group.id);
    res.json(serializeGroup(db, settled));
  });

  return router;
};
