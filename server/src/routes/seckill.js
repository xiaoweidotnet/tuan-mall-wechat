const express = require('express');
const { now } = require('../db');
const {
  SeckillError,
  computeActivityStatus,
  serializeActivity,
  serializeSeckillOrder,
  logEvent,
  logOperation,
  expireSeckillOrders,
  createSeckillOrder,
  paySeckillOrder,
  cancelSeckillOrder,
} = require('../services/seckill');

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function serializeProduct(p) {
  if (!p) return null;
  return { ...p, images: parseJson(p.images, []), detail_images: parseJson(p.detail_images, []) };
}

function handleSeckillError(res, err) {
  if (err instanceof SeckillError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

function statsByActivity(db) {
  const rows = db
    .prepare(
      `SELECT activity_id, status, COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS quantity
       FROM seckill_orders GROUP BY activity_id, status`
    )
    .all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.activity_id)) map.set(row.activity_id, {});
    map.get(row.activity_id)[row.status] = { count: row.count, quantity: row.quantity };
  }
  return map;
}

function summarize(activity, stats = {}) {
  const sold = activity.sold;
  return {
    activity,
    metrics: {
      sold_quantity: sold,
      remaining_stock: Math.max(activity.stock - sold, 0),
      order_count: Object.values(stats).reduce((sum, item) => sum + item.count, 0),
      paid_count: stats.paid ? stats.paid.count : 0,
      paid_quantity: stats.paid ? stats.paid.quantity : 0,
      pending_count: stats.pending ? stats.pending.count : 0,
      cancelled_count: stats.cancelled ? stats.cancelled.count : 0,
      refunded_count: stats.refunded ? stats.refunded.count : 0,
    },
  };
}

/**
 * 运营侧字段校验与归一化。create 时 existing 为空，update 时只覆盖传入字段。
 * 发布前同样复用本函数，保证价格、库存、时间始终合法。
 */
function normalizeActivityInput(db, input, existing = null) {
  const productId = existing ? existing.product_id : input.product_id;
  if (!Number.isInteger(productId)) {
    throw new SeckillError('INVALID_PRODUCT', 'product_id is required and must be an integer');
  }
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new SeckillError('PRODUCT_NOT_FOUND', 'product not found');
  if (product.status === 'off') {
    throw new SeckillError('PRODUCT_OFF', 'product is off sale');
  }

  const title = input.title !== undefined ? input.title : existing ? existing.title : product.title;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) {
    throw new SeckillError('INVALID_TITLE', 'title must be a non-empty string (max 100 chars)');
  }

  const seckillPrice =
    input.seckill_price !== undefined
      ? input.seckill_price
      : existing
      ? existing.seckill_price
      : undefined;
  if (!Number.isInteger(seckillPrice) || seckillPrice <= 0) {
    throw new SeckillError('INVALID_PRICE', 'seckill_price must be a positive integer (cents)');
  }
  if (seckillPrice >= product.price) {
    throw new SeckillError(
      'INVALID_PRICE',
      `seckill_price must be lower than product.price (${product.price})`
    );
  }

  const stock = input.stock !== undefined ? input.stock : existing ? existing.stock : undefined;
  if (!Number.isInteger(stock) || stock <= 0) {
    throw new SeckillError('INVALID_STOCK', 'stock must be a positive integer');
  }
  if (existing && stock < existing.sold) {
    throw new SeckillError('INVALID_STOCK', 'stock cannot be lower than sold quantity');
  }

  const startAt = input.start_at !== undefined ? input.start_at : existing ? existing.start_at : null;
  const endAt = input.end_at !== undefined ? input.end_at : existing ? existing.end_at : null;
  if (!startAt || Number.isNaN(Date.parse(startAt))) {
    throw new SeckillError('INVALID_TIME', 'start_at is required and must be a valid datetime');
  }
  if (!endAt || Number.isNaN(Date.parse(endAt))) {
    throw new SeckillError('INVALID_TIME', 'end_at is required and must be a valid datetime');
  }
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new SeckillError('INVALID_TIME', 'start_at must be earlier than end_at');
  }

  const limit =
    input.limit_per_user !== undefined
      ? input.limit_per_user
      : existing
      ? existing.limit_per_user
      : 1;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SeckillError('INVALID_LIMIT', 'limit_per_user must be a positive integer');
  }

  const timeout =
    input.pay_timeout_minutes !== undefined
      ? input.pay_timeout_minutes
      : existing
      ? existing.pay_timeout_minutes
      : 15;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
    throw new SeckillError('INVALID_PAY_TIMEOUT', 'pay_timeout_minutes must be an integer in [1, 120]');
  }

  return {
    product,
    title: title.trim(),
    seckill_price: seckillPrice,
    stock,
    start_at: new Date(startAt).toISOString(),
    end_at: new Date(endAt).toISOString(),
    limit_per_user: limit,
    pay_timeout_minutes: timeout,
  };
}

