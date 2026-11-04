/**
 * 秒杀活动与秒杀订单的核心逻辑。
 *
 * 关键约定：
 * - 活动库存 `stock` 与已占用库存 `sold` 都在活动上，`sold` 在下单时锁定、
 *   取消/支付超时时释放；商品库存不参与秒杀扣减（活动库存是独立分配的名额）。
 * - 活动是否可购买以服务端时间计算，页面倒计时只用于展示。
 * - 下单在同一事务内完成「限购校验 → 建单 → 条件扣库存」，条件更新失败即视为售罄，
 *   因此不会出现超卖；客户端 request_id 作为幂等键，重复提交返回同一张订单。
 * - 支付回调幂等；订单已超时取消后又收到支付成功通知时，自动退款并记录异常。
 */
const crypto = require('crypto');
const { now } = require('../db');
const payment = require('./payment');

class SeckillError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SeckillError';
    this.code = code;
    this.status = status;
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 活动对外状态：draft/not_started/ongoing/ended/terminated/sold_out */
function computeActivityStatus(activity, nowMs = Date.now()) {
  if (!activity) return null;
  if (activity.status === 'draft') return 'draft';
  if (activity.status === 'terminated') return 'terminated';
  const start = Date.parse(activity.start_at);
  const end = Date.parse(activity.end_at);
  if (nowMs < start) return 'not_started';
  if (nowMs >= end) return 'ended';
  if (activity.sold >= activity.stock) return 'sold_out';
  return 'ongoing';
}

function remainingStock(activity) {
  if (!activity) return 0;
  return Math.max(activity.stock - activity.sold, 0);
}

function serializeActivity(activity, nowMs = Date.now()) {
  if (!activity) return null;
  const status = computeActivityStatus(activity, nowMs);
  return {
    ...activity,
    status,
    lifecycle_status: activity.status,
    sold_out: status === 'sold_out',
    remaining_stock: remainingStock(activity),
    can_buy: status === 'ongoing' && remainingStock(activity) > 0,
    server_time: new Date(nowMs).toISOString(),
  };
}

function serializeSeckillOrder(db, order) {
  if (!order) return null;
  const activity = db
    .prepare(
      `SELECT id, title, seckill_price, stock, sold, start_at, end_at, limit_per_user,
              pay_timeout_minutes, status AS lifecycle_status
       FROM seckill_activities WHERE id = ?`
    )
    .get(order.activity_id);
  return {
    ...order,
    kind: 'seckill',
    address: order.address ? parseJson(order.address, order.address) : null,
    activity_title: activity ? activity.title : '',
    activity: activity || null,
    activity_status: computeActivityStatus(activity),
    server_time: new Date().toISOString(),
  };
}

