const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api } = require('./helpers');

const PHONE = '13800138000';
const OTHER_PHONE = '13900139000';

/** 短信替身：记录 provider 收到的 { phone, code }，不产生外部请求 */
function makeSmsStub() {
  const sent = [];
  return {
    name: 'test',
    sent,
    async sendVerificationCode(payload) {
      sent.push(payload);
    },
  };
}

const sendCode = (base, phone = PHONE) =>
  api(base, { method: 'POST', path: '/api/auth/send-code', body: { phone } });

const phoneLogin = (base, body) =>
  api(base, { method: 'POST', path: '/api/auth/phone-login', body });

test('发送验证码：校验手机号格式，成功响应不泄露验证码', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({ sms });
  t.after(() => server.close());

  for (const phone of ['', '12345', '12800138000', '1380013800x']) {
    const bad = await sendCode(base, phone);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /手机号/);
  }
  assert.equal(sms.sent.length, 0);

  const ok = await sendCode(base);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sent, true);
  assert.equal(ok.body.expires_in, 300);
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].phone, PHONE);
  assert.match(sms.sent[0].code, /^\d{6}$/);
  assert.equal(JSON.stringify(ok.body).includes(sms.sent[0].code), false);
});

test('发送验证码：provider 失败返回 502，且失败发送不占限流额度', async (t) => {
  let calls = 0;
  const flaky = {
    name: 'flaky',
    async sendVerificationCode() {
      calls += 1;
      if (calls === 1) throw new Error('sms gateway down');
    },
  };
  const { server, base, db } = await startServer({ sms: flaky });
  t.after(() => server.close());

  const failed = await sendCode(base);
  assert.equal(failed.status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_codes').get().n, 0);

  // 失败记录已删除，立刻重试不会被 60 秒最小间隔拦下
  const retried = await sendCode(base);
  assert.equal(retried.status, 200);
});

test('发送验证码：同一手机号 60 秒内重复发送被限流', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({ sms });
  t.after(() => server.close());

  const first = await sendCode(base);
  assert.equal(first.status, 200);

  const second = await sendCode(base);
  assert.equal(second.status, 429);
  assert.match(second.body.error, /频繁/);
  assert.ok(second.body.retry_after >= 1 && second.body.retry_after <= 60);
  assert.equal(sms.sent.length, 1);
});

test('发送验证码：同一手机号每小时条数上限', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({
    sms,
    smsLimits: { sendIntervalMs: 0, phoneHourlyLimit: 2 },
  });
  t.after(() => server.close());

  assert.equal((await sendCode(base)).status, 200);
  assert.equal((await sendCode(base)).status, 200);
  const third = await sendCode(base);
  assert.equal(third.status, 429);
  assert.match(third.body.error, /次数过多/);
  assert.equal(sms.sent.length, 2);
});

test('发送验证码：同一 IP 每小时条数上限（不同手机号）', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({
    sms,
    smsLimits: { sendIntervalMs: 0, phoneHourlyLimit: 100, ipHourlyLimit: 2 },
  });
  t.after(() => server.close());

  assert.equal((await sendCode(base, '13700137000')).status, 200);
  assert.equal((await sendCode(base, '13700137001')).status, 200);
  const third = await sendCode(base, '13700137002');
  assert.equal(third.status, 429);
  assert.match(third.body.error, /网络/);
  assert.equal(sms.sent.length, 2);
});

test('手机号登录：首次登录自动建档，token 可访问业务接口并走资料完善分流', async (t) => {
  const sms = makeSmsStub();
  const { server, base, db } = await startServer({ sms });
  t.after(() => server.close());

  await sendCode(base);
  const { code } = sms.sent[0];
  const res = await phoneLogin(base, { phone: PHONE, code });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.phone, PHONE);
  assert.equal(res.body.user.nickname, '');
  assert.equal(res.body.profile_completed, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);

  // 与微信登录共用 Bearer token 鉴权
  const products = await api(base, { path: '/api/products', token: res.body.token });
  assert.equal(products.status, 200);

  // 资料完善后 profile_completed 变为 true
  const profile = await api(base, {
    method: 'PUT',
    path: '/api/users/me',
    token: res.body.token,
    body: { nickname: '手机用户' },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.profile_completed, true);
});

