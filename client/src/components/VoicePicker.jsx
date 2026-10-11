// v1.26.0: 音色选择器（新建角色 / 角色设置共用，对标 AvatarPicker）
// 每个音色配符合气质的试听文案
import { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';

// v1.29.2: 系统内置音色全部动态拉取（管理员在模型管理里维护），不再硬编码
// 返回 null=加载中，[]=空（管理员尚未上传）
export function useBuiltinVoices() {
  const [voices, setVoices] = useState(null);
  useEffect(() => {
    api.getBuiltinVoices().then((r) => {
      const list = (r && r.voices) || [];
      setVoices(list.map((v) => ({
        id: v.voice_id,
        name: v.name,
        desc: v.description || '',
        gender: v.gender || '',
        preview: v.preview || `你好，我是${v.name}。`,
        has_audio: !!v.has_audio,
      })));
    }).catch(() => setVoices([]));
  }, []);
  return voices;
}

export default function VoicePicker({ value, onChange }) {
  const [testingId, setTestingId] = useState(null);
  const [testError, setTestError] = useState('');
  const [customVoices, setCustomVoices] = useState([]);
  const [designOpen, setDesignOpen] = useState(false);
  const audioRef = useRef(null);
  // v1.29.2: 内置音色动态拉取（null=加载中）
  const builtinVoices = useBuiltinVoices();

  // 拉取用户定制音色
  useEffect(() => {
    api.listCustomVoices().then(setCustomVoices).catch(() => {});
  }, []);

  // v1.29.7: 内置音色试听直接播参考原音（不调 TTS 接口，省积分）；定制音色走 TTS
  const testVoice = async (v, isCustom) => {
    // 正在试听同一个 → 停止
    if (testingId === v.id) {
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch {}
      }
      setTestingId(null);
      return;
    }
    setTestingId(v.id);
    setTestError('');
    try {
      let audio;
      if (!isCustom && v.has_audio) {
        audio = new Audio(api.builtinAudioUrl(v.name));
      } else {
        const r = await api.voiceTts({
          text: isCustom ? '你好，我是你的专属定制音色，很高兴为你服务。' : v.preview,
          voice: v.id, // 定制音色传 custom_voices.id，后端解析
          speed: 1.0,
          forceAll: true,
        });
        if (r.skipped || !r.audio) {
          setTestingId(null);
          return;
        }
        audio = new Audio(`data:audio/mp3;base64,${r.audio}`);
      }
      audioRef.current = audio;
      audio.onended = () => setTestingId(null);
      audio.onerror = () => { setTestingId(null); setTestError('音频播放失败'); };
      await audio.play();
    } catch (e) {
      setTestingId(null);
      // v1.29.4: 试听失败显示具体错误，不再静默
      setTestError(`「${v.name}」试听失败：${(e && e.message) || '未知错误'}`);
    }
  };

  return (
    <div>
      <div className="voice-grid">
        {builtinVoices === null && (
          <div className="key-desc small" style={{ padding: 12 }}>音色加载中…</div>
        )}
        {builtinVoices !== null && builtinVoices.length === 0 && customVoices.length === 0 && (
          <div className="key-desc small" style={{ padding: 12 }}>暂无内置音色，请联系管理员在模型管理中上传。</div>
        )}
        {(builtinVoices || []).map((v) => (
          <div
            key={v.id}
            className={`voice-option${value === v.id ? ' selected' : ''}`}
          >
            <button
              type="button"
              className="voice-option-main"
              onClick={() => onChange(v.id)}
              title={`选择${v.name}`}
            >
              <span className="voice-name">{v.name}</span>
              <span className="voice-desc">{v.desc}</span>
            </button>
            <button
              type="button"
              className={`voice-test${testingId === v.id ? ' testing' : ''}`}
              onClick={() => testVoice(v, false)}
              title="试听"
            >
              <Icon name={testingId === v.id ? 'stop' : 'volume'} size={14} />
            </button>
          </div>
        ))}
        {/* 用户定制音色 */}
        {customVoices.map((v) => (
          <div
            key={`custom-${v.id}`}
            className={`voice-option custom${value === v.id ? ' selected' : ''}`}
          >
            <button
              type="button"
              className="voice-option-main"
              onClick={() => onChange(v.id)}
              title={`选择${v.name}（定制）`}
            >
              <span className="voice-name">{v.name}</span>
              <span className="voice-desc">定制音色</span>
            </button>
            <button
              type="button"
              className={`voice-test${testingId === v.id ? ' testing' : ''}`}
              onClick={() => testVoice(v, true)}
              title="试听"
            >
              <Icon name={testingId === v.id ? 'stop' : 'volume'} size={14} />
            </button>
          </div>
        ))}
      </div>
      {testError && (
        <div className="test-result fail" style={{ marginTop: 8 }}>{testError}</div>
      )}
      {/* 定制音色入口 */}
      <button
        type="button"
        className="btn secondary small voice-design-btn"
        onClick={() => setDesignOpen(true)}
      >
        <Icon name="plus" size={14} /> 定制音色（20 积分/次）
      </button>
      {designOpen && (
        <VoiceDesignModal
          onClose={() => setDesignOpen(false)}
          onCreated={(v) => {
            setCustomVoices((list) => [v, ...list]);
            onChange(v.id);
            setDesignOpen(false);
          }}
        />
      )}
    </div>
  );
}