const KEY_FIELDS = ['seckill_price', 'stock', 'start_at', 'end_at', 'limit_per_user', 'pay_timeout_minutes'];

function diffActivity(activity, fields) {
  const changes = {};
  for (const key of KEY_FIELDS.concat('title')) {
    if (String(activity[key]) !== String(fields[key])) {
      changes[key] = { from: activity[key], to: fields[key] };
    }
  }
  return changes;
}

/** 用户侧：活动列表 / 详情 / 抢购下单 / 秒杀订单 */
function seckillRouter({ db }) {
  const router = express.Router();
  // 非法 id 直接 404，避免把 NaN 传入 SQLite 绑定
  router.param('id', (req, res, next, id) => {
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return res.status(404).json({ error: 'not found' });
    }
    req.params.id = parsed;
    next();
  });

  router.get('/activities', (req, res) => {
    expireSeckillOrders(db);
    const rows = db
      .prepare(`SELECT * FROM seckill_activities WHERE status = 'published' ORDER BY start_at ASC LIMIT 50`)
      .all();
    const nowMs = Date.now();
    res.json(
      rows.map((activity) => {
        const serialized = serializeActivity(activity, nowMs);
        const product = db
          .prepare('SELECT * FROM products WHERE id = ?')
          .get(activity.product_id);
        return { ...serialized, product: serializeProduct(product) };
      })
    );
  });

  router.get('/activities/:id', (req, res) => {
    const activity = db
      .prepare('SELECT * FROM seckill_activities WHERE id = ?')
      .get(req.params.id);
    if (!activity || activity.status === 'draft') {
      return res.status(404).json({ error: 'activity not found' });
    }
    expireSeckillOrders(db, { activityId: activity.id });

    // 访问事件：同一用户同一活动 60 秒内只记一次，避免轮询放大
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = db
      .prepare(
        `SELECT id FROM seckill_events
         WHERE activity_id = ? AND event_type = 'view' AND user_id = ? AND created_at >= ?`
      )
      .get(activity.id, req.user.id, since);
    if (!recent) {
      logEvent(db, { activityId: activity.id, eventType: 'view', userId: req.user.id });
    }

    const fresh = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(activity.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(fresh.product_id);
    res.json({ ...serializeActivity(fresh), product: serializeProduct(product) });
  });

  router.post('/activities/:id/orders', (req, res) => {
    const { quantity = 1, request_id, delivery_method = 'express', address = null, pickup_point_id = null } =
      req.body || {};
    try {
      const { order, created } = createSeckillOrder(db, {
        activityId: Number(req.params.id),
        buyer: req.user,
        quantity,
        requestId: request_id,
        deliveryMethod: delivery_method,
        address,
        pickupPointId: pickup_point_id,
      });
      res.status(created ? 201 : 200).json(serializeSeckillOrder(db, order));
    } catch (err) {
      handleSeckillError(res, err);
    }
  });

  router.get('/orders', (req, res) => {
    expireSeckillOrders(db);
    const rows = db
      .prepare('SELECT * FROM seckill_orders WHERE buyer_id = ? ORDER BY id DESC')
      .all(req.user.id);
    res.json(rows.map((order) => serializeSeckillOrder(db, order)));
  });

  router.get('/orders/:id', (req, res) => {
    expireSeckillOrders(db);
    const order = db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'only the buyer can view the order' });
    }
    res.json(serializeSeckillOrder(db, order));
  });

  router.post('/orders/:id/pay', (req, res) => {
    try {
      const { order, alreadyPaid } = paySeckillOrder(db, {
        orderId: Number(req.params.id),
        user: req.user,
      });
      res.json({ ...serializeSeckillOrder(db, order), already_paid: !!alreadyPaid });
    } catch (err) {
      handleSeckillError(res, err);
    }
  });

  router.post('/orders/:id/cancel', (req, res) => {
    try {
      const { order } = cancelSeckillOrder(db, {
        orderId: Number(req.params.id),
        user: req.user,
      });
      res.json(serializeSeckillOrder(db, order));
    } catch (err) {
      handleSeckillError(res, err);
    }
  });

  return router;
}