test('手机号登录：老用户再次登录复用同一账号', async (t) => {
  const sms = makeSmsStub();
  const { server, base, db } = await startServer({
    sms,
    smsLimits: { sendIntervalMs: 0 },
  });
  t.after(() => server.close());

  await sendCode(base);
  const first = await phoneLogin(base, { phone: PHONE, code: sms.sent[0].code });
  assert.equal(first.status, 201);

  await sendCode(base);
  const second = await phoneLogin(base, { phone: PHONE, code: sms.sent[1].code });
  assert.equal(second.status, 201);
  assert.equal(second.body.user.id, first.body.user.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE phone = ?').get(PHONE).n, 1);

  // users.phone 唯一索引：同一手机号不允许重复建档
  assert.throws(() =>
    db
      .prepare('INSERT INTO users (openid, phone, nickname, created_at) VALUES (?, ?, ?, ?)')
      .run('duplicate_phone_openid', PHONE, '', new Date().toISOString())
  );
});

test('手机号登录：验证码错误、跨手机号使用、参数非法均返回 400 且不消费正确验证码', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({ sms });
  t.after(() => server.close());

  await sendCode(base);
  const { code } = sms.sent[0];
  const wrong = code === '000000' ? '111111' : '000000';

  const badFormat = await phoneLogin(base, { phone: '123', code });
  assert.equal(badFormat.status, 400);

  const badCodeFormat = await phoneLogin(base, { phone: PHONE, code: '12ab' });
  assert.equal(badCodeFormat.status, 400);
  assert.match(badCodeFormat.body.error, /格式/);

  const wrongCode = await phoneLogin(base, { phone: PHONE, code: wrong });
  assert.equal(wrongCode.status, 400);
  assert.match(wrongCode.body.error, /验证码错误/);

  // 验证码与手机号绑定：同码换手机号不能用
  const otherPhone = await phoneLogin(base, { phone: OTHER_PHONE, code });
  assert.equal(otherPhone.status, 400);

  // 错误尝试不消耗正确验证码
  const ok = await phoneLogin(base, { phone: PHONE, code });
  assert.equal(ok.status, 201);
});

test('手机号登录：验证码过期失效', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({ sms, smsLimits: { codeTtlMs: 20 } });
  t.after(() => server.close());

  await sendCode(base);
  const { code } = sms.sent[0];
  await new Promise((resolve) => setTimeout(resolve, 40));

  const res = await phoneLogin(base, { phone: PHONE, code });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /过期/);
});

test('手机号登录：验证码一次性使用，复用返回 400', async (t) => {
  const sms = makeSmsStub();
  const { server, base } = await startServer({ sms });
  t.after(() => server.close());

  await sendCode(base);
  const { code } = sms.sent[0];

  const first = await phoneLogin(base, { phone: PHONE, code });
  assert.equal(first.status, 201);

  const reused = await phoneLogin(base, { phone: PHONE, code });
  assert.equal(reused.status, 400);
  assert.match(reused.body.error, /验证码/);
});

test('手机号登录：未请求验证码直接登录返回 400', async (t) => {
  const { server, base } = await startServer({ sms: makeSmsStub() });
  t.after(() => server.close());

  const res = await phoneLogin(base, { phone: PHONE, code: '123456' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /验证码/);
});

test('手机号登录：验证码只以 HMAC 形式落库', async (t) => {
  const sms = makeSmsStub();
  const { server, base, db } = await startServer({ sms });
  t.after(() => server.close());

  await sendCode(base);
  const { code } = sms.sent[0];
  const row = db.prepare('SELECT * FROM sms_codes').get();
  assert.notEqual(row.code_hash, code);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.used_at, null);

  await phoneLogin(base, { phone: PHONE, code });
  assert.ok(db.prepare('SELECT used_at FROM sms_codes WHERE id = ?').get(row.id).used_at);
});
