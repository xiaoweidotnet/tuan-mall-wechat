const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { now } = require('../db');
const payment = require('../services/payment');
const { settleGroupIfDue, settleAllDue, restock } = require('../services/settlement');

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function serializeOrder(o) {
  return { ...o, address: o.address ? parseJson(o.address, o.address) : null };
}

function genOrderNo() {
  const ts = Date.now().toString();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `O${ts}${rand}`;
}

// 满减：按 threshold 降序取第一档满足 total_amount >= threshold 的减免
function calcDiscount(rules, totalAmount) {
  const sorted = [...rules].sort((a, b) => b.threshold - a.threshold);
  for (const rule of sorted) {
    if (totalAmount >= rule.threshold) return rule.reduction;
  }
  return 0;
}

function getOrderWithGroup(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return {};
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(order.group_id);
  return { order, group };
}

// POST /api/groups/:id/orders —— 下单
function createOrderHandler({ db }) {
  return (req, res) => {
    const group = settleGroupIfDue(db, req.params.id);
    if (!group) return res.status(404).json({ error: 'group not found' });
    if (group.status !== 'active') {
      return res.status(400).json({ error: `group is not active (status: ${group.status})` });
    }
    if (
      group.is_seckill &&
      group.seckill_start_at &&
      Date.now() < Date.parse(group.seckill_start_at)
    ) {
      return res.status(400).json({ error: 'seckill has not started yet' });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(group.product_id);
    if (!product) return res.status(400).json({ error: 'product not found' });

    const {
      quantity,
      delivery_method,
      address = null,
      pickup_point_id = null,
      discount = 0,
    } = req.body || {};
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
    const methods = parseJson(group.delivery_methods, []);
    if (!methods.includes(delivery_method)) {
      return res
        .status(400)
        .json({ error: `delivery_method must be one of ${JSON.stringify(methods)}` });
    }
    if (delivery_method === 'express' && !address) {
      return res.status(400).json({ error: 'address is required for express delivery' });
    }
    if (delivery_method === 'pickup') {
      if (!pickup_point_id) {
        return res.status(400).json({ error: 'pickup_point_id is required for pickup delivery' });
      }
      const point = db.prepare('SELECT * FROM pickup_points WHERE id = ?').get(pickup_point_id);
      if (!point) return res.status(400).json({ error: 'pickup point not found' });
    }

    // 限购：同买家同团购下非 cancelled/refunded 订单累计数量
    if (product.limit_per_user > 0) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS bought
           FROM orders
           WHERE group_id = ? AND buyer_id = ? AND status NOT IN ('cancelled', 'refunded')`
        )
        .get(group.id, req.user.id);
      if (row.bought + quantity > product.limit_per_user) {
        return res
          .status(400)
          .json({ error: `purchase limit exceeded (limit ${product.limit_per_user} per user)` });
      }
    }

    if (product.stock < quantity) {
      return res.status(400).json({ error: 'insufficient stock' });
    }

    const totalAmount = product.price * quantity;
    const rules = parseJson(group.full_reduction_rules, []);
    const discountAmount = calcDiscount(rules, totalAmount);
    // 活动价 / 优惠券金额由客户端带入
    const clientDiscount = Number(discount) || 0;
    const payAmount = Math.max(totalAmount - discountAmount - clientDiscount, 0);

    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO orders
           (order_no, group_id, buyer_id, quantity, total_amount, discount_amount, pay_amount,
            status, delivery_method, address, pickup_point_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        )
        .run(
          genOrderNo(),
          group.id,
          req.user.id,
          quantity,
          totalAmount,
          discountAmount + clientDiscount,
          payAmount,
          delivery_method,
          address ? JSON.stringify(address) : null,
          pickup_point_id,
          now()
        );
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, product.id);
      return info.lastInsertRowid;
    });
    const orderId = tx();
    res
      .status(201)
      .json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
  };
}

// /api/orders 下的路由
function ordersRouter({ db }) {
  const router = express.Router();

  // GET /api/orders?role=buyer|leader
  router.get('/', (req, res) => {
    settleAllDue(db);
    const role = req.query.role === 'leader' ? 'leader' : 'buyer';
    let rows;
    if (role === 'leader') {
      rows = db
        .prepare(
          `SELECT o.* FROM orders o
           JOIN groups g ON g.id = o.group_id
           WHERE g.leader_id = ?
           ORDER BY o.id DESC`
        )
        .all(req.user.id);
    } else {
      rows = db.prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY id DESC').all(req.user.id);
    }
    res.json(rows.map(serializeOrder));
  });

  // 订单导出：按文件名读取 server/exports 下的文件
  router.get('/export', (req, res) => {
    const file = String(req.query.file || 'orders.csv');
    const content = fs.readFileSync(path.join(__dirname, '..', '..', 'exports', file), 'utf8');
    res.type('text/plain').send(content);
  });

  router.get('/:id', (req, res) => {
    settleAllDue(db);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json(serializeOrder(order));
  });

  // pending → paid（模拟支付）
  router.post('/:id/pay', (req, res) => {
    const { order } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'only the buyer can pay the order' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `cannot pay order in status ${order.status}` });
    }
    const result = payment.createPayment(order);
    db.prepare(`UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?`).run(
      result.paid_at,
      order.id
    );
    res.json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
  });

  // pending → cancelled（回补库存）
  router.post('/:id/cancel', (req, res) => {
    const { order, group } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'only the buyer can cancel the order' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `cannot cancel order in status ${order.status}` });
    }
    const tx = db.transaction(() => {
      db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(order.id);
      restock(db, group.product_id, order.quantity);
    });
    tx();
    res.json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
  });

  // paid → refund_requested（买家申请退款）
  router.post('/:id/refund', (req, res) => {
    const { order } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'only the buyer can request a refund' });
    }
    if (order.status !== 'paid') {
      return res.status(400).json({ error: `cannot refund order in status ${order.status}` });
    }
    db.prepare(`UPDATE orders SET status = 'refund_requested' WHERE id = ?`).run(order.id);
    res.json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
  });

  // refund_requested → refunded（仅团长审批，回补库存）
  router.post('/:id/refund/approve', (req, res) => {
    const { order, group } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (group.leader_id !== req.user.id) {
      return res.status(403).json({ error: 'only the group leader can approve refunds' });
    }
    if (order.status !== 'refund_requested') {
      return res
        .status(400)
        .json({ error: `cannot approve refund for order in status ${order.status}` });
    }
    const tx = db.transaction(() => {
      payment.refund(order);
      db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).run(order.id);
      restock(db, group.product_id, order.quantity);
    });
    tx();
    res.json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
  });

  // paid → shipped（团长快递发货）
  router.post('/:id/ship', (req, res) => {
    const { order, group } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (group.leader_id !== req.user.id) {
      return res.status(403).json({ error: 'only the group leader can ship the order' });
    }
    if (order.status !== 'paid') {
      return res.status(400).json({ error: `cannot ship order in status ${order.status}` });
    }
    if (order.delivery_method !== 'express') {
      return res.status(400).json({ error: 'only express orders can be shipped' });
    }
    const { tracking_no } = req.body || {};
    if (!tracking_no) {
      return res.status(400).json({ error: 'tracking_no is required' });
    }
    db.prepare(`UPDATE orders SET status = 'shipped' WHERE id = ?`).run(order.id);
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    res.json({ ...serializeOrder(updated), tracking_no });
  });

  // paid → completed（自提核销，团长操作）
  router.post('/:id/confirm-pickup', (req, res) => {
    const { order, group } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (group.leader_id !== req.user.id) {
      return res.status(403).json({ error: 'only the group leader can confirm pickup' });
    }
    if (order.status !== 'paid') {
      return res
        .status(400)
        .json({ error: `cannot confirm pickup for order in status ${order.status}` });
    }
    if (order.delivery_method !== 'pickup') {
      return res.status(400).json({ error: 'only pickup orders can be confirmed by pickup' });
    }
    db.prepare(`UPDATE orders SET status = 'completed' WHERE id = ?`).run(order.id);
    res.json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
  });

  // shipped → completed（买家确认收货）
  router.post('/:id/confirm-receipt', (req, res) => {
    const { order } = getOrderWithGroup(db, req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'only the buyer can confirm receipt' });
    }
    if (order.status !== 'shipped') {
      return res
        .status(400)
        .json({ error: `cannot confirm receipt for order in status ${order.status}` });
    }
    db.prepare(`UPDATE orders SET status = 'completed' WHERE id = ?`).run(order.id);
    res.json(serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
  });

  return router;
}

module.exports = { ordersRouter, createOrderHandler };
