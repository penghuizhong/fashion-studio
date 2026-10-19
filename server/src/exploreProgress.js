import { randomUUID } from 'node:crypto';
import { ah } from './asyncHandler.js';
import { upstreamProblem } from './exploreErrors.js';
export const MAX_EXPLORE_COUNT = 16;
export function expandOutputBudget(fields, count, thinking = false) {
  const base = Math.max(2048, count * (fields.length * 65 + 150));
  return Math.min(thinking ? 32768 : 24576, thinking ? base * 2 : base);
}
// Only completed JSON objects are counted; never expose model reasoning or unvalidated DNA.
export function receivedProposalCount(text) {
  const start = /"proposals"\s*:\s*\[/.exec(text);
  if (!start) return 0;
  let depth = 0,
    inString = false,
    escape = false,
    count = 0;
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) count++;
    else if (c === ']' && depth === 0) break;
  }
  return count;
}
export function progressRoute(fn) {
  return ah(async (req, res) => {
    if (!req.body?.stream_progress) return fn(req, res);
    const started = Date.now();
    let latest = { stage: 'preparing', message: '正在检查模型和配置' };
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    req.exploreProgress = (data) => {
      latest = { ...latest, ...data };
      send('progress', { ...latest, elapsed_ms: Date.now() - started });
    };
    const timer = setInterval(
      () => send('progress', { ...latest, elapsed_ms: Date.now() - started }),
      3000
    );
    timer.unref();
    const original = res.json.bind(res);
    res.json = (data) => {
      send('result', data);
      res.end();
      return res;
    };
    req.exploreProgress(latest);
    try {
      await fn(req, res);
    } catch (e) {
      const err = upstreamProblem(e, '创意发散');
      const id = randomUUID();
      console.error('[explore-stream-error]', id, err.code);
      send('error', {
        error: err.publicMessage,
        code: err.code,
        status: err.statusCode,
        request_id: id,
      });
      res.end();
    } finally {
      clearInterval(timer);
      res.json = original;
    }
  });
}
