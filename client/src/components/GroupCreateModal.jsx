// v1.25.4: 建群弹窗抽成共用组件（侧边栏 + 首页共用）
// v1.25.5: 角色不足 2 个时引导先去新建角色
import { useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import Avatar from './Avatar.jsx';
import Icon from './icons.jsx';

export default function GroupCreateModal({ characters, onClose, onCreated, onCreateCharacter, showToast }) {
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState([]);
  const [creating, setCreating] = useState(false);
  const needMore = Math.max(0, 2 - characters.length);

  const toggleMember = (id) => {
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const handleCreate = async () => {
    if (memberIds.length < 2) {
      showToast('群聊至少选择 2 个角色');
      return;
    }
    setCreating(true);
    try {
      const g = await api.createGroup({ name: name.trim(), member_ids: memberIds });
      onClose();
      if (onCreated) onCreated(g);
    } catch (err) {
      showToast((err && err.message) || '建群失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      title="新建群聊"
      size="s"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={handleCreate} disabled={creating}>
            {creating ? '建群中…' : `建群（${memberIds.length} 人）`}
          </button>
        </>
      }
    >
      <label>
        群名
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="留空用成员名自动生成" />
      </label>
      <div className="member-picker">
        <div className="member-picker-title">选择成员（至少 2 个）</div>
        {needMore > 0 && (
          <div className="group-need-chars">
            <Icon name="alert" size={16} />
            <span>
              {characters.length === 0
                ? '你还没有角色，先新建 2 个角色才能建群'
                : '再新建 1 个角色就能建群了'}
            </span>
            {onCreateCharacter && (
              <button className="btn primary small" onClick={onCreateCharacter}>
                去新建角色
              </button>
            )}
          </div>
        )}
        {characters.map((c) => (
          <label key={c.id} className="member-option">
            <input type="checkbox" checked={memberIds.includes(c.id)} onChange={() => toggleMember(c.id)} />
            <Avatar src={c.avatar} size={28} className="member-avatar" />
            <span>{c.name}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
