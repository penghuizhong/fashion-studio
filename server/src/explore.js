// P4 发散创建：发散引擎（纯函数）+ 渲染复用
// P5: DNA 字段按类目预设动态（废弃旧 11 字段定死）
import { randomUUID } from 'node:crypto';
import { getConfig } from './config.js';
import { getDb } from './db.js';
import { ah } from './asyncHandler.js';
import {
  availableModels,
  resolveExploreModel,
  publicModel,
} from './exploreModels.js';
import { problem, upstreamProblem } from './exploreErrors.js';
import {
  parseIndexes,
  requireBatch,
  makeQuote,
  startJob,
  waitJob,
  batchJobs,
  recoverExploreJobs,
  syncBatch,
} from './exploreJobs.js';
import { addLedger, recordByokUsage } from './points.js';
import {
  MAX_EXPLORE_COUNT,
  expandOutputBudget,
  receivedProposalCount,
  progressRoute,
} from './exploreProgress.js';
import { postJson, postJsonStream, stripFences } from './llm.js';
import { getPreset } from './dnaPresets.js';

// 旧 11 字段保留作回退（无预设时的兼容）；正常流程一律走预设
const LEGACY_DNA_FIELDS = [
  'category',
  'silhouette',
  'collar',
  'sleeve',
  'skirt',
  'fabric',
  'primary_color',
  'secondary_color',
  'style',
  'details',
  'scene',
];

const AXIS_SEEDS = {
  silhouette: ['A字型', '茧型', '修身', '宽松直筒'],
  fabric: ['真丝', '棉麻', '牛仔', '针织'],
  style: ['极简', '复古', '街头', '优雅'],
  details: ['刺绣', '褶皱', '镂空', '拼接'],
  scene: ['日常通勤', '度假', '晚宴', '街头'],
  category: ['连衣裙', '半裙', '外套', '衬衫'],
  collar: ['圆领', 'V领', '立领', '翻领'],
  sleeve: ['无袖', '短袖', '长袖', '泡泡袖'],
  skirt: ['短裙', '中裙', '长裙', '鱼尾裙'],
  primary_color: ['黑', '白', '米色', '雾蓝'],
  secondary_color: ['金', '银', '红', '墨绿'],
};

function fieldsOf(preset) {
  const fs =
    preset && preset.fields && preset.fields.length ? preset.fields : null;
  if (fs)
    return fs.map((f) => ({ key: f.key, label: f.label, hint: f.hint || '' }));
  return LEGACY_DNA_FIELDS.map((k) => ({ key: k, label: k }));
}

function blankDna(preset) {
  const dna = {};
  for (const f of fieldsOf(preset)) dna[f.key] = { value: '', confidence: 0 };
  return dna;
}

function normalizeDna(raw, preset) {
  const dna = blankDna(preset);
  if (raw && typeof raw === 'object') {
    for (const f of fieldsOf(preset)) {
      const v = raw[f.key];
      if (v && typeof v === 'object' && 'value' in v) {
        dna[f.key] = { value: v.value, confidence: Number(v.confidence) || 0 };
      } else if (v != null && typeof v !== 'object') {
        dna[f.key] = { value: v, confidence: 0.5 };
      }
    }
  }
  return dna;
}

// mock 分支：确定性生成 count 个 DNA，axes 字段轮换取候选值（供回归）
function mockExpand({ axes, count, preset, locked = {} }) {
  const proposals = [];
  for (let i = 0; i < count; i++) {
    const dna = blankDna(preset);
    for (const f of fieldsOf(preset))
      dna[f.key] = {
        value: f.key === 'details' ? ['测试细节'] : '测试' + f.label,
        confidence: 0.8,
      };
    for (const [k, value] of Object.entries(locked))
      dna[k] = { value, confidence: 1 };
    for (const ax of axes) {
      const seeds = AXIS_SEEDS[ax] || ['方案A', '方案B', '方案C', '方案D'];
      const val =
        i < seeds.length ? seeds[i] : `${seeds[i % seeds.length]}变化${i + 1}`;
      dna[ax] = { value: ax === 'details' ? [val] : val, confidence: 0.8 };
    }
    proposals.push({
      dna,
      rationale: `mock 候选 ${i + 1}：${axes.map((a) => (dna[a] || {}).value).join(' / ')}`,
    });
  }
  return proposals;
}

