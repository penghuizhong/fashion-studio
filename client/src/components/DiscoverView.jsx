import { useEffect, useMemo, useState } from 'react';
import { api, isMultiUserMode } from '../api.js';
import Icon from './icons.jsx';

const AGE_KEY = 'soulchat-age-ok';
const CAT_FALLBACK = {
  romance: '恋爱',
  comfort: '治愈',
  anime: '二次元',
  xianxia: '仙侠',
  mystery: '悬疑',
  comedy: '搞笑',
  history: '历史',
};

// 发现角色：预设卡浏览 + 一键领养 + AI 生成
export default function DiscoverView({
  user,
  config,
  onAdopted,
  onRequireLogin,
  onExit,
  onOpenSidebar,
  showToast,
}) {
  const loggedIn = !isMultiUserMode() || !!user;
  const [data, setData] = useState(null);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState(null);
  const [adopting, setAdopting] = useState(false);
  const [ageOk, setAgeOk] = useState(() => {
    try {
      return localStorage.getItem(AGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [gateOpen, setGateOpen] = useState(() => {
    try {
      return localStorage.getItem(AGE_KEY) !== '1';
    } catch {
      return true;
    }
  });
  // AI 生成
  const [genOpen, setGenOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [genModel, setGenModel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState(null);

  useEffect(() => {
    api
      .getPresetCards()
      .then(setData)
      .catch(() => showToast('角色卡加载失败，请稍后重试'));
  }, [showToast]);

  const categories = (data && data.categories) || CAT_FALLBACK;
  const cards = (data && data.cards) || [];

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return cards.filter((c) => {
      if (cat !== 'all' && c.category !== cat) return false;
      if (!kw) return true;
      const hay = `${c.name} ${c.tagline || ''} ${(c.tags || []).join(' ')} ${c.description || ''}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [cards, cat, q]);

  const confirmAge = () => {
    try {
      localStorage.setItem(AGE_KEY, '1');
    } catch {
      /* 忽略 */
    }
    setAgeOk(true);
    setGateOpen(false);
  };

  const adopt = async (card, presetId) => {
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    if (adopting) return;
    setAdopting(true);
    try {
      const r = await api.adoptCharacterCard(presetId ? { preset_id: presetId } : { card });
      showToast(`已领养 ${r.character.name} 🎉`);
      setDetail(null);
      setGenResult(null);
      setGenOpen(false);
      onAdopted(r.character.id, r.conversation.id);
    } catch (e) {
      showToast((e && e.message) || '领养失败');
    } finally {
      setAdopting(false);
    }
  };

  const generate = async () => {
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    const desc = prompt.trim();
    if (!desc) {
      showToast('先用一句话描述你想要的角色');
      return;
    }
    if (generating) return;
    setGenerating(true);
    setGenResult(null);
    try {
      const r = await api.generateCharacterCard({ prompt: desc, model: genModel || undefined });
      setGenResult(r);
      if (r.cost) showToast(`生成成功，消耗 ${r.cost.points} 积分`);
      else showToast('生成成功');
    } catch (e) {
      showToast((e && e.message) || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const models = (config && config.points_models) || [];

  // 年龄门未过：占位页
  if (!ageOk) {
    return (
      <div className="discover">
        <header className="discover-header">
          <div className="discover-header-inner">
            <button className="menu-btn icon-btn" title="打开侧边栏" onClick={onOpenSidebar}>
              ☰
            </button>
            <h2>发现角色</h2>
          </div>
        </header>
        <div className="discover-inner">
        <div className="discover-gate">
          <div className="gate-card">
          <div className="gate-emoji">🧭</div>
          <h2>发现角色</h2>
          <p>这里有官方预设的角色卡和 AI 生成器，开始前请确认：</p>
          <button className="btn primary" onClick={() => setGateOpen(true)}>
            进入前确认年龄
          </button>
          {onExit && (
            <button className="btn secondary" onClick={onExit}>
              以后再说
            </button>
          )}
        </div>
        {gateOpen && (
          <div className="modal-overlay" onClick={() => setGateOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>年龄确认</h3>
              <p className="gate-text">
                发现页包含恋爱向等成人向角色卡。请确认你已年满 18
                岁，并知晓角色均为虚构 AI，不提供医疗、法律等专业建议。
              </p>
              <div className="modal-actions">
                <button className="btn secondary" onClick={() => setGateOpen(false)}>
                  取消
                </button>
                <button className="btn primary" onClick={confirmAge}>
                  我已年满 18 岁
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="discover">
      <header className="discover-header">
        <div className="discover-header-inner">
          <button className="menu-btn icon-btn" title="打开侧边栏" onClick={onOpenSidebar}>
            ☰
          </button>
          <h2>发现角色</h2>
        </div>
      </header>
      <div className="discover-inner">
      <p className="discover-sub">官方预设，一键领养即聊；也可以让 AI 为你定制一张</p>

      <div className="discover-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索名字、标签、简介…"
        />
      </div>

      <div className="gen-entry">
        <button className="gen-entry-btn" onClick={() => setGenOpen((o) => !o)}>
          <span className="gen-spark">✨</span> AI 一键生成角色
          <Icon name="chevronDown" size={16} />
        </button>
        {genOpen && (
          <div className="gen-panel">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="用一句话描述你想要的角色，比如：嘴硬心软的猫耳女仆，喜欢讲冷笑话"
              rows={3}
              maxLength={500}
            />
            <div className="gen-row">
              {isMultiUserMode() && models.length > 0 && (
                <select value={genModel} onChange={(e) => setGenModel(e.target.value)}>
                  <option value="">自动（最便宜）</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}（{m.inputPer1M}/{m.outputPer1M}）
                    </option>
                  ))}
                </select>
              )}
              <button className="btn primary" onClick={generate} disabled={generating}>
                {generating ? '生成中…' : '生成'}
              </button>
            </div>
            <div className="gen-hint">
              {isMultiUserMode()
                ? '按实际用量扣积分，失败不扣；生成后可预览，满意再领养'
                : '使用你自己的 Key 生成，不扣平台积分'}
            </div>
            {genResult && genResult.card && (
              <div className="gen-result">
                <CardFace card={genResult.card} categories={categories} />
                {genResult.cost && (
                  <div className="gen-cost">
                    本次消耗 {genResult.cost.points} 积分（{genResult.cost.model}，
                    {genResult.cost.tokens_input}+{genResult.cost.tokens_output} tokens）
                  </div>
                )}
                <div className="gen-result-actions">
                  <button
                    className="btn primary"
                    disabled={adopting}
                    onClick={() => adopt(genResult.card, null)}
                  >
                    {adopting ? '领养中…' : '领养这个角色'}
                  </button>
                  <button className="btn secondary" onClick={generate} disabled={generating}>
                    换一张
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="cat-tabs">
        <button className={cat === 'all' ? 'cat-tab active' : 'cat-tab'} onClick={() => setCat('all')}>
          全部
        </button>
        {Object.keys(categories).map((k) => (
          <button
            key={k}
            className={cat === k ? 'cat-tab active' : 'cat-tab'}
            onClick={() => setCat(k)}
          >
            {categories[k]}
          </button>
        ))}
      </div>

      {!data ? (
        <div className="discover-loading">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="discover-empty">没有找到相关角色，换个关键词试试</div>
      ) : (
        <div className="card-grid">
          {filtered.map((c) => (
            <div key={c.id} className="preset-card" onClick={() => setDetail(c)}>
              <CardFace card={c} categories={categories} />
              <button
                className="btn primary small preset-adopt"
                onClick={(e) => {
                  e.stopPropagation();
                  adopt(c, c.id);
                }}
                disabled={adopting}
              >
                开始聊天
              </button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{detail.name}</h3>
              <button className="modal-close" onClick={() => setDetail(null)}>
                ✕
              </button>
            </div>
            <div className="card-detail">
              <div className="card-detail-top">
                <span className="preset-avatar xl">{detail.avatar || '🤖'}</span>
                <div>
                  <div className="preset-tagline">{detail.tagline}</div>
                  <div className="preset-tags">
                    <span className="cat-badge">{categories[detail.category] || detail.category}</span>
                    {(detail.tags || []).map((t) => (
                      <span key={t} className="tag-badge">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {detail.description && <p className="card-desc">{detail.description}</p>}
              <div className="greeting-label">开场白</div>
              <div className="greeting-box">{detail.greeting}</div>
              {detail.example_dialogues && detail.example_dialogues.length > 0 && (
                <>
                  <div className="greeting-label">示例对话</div>
                  <div className="example-dialogues">
                    {detail.example_dialogues.map((d, i) => (
                      <div key={i} className="example-turn">
                        <div className="ex-user">你：{d.user}</div>
                        <div className="ex-assistant">
                          {detail.name}：{d.assistant}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn primary"
                disabled={adopting}
                onClick={() => adopt(detail, detail.id)}
              >
                {adopting ? '领养中…' : '领养并开始聊天'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function CardFace({ card, categories }) {
  return (
    <div className="preset-face">
      <span className="preset-avatar">{card.avatar || '🤖'}</span>
      <div className="preset-meta">
        <div className="preset-name">{card.name}</div>
        <div className="preset-tagline">{card.tagline}</div>
        <div className="preset-tags">
          <span className="cat-badge">{categories[card.category] || card.category}</span>
          {(card.tags || []).slice(0, 2).map((t) => (
            <span key={t} className="tag-badge">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
