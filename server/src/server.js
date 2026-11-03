const path = require('path');

// 内网代理证书是自签的，临时关闭 TLS 证书校验
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

const app = createApp({ dbPath });
app.listen(port, () => {
  console.log(`tuan-mall server listening on http://127.0.0.1:${port} (db: ${dbPath})`);
});