export function buildExpandSystem(preset) {
  const fields = fieldsOf(preset);
  const fieldDesc = fields
    .map((f) => `${f.key}(${f.label}${f.hint ? `；建议：${f.hint}` : ''})`)
    .join('\n');
  const pname = (preset && preset.name) || '服装';
  return `你是服装设计师的灵感发散引擎。用户给出一句灵感（可能为空），你要把它发散成 N 个完整且互异的${pname}款式 DNA。

DNA 有 ${fields.length} 个字段，每个字段格式为 {"value": ..., "confidence": 0~1}。details.value 必须为字符串数组，其他 value 为非空字符串，secondary_color 可为 null；禁止额外字段：
${fieldDesc}。

严格要求：
1. 只输出 JSON，格式：{"proposals": [{"dna": {${fields.length}字段}, "rationale": "一句话说明这个方案的差异点"}]}，不要 Markdown 代码块或说明文字；使用紧凑 JSON 不缩进，rationale 不超过 60 字。
2. N 个方案的发散轴组合必须两两互异（这是发散的核心，不许换汤不换药）。
3. 规则优先级：用户明确要求及锁定字段 > 类目补充规则 > 字段 hint > 发散轴建议；非轴字段填与灵感自洽的合理值；灵感为空时按当季流行风格自由发散。
4. confidence 按你对该取值的把握填写。
5. 用户明确给出的款式、色彩、结构及面料约束必须被所有方案保留；只在指定发散轴上改变未锁定的属性。
6. 每个字段必须存在，confidence 必须在 0 到 1 之间；返回恰好 N 个方案。${String(preset?.expand_prompt || '').trim() ? '\n类目发散补充规则：\n' + String(preset.expand_prompt).trim() : ''}`;
}

export function validateLocks(locked, fields, axes) {
  if (!locked || typeof locked !== 'object' || Array.isArray(locked))
    throw problem('INVALID_LOCKS', '锁定字段格式错误');
  for (const [k, v] of Object.entries(locked)) {
    if (!fields.some((f) => f.key === k) || axes.includes(k))
      throw problem('LOCK_AXIS_CONFLICT', '锁定字段不能同时作为发散轴');
    if (
      !validValue(v, k) ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && !v.length)
    )
      throw problem('INVALID_LOCKS', '锁定值不能为空，细节需使用文本数组');
  }
}
function validValue(v, key) {
  return key === 'details'
    ? Array.isArray(v) &&
        v.every((x) => typeof x === 'string' && x.trim() && x.length <= 200)
    : v === null || (typeof v === 'string' && v.length <= 500);
}
export function validateProposals(list, { fields, axes, count, locked = {} }) {
  if (!Array.isArray(list) || list.length !== count)
    throw new Error('候选数量不准确');
  const expected = fields.map((f) => f.key);
  const proposals = list.map((p) => {
    if (
      !p?.dna ||
      Array.isArray(p.dna) ||
      Object.keys(p.dna).length !== expected.length ||
      Object.keys(p.dna).some((k) => !expected.includes(k))
    )
      throw new Error('DNA 字段键不匹配');
    for (const key of expected) {
      const v = p.dna[key];
      if (
        !v ||
        Array.isArray(v) ||
        !Object.hasOwn(v, 'value') ||
        !Number.isFinite(v.confidence) ||
        v.confidence < 0 ||
        v.confidence > 1 ||
        !validValue(v.value, key)
      )
        throw new Error(`字段 ${key} 类型或置信度错误`);
      if (
        v.value === '' ||
        (v.value === null && !['secondary_color'].includes(key))
      )
        throw new Error(`字段 ${key} 不能为空`);
      if (
        Object.hasOwn(locked, key) &&
        JSON.stringify(locked[key]) !== JSON.stringify(v.value)
      )
        throw new Error(`锁定字段 ${key} 被改变`);
    }
    return {
      dna: normalizeDna(p.dna, { fields }),
      rationale: String(p.rationale || '').slice(0, 200),
    };
  });
  const signatures = proposals.map((p) =>
    JSON.stringify(
      axes.map((k) =>
        typeof p.dna[k].value === 'string'
          ? p.dna[k].value.trim().toLowerCase()
          : p.dna[k].value
      )
    )
  );
  if (new Set(signatures).size !== count) throw new Error('发散轴组合重复');
  return proposals;
}

/**
 * 发散意图 → N 个完整 DNA
 * @param {Object} p - { intentText, axes, count, preset, model, apiKey, baseUrl, provider, onUsage }
 * @returns {Promise<Array<{dna, rationale}>>}
 */
