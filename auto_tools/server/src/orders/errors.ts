/** 订单导出的输入/状态错误，路由层按 status 返回。 */
export class OrderInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'OrderInputError';
  }
}
