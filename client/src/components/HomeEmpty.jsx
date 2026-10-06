// v1.16.6 首页角色墙：Top 6-8 领养数卡片轻轻浮动 + 拼图卡进发现页 + 底部 AI 生成输入框
// 新用户 10 秒开聊：挑一张现成的，或一句话生成一个
import { useEffect, useState } from 'react';
import { api, isMultiUserMode } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';

const WALL_COUNT = 8;

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
  const [wallCards, setWallCards] = useState([]);
  const [collageCards, setCollageCards] = useState([]);
  const [adoptingId, setAdoptingId] = useState(null);
  // AI 生成
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState(null);

  useEffect(() => {
    api
      .getPresetCards()
      .then((d) => {
        const cards = (d && d.cards) || [];
        // 按领养数排序（后端已排好），取前 8 张上墙
        setWallCards(cards.slice(0, WALL_COUNT));
        // 拼图卡用接下来的 4 张
        setCollageCards(cards.slice(WALL_COUNT, WALL_COUNT + 4));
      })
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

      <div className="home-body wall-body">
        <h1 className="home-title">今天想和谁聊天？</h1>

        {/* 角色圆墙：Top 领养数卡片在圆内轻轻漂移（鱼缸式） */}
        {wallCards.length > 0 && (
          <div className="circle-wall">
            <div className="circle-center">
              <img src="/favicon.png" alt="SoulChat" />
            </div>
            {wallCards.map((c, i) => {
              const angle = (i / wallCards.length) * 360 - 90;
              const rad = (angle * Math.PI) / 180;
              const R = 36;
              const x = 50 + R * Math.cos(rad);
              const y = 50 + R * Math.sin(rad);
              return (
                <span
                  key={c.id}
                  className="orbit-slot"
                  style={{ left: `${x}%`, top: `${y}%` }}
                >
                  <button
                    className={`orbit-card drift-${i % 4}`}
                    style={{ animationDelay: `${(i % 8) * 0.8}s` }}
                    onClick={() => adopt(c, c.id)}
                    disabled={!!adoptingId}
                  >
                    <Avatar src={c.avatar} size={56} className="orbit-avatar" />
                    <span className="orbit-name">{c.name}</span>
                    {adoptingId === c.id && <span className="orbit-loading">…</span>}
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* 拼图条：进发现页 */}
        {collageCards.length >= 4 && (
          <button className="wall-collage-strip" onClick={onOpenDiscover}>
            <span className="collage-row">
              {collageCards.map((c) => (
                <Avatar key={c.id} src={c.avatar} size={32} />
              ))}
            </span>
            <span className="collage-label">发现更多角色</span>
            <Icon name="chevronRight" size={16} />
          </button>
        )}

        {/* 生成结果卡 */}
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

      {/* 底部 AI 生成输入框（缩小版） */}
      <div className="home-gen-bottom">
        <div className="home-gen-capsule small">
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
          {isMultiUserMode() ? 'AI 生成按实际用量扣积分，失败不扣' : '使用你自己的 Key 生成，不扣平台积分'}
        </p>
      </div>
    </div>
  );
}
