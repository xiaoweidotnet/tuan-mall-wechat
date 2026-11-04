/**
 * 短信服务商抽象：登录验证码的发送只依赖 provider.sendVerificationCode。
 *
 * 短信服务商（阿里云/腾讯云等）与签名模板尚未确定，当前只内置开发 mock：
 * 验证码打印到服务端日志，不产生外部依赖。真实通道接入时，新增一个实现
 * { name, sendVerificationCode({ phone, code }) } 的 provider，并在 createSmsService
 * 的注册表里切换即可，路由层无需改动。
 */
function createMockSmsProvider() {
  return {
    name: 'mock',
    async sendVerificationCode({ phone, code }) {
      console.log(
        `[sms][mock] 未配置短信服务商，验证码仅输出到日志：phone=${phone} code=${code}`
      );
    },
  };
}

function createSmsService({ provider, providerName = 'mock' } = {}) {
  if (provider) {
    if (typeof provider.sendVerificationCode !== 'function') {
      throw new Error('SMS provider must implement sendVerificationCode()');
    }
    return {
      name: provider.name || 'custom',
      sendVerificationCode(payload) {
        return provider.sendVerificationCode(payload);
      },
    };
  }

  if (providerName !== 'mock') {
    throw new Error(
      `unsupported SMS provider: ${providerName}（当前仅内置 mock，接入真实通道需先实现 provider）`
    );
  }

  const mock = createMockSmsProvider();
  return {
    name: mock.name,
    sendVerificationCode(payload) {
      return mock.sendVerificationCode(payload);
    },
  };
}

module.exports = { createSmsService, createMockSmsProvider };
