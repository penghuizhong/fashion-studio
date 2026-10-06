// v1.16.5: 头像选择器（新建角色 / 角色设置共用）
// 默认显示 8 张，点"展开更多"显示全部 26 张
import { useState } from 'react';
import { AVATAR_LIST, AVATAR_DEFAULT_COUNT } from '../avatars.js';

export default function AvatarPicker({ value, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? AVATAR_LIST : AVATAR_LIST.slice(0, AVATAR_DEFAULT_COUNT);

  return (
    <div>
      <div className="avatar-grid">
        {shown.map((a) => (
          <button
            key={a}
            type="button"
            className={`avatar-option${value === a ? ' selected' : ''}`}
            onClick={() => onChange(a)}
            title="选择头像"
          >
            <img src={a} alt="头像" loading="lazy" />
          </button>
        ))}
      </div>
      {AVATAR_LIST.length > AVATAR_DEFAULT_COUNT && (
        <button
          type="button"
          className="btn secondary small avatar-more"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? '收起 ▲' : `展开更多（${AVATAR_LIST.length - AVATAR_DEFAULT_COUNT} 张）▼`}
        </button>
      )}
    </div>
  );
}
