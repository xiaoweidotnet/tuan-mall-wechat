const payment = require('./payment');

// 已售数量：非 cancelled/refunded 订单的累计件数
function soldQuantity(db, groupId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS sold
       FROM orders
       WHERE group_id = ? AND status NOT IN ('cancelled', 'refunded')`
    )
    .get(groupId);
  return row.sold;
}

function restock(db, productId, quantity) {
  db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(quantity, productId);
}

/**
 * 结算团购（无论是否到期）：target_quantity>0 且已售未达标 → failed，
 * 所有 paid/refund_requested/shipped 订单自动退款并回补库存，
 * pending 订单取消并回补库存（设计文档只提到 paid 订单，pending 留在 failed 团里
 * 无法支付也无意义，故一并取消）；否则 succeeded。
 */
function settleGroup(db, groupId) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group || group.status !== 'active') return group;

  const sold = soldQuantity(db, groupId);
  const failed = group.target_quantity > 0 && sold < group.target_quantity;

  const tx = db.transaction(() => {
    db.prepare('UPDATE groups SET status = ? WHERE id = ?').run(
      failed ? 'failed' : 'succeeded',
      groupId
    );
    if (failed) {
      const orders = db
        .prepare(
          `SELECT * FROM orders
           WHERE group_id = ? AND status IN ('pending', 'paid', 'refund_requested', 'shipped')`
        )
        .all(groupId);
      for (const order of orders) {
        if (order.status === 'pending') {
          db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(order.id);
        } else {
          payment.refund(order);
          db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).run(order.id);
        }
        restock(db, group.product_id, order.quantity);
      }
    }
  });
  tx();

  return db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
}

// 惰性结算：到期才触发
function settleGroupIfDue(db, groupId) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (group && group.status === 'active' && Date.parse(group.end_at) <= Date.now()) {
    return settleGroup(db, groupId);
  }
  return group;
}

// 读列表前批量惰性结算所有到期团购
function settleAllDue(db) {
  const rows = db.prepare(`SELECT id, end_at FROM groups WHERE status = 'active'`).all();
  for (const row of rows) {
    if (Date.parse(row.end_at) <= Date.now()) settleGroup(db, row.id);
  }
}

module.exports = { soldQuantity, settleGroup, settleGroupIfDue, settleAllDue, restock };
