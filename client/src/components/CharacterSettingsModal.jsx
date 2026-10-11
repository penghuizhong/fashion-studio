// 角色设置弹窗：横向滑动二级导航（对话 / soul / user / memory）
import { useEffect, useRef, useState } from 'react';
import { api, formatFullTime } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';
import AvatarPicker from './AvatarPicker.jsx';
// v1.26.0: 音色选择
import VoicePicker from './VoicePicker.jsx';
import MemoryFacts from './MemoryFacts.jsx';
import { ROLEPLAY_TEMPLATE } from '../roleplayTemplate.js';
import { useAuth } from '../auth.jsx';

const TABS = [
  { id: 'chat', label: '对话', icon: 'chat' },
  { id: 'soul', label: '灵魂', icon: 'book' },
  { id: 'user', label: '档案', icon: 'user' },
  { id: 'memory', label: '记忆', icon: 'history' },
];

const FILE_FIELD = { soul: 'soul_md', user: 'user_md', memory: 'memory_md' };

export default function CharacterSettingsModal({ characterId, onClose, onCharacterUpdated, onCharacterDeleted, showToast }) {
  // v1.18.1: 破限白名单——无权限用户看不到可用开关
  const { user, multiUser } = useAuth();
  // v1.18.2: 每次打开角色设置都刷新权限（管理后台授权后不用刷新页面）
  const [jbAllowedFresh, setJbAllowedFresh] = useState(null);
  useEffect(() => {
    if (!multiUser) return;
    let cancelled = false;
    api.getMe().then((d) => {
      if (!cancelled && d && d.user) setJbAllowedFresh(!!d.user.jailbreak_allowed);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [characterId, multiUser]);
  const jbAllowed = !multiUser || (jbAllowedFresh !== null ? jbAllowedFresh : !!(user && user.jailbreak_allowed));
  const [tab, setTab] = useState('chat');
  const [character, setCharacter] = useState(null);
  const [settings, setSettings] = useState({ name: '', avatar: '', temperature: 0.7 });
  const [files, setFiles] = useState({ soul_md: '', user_md: '', memory_md: '' });
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  // v1.15.0: 扮演模式
  const [roleplayMode, setRoleplayMode] = useState(false);
  const [roleplayPrompt, setRoleplayPrompt] = useState(null); // null=用内置模板
  // v1.17.7: 生效中的扮演模板（管理员覆盖 > 内置）；前端硬编码 ROLEPLAY_TEMPLATE 仅作请求失败的回退
  const [defaultRpTemplate, setDefaultRpTemplate] = useState(ROLEPLAY_TEMPLATE);
  const effectiveRpTemplate = defaultRpTemplate || ROLEPLAY_TEMPLATE;
  // v1.17.0: 破限预设插件化（null=关闭）
  const [jailbreakPreset, setJailbreakPreset] = useState(null);
  const [jbPresets, setJbPresets] = useState([]);
  const [rpDirty, setRpDirty] = useState(false);
  const [rpSaving, setRpSaving] = useState(false);
  // v1.17.8: 破限模式年龄确认弹窗
  // v1.17.9: 用破限专用 key（soulchat-jb-age-ok），与发现页分开：勾选破限必弹一次
  const [jbGateOpen, setJbGateOpen] = useState(false);
  const jbAgeOk = () => {
    try { return localStorage.getItem('soulchat-jb-age-ok') === '1'; } catch { return false; }
  };
  const handleJbToggle = (e) => {
    const on = e.target.checked;
    if (on && !jbAgeOk()) { setJbGateOpen(true); return; } // 未确认年龄：先弹确认框，不直接开启
    setJailbreakPreset(on ? (jbPresets[0] && jbPresets[0].key) || null : null);
    setRpDirty(true);
  };
  const confirmJbAge = () => {
    try { localStorage.setItem('soulchat-jb-age-ok', '1'); } catch { /* 忽略 */ }
    setJbGateOpen(false);
    setJailbreakPreset((jbPresets[0] && jbPresets[0].key) || null);
    setRpDirty(true);
  };
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState([]);

  useEffect(() => {
    api.getJailbreakPresets().then((d) => setJbPresets((d && d.presets) || [])).catch(() => {});
    // v1.17.7: 取生效中的扮演模板（管理员在提示词管理改过的话，这里也要跟上）
    api.getPromptTemplates()
      .then((d) => { if (d && d.roleplay_template) setDefaultRpTemplate(d.roleplay_template); })
      .catch(() => {});
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
          voice_id: char.voice_id || '', // v1.29.15: 加载已保存的音色（之前漏了，导致选择不持久）
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
        setJailbreakPreset(char.jailbreak_preset || null);
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
    // v1.20.2: files 加入依赖——files 后加载完也能同步到 draft，修灵魂输入框偶发空白
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
  }, [tab, characterId, files]);

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
        voice_id: settings.voice_id || null, // v1.26.0: 音色
      });
      await onCharacterUpdated();
      showToast('已保存');
    } catch (err) {
      showToast(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // v1.15.0: 保存扮演模式（文本框内容与生效模板一致则存 null，吃未来模板升级）
  const saveRoleplay = async () => {
    setRpSaving(true);
    try {
      const custom = (roleplayPrompt || '').trim();
      await api.updateCharacter(characterId, {
        roleplay_mode: roleplayMode ? 1 : 0,
        roleplay_prompt: custom && custom !== effectiveRpTemplate ? custom : null,
        jailbreak_preset: jailbreakPreset || null,
      });
      setRoleplayPrompt(custom && custom !== effectiveRpTemplate ? custom : null);
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

  // v1.20.2: 档案模板一键填入
  const USER_TEMPLATE = '- 称呼：\n- 偏好：\n- 重要事项：\n';
  const fillUserTemplate = () => {
    const stripped = draft.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (stripped && !window.confirm('当前已有内容，确定用模板覆盖吗？')) return;
    setDraft(USER_TEMPLATE);
    setDirty(true);
  };

  // v1.20.2: 文件编辑器（灵魂/档案共用；灵魂 tab 里放最顶）
  const fileEditor = (
    <>
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
    </>
  );

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
                <AvatarPicker
                  value={settings.avatar}
                  onChange={(a) => setS('avatar')({ target: { value: a } })}
                />
              </div>
              {/* v1.26.0: 音色选择（与头像同一 tab） */}
              <div>
                <div className="field-label">音色</div>
                <VoicePicker
                  value={settings.voice_id}
                  onChange={(v) => setS('voice_id')({ target: { value: v } })}
                />
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
                {/* v1.20.2: 灵魂输入框移到最顶 */}
                {tab === 'soul' && fileEditor}
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
                          value={roleplayPrompt ?? effectiveRpTemplate}
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
                        </div>
                      </>
                    )}
                    {/* v1.17.0: 破限模式（插件化） */}
                    {/* v1.18.1: 白名单——无权限用户开关置灰，提示需管理员授权 */}
                    <div className="jailbreak-section">
                      <label className="roleplay-toggle" style={jbAllowed ? undefined : { opacity: 0.5 }}>
                        <input
                          type="checkbox"
                          checked={!!jailbreakPreset}
                          disabled={!jbAllowed}
                          onChange={handleJbToggle}
                        />
                        <span className="roleplay-toggle-label">破限模式</span>
                        <span className="roleplay-toggle-desc">{jbAllowed ? '减少 AI 拒绝，角色扮演更放得开' : '需管理员授权后可用'}</span>
                      </label>
                      {jailbreakPreset && (
                        <>
                          {jbPresets.length > 1 && (
                            <select
                              className="jb-select"
                              value={jailbreakPreset}
                              onChange={(e) => {
                                setJailbreakPreset(e.target.value || null);
                                setRpDirty(true);
                              }}
                            >
                              {jbPresets.map((p) => (
                                <option key={p.key} value={p.key}>
                                  {p.name}（{p.description}）
                                </option>
                              ))}
                            </select>
                          )}
                          <p className="jb-warning">
                            温馨提示：破限模式会大幅减少 AI 的拒绝，但回复可能包含成人向内容，请确认你已年满 18
                            岁。破限指令约 0.5KB，按正常对话计费。
                          </p>
                        </>
                      )}
                    </div>
                    {/* v1.16.3: 保存按钮移出 roleplayMode 条件，关闭时也能保存 */}
                    <div className="settings-actions">
                      <span className="dirty-hint">{rpDirty ? '● 有未保存的修改' : ''}</span>
                      <button className="btn primary" onClick={saveRoleplay} disabled={rpSaving || !rpDirty}>
                        {rpSaving ? '保存中…' : '保存扮演设置'}
                      </button>
                    </div>
                  </div>
                )}
                {tab === 'user' && (
                  <>
                    <div className="profile-guide">
                      <p>这里写你希望 AI 记住的关于你的事：别人怎么称呼你、你的喜好、忌讳等。每次聊天都会告诉 AI。</p>
                      <p>AI 也会根据聊天自动补充你的长期画像；具体事件或约定，直接在聊天里说"记住"，会进「记忆」。</p>
                      <button className="btn secondary small" onClick={fillUserTemplate}>
                        一键填入模板
                      </button>
                    </div>
                    {fileEditor}
                  </>
                )}
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
      {/* v1.17.8: 破限模式年龄确认 */}
      {jbGateOpen && (
        <div className="modal-overlay" onClick={() => setJbGateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>年龄确认</h3>
            <p className="gate-text">
              破限模式会大幅减少 AI 的拒绝，回复可能包含成人向虚构内容。请确认你已年满 18
              岁，并知晓角色均为虚构 AI，不提供医疗、法律等专业建议。
            </p>
            <div className="modal-actions">
              <button className="btn secondary" onClick={() => setJbGateOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={confirmJbAge}>
                我已年满 18 岁
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
