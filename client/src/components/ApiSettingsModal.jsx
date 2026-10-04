// 全局 API 设置（用户级）：API 地址 / Key / 聊天模型 / 后台模型。
// 单用户模式：配置只存本浏览器 localStorage，对所有角色生效；后端只透传、不存储。
// 多用户模式：四个字段都存服务器（key 加密，永不回显明文），随账号走、换设备不丢；
//   前端不发任何配置头，会话即身份。保存=合并（key 留空=保持原值），"清除"按钮=清空全部。
import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import {
  api,
  getApiConfig,
  setApiConfig,
  clearApiConfig,
  fetchModels,
  DEFAULT_BASE_URL,
} from '../api.js';

const EMPTY_FORM = { baseUrl: '', key: '', model: '', workerModel: '' };

export default function ApiSettingsModal({ onClose, showToast }) {
  const { multiUser } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [version, setVersion] = useState('');
  // 多用户模式：服务器端配置状态
  const [hasServerKey, setHasServerKey] = useState(false);
  const [serverLoading, setServerLoading] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => setVersion((c && c.version) || '')).catch(() => {});
    if (multiUser) {
      // 多用户模式：从服务器回填（key 永不回显）；失败则保持空表单
      setServerLoading(true);
      api
        .getUserApiKey()
        .then((d) => {
          setForm({
            baseUrl: (d && d.baseUrl) || '',
            key: '',
            model: (d && d.chatModel) || '',
            workerModel: (d && d.workerModel) || '',
          });
          setHasServerKey(!!(d && d.hasKey));
        })
        .catch(() => {
          showToast('读取服务器配置失败，请检查网络后重试', 2600);
        })
        .finally(() => setServerLoading(false));
    } else {
      setForm(getApiConfig());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiUser]);

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // 用当前输入的 key / 地址动态拉取可用模型
  // 多用户模式：key 输入框可留空，此时用服务器已保存的 key 拉取
  const pullModels = async () => {
    const key = form.key.trim();
    if (!key && !multiUser) {
      showToast('请先填写 API Key', 2000);
      return;
    }
    if (!key && multiUser && !hasServerKey) {
      showToast('请先填写并保存 API Key', 2000);
      return;
    }
    setLoading(true);
    try {
      const base = multiUser ? form.baseUrl.trim() : form.baseUrl.trim() || DEFAULT_BASE_URL;
      const list = await fetchModels(base, key);
      setModels(list);
      showToast(
        list.length ? `已拉取 ${list.length} 个可用模型` : '拉取成功，但列表为空（可手动输入模型名）',
        2200
      );
    } catch (e) {
      showToast((e && e.message) || '拉取失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (multiUser) {
      // 多用户模式：保存到服务器（合并语义：key 留空=保持原值，其余字段按表单原样存，
      // 清空某字段=恢复服务器默认）。不写 localStorage。
      const key = form.key.trim();
      if (!key && !hasServerKey) {
        showToast('请填写 API Key', 2000);
        return;
      }
      const payload = {
        baseUrl: form.baseUrl.trim(),
        chatModel: form.model.trim(),
        workerModel: form.workerModel.trim(),
      };
      if (key) payload.key = key; // 留空则不传，后端保持原值
      setLoading(true);
      try {
        const d = await api.saveUserApiKey(payload);
        setHasServerKey(!!(d && d.hasKey)); // 以服务器返回为准
        setForm((f) => ({ ...f, key: '' }));
        window.dispatchEvent(new Event('soulchat-server-key-changed'));
        showToast('API 配置已保存到服务器，换设备也生效', 2200);
        onClose();
      } catch (e) {
        showToast((e && e.message) || '保存失败', 2600);
      } finally {
        setLoading(false);
      }
      return;
    }
    // 单用户模式：原有 localStorage 逻辑不变
    if (!form.key.trim()) {
      showToast('请填写 API Key', 2000);
      return;
    }
    setApiConfig({
      baseUrl: form.baseUrl.trim(),
      key: form.key.trim(),
      model: form.model.trim(),
      workerModel: form.workerModel.trim(),
    });
    showToast('API 配置已保存到本浏览器', 2200);
    onClose();
  };

  const clear = () => {
    clearApiConfig();
    setForm({ baseUrl: '', key: '', model: '', workerModel: '' });
    setModels([]);
    showToast('已清除本浏览器的 API 配置', 2000);
  };

  // 多用户模式：清除服务器上保存的全部配置（含 Key），需二次确认
  const clearServer = async () => {
    if (
      !window.confirm('确定清除服务器上保存的 API 配置吗？\nKey 也会被删除，之后聊天需要重新填写。')
    ) {
      return;
    }
    setLoading(true);
    try {
      await api.saveUserApiKey({ key: '', baseUrl: '', chatModel: '', workerModel: '' });
      setForm({ baseUrl: '', key: '', model: '', workerModel: '' });
      setHasServerKey(false);
      setModels([]);
      showToast('服务器配置已清除', 2000);
    } catch (e) {
      showToast((e && e.message) || '清除失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>API 设置</h3>
          <button className="modal-close" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        {multiUser ? (
          <p className="key-desc">
            用户级配置，保存在<b>服务器</b>（Key 加密存储，永不回显），随账号走，换设备也生效。
          </p>
        ) : (
          <p className="key-desc">
            用户级配置，保存在<b>本浏览器</b>，对所有角色生效。后端只透传、不存储、不记日志。
          </p>
        )}
        <label>
          API 地址
          <input
            value={form.baseUrl}
            onChange={setField('baseUrl')}
            placeholder={DEFAULT_BASE_URL}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {multiUser && (
          <div className="key-status-row">
            <span className="key-status-label">API Key</span>
            {serverLoading ? (
              <span className="key-none">读取中…</span>
            ) : hasServerKey ? (
              <span className="key-ok">已保存 ●</span>
            ) : (
              <span className="key-none">未保存</span>
            )}
          </div>
        )}
        <label>
          API Key
          <div className="key-input-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={form.key}
              onChange={setField('key')}
              placeholder={multiUser && hasServerKey ? '留空则保持已保存的 Key，填写则替换' : 'sk-or-v1-…'}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn secondary" onClick={() => setShowKey((s) => !s)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </label>
        <label>
          聊天模型
          <div className="key-input-row">
            <input
              list="soulchat-models"
              value={form.model}
              onChange={setField('model')}
              placeholder="先拉取模型列表，或手动输入"
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn secondary" onClick={pullModels} disabled={loading}>
              {loading ? '拉取中…' : '拉取模型'}
            </button>
          </div>
          <datalist id="soulchat-models">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </datalist>
        </label>
        {models.length > 0 && (
          <p className="key-desc small">共 {models.length} 个可用模型，可在输入框中搜索选择。</p>
        )}
        <label>
          后台模型
          <input
            list="soulchat-models"
            value={form.workerModel || ''}
            onChange={setField('workerModel')}
            placeholder="留空用默认便宜模型"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <p className="key-desc small">
          后台模型负责群聊导演调度、记忆提取、对话摘要——用户看不到，用便宜的就行。
          留空则用服务器默认（DeepSeek）。
        </p>
        <p className="key-desc small">
          兼容 OpenAI 格式的接口都可填（如 OpenRouter）。Key 在 openrouter.ai 的 Keys 页面创建，
          不要发给任何人。
        </p>
        {version && <p className="key-desc small version-line">SoulChat v{version}</p>}
        <div className="modal-actions">
          {multiUser ? (
            <button className="btn secondary" onClick={clearServer} disabled={loading}>
              清除
            </button>
          ) : (
            <button className="btn secondary" onClick={clear}>
              清除
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={loading}>
            {loading ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
