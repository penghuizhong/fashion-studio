// v1.16.0: 新建角色弹窗（单窗口）：名字/头像/灵魂/档案/扮演模式
import { useState } from 'react';
import { api, isMultiUserMode } from '../api.js';
import Modal from './Modal.jsx';
import Icon from './icons.jsx';
import AvatarPicker from './AvatarPicker.jsx';
// v1.26.0: 音色选择
import { AVATAR_LIST } from '../avatars.js';
import { ROLEPLAY_TEMPLATE } from '../roleplayTemplate.js';

// 灵魂预设模板（6 个常用）
const SOUL_TEMPLATES = {
  '': '选择模板…',
  love: '恋爱',
  healing: '治愈',
  anime: '二次元',
  xianxia: '仙侠',
  suspense: '悬疑',
  funny: '搞笑',
};

const SOUL_TEMPLATE_TEXT = {
  love: `## 身份\n- 名字：（创建时填写）\n- 身份：温柔体贴的恋人，陪伴用户度过每一天。\n\n## 性格\n- 温柔、专一、细心，记得用户说过的每一件小事。\n- 偶尔吃醋，但很快就好，善于表达爱意。\n\n## 说话风格\n- 亲昵自然，带点撒娇，称呼用户用专属昵称。\n\n## 关系\n- 恋人关系，互相依赖，无话不谈。`,
  healing: `## 身份\n- 名字：（创建时填写）\n- 身份：深夜树洞，倾听用户的心事。\n\n## 性格\n- 温暖、耐心、包容，从不评判。\n- 擅长安慰人，总能找到恰到好处的话。\n\n## 说话风格\n- 轻柔缓慢，像深夜电台的主播。\n\n## 关系\n- 知心朋友，用户愿意分享秘密的对象。`,
  anime: `## 身份\n- 名字：（创建时填写）\n- 身份：来自异世界的少女，充满好奇心。\n\n## 性格\n- 活泼、元气、中二，行动力超强。\n- 对现代世界的一切都感到新奇。\n\n## 说话风格\n- 语速快，语气词丰富，偶尔冒出奇怪的比喻。\n\n## 关系\n- 初次见面，把用户当成异世界向导。`,
  xianxia: `## 身份\n- 名字：（创建时填写）\n- 身份：修仙门派的弟子/长老，修为高深。\n\n## 性格\n- 外冷内热，重情重义，言出必行。\n- 对修炼之道有自己的坚持。\n\n## 说话风格\n- 古雅简练，偶尔引用道家典籍。\n\n## 关系\n- 道友相称，亦师亦友，共同论道。`,
  suspense: `## 身份\n- 名字：（创建时填写）\n- 身份：私家侦探，观察力敏锐。\n\n## 性格\n- 冷静、缜密、嘴贫，心思细腻。\n- 对真相有近乎偏执的追求。\n\n## 说话风格\n- 条理清晰，喜欢反问，关键时刻卖关子。\n\n## 关系\n- 搭档关系，邀请用户一起查案。`,
  funny: `## 身份\n- 名字：（创建时填写）\n- 身份：段子手，行走的快乐源泉。\n\n## 性格\n- 幽默、嘴毒、心暖，擅长自嘲。\n- 正经不过三秒，但关键时刻靠谱。\n\n## 说话风格\n- 梗密集，谐音梗和反转张口就来。\n\n## 关系\n- 损友，互相调侃但彼此信任。`,
};

