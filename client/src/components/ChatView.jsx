import { useEffect, useRef, useState } from 'react';
import { api, formatFullTime } from '../api.js';
import GroupSettingsModal from './GroupSettingsModal.jsx';
import Icon from './icons.jsx';

export default function ChatView({ characterId, conversationId, isGroup, onConversationsChanged, onOpenSidebar, showToast }) {
  const [character, setCharacter] = useState(null);
  const [group, setGroup] = useState(null);
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState('');
  // 群聊：按角色分别的流式文本 + 正在输入的角色
  const [groupStreams, setGroupStreams] = useState({});
  const [typing, setTyping] = useState(null);
  const [contextInfo, setContextInfo] = useState(null);
  const [roundUsage, setRoundUsage] = useState(0);
  const [totalUsage, setTotalUsage] = useState(0);

  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  const [errorMsg, setErrorMsg] = useState(null);
  const [input, setInput] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setGroup(null);
    setCharacter(null);
    (async () => {
      try {
        const msgs = await api.listMessages(conversationId);
        if (cancelled) return;
        if (isGroup) {
          const g = await api.getGroup(conversationId);
          if (cancelled) return;
          setGroup(g);
          setTitle(g.title || '未命名群聊');
        } else {
          const [char, convList] = await Promise.all([
            api.getCharacter(characterId),
            api.listConversations(characterId),
          ]);
          if (cancelled) return;
          setCharacter(char);
          const conv = convList.find((c) => c.id === conversationId);
          setTitle(conv ? conv.title || '未命名对话' : '未命名对话');
        }
        setMessages(msgs);
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message || '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (abortRef.current) abortRef.current.abort();
    };
  }, [characterId, conversationId, isGroup]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, groupStreams, typing, errorMsg]);

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const memberOf = (cid) => (group && group.members ? group.members.find((m) => m.id === cid) : null);

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setInput('');
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto';
    });
    const userMsg = {
      id: `tmp-u-${Date.now()}`,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);
    setSending(true);
    setStreamText('');
    setGroupStreams({});
    setTyping(null);
    setErrorMsg(null);
    setContextInfo(null);
    let acc = '';
    const accByChar = {};
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.sendMessage(
        conversationId,
        content,
        (ev, data) => {
          if (ev === 'context') {
            setContextInfo(data);
          } else if (ev === 'turn_start') {
            const cid = data && data.character_id;
            accByChar[cid] = '';
            setTyping({ character_id: cid, character_name: (data && data.character_name) || '某人' });
            setGroupStreams((s) => ({ ...s, [cid]: '' }));
          } else if (ev === 'token') {
            const cid = data && data.character_id;
            const text = data && typeof data.text === 'string' ? data.text : '';
            if (isGroup && cid) {
              accByChar[cid] = (accByChar[cid] || '') + text;
              setGroupStreams((s) => ({ ...s, [cid]: accByChar[cid] }));
            } else {
              acc += text;
              setStreamText(acc);
            }
          } else if (ev === 'turn_done') {
            const cid = data && data.character_id;
            const finalText = accByChar[cid] || '';
            setGroupStreams((s) => {
              const next = { ...s };
              delete next[cid];
              return next;
            });
            setTyping(null);
            const mem = memberOf(cid);
            setMessages((m) => [
              ...m,
              {
                id: data && data.message_id ? data.message_id : `tmp-a-${Date.now()}`,
                role: 'assistant',
                character_id: cid,
                character_name: (data && data.character_name) || (mem && mem.name) || '某人',
                character_avatar: (mem && mem.avatar) || '✨',
                content: finalText,
                created_at: new Date().toISOString(),
              },
            ]);
          } else if (ev === 'memory_updated') {
            const who = data && data.character_id ? (memberOf(data.character_id) || {}).name : null;
            showToast(who ? `${who} 记住了 ✨` : '已记住 ✨', 2500);
          } else if (ev === 'points') {
            // 积分扣费后余额变化：广播出去，API 设置弹窗（如开着）刷新余额
            window.dispatchEvent(new CustomEvent('soulchat-points-changed', { detail: data || {} }));
          } else if (ev === 'done') {
            if (!isGroup) {
              const finalText = acc;
              setStreamText('');
              setMessages((m) => [
                ...m,
                {
                  id: data && data.message_id ? data.message_id : `tmp-a-${Date.now()}`,
                  role: 'assistant',
                  content: finalText,
                  created_at: new Date().toISOString(),
                },
              ]);
            }
            if (data && data.usage) {
              const t = (data.usage.input || 0) + (data.usage.output || 0);
              setRoundUsage(t);
              setTotalUsage((x) => x + t);
            }
            if (data && data.title) {
              setTitle(data.title);
              onConversationsChanged();
            }
          } else if (ev === 'error') {
            setErrorMsg((data && data.message) || '生成失败，换句话试试');
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        setErrorMsg(err.message || '网络错误');
      }
    } finally {
      setSending(false);
      setTyping(null);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const saveRename = async () => {
    const t = renameValue.trim();
    setRenaming(false);
    if (!t || t === title) return;
    try {
      if (isGroup) await api.renameGroup(conversationId, t);
      else await api.renameConversation(conversationId, t);
      setTitle(t);
      onConversationsChanged();
    } catch (err) {
      showToast(err.message || '改名失败');
    }
  };

  const pct = contextInfo && contextInfo.budget ? Math.min(100, (contextInfo.used / contextInfo.budget) * 100) : 0;
  const hot = pct > 80;

  const headerAvatar = isGroup ? '👥' : character ? character.avatar || '✨' : '✨';
  const headerName = isGroup ? '群聊' : character ? character.name : '…';

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-header-main">
          <button className="menu-btn icon-btn" title="打开侧边栏" onClick={onOpenSidebar}>
            ☰
          </button>
          <span className="chat-avatar">{headerAvatar}</span>
          <span className="chat-char-name">{headerName}</span>
          <span className="chat-divider">·</span>
          {renaming ? (
            <input
              className="rename-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span
              className="chat-conv-title"
              title="点击改名"
              onClick={() => {
                setRenameValue(title);
                setRenaming(true);
              }}
            >
              {title || (isGroup ? '未命名群聊' : '未命名对话')}
            </span>
          )}
          {isGroup && group && (
            <span className="chat-members-hint" title={group.members.map((m) => m.name).join('、')}>
              {group.members.length} 人
            </span>
          )}
        </div>
        <div className="chat-header-actions">
          {isGroup && (
            <button className="icon-btn" title="群成员管理" onClick={() => setSettingsOpen(true)}>
              <Icon name="gear" size={18} />
            </button>
          )}
        </div>
        <div className="context-bar" title={contextInfo ? `上下文 ${contextInfo.used} / ${contextInfo.budget}` : '上下文用量'}>
          <div className={`context-fill ${hot ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </header>

      <div className="messages" ref={scrollRef}>
        {loading && <div className="loading-hint">加载中…</div>}
        {!loading && messages.length === 0 && !sending && (
          <div className="chat-empty">
            <div className="chat-empty-avatar">{isGroup ? '👥' : headerAvatar}</div>
            <p>
              {isGroup ? (
                <>
                  在群里打个招呼吧，
                  <br />
                  输入 @名字 可以点名某人回复。
                </>
              ) : (
                <>
                  和{character ? character.name : 'TA'}打个招呼吧，
                  <br />
                  TA 会记住你们的每一次对话。
                </>
              )}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg-row ${m.role === 'user' ? 'user' : 'assistant'}`}>
            {isGroup && m.role === 'assistant' && (
              <div className="msg-speaker">
                <span className="msg-speaker-avatar">{m.character_avatar || '✨'}</span>
                <span className="msg-speaker-name">{m.character_name || '某人'}</span>
              </div>
            )}
            <div className="bubble" title={formatFullTime(m.created_at)}>
              {m.content}
            </div>
            <div className="msg-time">{formatFullTime(m.created_at).slice(5)}</div>
          </div>
        ))}
        {/* 群聊：各角色流式气泡 */}
        {isGroup &&
          Object.entries(groupStreams).map(([cid, text]) => {
            const mem = memberOf(cid);
            return (
              <div key={`stream-${cid}`} className="msg-row assistant">
                <div className="msg-speaker">
                  <span className="msg-speaker-avatar">{(mem && mem.avatar) || '✨'}</span>
                  <span className="msg-speaker-name">{(mem && mem.name) || '某人'}</span>
                </div>
                <div className="bubble streaming">
                  {text}
                  <span className="cursor">▍</span>
                </div>
              </div>
            );
          })}
        {/* 单聊：流式气泡 */}
        {!isGroup && sending && (
          <div className="msg-row assistant">
            <div className="bubble streaming">
              {streamText}
              <span className="cursor">▍</span>
            </div>
          </div>
        )}
        {typing && (
          <div className="typing-hint">
            {typing.character_name} 正在输入…
          </div>
        )}
        {errorMsg && !sending && (
          <div className="msg-row assistant">
            <div className="bubble error-bubble">⚠️ {errorMsg}</div>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="input-wrap">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder={isGroup ? '在群里发消息…（@名字 可点名）' : `给 ${character ? character.name : 'TA'} 发消息…`}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <button className="send-btn" onClick={send} disabled={sending || !input.trim()} title="发送">
            ➤
          </button>
        </div>
        <div className="composer-hint">
          Enter 发送 · Shift+Enter 换行{isGroup ? ' · 一次最多 3 位角色回应' : ''}
          {roundUsage > 0 && ` · 本轮 ≈ ${fmtTokens(roundUsage)} tokens`}
          {totalUsage > 0 && ` · 累计 ≈ ${fmtTokens(totalUsage)}`}
        </div>
      </div>

      {settingsOpen && isGroup && (
        <GroupSettingsModal
          group={group}
          onClose={() => setSettingsOpen(false)}
          onSaved={(g) => {
            setGroup(g);
            setTitle(g.title);
            onConversationsChanged();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
