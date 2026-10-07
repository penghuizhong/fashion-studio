import { useEffect, useRef, useState } from 'react';
import { api, formatFullTime } from '../api.js';
import GroupSettingsModal from './GroupSettingsModal.jsx';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';

// v1.13.3 轻量 markdown 渲染（聊天消息用）：只处理加粗/代码块/换行
// 先转义 HTML 防 XSS；代码块先提取避免内部 ** 被误处理
function renderMarkdown(text) {
  if (!text) return '';
  let html = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const codeBlocks = [];
  html = html.replace(/```\w*\n?([\s\S]*?)```/g, (m, code) => {
    codeBlocks.push(`<pre class="md-codeblock"><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\u0000CB(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)] || '');
  return html;
}

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
  // v1.10 意图识别：待确认的灵魂修改建议
  const [suggestions, setSuggestions] = useState([]);
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const memPollRef = useRef(null); // v1.12 记忆事件轮询定时器

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
      if (memPollRef.current) {
        clearInterval(memPollRef.current);
        memPollRef.current = null;
      }
    };
  }, [characterId, conversationId, isGroup]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, groupStreams, typing, errorMsg]);

  // v1.10：轮询待确认的灵魂修改建议（仅单聊）
  useEffect(() => {
    if (isGroup || !characterId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const list = await api.getSuggestions(characterId);
        if (!cancelled) setSuggestions(Array.isArray(list) ? list : []);
      } catch {
        /* 忽略，后台静默重试 */
      }
    };
    poll();
    timer = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [characterId, isGroup, conversationId]);

  const handleApplySuggestion = async (id) => {
    try {
      await api.applySuggestion(id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
      showToast('已写入灵魂');
    } catch (e) {
      showToast(e.message || '写入失败');
    }
  };

  const handleDismissSuggestion = async (id) => {
    try {
      await api.dismissSuggestion(id);
    } catch {
      /* 忽略 */
    }
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const memberOf = (cid) => (group && group.members ? group.members.find((m) => m.id === cid) : null);

  // v1.12：done 后轮询记忆写入事件，有实际写入即 toast"记住了"（后台流水线约需 5~20 秒）
  const pollMemoryEvents = (since) => {
    if (memPollRef.current) clearInterval(memPollRef.current);
    const seen = new Set();
    let cursor = since;
    let lastNewAt = 0;
    let n = 0;
    memPollRef.current = setInterval(async () => {
      n++;
      try {
        const list = await api.getMemoryEvents(conversationId, cursor);
        let newest = cursor;
        for (const e of Array.isArray(list) ? list : []) {
          if (!e || seen.has(e.id)) continue;
          seen.add(e.id);
          if (e.created_at > newest) newest = e.created_at;
          lastNewAt = Date.now();
          const who = e.character_name || (e.character_id ? (memberOf(e.character_id) || {}).name : null);
          showToast(who ? `${who} 记住了 ✨` : '已记住 ✨', 2500);
        }
        cursor = newest;
      } catch {
        // 查询失败（网络/会话失效）就停，避免空转
        clearInterval(memPollRef.current);
        memPollRef.current = null;
        return;
      }
      // 最多 60 秒；有事件后 15 秒无新事件也停
      if (n >= 15 || (lastNewAt > 0 && Date.now() - lastNewAt > 15000)) {
        clearInterval(memPollRef.current);
        memPollRef.current = null;
      }
    }, 4000);
  };

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
          } else if (ev === 'filter_retry') {
            // v1.17.1: 上游内容过滤，自动换模型重试——丢弃半截输出，不卡住
            const cid = data && data.character_id;
            if (isGroup && cid) {
              accByChar[cid] = '';
              setGroupStreams((s) => ({ ...s, [cid]: '' }));
            } else {
              acc = '';
              setStreamText('');
            }
            showToast('内容被上游拦截，正在换模型重试…', 2500);
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
            // v1.12：后台记忆流水线跑完有写入时 toast 提示
            pollMemoryEvents(new Date().toISOString());
          } else if (ev === 'error') {
            setErrorMsg((data && data.message) || '生成失败，换句话试试');
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        if (err.status === 429) setErrorMsg('请求太频繁了，休息几秒再试');
        else setErrorMsg(err.message || '网络错误');
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

  const headerAvatarSrc = isGroup ? null : character ? character.avatar : null;
  const headerName = isGroup ? '群聊' : character ? character.name : '…';

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-header-main">
          <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
            ☰
          </button>
          {isGroup ? (
            <span className="chat-avatar">👥</span>
          ) : (
            <Avatar src={headerAvatarSrc} size={32} className="chat-avatar" />
          )}
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
            <div className="chat-empty-avatar">
              {isGroup ? '👥' : <Avatar src={headerAvatarSrc} size={64} />}
            </div>
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
                <Avatar src={m.character_avatar} size={24} className="msg-speaker-avatar" />
                <span className="msg-speaker-name">{m.character_name || '某人'}</span>
              </div>
            )}
            <div
              className="bubble"
              title={formatFullTime(m.created_at)}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
            />
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
                  <Avatar src={mem && mem.avatar} size={24} className="msg-speaker-avatar" />
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
        {!isGroup && suggestions.length > 0 && (
          <div className="suggestion-nudge">
            <div className="suggestion-text">
              💡 检测到你想给「{character ? character.name : 'TA'}」加个设定：「{suggestions[0].proposed}」
            </div>
            <div className="suggestion-actions">
              <button className="btn small primary" onClick={() => handleApplySuggestion(suggestions[0].id)}>
                写入灵魂
              </button>
              <button className="btn small secondary" onClick={() => handleDismissSuggestion(suggestions[0].id)}>
                忽略
              </button>
            </div>
          </div>
        )}
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
