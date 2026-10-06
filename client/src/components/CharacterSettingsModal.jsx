// 角色设置弹窗：横向滑动二级导航（对话 / soul / user / memory）
import { useEffect, useRef, useState } from 'react';
import { api, formatFullTime } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';
import MemoryFacts from './MemoryFacts.jsx';

const TABS = [
  { id: 'chat', label: '对话', icon: 'chat' },
  { id: 'soul', label: '灵魂', icon: 'book' },
  { id: 'user', label: '档案', icon: 'user' },
  { id: 'memory', label: '记忆', icon: 'history' },
];

const FILE_FIELD = { soul: 'soul_md', user: 'user_md', memory: 'memory_md' };

// v1.15.0: 扮演模式内置模板（与后端 server/src/memory.js 的 ROLEPLAY_TEMPLATE 保持一致）
const ROLEPLAY_TEMPLATE = `## 回复格式：小说式角色扮演

1. 场景头：每次回复第一行用 [日期 世界·地点] 标注当前场景，日期用当天真实日期，地点跟着剧情走。
2. 旁白：小说笔法，多感官细节＋心理活动，短句有节奏；每个旁白段落段首加 丨。
3. 台词：角色说出口的话用 **加粗** 独立成段，不混在旁白里；多人时带名字前缀。
4. 不用括号备注动作神态，全部写进旁白。
5. 正文结束后另起 markdown 代码块，写角色没说出口的真实内心独白；独白可与说出口的话矛盾。
6. 每轮 200～500 字（不含独白块），信息密度高，不水文、不重复。`;

