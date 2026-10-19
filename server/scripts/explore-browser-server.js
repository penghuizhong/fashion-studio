// Isolated browser fixture: never touches the developer or production database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'fashion-explore-browser-')
);
process.env.MULTI_USER = 'false';
process.env.MOCK_LLM = 'true';
const { getDb, setSetting } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const db = getDb(),
  now = new Date().toISOString();
db.prepare(
  'INSERT INTO providers(id,name,preset,kind,base_url,is_active,created_at) VALUES(?,?,?,?,?,?,?)'
).run(
  'browser-provider',
  '浏览器测试供应商',
  'custom',
  'both',
  'https://example.invalid',
  1,
  now
);
for (const kind of ['chat', 'image'])
  for (const suffix of ['one', 'two'])
    db.prepare(
      'INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(
      `browser-${kind}-${suffix}`,
      'browser-provider',
      kind,
      `test/${kind}/${suffix}`,
      `${kind === 'chat' ? '发散' : '图片'}模型${suffix}`,
      JSON.stringify(
        kind === 'image'
          ? { per_call: 5 }
          : { input_per_1m: 100, output_per_1m: 200 }
      ),
      JSON.stringify({ sizes: ['512x512', '1024x1024'], image_edit:kind==='image',multi_reference:kind==='image',vision:kind==='chat' }),
      1,
      now
    );
db.prepare('INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('browser-reasoner','browser-provider','chat','deepseek-reasoner','固定推理模型','{"input_per_1m":100,"output_per_1m":200}','{}',1,now);
setSetting('worker_model', 'test/chat/one');
const server = createApp().listen(3310, '127.0.0.1', () =>
  console.log('browser fixture ready')
);
const stop = () => {
  server.closeAllConnections();
  server.close(() => {
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    process.exit(0);
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
