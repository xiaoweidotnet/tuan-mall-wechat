/**
 * 支付服务（mock 实现）。
 *
 * 真实接入微信支付 v3 时替换为官方客户端（如 wechatpay-node-v3 / 自封装）：
 * - createPayment(order): 调用「JSAPI/小程序下单」POST /v3/pay/transactions/jsapi，
 *   商户号 mchid、API v3 密钥、商户私钥证书通过环境变量配置，
 *   返回 prepay_id 供小程序 wx.requestPayment 调起支付；
 *   支付结果以「支付通知回调」POST /v3/pay/transactions 的异步通知为准（需验签）。
 * - refund(order): 调用「申请退款」POST /v3/refund/domestic/refunds，
 *   退款结果同样以异步通知为准。
 *
 * MVP 阶段两个接口均直接返回成功。
 */

function createPayment(order) {
  return {
    success: true,
    transaction_id: `mock_tx_${order.order_no}`,
    paid_at: new Date().toISOString(),
  };
}

function refund(order) {
  return {
    success: true,
    refund_id: `mock_refund_${order.order_no}`,
    refunded_at: new Date().toISOString(),
  };
}

module.exports = { createPayment, refund };
