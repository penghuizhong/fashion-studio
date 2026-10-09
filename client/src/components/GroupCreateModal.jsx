// v1.25.4: 建群弹窗抽成共用组件（侧边栏 + 首页共用）
import { useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import Avatar from './Avatar.jsx';

export default function GroupCreateModal({ characters, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState([]);
  const [creating, setCreating] = useState(false);

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
        {characters.length === 0 && <div className="versions-empty">还没有角色，先去新建角色</div>}
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
