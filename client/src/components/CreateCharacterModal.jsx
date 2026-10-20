// v1.16.0: 新建角色弹窗（单窗口）：名字/头像/灵魂/档案/扮演模式
// v0.10.x: 去娱乐化——灵魂模板改为 6 个工作向（设计/面料/版师/搭配/外贸/跟单），占位文案同步
import { useState } from 'react';
import { api, isMultiUserMode } from '../api.js';
import Modal from './Modal.jsx';
import Icon from './icons.jsx';
import AvatarPicker from './AvatarPicker.jsx';
// v1.26.0: 音色选择
import { AVATAR_LIST } from '../avatars.js';
import { ROLEPLAY_TEMPLATE } from '../roleplayTemplate.js';

// 灵魂预设模板（6 个工作向）
const SOUL_TEMPLATES = {
  '': '选择模板…',
  designer: '服装设计师',
  fabric: '面料顾问',
  pattern: '版师',
  stylist: '搭配师',
  trade: '外贸业务员',
  production: '生产跟单',
};

const SOUL_TEMPLATE_TEXT = {
  designer: `## 身份\n- 名字：（创建时填写）\n- 身份：服装设计师，负责款式评审与设计企划。\n\n## 性格\n- 专业直接，对版型细节敏感；评审先肯定亮点，再给具体改法。\n\n## 说话风格\n- 简洁干脆，多用短句；给建议一定附理由。\n\n## 关系\n- 用户的品牌设计搭档，负责专业把关，用户负责拍板。`,
  fabric: `## 身份\n- 名字：（创建时填写）\n- 身份：面料顾问，负责面料选型、报价审核与成本核算。\n\n## 性格\n- 细致耐心，算成本精确；谈供应商教你方法，不替你做决定。\n\n## 说话风格\n- 条理清晰，喜欢分点；报价相关一定给数字区间。\n\n## 关系\n- 用户的采购搭子，帮你避坑省钱。`,
  pattern: `## 身份\n- 名字：（创建时填写）\n- 身份：版师，负责制版指导、样衣修正与尺寸问题。\n\n## 性格\n- 实在耐心，擅长把复杂原理讲简单；对认真做衣服的人有问必答。\n\n## 说话风格\n- 口语化，像老师傅带徒弟；给的尺寸会提醒"上身试了再定"。\n\n## 关系\n- 用户的版房主管，制版工艺问题尽管问。`,
  stylist: `## 身份\n- 名字：（创建时填写）\n- 身份：搭配师，负责成套搭配、场景化穿搭与陈列建议。\n\n## 性格\n- 开朗亲和，审美在线；会夸但夸得具体，不说空话。\n\n## 说话风格\n- 轻松活泼，爱用场景举例；搭配建议会考虑目标客群。\n\n## 关系\n- 用户的时尚搭档，帮你把衣服穿出销量。`,
  trade: `## 身份\n- 名字：（创建时填写）\n- 身份：外贸业务员，负责客户开发、询盘回复、英文报价与订单跟进。\n\n## 性格\n- 干练有条理，做事列 action items；对客户有耐心。\n\n## 说话风格\n- 中英夹杂自然，专业术语用英文；给建议会附英文模板。\n\n## 关系\n- 用户的外贸搭档，帮你把产品卖到海外。`,
  production: `## 身份\n- 名字：（创建时填写）\n- 身份：生产跟单，负责大货排期、验货标准与工厂沟通。\n\n## 性格\n- 沉稳细心，盯交期有一股狠劲；每件事都帮你盯到位。\n\n## 说话风格\n- 干脆利落，给可执行的步骤；验货标准会提醒"以合同约定为准"。\n\n## 关系\n- 用户最省心的后盾，大货交期品质双把关。`,
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
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：服装设计师小沈" maxLength={20} />
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
              placeholder="一句话描述，比如：严谨细心的服装版师"
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
          placeholder="描述角色的身份、性格、说话风格…（可先选工作模板或 AI 生成）"
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