function logOperation(db, { activityId, actor, action, detail = {} }) {
  db.prepare(
    `INSERT INTO seckill_logs (activity_id, actor, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(activityId, String(actor), action, JSON.stringify(detail), now());
}

function logEvent(db, { activityId, eventType, userId = null, detail = {} }) {
  db.prepare(
    `INSERT INTO seckill_events (activity_id, event_type, user_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(activityId, eventType, userId, JSON.stringify(detail), now());
}

/** 释放已占用库存（取消/超时），不会把 sold 扣成负数 */
function releaseStock(db, activityId, quantity) {
  db.prepare(
    `UPDATE seckill_activities
     SET sold = CASE WHEN sold >= ? THEN sold - ? ELSE 0 END
     WHERE id = ?`
  ).run(quantity, quantity, activityId);
}

/** 惰性取消所有已过支付期限的待支付订单（可指定活动），返回取消数量 */
function expireSeckillOrders(db, { activityId = null, nowMs = Date.now() } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const rows =
    activityId == null
      ? db
          .prepare(`SELECT * FROM seckill_orders WHERE status = 'pending' AND expires_at <= ?`)
          .all(nowIso)
      : db
          .prepare(
            `SELECT * FROM seckill_orders
             WHERE status = 'pending' AND expires_at <= ? AND activity_id = ?`
          )
          .all(nowIso, activityId);
  if (rows.length === 0) return 0;

  let cancelled = 0;
  const tx = db.transaction(() => {
    for (const order of rows) {
      const info = db
        .prepare(
          `UPDATE seckill_orders
           SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'payment_timeout'
           WHERE id = ? AND status = 'pending'`
        )
        .run(nowIso, order.id);
      if (info.changes === 0) continue;
      releaseStock(db, order.activity_id, order.quantity);
      logEvent(db, {
        activityId: order.activity_id,
        eventType: 'order_timeout_cancelled',
        userId: order.buyer_id,
        detail: { order_no: order.order_no, quantity: order.quantity },
      });
      cancelled += 1;
    }
  });
  tx();
  return cancelled;
}

function genSeckillOrderNo() {
  return `S${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * 下单：校验登录由路由保证；这里校验活动状态、限购、库存和履约信息。
 * 返回 { order, created }，重复 request_id 返回 created=false 的原订单。
 */
function createSeckillOrder(db, {
  activityId,
  buyer,
  quantity,
  requestId,
  deliveryMethod = 'express',
  address = null,
  pickupPointId = null,
  nowMs = Date.now(),
} = {}) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new SeckillError('INVALID_QUANTITY', 'quantity must be a positive integer');
  }
  if (!requestId || typeof requestId !== 'string' || requestId.length > 64) {
    throw new SeckillError('INVALID_REQUEST_ID', 'request_id is required (max 64 chars)');
  }
  if (!['express', 'pickup'].includes(deliveryMethod)) {
    throw new SeckillError('INVALID_DELIVERY', "delivery_method must be 'express' or 'pickup'");
  }
  if (deliveryMethod === 'express' && !address) {
    throw new SeckillError('ADDRESS_REQUIRED', 'address is required for express delivery');
  }
  if (deliveryMethod === 'pickup' && !pickupPointId) {
    throw new SeckillError('PICKUP_POINT_REQUIRED', 'pickup_point_id is required for pickup delivery');
  }

  expireSeckillOrders(db, { nowMs });

  const duplicate = db
    .prepare(
      `SELECT * FROM seckill_orders
       WHERE buyer_id = ? AND activity_id = ? AND request_id = ?`
    )
    .get(buyer.id, activityId, requestId);
  if (duplicate) return { order: duplicate, created: false };

  const createdAt = new Date(nowMs).toISOString();
  const tx = db.transaction(() => {
    const activity = db
      .prepare('SELECT * FROM seckill_activities WHERE id = ?')
      .get(activityId);
    if (!activity) throw new SeckillError('ACTIVITY_NOT_FOUND', 'activity not found', 404);

    const status = computeActivityStatus(activity, nowMs);
    if (status === 'draft' || status === 'terminated') {
      throw new SeckillError('NOT_PURCHASABLE', 'activity is not purchasable');
    }
    if (status === 'not_started') {
      throw new SeckillError('NOT_STARTED', 'seckill has not started yet');
    }
    if (status === 'ended') throw new SeckillError('ENDED', 'seckill has ended');
    if (status === 'sold_out') throw new SeckillError('SOLD_OUT', 'seckill is sold out');

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(activity.product_id);
    if (!product) throw new SeckillError('PRODUCT_NOT_FOUND', 'product not found');
    if (product.status === 'off') {
      throw new SeckillError('PRODUCT_OFF', 'product is off sale');
    }

    if (deliveryMethod === 'pickup') {
      const point = db.prepare('SELECT id FROM pickup_points WHERE id = ?').get(pickupPointId);
      if (!point) throw new SeckillError('PICKUP_POINT_NOT_FOUND', 'pickup point not found');
    }

    const bought = db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS bought FROM seckill_orders
         WHERE activity_id = ? AND buyer_id = ? AND status IN ('pending', 'paid')`
      )
      .get(activityId, buyer.id).bought;
    if (bought + quantity > activity.limit_per_user) {
      throw new SeckillError(
        'LIMIT_EXCEEDED',
        `purchase limit exceeded (limit ${activity.limit_per_user} per user)`
      );
    }

    const expiresAt = new Date(
      nowMs + activity.pay_timeout_minutes * 60 * 1000
    ).toISOString();
    const orderNo = genSeckillOrderNo();
    let info;
    try {
      info = db
        .prepare(
          `INSERT INTO seckill_orders
           (order_no, activity_id, buyer_id, quantity, unit_price, pay_amount, status,
            delivery_method, address, pickup_point_id, request_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          orderNo,
          activityId,
          buyer.id,
          quantity,
          activity.seckill_price,
          activity.seckill_price * quantity,
          deliveryMethod,
          address ? JSON.stringify(address) : null,
          pickupPointId,
          requestId,
          createdAt,
          expiresAt
        );
    } catch (err) {
      // 并发提交同一 request_id：唯一索引冲突时返回已生成的订单
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const existing = db
          .prepare(
            `SELECT * FROM seckill_orders
             WHERE buyer_id = ? AND activity_id = ? AND request_id = ?`
          )
          .get(buyer.id, activityId, requestId);
        if (existing) return { order: existing, created: false };
      }
      throw err;
    }

    // 条件扣减：sold + quantity <= stock 才成功，否则整笔事务回滚（防超卖）
    const stockUpdate = db
      .prepare(
        `UPDATE seckill_activities
         SET sold = sold + ?
         WHERE id = ? AND sold + ? <= stock`
      )
      .run(quantity, activityId, quantity);
    if (stockUpdate.changes === 0) {
      throw new SeckillError('SOLD_OUT', 'seckill is sold out');
    }
    if (activity.sold + quantity === activity.stock) {
      logEvent(db, {
        activityId,
        eventType: 'sold_out',
        userId: buyer.id,
        detail: { order_no: orderNo },
      });
    }

    const order = db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(info.lastInsertRowid);
    logEvent(db, {
      activityId,
      eventType: 'order_created',
      userId: buyer.id,
      detail: { order_no: order.order_no, quantity },
    });
    return { order, created: true };
  });

  return tx();
}

/** 支付（mock）：等待支付订单置为已支付；重复支付幂等返回 */
function paySeckillOrder(db, { orderId, user, nowMs = Date.now() } = {}) {
  expireSeckillOrders(db, { nowMs });
  const order = db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(orderId);
  if (!order) throw new SeckillError('ORDER_NOT_FOUND', 'order not found', 404);
  if (order.buyer_id !== user.id) {
    throw new SeckillError('FORBIDDEN', 'only the buyer can pay the order', 403);
  }
  if (order.status === 'paid') return { order, alreadyPaid: true };
  if (order.status !== 'pending') {
    throw new SeckillError('INVALID_STATUS', `cannot pay order in status ${order.status}`);
  }

  const tx = db.transaction(() => {
    const result = payment.createPayment(order);
    const info = db
      .prepare(`UPDATE seckill_orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'`)
      .run(result.paid_at, order.id);
    const paid = db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(order.id);
    if (info.changes === 0) {
      if (paid.status === 'paid') return { order: paid, alreadyPaid: true };
      throw new SeckillError('INVALID_STATUS', `cannot pay order in status ${paid.status}`);
    }
    logEvent(db, {
      activityId: order.activity_id,
      eventType: 'payment_succeeded',
      userId: order.buyer_id,
      detail: { order_no: order.order_no },
    });
    return { order: paid, alreadyPaid: false };
  });
  return tx();
}

/** 买家主动取消待支付订单，释放占用库存 */
function cancelSeckillOrder(db, { orderId, user, nowMs = Date.now() } = {}) {
  expireSeckillOrders(db, { nowMs });
  const order = db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(orderId);
  if (!order) throw new SeckillError('ORDER_NOT_FOUND', 'order not found', 404);
  if (order.buyer_id !== user.id) {
    throw new SeckillError('FORBIDDEN', 'only the buyer can cancel the order', 403);
  }
  if (order.status !== 'pending') {
    throw new SeckillError('INVALID_STATUS', `cannot cancel order in status ${order.status}`);
  }
  const cancelledAt = new Date(nowMs).toISOString();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE seckill_orders
         SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'user_cancelled'
         WHERE id = ? AND status = 'pending'`
      )
      .run(cancelledAt, order.id);
    if (info.changes === 0) {
      const latest = db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(order.id);
      if (latest.status === 'cancelled') return latest;
      throw new SeckillError('INVALID_STATUS', `cannot cancel order in status ${latest.status}`);
    }
    releaseStock(db, order.activity_id, order.quantity);
    logEvent(db, {
      activityId: order.activity_id,
      eventType: 'order_cancelled',
      userId: order.buyer_id,
      detail: { order_no: order.order_no },
    });
    return db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(order.id);
  });
  return { order: tx() };
}

/**
 * 处理秒杀订单的支付回调（app.js 的 /api/payments/notify 复用）。
 * 返回 null 表示不是秒杀订单；否则返回处理结果。
 * - 重复成功通知：幂等，不重复记账；
 * - 已取消/超时订单收到成功通知：执行退款并记录异常，避免用户已付未得。
 */
function handlePaymentNotify(db, { orderNo, status = 'paid', nowMs = Date.now() } = {}) {
  const order = db.prepare('SELECT * FROM seckill_orders WHERE order_no = ?').get(orderNo);
  if (!order) return null;

  if (status !== 'paid') {
    logEvent(db, {
      activityId: order.activity_id,
      eventType: 'payment_notify_ignored',
      userId: order.buyer_id,
      detail: { order_no: orderNo, status },
    });
    return { order, ignored: true };
  }

  if (order.status === 'paid' || order.status === 'refunded') {
    logEvent(db, {
      activityId: order.activity_id,
      eventType: 'payment_notify_duplicate',
      userId: order.buyer_id,
      detail: { order_no: orderNo, status: order.status },
    });
    return { order, duplicate: true };
  }

  expireSeckillOrders(db, { nowMs });
  const fresh = db.prepare('SELECT * FROM seckill_orders WHERE order_no = ?').get(orderNo);

  if (fresh.status === 'pending') {
    const tx = db.transaction(() => {
      const result = payment.createPayment(fresh);
      db.prepare(
        `UPDATE seckill_orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'`
      ).run(result.paid_at, fresh.id);
      logEvent(db, {
        activityId: fresh.activity_id,
        eventType: 'payment_succeeded',
        userId: fresh.buyer_id,
        detail: { order_no: orderNo, source: 'notify' },
      });
    });
    tx();
    return {
      order: db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(fresh.id),
      paid: true,
    };
  }

  if (fresh.status === 'cancelled') {
    // 超时取消与支付成功并发：订单已关闭但款项已到，退款并留痕人工核对
    const tx = db.transaction(() => {
      const result = payment.refund(fresh);
      db.prepare(`UPDATE seckill_orders SET status = 'refunded' WHERE id = ? AND status = 'cancelled'`).run(
        fresh.id
      );
      logEvent(db, {
        activityId: fresh.activity_id,
        eventType: 'payment_after_cancel_refunded',
        userId: fresh.buyer_id,
        detail: { order_no: orderNo, refund_id: result.refund_id },
      });
      logOperation(db, {
        activityId: fresh.activity_id,
        actor: 'system',
        action: 'refund_after_cancel',
        detail: { order_no: orderNo, pay_amount: fresh.pay_amount },
      });
    });
    tx();
    return { order: db.prepare('SELECT * FROM seckill_orders WHERE id = ?').get(fresh.id), refunded: true };
  }

  return { order: fresh, ignored: true };
}

module.exports = {
  SeckillError,
  computeActivityStatus,
  remainingStock,
  serializeActivity,
  serializeSeckillOrder,
  logOperation,
  logEvent,
  expireSeckillOrders,
  createSeckillOrder,
  paySeckillOrder,
  cancelSeckillOrder,
  handlePaymentNotify,
  genSeckillOrderNo,
};