export async function expandIntent({
  intentText,
  axes,
  count,
  preset,
  model,
  apiKey,
  baseUrl,
  provider,
  onUsage,
  locked = {},
  thinking = false,
  onProgress,
}) {
  const fields = fieldsOf(preset);
  const validKeys = new Set(fields.map((f) => f.key));
  const ax = [...new Set((axes || []).map((a) => String(a).trim()))];
  const n = count === undefined ? 6 : Number(count);
  if (ax.length === 0) throw new Error('至少选择一个发散轴');
  for (const a of ax) {
    if (!validKeys.has(a)) throw new Error(`非法发散轴: ${a}`);
  }
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXPLORE_COUNT)
    throw new Error(`候选数量须在 1..${MAX_EXPLORE_COUNT} 之间`);
  validateLocks(locked, fields, ax);
  const intent = String(intentText || '').slice(0, 500);

  const cfg = getConfig();
  if (cfg.mockLlm)
    return validateProposals(
      mockExpand({ axes: ax, count: n, preset, locked }),
      { fields, axes: ax, count: n, locked }
    );

  const labelOf = (k) => (fields.find((f) => f.key === k) || {}).label || k;
  const userPrompt = `灵感：${intent || '（空，按流行风格自由发散）'}\n发散轴：${ax.map((a) => `${a}(${labelOf(a)})`).join(', ')}\n数量：${n}\n锁定字段（必须逐字保留）：${JSON.stringify(locked)}`;
  let lastErr = null;
  let attempt = 0;
  for (const temperature of [0.65, 0.4]) {
    attempt++;
    onProgress?.({
      stage: attempt === 1 ? 'waiting' : 'repairing',
      attempt,
      message:
        attempt === 1
          ? '请求已提交，等待模型响应'
          : '方案未通过校验，正在进行一次格式修复',
      received_chars: 0,
      received_proposals: 0,
    });
    const { json, usage } = await (onProgress ? postJsonStream : postJson)({
      model,
      temperature,
      apiKey,
      baseUrl,
      provider,
      strictCredentials: true,
      maxTokens: expandOutputBudget(fields, n, thinking),
      thinking,
      onProgress,
      onContentProgress: (text) =>
        onProgress?.({
          stage: 'generating',
          attempt,
          message: '正在接收候选方案（尚未校验）',
          received_chars: text.length,
          received_proposals: receivedProposalCount(text),
        }),
      messages: [
        { role: 'system', content: buildExpandSystem(preset) },
        {
          role: 'user',
          content:
            userPrompt +
            (lastErr ? `\n上次输出不合规，请修复：${lastErr.message}` : ''),
        },
      ],
    });
    if (onUsage) onUsage(usage);
    const text =
      (json &&
        json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content) ||
      '';
    onProgress?.({
      stage: 'validating',
      attempt,
      message: '正在校验数量、锁定字段和方案差异',
    });
    try {
      const parsed = JSON.parse(stripFences(text));
      const proposals = validateProposals(parsed?.proposals, {
        fields,
        axes: ax,
        count: n,
        locked,
      });
      return proposals;
    } catch (e) {
      lastErr = e;
    }
  }
  throw problem(
    'INVALID_MODEL_OUTPUT',
    `发散模型输出不合规：${lastErr?.message || '无法解析'}，请更换模型或调整条件`,
    422
  );
}

// ---------- 路由 ----------
// P4-3: 全部要登录；multiUser 按 user_id 隔离（与 studio.js 一致）

export const DEFAULT_AXES = [
  'silhouette',
  'fabric',
  'style',
  'details',
  'scene',
];

// P5: 按预设取默认发散轴（取预设字段中风格相关的前 5 个；无预设用旧默认）
export function defaultAxesFor(preset) {
  if (!preset || !preset.fields || !preset.fields.length) return DEFAULT_AXES;
  const prefer = [
    'silhouette',
    'fabric',
    'style',
    'details',
    'scene',
    'pattern',
    'collar',
    'neckline',
  ];
  const keys = preset.fields.map((f) => f.key);
  const picked = prefer.filter((k) => keys.includes(k));
  for (const k of keys)
    if (!picked.includes(k) && picked.length < 5) picked.push(k);
  return picked.slice(0, 5);
}

