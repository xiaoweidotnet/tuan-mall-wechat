const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar_url TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  price INTEGER NOT NULL,
  original_price INTEGER DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  limit_per_user INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  leader_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  target_quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  delivery_methods TEXT NOT NULL DEFAULT '["express"]',
  is_seckill INTEGER NOT NULL DEFAULT 0,
  seckill_start_at TEXT,
  full_reduction_rules TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  quantity INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  pay_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_method TEXT NOT NULL DEFAULT 'express',
  address TEXT,
  pickup_point_id INTEGER,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS pickup_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  contact TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 秒杀活动：运营配置商品、秒杀价、活动库存、起止时间、限购与支付期限。
-- sold 为「已占用库存」：下单即锁定，取消/超时释放，支付后保留。
CREATE TABLE IF NOT EXISTS seckill_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,
  seckill_price INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  sold INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  limit_per_user INTEGER NOT NULL DEFAULT 1,
  pay_timeout_minutes INTEGER NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 秒杀订单：request_id 为客户端幂等键，同一用户同一活动重复提交返回同一订单。
CREATE TABLE IF NOT EXISTS seckill_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  activity_id INTEGER NOT NULL REFERENCES seckill_activities(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  pay_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_method TEXT NOT NULL DEFAULT 'express',
  address TEXT,
  pickup_point_id INTEGER,
  request_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS seckill_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seckill_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  user_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`;

function createDb(dbPath = ':memory:') {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // 轻量迁移：老库补 detail_images 列（已存在时 ALTER 报错，忽略即可）
  try {
    db.exec("ALTER TABLE products ADD COLUMN detail_images TEXT NOT NULL DEFAULT '[]'");
  } catch {
    // duplicate column name，忽略
  }
  // openid 唯一索引：防止同一微信用户重复建档（老库若有重复数据则跳过）
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_openid ON users(openid)');
  } catch {
    // 历史数据重复等，忽略
  }
  // 秒杀下单幂等键：同一用户同一活动同一 request_id 只允许一张订单
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_seckill_orders_request
       ON seckill_orders(buyer_id, activity_id, request_id)
       WHERE request_id IS NOT NULL`
    );
  } catch {
    // 历史数据冲突等，忽略
  }
  return db;
}

function now() {
  return new Date().toISOString();
}

module.exports = { createDb, now };