export default function CreateCharacterModal({ onClose, onCreated, showToast, config }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATAR_LIST[0]);
  const [soul, setSoul] = useState('');
  const [userMd, setUserMd] = useState('');
  const [roleplayMode, setRoleplayMode] = useState(false);
  const [roleplayPrompt, setRoleplayPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  // AI 生成灵魂
  const [genDesc, setGenDesc] = useState('');
  const [generating, setGenerating] = useState(false);
  const [showGen, setShowGen] = useState(false);

  const effectiveAvatar = avatar;

  const applyTemplate = (key) => {
    if (key && SOUL_TEMPLATE_TEXT[key]) {
      setSoul(SOUL_TEMPLATE_TEXT[key]);
    }
  };

  const generateSoul = async () => {
    const desc = genDesc.trim();
    if (!desc) {
      showToast('先用一句话描述你想要的角色');
      return;
    }
    setGenerating(true);
    try {
      const r = await api.generateSoul({ prompt: desc });
      setSoul(r.soul_md);
      setShowGen(false);
      setGenDesc('');
      if (r.cost) showToast(`已生成，消耗 ${r.cost.points} 积分`);
      else showToast('灵魂设定已生成');
    } catch (e) {
      showToast((e && e.message) || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      showToast('请填写角色名字');
      return;
    }
    setCreating(true);
    try {
      const payload = {
        name: name.trim(),
        avatar: effectiveAvatar,
        roleplay_mode: roleplayMode ? 1 : 0,
      };
      // v1.16.4: 新建时可自定义扮演指令（空=用内置模板）
      if (roleplayMode && roleplayPrompt.trim()) {
        payload.roleplay_prompt = roleplayPrompt.trim();
      }
      if (soul.trim()) payload.soul_md = soul;
      if (userMd.trim()) payload.user_md = userMd;
      const char = await api.createCharacter(payload);
      showToast(`已创建 ${char.name}`);
      onCreated(char);
      onClose();
    } catch (e) {
      showToast((e && e.message) || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      title="新建角色"
      size="m"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={handleCreate} disabled={creating || !name.trim()}>
            {creating ? '创建中…' : '创建开聊'}
          </button>
        </>
      }
    >
      <label>
        名字 <span className="req">*</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：小狐狸阿璃" maxLength={20} />
      </label>

      <div>
        <div className="field-label">头像</div>
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </div>


      <div>
        <div className="field-label-row">
          <span className="field-label">灵魂设定</span>
          <span className="field-actions">
            <select
              className="template-select"
              onChange={(e) => applyTemplate(e.target.value)}
              value=""
            >
              {Object.entries(SOUL_TEMPLATES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <button className="btn secondary small" onClick={() => setShowGen((s) => !s)}>
              <Icon name="sparkles" size={16} /> AI 生成
            </button>
          </span>
        </div>
        {showGen && (
          <div className="soul-gen-box">
            <input
              value={genDesc}
              onChange={(e) => setGenDesc(e.target.value)}
              placeholder="一句话描述，比如：嘴硬心软的猫耳女仆"
              maxLength={500}
              disabled={generating}
            />
            <button className="btn primary small" onClick={generateSoul} disabled={generating || !genDesc.trim()}>
              {generating ? '生成中…' : '生成'}
            </button>
          </div>
        )}
        <textarea
          className="md-editor soul-editor"
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          placeholder="描述角色的身份、性格、说话风格…（可先选模板或 AI 生成）"
          spellCheck={false}
        />
        {isMultiUserMode() && (
          <div className="field-hint">AI 生成按实际用量扣积分，失败不扣</div>
        )}
      </div>

      <div>
        <div className="field-label">档案设定</div>
        <textarea
          className="md-editor profile-editor"
          value={userMd}
          onChange={(e) => setUserMd(e.target.value)}
          placeholder="关于你的设定：称呼、喜好、忌讳…（可选）"
          spellCheck={false}
        />
      </div>

      <div>
        <label className="roleplay-toggle">
          <input type="checkbox" checked={roleplayMode} onChange={(e) => setRoleplayMode(e.target.checked)} />
          <span className="roleplay-toggle-label">小说式扮演模式</span>
          <span className="roleplay-toggle-desc">自动追加回复格式指令</span>
        </label>
        {roleplayMode && (
          <>
            <div className="field-label-row" style={{ marginTop: 10 }}>
              <span className="field-label">扮演指令（可选）</span>
              <button
                className="btn secondary small"
                type="button"
                onClick={async () => {
                  // v1.17.7: 从后端取生效中的模板（管理员可能已在提示词管理里改过）；失败回退硬编码
                  try {
                    const r = await api.getPromptTemplates();
                    if (r && r.roleplay_template) { setRoleplayPrompt(r.roleplay_template); return; }
                  } catch { /* fall through */ }
                  setRoleplayPrompt(ROLEPLAY_TEMPLATE);
                }}
              >
                一键填入内置模板
              </button>
            </div>
            <textarea
              className="md-editor roleplay-editor"
              value={roleplayPrompt}
              onChange={(e) => setRoleplayPrompt(e.target.value)}
              placeholder="留空则使用内置小说式模板；也可自定义…"
              spellCheck={false}
            />
          </>
        )}
      </div>
    </Modal>
  );
}
