export function problem(code, message, statusCode = 400) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    publicMessage: message,
  });
}
export function upstreamProblem(e, phase = '生成') {
  if (e.publicMessage) return e;
  const status = e.status || e.statusCode;
  if (status === 401 || status === 403)
    return problem(
      'PROVIDER_AUTH',
      '供应商授权失败，请检查所选模型的 Key',
      422
    );
  if (status === 404)
    return problem(
      'MODEL_UNAVAILABLE',
      '供应商不支持所选模型，请检查模型配置',
      422
    );
  if (status === 429)
    return problem('PROVIDER_LIMIT', '供应商限流，请稍后重试', 429);
  if (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    /timeout|fetch failed/i.test(e.message)
  )
    return problem(
      'RESULT_UNCERTAIN',
      `${phase}请求中断，结果待确认，请勿重复提交`,
      504
    );
  return problem(
    'PROVIDER_ERROR',
    `${phase}失败，供应商暂不可用或返回格式不正确`,
    502
  );
}
