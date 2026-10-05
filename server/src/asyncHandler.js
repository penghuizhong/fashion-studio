// Express 4 不捕获 async 路由的 reject（Node 22 下 unhandled rejection 直接崩进程）。
// 所有 async handler 用 ah() 包一层，错误统一进集中错误处理中间件。
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 集中错误处理：500 对外脱敏（不泄堆栈/SQL），4xx 透传业务 message
// eslint-disable-next-line no-unused-vars
export function apiErrorHandler(err, req, res, next) {
  try {
    console.error('[api-error]', req.method, req.path, (err && err.message) || err);
  } catch {
    /* 忽略日志异常 */
  }
  if (res.headersSent) return next(err);
  const status = err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;
  res.status(status).json({
    error: status === 500 ? '服务器开小差了，请稍后再试' : String((err && err.message) || '请求失败'),
  });
}
