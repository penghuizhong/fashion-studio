// 群聊设置：改群名、增删成员
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import Modal from './Modal.jsx';

export default function GroupSettingsModal({ group, onClose, onSaved, onMessagesCleared, showToast }) {
  const [name, setName] = useState((group && group.title) || '');
  const [memberIds, setMemberIds] = useState(() => (group && group.members ? group.members.map((m) => m.id) : []));
  const [allChars, setAllChars] = useState([]);
  const [saving, setSaving] = useState(false);
  // v1.20.5: 清空消息
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    api
      .listCharacters()
      .then(setAllChars)
      .catch(() => {});
  }, []);

  const toggle = (id) => {
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const save = async () => {
    if (memberIds.length < 2) {
      showToast('群聊至少需要 2 个角色');
      return;
    }
    setSaving(true);
    try {
      const g = await api.updateGroupMembers(group.id, memberIds);
      const t = name.trim();
      const final = t && t !== g.title ? await api.renameGroup(group.id, t) : g;
      onSaved(final);
      showToast('群聊已更新', 2000);
      onClose();
    } catch (err) {
      showToast(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // v1.20.5: 清空群聊消息（防上下文污染）
  const clearMessages = async () => {
    if (!window.confirm('确定清空该群聊的全部消息吗？摘要也会一起删除，此操作不可恢复。')) return;
    if (!window.confirm('再次确认：真的要清空吗？')) return;
    setClearing(true);
    try {
      await api.clearMessages(group.id);
      showToast('群聊消息已清空', 2000);
      if (onMessagesCleared) onMessagesCleared();
      onSaved({ ...group });
      onClose();
    } catch (err) {
      showToast(err.message || '清空失败');
    } finally {
      setClearing(false);
    }
  };

  return (
    <Modal
      title="群聊设置"
      size="s"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <label>
        群名
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="群聊名称" />
      </label>
      <div className="member-picker">
        <div className="member-picker-title">成员（至少 2 个，最多 8 个）</div>
        {allChars.map((c) => (
          <label key={c.id} className="member-option">
            <input type="checkbox" checked={memberIds.includes(c.id)} onChange={() => toggle(c.id)} />
            <Avatar src={c.avatar || null} size={28} className="member-avatar" />
            <span>{c.name}</span>
          </label>
        ))}
      </div>
      <div className="danger-zone">
        <button className="btn danger" onClick={clearMessages} disabled={clearing}>
          {clearing ? '清空中…' : '清空群聊消息'}
        </button>
      </div>
    </Modal>
  );
}