/** 运营侧：活动配置、发布、终止、数据与操作日志（/api/admin/seckill，已由 admin token 保护） */
function seckillAdminRouter({ db }) {
  const router = express.Router();
  router.param('id', (req, res, next, id) => {
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return res.status(404).json({ error: 'not found' });
    }
    req.params.id = parsed;
    next();
  });

  router.get('/activities', (req, res) => {
    expireSeckillOrders(db);
    const rows = db.prepare('SELECT * FROM seckill_activities ORDER BY id DESC').all();
    const stats = statsByActivity(db);
    const nowMs = Date.now();
    res.json(
      rows.map((activity) => ({
        ...serializeActivity(activity, nowMs),
        stats: summarize(activity, stats.get(activity.id) || {}).metrics,
      }))
    );
  });

  router.post('/activities', (req, res) => {
    try {
      const fields = normalizeActivityInput(db, req.body || {});
      const info = db
        .prepare(
          `INSERT INTO seckill_activities
           (product_id, title, seckill_price, stock, sold, start_at, end_at, limit_per_user,
            pay_timeout_minutes, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, ?, ?)`
        )
        .run(
          fields.product.id,
          fields.title,
          fields.seckill_price,
          fields.stock,
          fields.start_at,
          fields.end_at,
          fields.limit_per_user,
          fields.pay_timeout_minutes,
          null,
          now(),
          now()
        );
      const activity = db
        .prepare('SELECT * FROM seckill_activities WHERE id = ?')
        .get(info.lastInsertRowid);
      logOperation(db, {
        activityId: activity.id,
        actor: 'admin',
        action: 'create',
        detail: fields,
      });
      res.status(201).json(serializeActivity(activity));
    } catch (err) {
      handleSeckillError(res, err);
    }
  });

  router.put('/activities/:id', (req, res) => {
    const activity = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(req.params.id);
    if (!activity) return res.status(404).json({ error: 'activity not found' });
    if (!['draft', 'published'].includes(activity.status)) {
      return res.status(400).json({ error: `activity is already ${activity.status}` });
    }
    try {
      const fields = normalizeActivityInput(db, req.body || {}, activity);
      const changes = diffActivity(activity, fields);
      db.prepare(
        `UPDATE seckill_activities
         SET title = ?, seckill_price = ?, stock = ?, start_at = ?, end_at = ?,
             limit_per_user = ?, pay_timeout_minutes = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        fields.title,
        fields.seckill_price,
        fields.stock,
        fields.start_at,
        fields.end_at,
        fields.limit_per_user,
        fields.pay_timeout_minutes,
        now(),
        activity.id
      );
      logOperation(db, {
        activityId: activity.id,
        actor: 'admin',
        action: 'update',
        detail: changes,
      });
      res.json(
        serializeActivity(db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(activity.id))
      );
    } catch (err) {
      handleSeckillError(res, err);
    }
  });

  router.post('/activities/:id/publish', (req, res) => {
    const activity = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(req.params.id);
    if (!activity) return res.status(404).json({ error: 'activity not found' });
    if (activity.status !== 'draft') {
      return res.status(400).json({ error: `activity is already ${activity.status}` });
    }
    try {
      const fields = normalizeActivityInput(db, {}, activity);
      if (Date.parse(fields.end_at) <= Date.now()) {
        throw new SeckillError('INVALID_TIME', 'end_at must be in the future before publishing');
      }
      db.prepare(
        `UPDATE seckill_activities
         SET title = ?, seckill_price = ?, stock = ?, start_at = ?, end_at = ?,
             limit_per_user = ?, pay_timeout_minutes = ?, status = 'published', updated_at = ?
         WHERE id = ? AND status = 'draft'`
      ).run(
        fields.title,
        fields.seckill_price,
        fields.stock,
        fields.start_at,
        fields.end_at,
        fields.limit_per_user,
        fields.pay_timeout_minutes,
        now(),
        activity.id
      );
      logOperation(db, {
        activityId: activity.id,
        actor: 'admin',
        action: 'publish',
        detail: {
          seckill_price: fields.seckill_price,
          stock: fields.stock,
          start_at: fields.start_at,
          end_at: fields.end_at,
        },
      });
      res.json(
        serializeActivity(db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(activity.id))
      );
    } catch (err) {
      handleSeckillError(res, err);
    }
  });

  // 提前终止：停止新下单；已创建的待支付订单仍按各自支付期限处理
  router.post('/activities/:id/terminate', (req, res) => {
    const activity = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(req.params.id);
    if (!activity) return res.status(404).json({ error: 'activity not found' });
    if (activity.status !== 'published') {
      return res.status(400).json({ error: `activity is ${activity.status} and cannot be terminated` });
    }
    const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason : '';
    db.prepare(`UPDATE seckill_activities SET status = 'terminated', updated_at = ? WHERE id = ?`).run(
      now(),
      activity.id
    );
    logOperation(db, {
      activityId: activity.id,
      actor: 'admin',
      action: 'terminate',
      detail: { reason },
    });
    res.json(
      serializeActivity(db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(activity.id))
    );
  });

  router.get('/activities/:id/stats', (req, res) => {
    const activity = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(req.params.id);
    if (!activity) return res.status(404).json({ error: 'activity not found' });
    expireSeckillOrders(db, { activityId: activity.id });

    const stats = statsByActivity(db).get(activity.id) || {};
    const fresh = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(activity.id);
    const eventRows = db
      .prepare(
        `SELECT event_type, COUNT(*) AS count FROM seckill_events
         WHERE activity_id = ? GROUP BY event_type ORDER BY count DESC`
      )
      .all(activity.id);
    const events = {};
    for (const row of eventRows) events[row.event_type] = row.count;

    const { metrics } = summarize(fresh, stats);
    const paidAmount = db
      .prepare(
        `SELECT COALESCE(SUM(pay_amount), 0) AS amount FROM seckill_orders
         WHERE activity_id = ? AND status = 'paid'`
      )
      .get(activity.id).amount;
    const soldOutEvent = db
      .prepare(
        `SELECT created_at FROM seckill_events
         WHERE activity_id = ? AND event_type = 'sold_out' ORDER BY id ASC LIMIT 1`
      )
      .get(activity.id);
    const views = events.view || 0;
    const abnormalCount =
      metrics.refunded_count + (events.payment_after_cancel_refunded || 0);

    res.json({
      activity: serializeActivity(fresh),
      metrics: {
        ...metrics,
        paid_amount: paidAmount,
        activity_views: views,
        order_conversion: views > 0 ? Number((metrics.order_count / views).toFixed(4)) : 0,
        payment_conversion:
          metrics.order_count > 0
            ? Number((metrics.paid_count / metrics.order_count).toFixed(4))
            : 0,
        sold_out_at: soldOutEvent ? soldOutEvent.created_at : null,
        abnormal_order_count: abnormalCount,
        stock_usage_rate: fresh.stock > 0 ? Number((fresh.sold / fresh.stock).toFixed(4)) : 0,
      },
      events,
      server_time: new Date().toISOString(),
    });
  });

  router.get('/activities/:id/logs', (req, res) => {
    const activity = db.prepare('SELECT * FROM seckill_activities WHERE id = ?').get(req.params.id);
    if (!activity) return res.status(404).json({ error: 'activity not found' });
    const rows = db
      .prepare('SELECT * FROM seckill_logs WHERE activity_id = ? ORDER BY id DESC LIMIT 200')
      .all(activity.id);
    res.json(rows.map((row) => ({ ...row, detail: parseJson(row.detail, {}) })));
  });

  return router;
}

module.exports = { seckillRouter, seckillAdminRouter, normalizeActivityInput };
