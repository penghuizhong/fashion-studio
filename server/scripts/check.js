// SoulChat 后端回归测试入口（v1.24.0 拆分：lib + single + multi，单文件防超限）
// 用法：
//   node scripts/check.js                  # 单用户模式
//   CHECK_MODE=multi node scripts/check.js  # 多用户模式
// 注意：只扩展 check-single.js / check-multi.js；不要改版本号，不要碰 client/。
import { ok, results, server, MODE } from './check-lib.js';
import { runSingle } from './check-single.js';
import { runMulti } from './check-multi.js';

try {
  if (MODE === 'multi') await runMulti();
  else await runSingle();
} catch (e) {
  ok('未捕获异常', false, e && e.stack ? e.stack : String(e));
} finally {
  server.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`[${MODE}] 通过 ${passed}/${results.length}`);
for (const r of results.filter((r) => !r.pass)) {
  console.log(`[失败] ${r.name}${r.detail ? ' → ' + r.detail : ''}`);
}
process.exit(passed === results.length ? 0 : 1);
