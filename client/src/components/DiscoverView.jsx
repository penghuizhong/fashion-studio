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
const STATUS_LABEL = { pending: '待审核', approved: '已上架', rejected: '被打回' };

// 发现角色：官方预设 / 角色广场 / 集卡图鉴
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
  const [section, setSection] = useState('presets');
  // 预设卡
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
  // v1.13: 收藏的 AI 生成卡
  const [savedCards, setSavedCards] = useState(null);
  const [savedDetail, setSavedDetail] = useState(null);

  const loadSavedCards = async () => {
    if (!loggedIn) return;
    try {
      const r = await api.getSavedCards();
      setSavedCards((r && r.cards) || []);
    } catch {
      setSavedCards([]);
    }
  };
  useEffect(() => {
    if (section === 'saved') loadSavedCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

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

  // 领养：预设卡 / AI 生成卡
  const adopt = async (card, presetId, savedId) => {
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    if (adopting) return;
    setAdopting(true);
    try {
      const r = await api.adoptCharacterCard(
        presetId ? { preset_id: presetId } : { card, saved_id: savedId || undefined }
      );
      afterAdopt(r, savedId);
    } catch (e) {
      showToast((e && e.message) || '领养失败');
    } finally {
      setAdopting(false);
    }
  };

  const afterAdopt = (r, savedId) => {
    showToast(`已领养 ${r.character.name} 🎉`);
    if (r.collection_reward > 0) showToast(`🎉 集齐官方角色卡！+${r.collection_reward} 积分`, 3500);
    setDetail(null);
    setGenResult(null);
    setGenOpen(false);
    setSavedDetail(null);
    if (savedId) loadSavedCards();
    onAdopted(r.character.id, r.conversation.id);
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
      if (r.cost) showToast(`生成成功，已保存到「我的收藏」，消耗 ${r.cost.points} 积分`);
      else showToast('生成成功，已保存到「我的收藏」');
    } catch (e) {
      showToast((e && e.message) || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const models = (config && config.points_models) || [];

  const deleteSaved = async (id) => {
    if (!window.confirm('确定删除这张收藏的角色卡吗？')) return;
    try {
      await api.deleteSavedCard(id);
      showToast('已删除');
      setSavedDetail(null);
      loadSavedCards();
    } catch (e) {
      showToast((e && e.message) || '删除失败');
    }
  };

  // 年龄门未过：占位页
  if (!ageOk) {
    return (
      <div className="discover">
        <header className="discover-header">
          <div className="discover-header-inner">
            <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
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
          <p>官方预设、玩家广场、AI 生成，开始前请确认：</p>
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
                发现页包含恋爱向等成人向角色卡，广场含玩家投稿内容。请确认你已年满 18
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
    <>
    <div className="discover">
      <header className="discover-header">
        <div className="discover-header-inner">
          <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
            ☰
          </button>
          <h2>发现角色</h2>
        </div>
      </header>
      <div className="discover-inner">
      <div className="section-tabs">
        <button className={section === 'presets' ? 'section-tab active' : 'section-tab'} onClick={() => setSection('presets')}>
          官方预设
        </button>
        <button className={section === 'square' ? 'section-tab active' : 'section-tab'} onClick={() => setSection('square')}>
          角色广场
        </button>
        <button className={section === 'dex' ? 'section-tab active' : 'section-tab'} onClick={() => setSection('dex')}>
          集卡图鉴
        </button>
        <button className={section === 'saved' ? 'section-tab active' : 'section-tab'} onClick={() => setSection('saved')}>
          我的收藏
        </button>
      </div>

      {section === 'presets' && (
      <>
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
                    onClick={() => adopt(genResult.card, null, genResult.saved_id)}
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
        <CardDetailModal
          card={detail}
          categories={categories}
          onClose={() => setDetail(null)}
          onAdopt={() => adopt(detail, detail.id)}
          adopting={adopting}
        />
      )}
      </>
      )}

      {section === 'square' && (
        <SquareSection
          loggedIn={loggedIn}
          categories={categories}
          showToast={showToast}
          onRequireLogin={onRequireLogin}
          onAdopted={afterAdopt}
        />
      )}

      {section === 'dex' && (
        <DexSection
          categories={categories}
          showToast={showToast}
          onGoPresets={() => setSection('presets')}
        />
      )}

      {section === 'saved' && (
        <>
          <p className="discover-sub">AI 生成的角色卡会自动保存在这里，满意就领养开聊</p>
          {!loggedIn ? (
            <p className="key-desc">登录后查看收藏</p>
          ) : savedCards === null ? (
            <p className="key-desc">加载中…</p>
          ) : savedCards.length === 0 ? (
            <div className="dex-empty">
              <p className="key-desc">还没有收藏，去「官方预设」用 AI 生成一张吧 ✨</p>
              <button className="btn secondary" onClick={() => setSection('presets')}>去生成</button>
            </div>
          ) : (
            <div className="card-grid">
              {savedCards.map((s) => (
                s.card && (
                  <div key={s.id} className="preset-card" onClick={() => setSavedDetail(s)}>
                    <CardFace card={s.card} categories={categories} />
                    {s.adopted && <span className="preset-badge">已领养</span>}
                  </div>
                )
              ))}
            </div>
          )}
        </>
      )}
      </div>
    </div>
    {savedDetail && savedDetail.card && (
      <CardDetailModal
        card={savedDetail.card}
        categories={categories}
        onClose={() => setSavedDetail(null)}
        onAdopt={savedDetail.adopted ? null : () => adopt(savedDetail.card, null, savedDetail.id)}
        adopting={adopting}
        extraActions={
          <button className="btn danger secondary" onClick={() => deleteSaved(savedDetail.id)}>
            删除
          </button>
        }
      />
    )}
  </>
  );
}

// 预设卡详情弹窗（复用）
function CardDetailModal({ card, categories, onClose, onAdopt, adopting, extraActions }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{card.name}</h3>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-detail">
          <div className="card-detail-top">
            <span className="preset-avatar xl">{card.avatar || '🤖'}</span>
            <div>
              <div className="preset-tagline">{card.tagline}</div>
              <div className="preset-tags">
                <span className="cat-badge">{categories[card.category] || card.category}</span>
                {(card.tags || []).map((t) => (
                  <span key={t} className="tag-badge">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {card.description && <p className="card-desc">{card.description}</p>}
          <div className="greeting-label">开场白</div>
          <div className="greeting-box">{card.greeting}</div>
          {card.example_dialogues && card.example_dialogues.length > 0 && (
            <>
              <div className="greeting-label">示例对话</div>
              <div className="example-dialogues">
                {card.example_dialogues.map((d, i) => (
                  <div key={i} className="example-turn">
                    <div className="ex-user">你：{d.user}</div>
                    <div className="ex-assistant">
                      {card.name}：{d.assistant}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="modal-actions">
          {extraActions}
          {onAdopt ? (
            <button className="btn primary" disabled={adopting} onClick={onAdopt}>
              {adopting ? '领养中…' : '领养并开始聊天'}
            </button>
          ) : (
            <span className="key-desc small">已领养，可在侧边栏找到它</span>
          )}
        </div>
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

// ---------- 角色广场 ----------
function SquareSection({ loggedIn, categories, showToast, onRequireLogin, onAdopted }) {
  const [list, setList] = useState([]);
  const [sort, setSort] = useState('hot');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [adopting, setAdopting] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [myOpen, setMyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');

  const load = async (s, query) => {
    setLoading(true);
    try {
      setList(await api.listSharedCards({ sort: s, q: query, limit: 50 }));
    } catch {
      showToast('广场加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => load(sort, q.trim()), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sort]);

  const needLogin = () => {
    if (!loggedIn) {
      onRequireLogin();
      return true;
    }
    return false;
  };

  const adoptShared = async (item) => {
    if (needLogin() || adopting) return;
    setAdopting(true);
    try {
      const r = await api.adoptSharedCard(item.id);
      onAdopted(r);
      setDetail(null);
      load(sort, q.trim());
    } catch (e) {
      showToast((e && e.message) || '领养失败');
    } finally {
      setAdopting(false);
    }
  };

  const toggleLike = async (item) => {
    if (needLogin()) return;
    try {
      const r = await api.likeSharedCard(item.id);
      setList((ls) => ls.map((x) => (x.id === item.id ? { ...x, liked: r.liked, like_count: r.like_count } : x)));
      if (detail && detail.id === item.id) setDetail((d) => ({ ...d, liked: r.liked, like_count: r.like_count }));
    } catch (e) {
      showToast((e && e.message) || '操作失败');
    }
  };

  const submitReport = async () => {
    try {
      await api.reportSharedCard(detail.id, reportReason.trim());
      showToast('已收到举报，谢谢');
      setReportOpen(false);
      setReportReason('');
    } catch (e) {
      showToast((e && e.message) || '举报失败');
    }
  };

  return (
    <>
      <p className="discover-sub">玩家投稿的角色卡，领养数越高越热门；喜欢就点个赞吧</p>
      <div className="square-tools">
        <div className="square-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索广场…" />
        </div>
        <div className="square-sort">
          <button className={sort === 'hot' ? 'cat-tab active' : 'cat-tab'} onClick={() => setSort('hot')}>
            热度
          </button>
          <button className={sort === 'new' ? 'cat-tab active' : 'cat-tab'} onClick={() => setSort('new')}>
            最新
          </button>
        </div>
      </div>
      <div className="square-actions">
        <button
          className="btn primary small"
          onClick={() => {
            if (needLogin()) return;
            setPublishOpen(true);
          }}
        >
          ＋ 发布我的角色
        </button>
        <button
          className="btn secondary small"
          onClick={() => {
            if (needLogin()) return;
            setMyOpen(true);
          }}
        >
          我的投稿
        </button>
      </div>

      {loading ? (
        <div className="discover-loading">加载中…</div>
      ) : list.length === 0 ? (
        <div className="discover-empty">广场空空如也，快来发布第一张角色卡吧</div>
      ) : (
        <div className="card-grid">
          {list.map((item) => (
            <div key={item.id} className="preset-card" onClick={() => setDetail(item)}>
              <CardFace card={item.card} categories={categories} />
              <div className="shared-stats">
                <span className="shared-author">by {item.author_name}</span>
                <span className="shared-nums">
                  🔥{item.adopt_count} · ❤{item.like_count}
                </span>
              </div>
              <div className="shared-card-btns">
                <button
                  className="btn primary small preset-adopt"
                  onClick={(e) => {
                    e.stopPropagation();
                    adoptShared(item);
                  }}
                  disabled={adopting}
                >
                  {item.adopted ? '再领养' : '开始聊天'}
                </button>
                <button
                  className={`like-btn${item.liked ? ' liked' : ''}`}
                  title={item.liked ? '取消点赞' : '点赞'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLike(item);
                  }}
                >
                  {item.liked ? '❤️' : '🤍'} {item.like_count}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <CardDetailModal
          card={detail.card}
          categories={categories}
          onClose={() => {
            setDetail(null);
            setReportOpen(false);
          }}
          onAdopt={() => adoptShared(detail)}
          adopting={adopting}
          extraActions={
            <>
              <button
                className={`btn secondary${detail.liked ? ' liked-text' : ''}`}
                onClick={() => toggleLike(detail)}
              >
                {detail.liked ? '❤️ 已赞' : '🤍 点赞'} {detail.like_count}
              </button>
              <button
                className="link-btn"
                onClick={() => setReportOpen((o) => !o)}
                title="举报不良内容"
              >
                举报
              </button>
            </>
          }
        />
      )}
      {detail && reportOpen && (
        <div className="modal-overlay" onClick={() => setReportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>举报「{detail.card.name}」</h3>
            <label>
              举报原因（可选）
              <textarea
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                rows={3}
                maxLength={200}
                placeholder="比如：擦边、仿真真人、广告…"
              />
            </label>
            <div className="modal-actions">
              <button className="btn secondary" onClick={() => setReportOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={submitReport}>
                提交举报
              </button>
            </div>
          </div>
        </div>
      )}
      {publishOpen && (
        <PublishModal
          categories={categories}
          showToast={showToast}
          onClose={() => setPublishOpen(false)}
          onDone={() => {
            setPublishOpen(false);
            load(sort, q.trim());
          }}
        />
      )}
      {myOpen && <MyPublishedModal showToast={showToast} onClose={() => setMyOpen(false)} />}
    </>
  );
}

// 发布投稿弹窗
function PublishModal({ categories, showToast, onClose, onDone }) {
  const [chars, setChars] = useState([]);
  const [charId, setCharId] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [greeting, setGreeting] = useState('');
  const [category, setCategory] = useState('comfort');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listCharacters().then(setChars).catch(() => {});
  }, []);

  // 选中角色后自动带出最近一条 AI 回复作为开场白（可改）
  useEffect(() => {
    if (!charId) return;
    (async () => {
      try {
        const convs = await api.listConversations(charId);
        if (!convs.length) return;
        const msgs = await api.listMessages(convs[0].id, 200);
        const last = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (last) setGreeting(last.content);
      } catch {
        /* 忽略，留给用户手填 */
      }
    })();
  }, [charId]);

  const submit = async () => {
    if (!charId) {
      showToast('先选择一只角色');
      return;
    }
    if (!tagline.trim()) {
      showToast('请填写一句话卖点');
      return;
    }
    if (!description.trim()) {
      showToast('请填写角色简介');
      return;
    }
    if (!greeting.trim()) {
      showToast('请填写开场白');
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await api.publishCharacterCard({
        character_id: charId,
        tagline: tagline.trim(),
        description: description.trim(),
        greeting: greeting.trim(),
        category,
        tags: tags.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
      });
      showToast('已提交审核，通过后上架广场');
      onDone();
    } catch (e) {
      showToast((e && e.message) || '发布失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>发布角色到广场</h3>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <label>
          选择角色
          <select value={charId} onChange={(e) => setCharId(e.target.value)}>
            <option value="">请选择…</option>
            {chars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.avatar || '🤖'} {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          一句话卖点（必填）
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            maxLength={40}
            placeholder="比如：嘴硬心软的猫耳女仆"
          />
        </label>
        <label>
          角色简介（必填）
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="60-120 字介绍一下你的角色"
          />
        </label>
        <label>
          开场白（必填，可改）
          <textarea
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="广场卡的第一句话，默认取该角色最近一条 AI 回复"
          />
        </label>
        <div className="publish-row">
          <label>
            分类
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.keys(categories).map((k) => (
                <option key={k} value={k}>
                  {categories[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            标签（逗号分隔）
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              maxLength={60}
              placeholder="傲娇, 猫耳"
            />
          </label>
        </div>
        <p className="gen-hint">发布后进入人工审核，通过才上架；人设自动取自该角色当前 soul，快照发布时刻的状态。</p>
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? '提交中…' : '提交审核'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 我的投稿弹窗
function MyPublishedModal({ showToast, onClose }) {
  const [list, setList] = useState([]);
  const load = async () => {
    try {
      setList(await api.myPublishedCards());
    } catch {
      /* 忽略 */
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const del = async (id) => {
    if (!window.confirm('确定删除这条投稿吗？')) return;
    try {
      await api.deleteSharedCard(id);
      setList((ls) => ls.filter((x) => x.id !== id));
      showToast('已删除');
    } catch (e) {
      showToast((e && e.message) || '删除失败');
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>我的投稿</h3>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        {list.length === 0 ? (
          <p className="key-desc">还没有投稿，去广场发布第一张吧</p>
        ) : (
          <div className="my-pub-list">
            {list.map((item) => (
              <div key={item.id} className="my-pub-row">
                <span className="preset-avatar sm">{item.card.avatar || '🤖'}</span>
                <div className="my-pub-meta">
                  <div className="my-pub-name">{item.card.name}</div>
                  <div className="my-pub-sub">
                    🔥{item.adopt_count} · ❤{item.like_count}
                  </div>
                  {item.status === 'rejected' && item.reject_reason && (
                    <div className="my-pub-reject">打回原因：{item.reject_reason}</div>
                  )}
                </div>
                <span className={`status-badge ${item.status}`}>{STATUS_LABEL[item.status]}</span>
                <button className="link-btn danger-text" onClick={() => del(item.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 集卡图鉴 ----------
function DexSection({ categories, showToast, onGoPresets }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api
      .getCollection()
      .then(setData)
      .catch(() => showToast('图鉴加载失败'));
  }, [showToast]);
  if (!data) return <div className="discover-loading">加载中…</div>;
  const pct = data.total ? Math.round((data.adopted_count / data.total) * 100) : 0;
  const remain = data.total - data.adopted_count;
  return (
    <div className="dex">
      <p className="discover-sub">领养角色即点亮图鉴，集齐官方 18 张有惊喜</p>
      <div className="dex-progress-card">
        <div className="dex-progress-head">
          <span>
            官方图鉴 {data.adopted_count}/{data.total}
          </span>
          <span className="dex-pct">{pct}%</span>
        </div>
        <div className="dex-bar">
          <div className="dex-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="dex-reward">
          {data.reward_claimed
            ? '🎉 集齐奖励已领取（+200 积分）'
            : remain === 0
              ? '🎉 已集齐！奖励稍后到账'
              : `还差 ${remain} 张集齐，集齐奖 ${data.reward_points} 积分`}
        </div>
      </div>
      <div className="dex-grid">
        {data.presets.map((p) => (
          <div
            key={p.id}
            className={`dex-item${p.adopted ? '' : ' locked'}`}
            onClick={() => {
              if (!p.adopted) onGoPresets();
            }}
            title={p.adopted ? p.tagline : '去官方预设领养'}
          >
            <span className="dex-avatar">{p.adopted ? p.avatar || '🤖' : '❓'}</span>
            <span className="dex-name">{p.name}</span>
            <span className="dex-cat">{categories[p.category] || p.category}</span>
          </div>
        ))}
      </div>
      {data.shared_adopted.length > 0 && (
        <>
          <div className="greeting-label">我领养的广场卡（{data.shared_adopted.length}）</div>
          <div className="card-grid">
            {data.shared_adopted.map((s) => (
              <div key={s.id} className="preset-card" style={{ cursor: 'default' }}>
                <CardFace card={s.card} categories={categories} />
                <div className="shared-stats">
                  <span className="shared-nums">🔥{s.adopt_count} 人领养</span>
                  <span className="tag-badge">已领养</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {data.my_grown && data.my_grown.length > 0 && (
        <>
          <div className="greeting-label" style={{ marginTop: 12 }}>
            我的养成（{data.my_grown.filter((g) => g.in_dex).length}/{data.my_grown.length} 进图鉴 · {data.dex_threshold || 5} 条记忆准入）
          </div>
          <p className="discover-sub">和角色多聊天、产生 {data.dex_threshold || 5} 条记忆后即可进图鉴</p>
          <div className="dex-grid">
            {data.my_grown.map((g) => (
              <div
                key={`grown-${g.id}`}
                className={`dex-item${g.in_dex ? '' : ' locked'}`}
                title={g.in_dex ? (g.tagline || g.name) : `养成中：${g.fact_count}/${data.dex_threshold || 5} 条记忆`}
              >
                <span className="dex-avatar">{g.in_dex ? g.avatar || '🤖' : '🌱'}</span>
                <span className="dex-name">{g.name}</span>
                <span className="dex-cat">
                  {g.in_dex ? '已收录' : `${g.fact_count}/${data.dex_threshold || 5} 记忆`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
