const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL,
  phone TEXT,
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

-- 手机号登录验证码：只存 HMAC，不落明文；used_at 非空表示已一次性使用
CREATE TABLE IF NOT EXISTS sms_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_created ON sms_codes(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_codes_ip_created ON sms_codes(ip, created_at);
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
  // 轻量迁移：老库补 phone 列；手机号唯一（SQLite 唯一索引允许多个 NULL）
  try {
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  } catch {
    // duplicate column name，忽略
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
  } catch {
    // 历史数据重复等，忽略
  }
  return db;
}

function now() {
  return new Date().toISOString();
}

module.exports = { createDb, now };