export function mountExploreRoutes(app) {
  const db = getDb();
  const cfg = getConfig();
  const uidOf = (req) => (req && req.userId) || 'local';
  const getBatch = (id, req) => {
    const uid = uidOf(req);
    return cfg.multiUser
      ? db
          .prepare('SELECT * FROM exploration_batches WHERE id=? AND user_id=?')
          .get(id, uid)
      : db.prepare('SELECT * FROM exploration_batches WHERE id=?').get(id);
  };
  recoverExploreJobs();
  const recoveryTimer = setInterval(recoverExploreJobs, 60000);
  recoveryTimer.unref();
  app.get(
    '/api/studio/image-models',
    ah(async (req, res) =>
      res.json({ ok: true, models: availableModels('image') })
    )
  );
  app.get(
    '/api/studio/explore-models',
    ah(async (req, res) => {
      const models = availableModels('chat');
      let recommended_id = '';
      try {
        recommended_id = resolveExploreModel(req, null, 'chat').id;
      } catch {}
      res.json({ ok: true, models, recommended_id });
    })
  );
  app.post(
    '/api/studio/explore',
    progressRoute(async (req, res) => {
      const b = req.body || {},
        preset = getPreset(b.preset_id);
      if (!preset?.is_active) throw problem('INVALID_PRESET', '请选择服装类目');
      const axes = Array.isArray(b.axes) ? b.axes : defaultAxesFor(preset),
        count = b.count ?? 6;
      if (!Number.isInteger(count) || count < 1 || count > MAX_EXPLORE_COUNT)
        throw problem(
          'INVALID_COUNT',
          `候选数量须为 1..${MAX_EXPLORE_COUNT} 的整数`
        );
      const locked = b.locked_fields || {};
      validateLocks(locked, fieldsOf(preset), axes);
      if (
        !axes.length ||
        axes.some((a) => !preset.fields.some((f) => f.key === a))
      )
        throw problem('INVALID_AXES', '请选择有效发散轴');
      const model = resolveExploreModel(req, b.expand_model_id, 'chat');
      if (b.thinking !== undefined && typeof b.thinking !== 'boolean')
        throw problem('INVALID_THINKING', '思考开关必须为布尔值');
      const thinking =
        model.thinking_control === 'forced_on'
          ? true
          : model.thinking_control === 'unsupported'
            ? false
            : b.thinking === true;
      const timings = { started_at: new Date().toISOString(), attempts: 0 };
      const started = Date.now();
      const onProgress = (data) => {
        timings.attempts = Math.max(timings.attempts, data.attempt || 0);
        if (
          data.stage === 'receiving' &&
          timings.first_response_ms === undefined
        )
          timings.first_response_ms = Date.now() - started;
        if (data.received_chars > 0 && timings.first_content_ms === undefined)
          timings.first_content_ms = Date.now() - started;
        req.exploreProgress?.(data);
      };
      const requestKey = b.request_key || randomUUID();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey))
        throw problem('INVALID_REQUEST_KEY', '需要有效请求标识');
      const id = `${uidOf(req)}:${requestKey}`,
        now = new Date().toISOString(),
        intent = String(b.intent_text || '').slice(0, 500);
      const request = JSON.stringify({
        preset_id: preset.id,
        axes,
        count,
        locked,
        intent,
        model_id: model.id,
        thinking,
      });
      const prior = db
        .prepare('SELECT * FROM explore_expansions WHERE id=?')
        .get(id);
      if (prior) {
        if (JSON.parse(prior.snapshot_json).request !== request)
          throw problem(
            'IDEMPOTENCY_CONFLICT',
            '发散请求标识已用于其他参数',
            409
          );
        if (prior.batch_id) {
          const previous = requireBatch(prior.batch_id, req);
          return res.json({
            ok: true,
            id: previous.id,
            proposals: JSON.parse(previous.proposals_json),
            fields: JSON.parse(previous.snapshot_json).preset.fields,
            snapshot: JSON.parse(previous.snapshot_json),
            expand_cost: prior.usage_cost,
            reused: true,
          });
        }
        throw problem(
          prior.status === 'uncertain'
            ? 'RESULT_UNCERTAIN'
            : 'EXPANSION_EXISTS',
          prior.status === 'uncertain'
            ? '上次发散结果待核对，请勿重复提交'
            : '该发散请求正在执行或已失败，请刷新历史或重新发散',
          409
        );
      }
      const unknown = db
        .prepare(
          "SELECT snapshot_json FROM explore_expansions WHERE user_id=? AND status='uncertain'"
        )
        .all(uidOf(req));
      if (unknown.some((x) => JSON.parse(x.snapshot_json).request === request))
        throw problem(
          'RESULT_UNCERTAIN',
          '相同发散任务的费用待核对，请先联系管理员',
          409
        );
      const inputBudget =
        (buildExpandSystem(preset).length +
          intent.length +
          JSON.stringify(locked).length) *
          2 +
        4000;
      const paidRates =
        Number(model.pricing.input_per_1m) +
          Number(model.pricing.output_per_1m) >
        0;
      const budget =
        model.billable && paidRates
          ? 2 *
            Math.max(
              1,
              Math.ceil(
                (inputBudget * model.pricing.input_per_1m +
                  expandOutputBudget(preset.fields, count, thinking) *
                    model.pricing.output_per_1m) /
                  1e6
              )
            )
          : 0;
      const snapshot = {
        request,
        thinking,
        timings,
        preset,
        locked_fields: locked,
        expand_model: publicModel(model),
        prompt_version: 'explore-v2',
        billing_policy:
          '成功发散按实际 token 结算；格式修复最多一次，用量合并计费',
      };
      db.transaction(() => {
        if (budget)
          try {
            addLedger(
              uidOf(req),
              -budget,
              'explore_expand_reserve',
              'explore_expand',
              id
            );
          } catch {
            throw problem(
              'INSUFFICIENT_POINTS',
              '积分不足以支付本次发散额度',
              402
            );
          }
        db.prepare(
          'INSERT INTO explore_expansions(id,user_id,status,reserved,snapshot_json,lease_until) VALUES(?,?,?,?,?,?)'
        ).run(
          id,
          uidOf(req),
          'running',
          budget,
          JSON.stringify(snapshot),
          Date.now() + 300000
        );
      })();
      let usedInput = 0,
        usedOutput = 0;
      let spent = 0,
        uncertain = false,
        proposals,
        result,
        complete = false;
      try {
        proposals = await expandIntent({
          intentText: intent,
          axes,
          count,
          preset,
          locked,
          model: model.model_id,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          provider: model.provider,
          thinking,
          onProgress: req.exploreProgress ? onProgress : undefined,
          onUsage: (usage) => {
            usedInput += usage?.input || 0;
            usedOutput += usage?.output || 0;
            if (!usage && model.billable)
              throw problem(
                'USAGE_UNKNOWN',
                '供应商未返回用量，费用待核对',
                502
              );
            if (model.billable && paidRates)
              spent += Math.max(
                1,
                Math.ceil(
                  ((usage?.input || 0) * model.pricing.input_per_1m +
                    (usage?.output || 0) * model.pricing.output_per_1m) /
                    1e6
                )
              );
            else
              recordByokUsage(
                req.userId,
                model.model_id,
                'explore_expand',
                usage
              );
          },
        });
        if (spent > budget)
          throw problem(
            'USAGE_UNKNOWN',
            '供应商用量超出预留范围，费用待核对',
            502
          );
        complete = true;
      } catch (e) {
        const error = upstreamProblem(e, '创意发散');
        uncertain = ['RESULT_UNCERTAIN', 'USAGE_UNKNOWN'].includes(error.code);
        throw error;
      } finally {
        db.transaction(() => {
          // Product policy: unsuccessful/schema-invalid expansion is refunded; upstream cost is retained in audit.
          const charged = complete ? spent : 0;
          timings.total_ms = Date.now() - started;
          snapshot.usage = { input: usedInput, output: usedOutput };
          if (complete && model.billable)
            addLedger(
              uidOf(req),
              0,
              'explore_expand_settle',
              'explore_expand',
              id,
              {
                model: model.model_id,
                tokensInput: usedInput,
                tokensOutput: usedOutput,
                accountingDelta: -charged,
              }
            );
          if (!uncertain && budget > charged)
            addLedger(
              uidOf(req),
              budget - charged,
              'explore_expand_release',
              'explore_expand',
              id
            );
          if (complete) {
            result = db
              .prepare(
                `INSERT INTO exploration_batches(user_id,intent_text,preset_id,axes_json,count,proposals_json,render_model_id,render_size,cost_estimate,status,created_at,updated_at,snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
              )
              .run(
                uidOf(req),
                intent,
                preset.id,
                JSON.stringify(axes),
                count,
                JSON.stringify(proposals),
                b.render_model_id || '',
                b.render_size || '',
                0,
                'expanded',
                now,
                now,
                JSON.stringify(snapshot)
              );
            db.prepare(
              'UPDATE explore_expansions SET batch_id=? WHERE id=?'
            ).run(result.lastInsertRowid, id);
          }
          db.prepare(
            'UPDATE explore_expansions SET status=?,reserved=?,usage_cost=?,snapshot_json=? WHERE id=?'
          ).run(
            uncertain ? 'uncertain' : complete ? 'succeeded' : 'failed',
            uncertain ? budget : 0,
            spent,
            JSON.stringify(snapshot),
            id
          );
        })();
      }
      req.exploreProgress?.({
        stage: 'complete',
        message: '方案校验通过，已保存',
        received_proposals: count,
      });
      res.json({
        ok: true,
        id: result.lastInsertRowid,
        proposals,
        fields: preset.fields,
        preset_id: preset.id,
        snapshot,
        expand_cost: spent,
        cost_estimate: 0,
      });
    })
  );
  app.post(
    '/api/studio/explore/:id/select',
    ah(async (req, res) => {
      const batch = requireBatch(req.params.id, req),
        indexes = parseIndexes(
          req.body?.indexes,
          JSON.parse(batch.proposals_json).length
        );
      const lock = db
        .prepare(
          "UPDATE exploration_batches SET selected_json=?,status='selected',updated_at=? WHERE id=? AND status IN ('expanded','selected')"
        )
        .run(JSON.stringify(indexes), new Date().toISOString(), batch.id);
      if (!lock.changes)
        throw problem(
          'INVALID_BATCH_STATE',
          '该批次已进入生成流程，不能重置选择状态',
          409
        );
      res.json({ ok: true, selected: indexes });
    })
  );
  app.post(
    '/api/studio/explore/:id/quote',
    ah(async (req, res) =>
      res.json({
        ok: true,
        quote: makeQuote(requireBatch(req.params.id, req), req, req.body || {}),
      })
    )
  );
  app.post(
    '/api/studio/explore/:id/render',
    ah(async (req, res) => {
      const batch = requireBatch(req.params.id, req),
        b = req.body || {};
      if (b.confirm !== true)
        throw problem('CONFIRM_REQUIRED', '请确认费用后重试');
      // Legacy clients may render once synchronously. New clients always quote and use a stable request key.
      if (!b.quote_id) {
        parseIndexes(b.indexes, JSON.parse(batch.proposals_json).length);
        if (['rendered', 'adopted'].includes(batch.status))
          return res.json({
            ok: true,
            renders: JSON.parse(batch.renders_json),
            cost_actual: batch.cost_actual,
            reused: true,
          });
        const q = makeQuote(batch, req, b);
        b.quote_id = q.id;
        b.request_key = b.request_key || `legacy_${batch.id}`;
      }
      const result = startJob(batch, req, b);
      if (b.async) return res.status(202).json({ ok: true, ...result });
      const job = await waitJob(result.job.id);
      res.json({
        ok: true,
        ...result,
        job,
        renders: job.renders,
        cost_actual: job.cost_actual,
      });
    })
  );
  app.get(
    '/api/studio/explore/:id/jobs',
    ah(async (req, res) => {
      const b = requireBatch(req.params.id, req);
      res.json({ ok: true, jobs: batchJobs(b.id) });
    })
  );
  app.post(
    '/api/studio/explore/:id/adopt',
    ah(async (req, res) => {
      const batch = requireBatch(req.params.id, req),
        proposals = JSON.parse(batch.proposals_json),
        indexes = parseIndexes(req.body?.indexes, proposals.length);
      if (batch.status === 'rendering')
        throw problem('BATCH_BUSY', '生成完成后再收卡', 409);
      const selectedJob = req.body?.job_id
        ? batchJobs(batch.id).find((j) => j.id === req.body.job_id)
        : null;
      if (req.body?.job_id && !selectedJob)
        throw problem('JOB_NOT_FOUND', '生成记录不存在', 404);
      const renders = selectedJob?.renders || JSON.parse(batch.renders_json),
        byIdx = new Map(
          renders
            .filter((r) => !r.error && r.image_path)
            .map((r) => [r.proposal_idx, r])
        );
      // Legacy text-only adoption is preserved. Rendered batches may adopt successful images only.
      if (renders.length && indexes.some((i) => !byIdx.has(i)))
        throw problem('IMAGE_NOT_READY', '只能收取生成成功的图片');
      const templateIds = db.transaction(() => {
        const adopted = JSON.parse(
            db
              .prepare(
                'SELECT adopted_json FROM exploration_batches WHERE id=?'
              )
              .get(batch.id).adopted_json || '{}'
          ),
          ids = [],
          now = new Date().toISOString();
        for (const idx of indexes) {
          const image = byIdx.get(idx),
            key = image?.item_id || `proposal_${idx}`;
          if (adopted[key]) {
            ids.push(adopted[key]);
            continue;
          }
          const tr = db
            .prepare(
              `INSERT INTO style_dna_templates(user_id,name,preset_id,dna_json,gen_params_json,status,version,created_at,updated_at) VALUES(?,?,?,?,?,'draft',1,?,?)`
            )
            .run(
              uidOf(req),
              `发散灵感 #${batch.id}-${idx}`,
              batch.preset_id || '',
              JSON.stringify(proposals[idx].dna),
              JSON.stringify({
                explore_batch_id: batch.id,
                proposal_idx: idx,
                item_id: image?.item_id,
              }),
              now,
              now
            );
          const tid = tr.lastInsertRowid;
          if (image)
            db.prepare(
              `INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,prompt_snapshot,seed,model_id,size,op,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
            ).run(
              tid,
              uidOf(req),
              image.image_path,
              image.thumb_path,
              image.prompt_snapshot || '',
              image.seed,
              image.model,
              image.size,
              'explore',
              now
            );
          adopted[key] = tid;
          ids.push(tid);
        }
        db.prepare(
          "UPDATE exploration_batches SET adopted_json=?,status='adopted',updated_at=? WHERE id=?"
        ).run(JSON.stringify(adopted), now, batch.id);
        return ids;
      })();
      res.json({ ok: true, template_ids: templateIds });
    })
  );

  const requireAdmin = (req) => {
    if (
      !cfg.multiUser ||
      !db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.userId)
        ?.is_admin
    )
      throw problem('FORBIDDEN', '需要管理员权限', 403);
  };
  app.get(
    '/api/admin/explore-recovery',
    ah(async (req, res) => {
      requireAdmin(req);
      recoverExploreJobs();
      const images = db
        .prepare(
          `SELECT i.id,i.job_id,j.user_id,i.reserved,i.result_json FROM explore_items i JOIN explore_jobs j ON j.id=i.job_id WHERE i.status='uncertain' LIMIT 100`
        )
        .all()
        .map((i) => ({
          id: i.id,
          type: 'image',
          user_id: i.user_id,
          reserved: i.reserved,
          prompt: JSON.parse(i.result_json).prompt_snapshot || '',
          seed: JSON.parse(i.result_json).seed,
        }));
      const expansions = db
        .prepare(
          "SELECT id,user_id,reserved FROM explore_expansions WHERE status='uncertain' LIMIT 100"
        )
        .all()
        .map((x) => ({ ...x, type: 'expansion' }));
      const legacy = db
        .prepare(
          "SELECT id,user_id FROM exploration_batches b WHERE status='rendering' AND NOT EXISTS (SELECT 1 FROM explore_jobs j WHERE j.batch_id=b.id) LIMIT 100"
        )
        .all()
        .map((b) => ({ ...b, type: 'legacy', reserved: 0 }));
      res.json({ ok: true, items: [...images, ...expansions, ...legacy] });
    })
  );
  app.post(
    '/api/admin/explore-legacy/:batchId/resolve',
    ah(async (req, res) => {
      requireAdmin(req);
      const note = String(req.body?.note || '').trim();
      if (
        note.length < 10 ||
        note.length > 1000 ||
        req.body?.confirmed_failed !== true
      )
        throw problem(
          'CONFIRM_REQUIRED',
          '核对旧任务后，请填写至少 10 字处理依据'
        );
      db.transaction(() => {
        const batch = db
          .prepare(
            "SELECT * FROM exploration_batches b WHERE id=? AND status='rendering' AND NOT EXISTS (SELECT 1 FROM explore_jobs j WHERE j.batch_id=b.id)"
          )
          .get(req.params.batchId);
        if (!batch)
          throw problem('NOT_UNCERTAIN', '该批次不是旧版待核对任务', 409);
        const snapshot = JSON.parse(batch.snapshot_json);
        snapshot.legacy_resolution = {
          by: req.userId,
          note,
          at: new Date().toISOString(),
        };
        db.prepare(
          'UPDATE exploration_batches SET status=?,snapshot_json=? WHERE id=?'
        ).run(
          JSON.parse(batch.renders_json).length ? 'rendered' : 'expanded',
          JSON.stringify(snapshot),
          batch.id
        );
      })();
      res.json({ ok: true });
    })
  );
  app.post(
    '/api/admin/explore-expansions/:expansionId/resolve',
    ah(async (req, res) => {
      requireAdmin(req);
      const note = String(req.body?.note || '').trim();
      if (
        note.length < 10 ||
        note.length > 1000 ||
        req.body?.confirmed_failed !== true
      )
        throw problem(
          'CONFIRM_REQUIRED',
          '请核对供应商并填写至少 10 字处理依据'
        );
      db.transaction(() => {
        const e = db
          .prepare(
            "SELECT * FROM explore_expansions WHERE id=? AND status='uncertain'"
          )
          .get(req.params.expansionId);
        if (!e) throw problem('NOT_UNCERTAIN', '该发散不是待确认状态', 409);
        if (e.reserved)
          addLedger(
            e.user_id,
            e.reserved,
            'explore_resolve',
            'explore_expand',
            e.id
          );
        const snapshot = JSON.parse(e.snapshot_json);
        snapshot.resolution = {
          by: req.userId,
          note,
          at: new Date().toISOString(),
        };
        db.prepare(
          "UPDATE explore_expansions SET status='failed',reserved=0,snapshot_json=? WHERE id=?"
        ).run(JSON.stringify(snapshot), e.id);
      })();
      res.json({ ok: true });
    })
  );
  app.post(
    '/api/admin/explore-items/:itemId/resolve',
    ah(async (req, res) => {
      if (
        !cfg.multiUser ||
        !db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.userId)
          ?.is_admin
      )
        throw problem('FORBIDDEN', '需要管理员权限', 403);
      const note = String(req.body?.note || '').trim();
      if (
        note.length < 10 ||
        note.length > 1000 ||
        req.body?.confirmed_failed !== true
      )
        throw problem(
          'CONFIRM_REQUIRED',
          '核对供应商结果后，填写至少 10 字的处理依据并确认退款'
        );
      db.transaction(() => {
        const i = db
          .prepare(
            "SELECT i.*,j.user_id,j.batch_id FROM explore_items i JOIN explore_jobs j ON j.id=i.job_id WHERE i.id=? AND i.status='uncertain'"
          )
          .get(req.params.itemId);
        if (!i) throw problem('NOT_UNCERTAIN', '该项目不是待确认状态', 409);
        if (i.reserved)
          addLedger(
            i.user_id,
            i.reserved,
            'explore_resolve',
            'explore_item',
            i.id
          );
        const r = JSON.parse(i.result_json);
        r.code = 'RESOLVED_FAILED';
        r.error = '管理员已核对并退款，可重新报价';
        r.resolution = { by: req.userId, note, at: new Date().toISOString() };
        db.prepare(
          "UPDATE explore_items SET status='failed',reserved=0,result_json=? WHERE id=?"
        ).run(JSON.stringify(r), i.id);
        if (
          !db
            .prepare(
              "SELECT 1 FROM explore_items WHERE job_id=? AND status='uncertain'"
            )
            .get(i.job_id)
        )
          db.prepare(
            "UPDATE explore_jobs SET status='partial' WHERE id=? AND status IN ('uncertain','interrupted')"
          ).run(i.job_id);
        syncBatch(i.batch_id);
      })();
      res.json({ ok: true });
    })
  );

  // GET /api/studio/explore → 列表
  app.get(
    '/api/studio/explore',
    progressRoute(async (req, res) => {
      const uid = uidOf(req);
      const inc = req.query && req.query.include_archived === '1';
      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 20, 1),
        100
      );
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const conds = [];
      const args = [];
      if (cfg.multiUser) {
        conds.push('user_id=?');
        args.push(uid);
      }
      if (!inc) conds.push('archived=0');
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = db
        .prepare(
          `SELECT id,user_id,intent_text,preset_id,axes_json,count,selected_json,render_model_id,cost_estimate,cost_actual,status,archived,created_at,updated_at,
      json_array_length(proposals_json) AS proposal_count, json_array_length(renders_json) AS render_count,
      (SELECT count(*) FROM json_each(renders_json) WHERE json_extract(value,'$.image_path') IS NOT NULL AND json_extract(value,'$.error') IS NULL) AS success_count,
      (SELECT json_extract(value,'$.thumb_path') FROM json_each(renders_json) WHERE json_extract(value,'$.image_path') IS NOT NULL LIMIT 1) AS thumb_path
      FROM exploration_batches ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...args, limit, offset);
      res.json({ ok: true, batches: rows });
    })
  );

  // GET /api/studio/explore/:id → 详情
  app.get(
    '/api/studio/explore/:id',
    ah(async (req, res) => {
      requireBatch(req.params.id, req);
      batchJobs(Number(req.params.id));
      const batch = getBatch(req.params.id, req);
      if (!batch) return res.status(404).json({ error: '批次不存在' });
      res.json({ ok: true, batch });
    })
  );
}
