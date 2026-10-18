import { useEffect, useRef, useState } from 'react';
import { api, formatFullTime } from '../api.js';
import GroupSettingsModal from './GroupSettingsModal.jsx';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';
// v1.26.0: 语音

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

export default function ChatView({ characterId, conversationId, isGroup, onConversationsChanged, onOpenSidebar, showToast, config }) {
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
  const [billingMode, setBillingMode] = useState('api'); // v1.25.0: 'points' | 'api'
  const [roundPoints, setRoundPoints] = useState(0);
  const [totalPoints, setTotalPoints] = useState(0);

  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  const [errorMsg, setErrorMsg] = useState(null);
  // v1.20.3: 重新生成中
  const [regenerating, setRegenerating] = useState(false);
  const [input, setInput] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v1.10 意图识别：待确认的灵魂修改建议
  const [suggestions, setSuggestions] = useState([]);
  // v1.26.0: 语音
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const memPollRef = useRef(null); // v1.12 记忆事件轮询定时器
  const batchIdRef = useRef(null); // v1.22.2 群聊整轮 batch_id（断流补 truncated 用）
  const doneCidsRef = useRef(new Set()); // v1.22.2 收到 turn_done 的角色（断流时区分半截）
  const stickToBottomRef = useRef(true); // v1.28.0: 粘性底部——用户上滑后不再强制滚到底
  const [showScrollBtn, setShowScrollBtn] = useState(false); // v1.28.0: 上滑后显示"回到底部"悬浮按钮
  const SCROLL_NEAR_BOTTOM_PX = 100; // 距底部多少 px 内算"在底部"

  // v1.28.0: 滚动监听——用户主动上滑就松开粘性，滑回底部则恢复跟随
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_PX;
    stickToBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  };

  // v1.28.0: 点悬浮按钮回到底部（平滑），恢复粘性跟随
  const scrollToBottom = (smooth) => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setShowScrollBtn(false);
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setGroup(null);
    setCharacter(null);
    // v1.28.0: 切对话时恢复粘性底部
    stickToBottomRef.current = true;
    setShowScrollBtn(false);
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

  // v1.28.0: 粘性底部——只在用户处于底部附近时自动跟随，上滑后不再强制拽回到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, groupStreams, typing, errorMsg]);

  // v1.25.3: 挂载时拉取真实计费模式，避免刷新后默认 api 闪一下
  useEffect(() => {
    let cancelled = false;
    api.getPoints().then((p) => {
      if (cancelled || !p) return;
      const m = p.billing_mode === 'points' ? 'points' : 'api';
      setBillingMode(m);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // v1.25.1: 监听计费模式切换，设置弹窗保存后即时刷新下方提示
  useEffect(() => {
    const handler = (e) => {
      const mode = e && e.detail && e.detail.mode;
      if (mode === 'points' || mode === 'api') {
        setBillingMode(mode);
        // 切换模式后清零本轮计数，避免旧模式残留
        setRoundUsage(0);
        setRoundPoints(0);
      }
    };
    window.addEventListener('soulchat-billing-changed', handler);
    return () => window.removeEventListener('soulchat-billing-changed', handler);
  }, []);

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
          showToast(who ? `${who} 记住了` : '已记住', 2500);
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

  const lastContentRef = useRef('');
  const sendContent = async (rawContent, opts = {}) => {
    const content = String(rawContent || '').trim();
    if (!content || sending) return;
    lastContentRef.current = content;
    // v1.28.0: 发送新消息时恢复粘性底部（用户想看回复）
    stickToBottomRef.current = true;
    setShowScrollBtn(false);
    setInput('');
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto';
    });
    // v1.17.4: 重试不重复追加用户气泡（界面上已有一条）
    if (!opts.skipUserBubble) {
      const userMsg = {
        id: `tmp-u-${Date.now()}`,
        role: 'user',
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMsg]);
    }
    setSending(true);
    setStreamText('');
    setGroupStreams({});
    setTyping(null);
    setErrorMsg(null);
    setContextInfo(null);
    batchIdRef.current = null; // v1.22.2
    doneCidsRef.current = new Set(); // v1.22.2
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
            // v1.22.2: 记 batch_id + 已完成集合——断流时给没收到 turn_done 的半截补 truncated 消息
            if (data && data.batch_id) batchIdRef.current = data.batch_id;
            if (cid) doneCidsRef.current.delete(cid);
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
            if (cid) doneCidsRef.current.add(cid); // v1.22.2 断流区分用
            setGroupStreams((s) => {
              const next = { ...s };
              delete next[cid];
              return next;
            });
            setTyping(null);
            const mem = memberOf(cid);
            // v1.22.0: 截断标记——流异常结束时前端提示"好像没说完"并给重新生成
            const truncated = !!(data && data.truncated && finalText.trim());
            setMessages((m) => [
              ...m,
              {
                id: data && data.message_id ? data.message_id : `tmp-a-${Date.now()}`,
                role: 'assistant',
                character_id: cid,
                character_name: (data && data.character_name) || (mem && mem.name) || '某人',
                character_avatar: (mem && mem.avatar) || null,
                content: finalText,
                created_at: new Date().toISOString(),
                truncated,
              },
            ]);
          } else if (ev === 'memory_updated') {
            const who = data && data.character_id ? (memberOf(data.character_id) || {}).name : null;
            showToast(who ? `${who} 记住了` : '已记住', 2500);
          } else if (ev === 'points') {
            // 积分扣费后余额变化：广播出去，API 设置弹窗（如开着）刷新余额
            window.dispatchEvent(new CustomEvent('soulchat-points-changed', { detail: data || {} }));
          } else if (ev === 'done') {
            if (!isGroup) {
              const finalText = acc;
              setStreamText('');
              // v1.20.3: 截断标记——流异常结束时前端提示"好像没说完"
              const truncated = !!(data && data.truncated && finalText.trim());
              const msgId = data && data.message_id ? data.message_id : `tmp-a-${Date.now()}`;
              setMessages((m) => [
                ...m,
                {
                  id: msgId,
                  role: 'assistant',
                  content: finalText,
                  created_at: new Date().toISOString(),
                  truncated,
                },
              ]);
            }
            if (data && data.usage) {
              const t = (data.usage.input || 0) + (data.usage.output || 0);
              setRoundUsage(t);
              setTotalUsage((x) => x + t);
            }
            // v1.25.0: 计费模式 + 积分消耗
            if (data && data.billingMode) {
              setBillingMode(data.billingMode);
              if (data.billingMode === 'points') {
                const p = data.pointsUsed || 0;
                setRoundPoints(p);
                setTotalPoints((x) => x + p);
              }
            }
            if (data && data.title) {
              setTitle(data.title);
              onConversationsChanged();
            }
            // v1.12：后台记忆流水线跑完有写入时 toast 提示
            pollMemoryEvents(new Date().toISOString());
          } else if (ev === 'error') {
            const errCid = data && data.character_id;
            // v1.28.2: 群聊单角色流中途抛异常——把半截文本转成 truncated 消息并给重试按钮；
            // 之前只弹 toast，半截气泡会一直卡在流式状态且无恢复入口
            if (isGroup && errCid) {
              if (data && data.batch_id) batchIdRef.current = data.batch_id;
              doneCidsRef.current.add(errCid); // 整流 catch 不再重复补
              setGroupStreams((s) => {
                const next = { ...s };
                delete next[errCid];
                return next;
              });
              setTyping((t) => (t && String(t.character_id) === String(errCid) ? null : t));
              const partial = accByChar[errCid] || '';
              if (partial.trim()) {
                const mem = memberOf(errCid);
                const batchId = batchIdRef.current;
                setMessages((m) => [
                  ...m,
                  {
                    id: `tmp-err-${errCid}-${Date.now()}`,
                    role: 'assistant',
                    character_id: errCid,
                    character_name: (mem && mem.name) || '某人',
                    character_avatar: (mem && mem.avatar) || null,
                    content: partial,
                    created_at: new Date().toISOString(),
                    truncated: true,
                    // 后端未落库半截：按角色+batch 定位重跑（regenerate-turn 无半截时直接重跑）
                    batchRegen: batchId ? { character_id: errCid, batch_id: batchId } : null,
                  },
                ]);
              }
            }
            setErrorMsg((data && data.message) || '生成失败，换句话试试');
          }
        },
        controller.signal,
        // v1.22.0: 重新生成时告诉后端复用用户消息，不重复落库
        { regenerate: !!opts.regenerate }
      );
      // v1.29.13: 流正常结束但有群聊角色没收到 turn_done——补 truncated 消息给重试按钮
      // （之前只在 catch 里处理，静默断流时半截卡住无恢复入口）
      if (isGroup) {
        const batchId = batchIdRef.current;
        const incomplete = Object.entries(accByChar).filter(
          ([cid, text]) => text && text.trim() && !doneCidsRef.current.has(String(cid))
        );
        if (incomplete.length) {
          setMessages((m) => [
            ...m,
            ...incomplete.map(([cid, text]) => {
              const mem = memberOf(cid);
              return {
                id: `tmp-trunc-${cid}-${Date.now()}`,
                role: 'assistant',
                character_id: cid,
                character_name: (mem && mem.name) || '某人',
                character_avatar: (mem && mem.avatar) || null,
                content: text,
                created_at: new Date().toISOString(),
                truncated: true,
                batchRegen: batchId ? { character_id: cid, batch_id: batchId } : null,
              };
            }),
          ]);
          setGroupStreams((st) => {
            const next = { ...st };
            for (const [cid] of incomplete) delete next[cid];
            return next;
          });
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        if (err.status === 429) setErrorMsg('请求太频繁了，休息几秒再试');
        // v1.17.4: fetch 网络失败（iOS 抛 TypeError: Load failed）转中文，不显示英文原串
        else if (err instanceof TypeError) setErrorMsg('网络连接中断，请检查网络后重试');
        else setErrorMsg(err.message || '网络错误');
        // v1.22.2: 群聊断流时，没收到 turn_done 的角色半截文本转成 truncated 消息，给重新生成按钮
        if (isGroup) {
          const batchId = batchIdRef.current;
          const incomplete = Object.entries(accByChar).filter(
            ([cid, text]) => text && text.trim() && !doneCidsRef.current.has(cid)
          );
          if (incomplete.length) {
            setMessages((m) => [
              ...m,
              ...incomplete.map(([cid, text]) => {
                const mem = memberOf(cid);
                return {
                  id: `tmp-trunc-${cid}-${Date.now()}`,
                  role: 'assistant',
                  character_id: cid,
                  character_name: (mem && mem.name) || '某人',
                  character_avatar: (mem && mem.avatar) || null,
                  content: text,
                  created_at: new Date().toISOString(),
                  truncated: true,
                  // 无 message_id——重新生成时按角色+batch 定位后端半截
                  batchRegen: batchId ? { character_id: cid, batch_id: batchId } : null,
                };
              }),
            ]);
            setGroupStreams((s) => {
              const next = { ...s };
              for (const [cid] of incomplete) delete next[cid];
              return next;
            });
          }
        }
      }
    } finally {
      setSending(false);
      setTyping(null);
      abortRef.current = null;
    }
  };

  const send = () => sendContent(input);

  // v1.17.4: 网络中断后的重试入口
  // v1.27.1: 重试带 regenerate，后端按内容比对复用已落库的用户消息，不再重复插入
  const retrySend = () => {
    if (sending || !lastContentRef.current) return;
    sendContent(lastContentRef.current, { skipUserBubble: true, regenerate: true });
  };

  // v1.20.5: 消息长按/右键菜单（删除单条，防上下文污染）
  const [msgMenu, setMsgMenu] = useState(null); // { id, x, y }
  const msgPressTimer = useRef(null);
  const cancelMsgPress = () => {
    if (msgPressTimer.current) { clearTimeout(msgPressTimer.current); msgPressTimer.current = null; }
  };
  const startMsgPress = (e, id) => {
    if (e.touches && e.touches.length === 1) {
      const t = e.touches[0];
      msgPressTimer.current = setTimeout(() => {
        setMsgMenu({ id, x: t.clientX, y: t.clientY });
      }, 550);
    }
  };
  const deleteMsg = async (id) => {
    setMsgMenu(null);
    try {
      await api.deleteMessage(id);
      setMessages((msgs) => msgs.filter((m) => m.id !== id));
      showToast('已删除', 1500);
    } catch (err) {
      showToast(err.message || '删除失败');
    }
  };

  // v1.20.3: 重新生成最后一条 AI 回复（断流半截时用）——后端删掉半截，前端按原问题重发
  // v1.22.0: 重发时带 regenerate 标记，后端复用最后一条用户消息，不再重复落库
  const regenerate = async () => {
    if (sending || regenerating || isGroup) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    setRegenerating(true);
    setErrorMsg(null);
    try {
      const r = await api.regenerateMessage(conversationId);
      setMessages((m) => m.slice(0, -1));
      showToast('正在重新生成…', 1500);
      sendContent(r.content, { skipUserBubble: true, regenerate: true });
    } catch (err) {
      showToast(err.message || '重新生成失败');
    } finally {
      setRegenerating(false);
    }
  };

  // v1.22.0: 群聊单轮重新生成——删掉指定半截回复，只重跑该角色一轮
  // v1.22.2: 断流补的 truncated 消息无 message_id，改按 character_id+batch_id 定位后端半截
  const regenerateGroupTurn = async (msg) => {
    if (sending || regenerating || !isGroup) return;
    if (!msg || msg.role !== 'assistant' || !msg.character_id) return;
    const locator = msg.batchRegen || { message_id: msg.id };
    setRegenerating(true);
    setErrorMsg(null);
    // 先从界面上拿掉半截消息
    setMessages((m) => m.filter((x) => x.id !== msg.id));
    const cid = msg.character_id;
    setGroupStreams((s) => ({ ...s, [cid]: '' }));
    const controller = new AbortController();
    abortRef.current = controller;
    // v1.22.2: 重新生成断流时也补 truncated（按新 batch 定位）
    let regenBatchId = null;
    let regenText = '';
    let regenDone = false;
    try {
      await api.regenerateGroupTurn(conversationId, locator, (ev, data) => {
        if (ev === 'turn_start' && data && data.batch_id) {
          regenBatchId = data.batch_id;
        } else if (ev === 'token' && data && data.character_id === cid) {
          regenText += data.text || '';
          setGroupStreams((s) => ({ ...s, [cid]: (s[cid] || '') + (data.text || '') }));
        } else if (ev === 'turn_done' && data && data.character_id === cid) {
          regenDone = true;
          const finalText = data.content || '';
          setGroupStreams((s) => {
            const next = { ...s };
            delete next[cid];
            return next;
          });
          const mem = memberOf(cid);
          const truncated = !!(data.truncated && finalText.trim());
          setMessages((m) => [
            ...m,
            {
              id: data.message_id ? data.message_id : `tmp-a-${Date.now()}`,
              role: 'assistant',
              character_id: cid,
              character_name: (data && data.character_name) || (mem && mem.name) || msg.character_name || '某人',
              character_avatar: (mem && mem.avatar) || msg.character_avatar || null,
              content: finalText,
              created_at: new Date().toISOString(),
              truncated,
            },
          ]);
        } else if (ev === 'error') {
          setErrorMsg(data && data.message ? String(data.message) : '重新生成失败');
          // 失败时把原半截消息放回去，避免丢失
          setMessages((m) => [...m, msg]);
          setGroupStreams((s) => {
            const next = { ...s };
            delete next[cid];
            return next;
          });
        }
      }, controller.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        // v1.22.2: 重新生成也断流→半截转 truncated（按新 batch 定位），无半截才放回原消息
        if (regenText.trim() && !regenDone) {
          const mem = memberOf(cid);
          showToast(err.message || '重新生成中断，可再试一次');
          setMessages((m) => [
            ...m,
            {
              id: `tmp-trunc-${cid}-${Date.now()}`,
              role: 'assistant',
              character_id: cid,
              character_name: (mem && mem.name) || msg.character_name || '某人',
              character_avatar: (mem && mem.avatar) || msg.character_avatar || null,
              content: regenText,
              created_at: new Date().toISOString(),
              truncated: true,
              batchRegen: regenBatchId ? { character_id: cid, batch_id: regenBatchId } : null,
            },
          ]);
        } else {
          showToast(err.message || '重新生成失败');
          setMessages((m) => [...m, msg]);
        }
      }
      setGroupStreams((s) => {
        const next = { ...s };
        delete next[cid];
        return next;
      });
    } finally {
      setRegenerating(false);
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
            <Icon name="menu" size={22} />
          </button>
          {isGroup ? (
            <span className="chat-avatar"><Icon name="users" size={20} /></span>
          ) : (
            <Avatar src={headerAvatarSrc} size={32} className="chat-avatar" eager />
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

      <div className="messages" ref={scrollRef} onScroll={handleScroll}>
        {loading && <div className="loading-hint">加载中…</div>}
        {!loading && messages.length === 0 && !sending && (
          <div className="chat-empty">
            <div className="chat-empty-avatar">
              {isGroup ? <Icon name="users" size={32} /> : <Avatar src={headerAvatarSrc} size={64} eager />}
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
        {messages.map((m, i) => (
          <div
            key={m.id}
            className={`msg-row ${m.role === 'user' ? 'user' : 'assistant'}`}
            onContextMenu={typeof m.id === 'number' ? (e) => { e.preventDefault(); setMsgMenu({ id: m.id, x: e.clientX, y: e.clientY }); } : undefined}
            onTouchStart={typeof m.id === 'number' ? (e) => startMsgPress(e, m.id) : undefined}
            onTouchEnd={cancelMsgPress}
            onTouchMove={cancelMsgPress}
          >
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
            {/* v1.20.3: 最后一条 AI 回复下放重新生成 */}
            {!isGroup && m.role === 'assistant' && i === messages.length - 1 && !sending && (
              <div className="regen-row">
                {m.truncated && <span className="truncated-hint">回复好像没说完，</span>}
                <button className="btn secondary small" onClick={regenerate} disabled={regenerating}>
                  {regenerating ? '生成中…' : '↻ 重新生成'}
                </button>
              </div>
            )}
            {/* v1.29.16: 群聊每个角色最后一条 AI 消息下常驻重新生成（对齐单聊）；截断时加提示前缀 */}
            {isGroup && m.role === 'assistant' && !sending && (() => {
              const isLastFromChar = !messages.slice(i + 1).some(
                (x) => x.role === 'assistant' && String(x.character_id) === String(m.character_id)
              );
              if (!isLastFromChar) return null;
              return (
                <div className="regen-row">
                  {m.truncated && <span className="truncated-hint">回复好像没说完，</span>}
                  <button className="btn secondary small" onClick={() => regenerateGroupTurn(m)} disabled={regenerating}>
                    {regenerating ? '生成中…' : '↻ 重新生成'}
                  </button>
                </div>
              );
            })()}
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
            <div className="bubble error-bubble">
              <Icon name="alert" size={16} /> {errorMsg}
              <button className="btn secondary small" style={{ marginLeft: 8 }} onClick={retrySend}>重试</button>
            </div>
          </div>
        )}
        {/* v1.20.5: 消息删除菜单 */}
        {msgMenu && (
          <div
            className="conv-menu-backdrop"
            onClick={() => setMsgMenu(null)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div
              className="conv-menu"
              style={{
                left: Math.min(msgMenu.x, window.innerWidth - 150),
                top: Math.min(msgMenu.y, window.innerHeight - 130),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="conv-menu-item danger" onClick={() => deleteMsg(msgMenu.id)}>
                删除这条消息
              </button>
            </div>
          </div>
        )}
        {/* v1.28.0: 粘性底部——上滑后显示"回到底部"悬浮按钮，流式中带新内容小圆点 */}
        {showScrollBtn && (
          <button className="scroll-bottom-btn" onClick={() => scrollToBottom(true)} aria-label="回到底部">
            <Icon name="chevronDown" size={20} />
            {sending && <span className="scroll-bottom-dot" />}
          </button>
        )}
      </div>

      <div className="composer">
        {!isGroup && suggestions.length > 0 && (
          <div className="suggestion-nudge">
            <div className="suggestion-text">
              检测到你想给「{character ? character.name : 'TA'}」加个设定：「{suggestions[0].proposed}」
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
            placeholder={
              isGroup
                  ? '在群里发消息…（@名字 可点名）'
                  : `给 ${character ? character.name : 'TA'} 发消息…`
            }
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <button className="send-btn" onClick={send} disabled={sending || !input.trim()} title="发送">
            <Icon name="send" size={18} />
          </button>
        </div>
        <div className="composer-hint">
          Enter 发送 · Shift+Enter 换行{isGroup ? ' · 一次最多 3 位角色回应' : ''}
          {billingMode === 'points' ? (
            <>
              {' · 积分模式'}
              {roundPoints > 0 && ` · 本轮 ${roundPoints} 积分`}
              {totalPoints > 0 && ` · 累计 ${totalPoints}`}
            </>
          ) : (
            <>
              {' · API 模式'}
              {roundUsage > 0 && ` · 本轮 ≈ ${fmtTokens(roundUsage)} tokens`}
              {totalUsage > 0 && ` · 累计 ≈ ${fmtTokens(totalUsage)}`}
            </>
          )}
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
          onMessagesCleared={() => setMessages([])}
          showToast={showToast}
        />
      )}
    </div>
  );
}