export default function CharacterSettingsModal({ characterId, onClose, onCharacterUpdated, onCharacterDeleted, showToast }) {
  const [tab, setTab] = useState('chat');
  const [character, setCharacter] = useState(null);
  const [settings, setSettings] = useState({ name: '', avatar: '', temperature: 0.7 });
  const [files, setFiles] = useState({ soul_md: '', user_md: '', memory_md: '' });
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  // v1.15.0: 扮演模式
  const [roleplayMode, setRoleplayMode] = useState(false);
  const [roleplayPrompt, setRoleplayPrompt] = useState(null); // null=用内置模板
  const [rpDirty, setRpDirty] = useState(false);
  const [rpSaving, setRpSaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const char = await api.getCharacter(characterId);
        if (cancelled) return;
        setCharacter(char);
        setSettings({
          name: char.name || '',
          avatar: char.avatar || '',
          temperature: typeof char.temperature === 'number' ? char.temperature : 0.7,
        });
        const f = await api.getFiles(characterId).catch(() => null);
        if (cancelled) return;
        setFiles({
          soul_md: (f && f.soul_md) || char.soul_md || '',
          user_md: (f && f.user_md) || char.user_md || '',
          memory_md: (f && f.memory_md) || char.memory_md || '',
        });
        setRoleplayMode(!!char.roleplay_mode);
        setRoleplayPrompt(char.roleplay_prompt || null);
        setRpDirty(false);
      } catch (err) {
        if (!cancelled) showToast(err.message || '加载失败');
      }
    })();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  useEffect(() => {
    if (tab === 'chat' || tab === 'memory') return;
    setDraft(files[FILE_FIELD[tab]] || '');
    setDirty(false);
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getFileVersions(characterId, tab, 20);
        if (!cancelled) setVersions(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setVersions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, characterId]);

  const selectTab = (id, el) => {
    if (id === tab) return;
    if (dirty && !window.confirm('有未保存的修改，确定切换吗？')) return;
    setTab(id);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  const saveSettings = async () => {
    if (!settings.name.trim()) {
      showToast('名字不能为空');
      return;
    }
    setSaving(true);
    try {
      await api.updateCharacter(characterId, {
        name: settings.name.trim(),
        avatar: settings.avatar,
        temperature: Number(settings.temperature),
      });
      await onCharacterUpdated();
      showToast('已保存');
    } catch (err) {
      showToast(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // v1.15.0: 保存扮演模式（文本框内容与内置模板一致则存 null，吃未来模板升级）
  const saveRoleplay = async () => {
    setRpSaving(true);
    try {
      const custom = (roleplayPrompt || '').trim();
      await api.updateCharacter(characterId, {
        roleplay_mode: roleplayMode ? 1 : 0,
        roleplay_prompt: custom && custom !== ROLEPLAY_TEMPLATE ? custom : null,
      });
      setRoleplayPrompt(custom && custom !== ROLEPLAY_TEMPLATE ? custom : null);
      setRpDirty(false);
      await onCharacterUpdated();
      showToast('扮演模式已保存');
    } catch (err) {
      showToast(err.message || '保存失败');
    } finally {
      setRpSaving(false);
    }
  };

  const saveFile = async () => {
    const field = FILE_FIELD[tab];
    setSaving(true);
    try {
      const res = await api.updateFiles(characterId, { [field]: draft });
      setFiles({
        soul_md: res.soul_md ?? draft,
        user_md: res.user_md ?? files.user_md,
        memory_md: res.memory_md ?? files.memory_md,
      });
      setDirty(false);
      const list = await api.getFileVersions(characterId, tab, 20).catch(() => []);
      setVersions(Array.isArray(list) ? list : []);
      showToast('已保存');
    } catch (err) {
      showToast(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const restoreVersion = async (v) => {
    if (!window.confirm('确定用这个版本恢复吗？当前内容会被覆盖。')) return;
    const field = FILE_FIELD[tab];
    try {
      const res = await api.updateFiles(characterId, { [field]: v.content });
      const content = res[field] ?? v.content;
      setFiles((f) => ({ ...f, [field]: content }));
      setDraft(content);
      setDirty(false);
      const list = await api.getFileVersions(characterId, tab, 20).catch(() => []);
      setVersions(Array.isArray(list) ? list : []);
      showToast('已恢复该版本');
    } catch (err) {
      showToast(err.message || '恢复失败');
    }
  };

  const deleteCharacter = async () => {
    if (!window.confirm(`确定删除角色「${character ? character.name : ''}」吗？所有对话和记忆都会被删除。`)) return;
    if (!window.confirm('再次确认：真的要删除吗？此操作不可恢复。')) return;
    try {
      await api.deleteCharacter(characterId);
      onCharacterDeleted(characterId);
    } catch (err) {
      showToast(err.message || '删除失败');
    }
  };

  const setS = (k) => (e) => setSettings((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div className="settings-modal char-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="角色设置">
        <div className="settings-head">
          <span className="char-modal-title">
            <Avatar src={character ? character.avatar : ''} size={32} className="char-modal-avatar" />
            <h3>{character ? character.name : '加载中…'}</h3>
          </span>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab${tab === t.id ? ' active' : ''}`}
              onClick={(e) => selectTab(t.id, e.currentTarget)}
            >
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === 'chat' && (
            <>
              <label>
                名字
                <input value={settings.name} onChange={setS('name')} />
              </label>
              <div>
                <div className="field-label">头像</div>
                <div className="avatar-grid">
                  {[
                    '/avatars/avatar-gen-1.png',
                    '/avatars/avatar-gen-2.png',
                    '/avatars/avatar-gen-3.png',
                    '/avatars/avatar-gen-4.png',
                    '/avatars/avatar-gen-5.png',
                    '/avatars/avatar-gen-6.png',
                    '/avatars/avatar-gen-7.png',
                    '/avatars/avatar-gen-8.png',
                  ].map((a) => (
                    <button
                      key={a}
                      className={`avatar-option${settings.avatar === a ? ' selected' : ''}`}
                      onClick={() => setS('avatar')({ target: { value: a } })}
                      title="选择头像"
                      type="button"
                    >
                      <img src={a} alt="头像" />
                    </button>
                  ))}
                </div>
              </div>
              <label>
                温度：{Number(settings.temperature).toFixed(2)}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={settings.temperature}
                  onChange={setS('temperature')}
                />
              </label>
              <div className="settings-actions">
                <button className="btn primary" onClick={saveSettings} disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
              <div className="danger-zone">
                <button className="btn danger" onClick={deleteCharacter}>
                  删除角色
                </button>
              </div>
            </>
          )}
          {tab === 'memory' ? (
            <MemoryFacts characterId={characterId} showToast={showToast} />
          ) : (
            tab !== 'chat' && (
              <>
                {tab === 'soul' && (
                  <div className="roleplay-section">
                    <label className="roleplay-toggle">
                      <input
                        type="checkbox"
                        checked={roleplayMode}
                        onChange={(e) => {
                          setRoleplayMode(e.target.checked);
                          setRpDirty(true);
                        }}
                      />
                      <span className="roleplay-toggle-label">小说式扮演模式</span>
                      <span className="roleplay-toggle-desc">自动追加回复格式指令</span>
                    </label>
                    {roleplayMode && (
                      <>
                        <textarea
                          className="md-editor roleplay-editor"
                          value={roleplayPrompt ?? ROLEPLAY_TEMPLATE}
                          onChange={(e) => {
                            setRoleplayPrompt(e.target.value);
                            setRpDirty(true);
                          }}
                          spellCheck={false}
                          placeholder="回复格式指令…"
                        />
                        <div className="settings-actions">
                          <button
                            className="btn secondary small"
                            onClick={() => {
                              setRoleplayPrompt(null);
                              setRpDirty(true);
                            }}
                          >
                            恢复内置模板
                          </button>
                          <span className="dirty-hint">{rpDirty ? '● 有未保存的修改' : ''}</span>
                          <button className="btn primary" onClick={saveRoleplay} disabled={rpSaving || !rpDirty}>
                            {rpSaving ? '保存中…' : '保存扮演设置'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <textarea
                className="md-editor"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
              />
              <div className="settings-actions">
                <span className="dirty-hint">{dirty ? '● 有未保存的修改' : ''}</span>
                <button className="btn primary" onClick={saveFile} disabled={saving || !dirty}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
              <h4 className="versions-title">历史版本</h4>
              <div className="versions">
                {versions.length === 0 && <div className="versions-empty">暂无历史版本</div>}
                {versions.map((v) => (
                  <div key={v.id} className="version-item">
                    <div className="version-meta">{formatFullTime(v.created_at)}</div>
                    <div className="version-preview">{(v.content || '').slice(0, 60)}</div>
                    <button className="btn secondary small" onClick={() => restoreVersion(v)}>
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            </>
          )
          )}
        </div>
      </div>
    </div>
  );
}