// 定制音色弹窗
function VoiceDesignModal({ onClose, onCreated }) {
  const [mode, setMode] = useState('design'); // 'design' | 'clone'
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [audioBase64, setAudioBase64] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      setError('文件过大（限 10MB）');
      return;
    }
    setAudioFile(f);
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] || '';
      setAudioBase64(b64);
    };
    reader.readAsDataURL(f);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('请给音色起个名字');
      return;
    }
    if (mode === 'design' && !prompt.trim()) {
      setError('请描述想要的音色');
      return;
    }
    if (mode === 'clone' && !audioBase64) {
      setError('请上传参考音频');
      return;
    }
    setCreating(true);
    setError('');
    try {
      let r;
      if (mode === 'clone') {
        r = await api.voiceClone({
          name: name.trim(),
          audio: audioBase64,
          mimeType: audioFile.type || 'audio/wav',
        });
      } else {
        r = await api.voiceDesign({
          name: name.trim(),
          prompt: prompt.trim(),
          previewText: '你好，我是你的专属定制音色，很高兴为你服务。',
        });
        // 试听生成的音色
        if (r.preview_audio) {
          const audio = new Audio(`data:audio/mp3;base64,${r.preview_audio}`);
          audio.play().catch(() => {});
        }
      }
      onCreated(r);
    } catch (e) {
      setError(e.message || '生成失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>定制音色</h3>
          <button className="btn secondary small" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          {/* v1.27.0: 描述生成 / 音频克隆 双模式 */}
          <div className="key-input-row" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`btn small ${mode === 'design' ? 'primary' : 'secondary'}`}
              onClick={() => setMode('design')}
            >
              描述生成
            </button>
            <button
              type="button"
              className={`btn small ${mode === 'clone' ? 'primary' : 'secondary'}`}
              onClick={() => setMode('clone')}
            >
              音频克隆
            </button>
          </div>
          <div className="form-group">
            <label>音色名字</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：温柔姐姐"
              maxLength={16}
            />
          </div>
          {mode === 'design' ? (
            <div className="form-group">
              <label>音色描述</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：一个温柔的年轻女性声音，略带沙哑，说话节奏缓慢，有知性美"
                rows={3}
                maxLength={500}
              />
            </div>
          ) : (
            <div className="form-group">
              <label>参考音频</label>
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileChange}
              />
              {audioFile && (
                <p className="form-hint">已选择：{audioFile.name}（{(audioFile.size / 1024).toFixed(0)} KB）</p>
              )}
              <p className="form-hint">15-60 秒清晰人声，无背景音乐，单人说话。克隆一次后永久使用 voice_id，不重复传音频。</p>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
          <p className="form-hint">每次生成消耗 20 积分。{mode === 'design' ? '描述越具体，生成的音色越贴合。' : '音频质量越好，克隆效果越像。'}</p>
          <button
            className="btn primary"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? '生成中…' : mode === 'clone' ? '克隆音色（20 积分）' : '生成音色（20 积分）'}
          </button>
        </div>
      </div>
    </div>
  );
}
