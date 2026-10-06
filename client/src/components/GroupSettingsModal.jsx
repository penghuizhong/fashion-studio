// 群聊设置：改群名、增删成员
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';

export default function GroupSettingsModal({ group, onClose, onSaved, showToast }) {
  const [name, setName] = useState((group && group.title) || '');
  const [memberIds, setMemberIds] = useState(() => (group && group.members ? group.members.map((m) => m.id) : []));
  const [allChars, setAllChars] = useState([]);
  const [saving, setSaving] = useState(false);

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
            <span className="member-avatar">{c.avatar || '✨'}</span>
            <span>{c.name}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
