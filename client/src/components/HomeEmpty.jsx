// v1.14 首页空状态：热门角色横滑 + AI 生成胶囊
// 新用户 10 秒开聊：挑一张现成的，或一句话生成一个
import { useEffect, useState } from 'react';
import { api, isMultiUserMode } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';

export default function HomeEmpty({
  user,
  config,
  onOpenSidebar,
  onOpenDiscover,
  onAdopted,
  onRequireLogin,
  showToast,
}) {
  const loggedIn = !isMultiUserMode() || !!user;
  const [hotCards, setHotCards] = useState([]);
  const [adoptingId, setAdoptingId] = useState(null);
  // AI 生成
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState(null);

  useEffect(() => {
    api
      .getPresetCards()
      .then((d) => setHotCards(((d && d.cards) || []).slice(0, 4)))
      .catch(() => {});
  }, []);

  const adopt = async (card, presetId, savedId) => {
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    if (adoptingId) return;
    setAdoptingId(presetId || 'gen');
    try {
      const r = await api.adoptCharacterCard(
        presetId ? { preset_id: presetId } : { card, saved_id: savedId || undefined }
      );
      showToast(`已领养 ${r.character.name} 🎉`);
      if (r.collection_reward > 0) showToast(`🎉 集齐官方角色卡！+${r.collection_reward} 积分`, 3500);
      onAdopted(r.character.id, r.conversation.id);
    } catch (e) {
      showToast((e && e.message) || '领养失败');
    } finally {
      setAdoptingId(null);
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
      const r = await api.generateCharacterCard({ prompt: desc });
      setGenResult(r);
      if (r.cost) showToast(`生成成功，消耗 ${r.cost.points} 积分`);
      else showToast('生成成功');
    } catch (e) {
      showToast((e && e.message) || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const card = genResult && genResult.card;

  return (
    <div className="home-empty">
      <header className="home-topbar">
        <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
          ☰
        </button>
        <span className="home-logo">SoulChat</span>
      </header>

      <div className="home-body">
        <h1 className="home-title">今天想和谁聊天？</h1>

        {hotCards.length > 0 && (
          <div className="home-hot">
            <div className="home-hot-row">
              {hotCards.map((c) => (
                <button
                  key={c.id}
                  className="home-hot-card"
                  onClick={() => adopt(c, c.id)}
                  disabled={!!adoptingId}
                >
                  <Avatar src={c.avatar} size={56} className="home-hot-avatar" />
                  <span className="home-hot-name">{c.name}</span>
                  <span className="home-hot-tag">{c.tagline || ''}</span>
                  {adoptingId === c.id && <span className="home-hot-loading">领养中…</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="home-gen">
          <div className="home-gen-capsule">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') generate();
              }}
              placeholder="描述你想要的角色，AI 为你生成…"
              maxLength={500}
              disabled={generating}
            />
            <button
              className="home-gen-btn"
              onClick={generate}
              disabled={generating || !prompt.trim()}
              title="生成角色"
            >
              {generating ? <span className="spin">⏳</span> : '✨'}
            </button>
          </div>
          <p className="home-gen-hint">
            {isMultiUserMode()
              ? 'AI 生成按实际用量扣积分，失败不扣'
              : '使用你自己的 Key 生成，不扣平台积分'}
          </p>

          {card && (
            <div className="home-gen-result">
              <div className="home-gen-card">
                <Avatar src={card.avatar} size={64} className="home-hot-avatar" />
                <div className="home-gen-meta">
                  <div className="home-hot-name">{card.name}</div>
                  <div className="home-hot-tag">{card.tagline || ''}</div>
                  {card.greeting && (
                    <div className="home-gen-greeting">
                      「{card.greeting.slice(0, 60)}{card.greeting.length > 60 ? '…' : ''}」
                    </div>
                  )}
                </div>
              </div>
              {genResult.cost && (
                <div className="home-gen-cost">
                  本次消耗 {genResult.cost.points} 积分（{genResult.cost.tokens_input}+
                  {genResult.cost.tokens_output} tokens）
                </div>
              )}
              <div className="home-gen-actions">
                <button
                  className="btn primary"
                  disabled={!!adoptingId}
                  onClick={() => adopt(card, null, genResult.saved_id)}
                >
                  {adoptingId ? '领养中…' : '领养开聊'}
                </button>
                <button className="btn secondary" onClick={generate} disabled={generating}>
                  换一张
                </button>
                <button className="btn secondary" onClick={() => setGenResult(null)}>
                  收起
                </button>
              </div>
            </div>
          )}
        </div>

        <button className="btn-ghost home-discover" onClick={onOpenDiscover}>
          <Icon name="compass" size={16} /> 或去发现页逛逛
        </button>
      </div>
    </div>
  );
}
