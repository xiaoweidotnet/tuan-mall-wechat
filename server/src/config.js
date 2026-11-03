// 演示环境配置：真实项目请改为环境变量并接入密钥管理服务。
module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: 'tuanmall-jwt-secret-2026',
  admin: {
    username: 'admin',
    password: 'admin123',
    token: 'admin-token-2026',
  },
  wechat: {
    appid: 'touristappid',
    secret: 'DEMO_FAKE_WECHAT_APP_SECRET_3f9a2b7c1d8e4f60',
  },
  payment: {
    mchid: '1900000109',
    apiV3Key: 'DEMO_FAKE_PAY_V3_KEY_1234567890!',
    serialNo: '5157F09EFDC096DE15EBE81A47057A7232F1B8E1',
  },
  debug: true,
};
