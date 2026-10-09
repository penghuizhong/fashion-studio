// v1.26.0: 音色选择器（新建角色 / 角色设置共用，对标 AvatarPicker）
// 每个音色配符合气质的试听文案
import { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';

export const VOICE_LIST = [
  {
    id: 'Cherry',
    name: '芊悦',
    desc: '阳光女声',
    gender: '女',
    preview: '你好呀！我是芊悦，今天也是元气满满的一天呢，一起加油吧！',
  },
  {
    id: 'Serena',
    name: '苏瑶',
    desc: '温柔女声',
    gender: '女',
    preview: '你好，我是苏瑶，很高兴能在这里与你相遇，愿我们相谈甚欢。',
  },
  {
    id: 'Chelsie',
    name: '千雪',
    desc: '二次元女友',
    gender: '女',
    preview: '呐呐，你终于来啦！人家等你好久了，今天想聊点什么呢？',
  },
  {
    id: 'Bella',
    name: '萌宝',
    desc: '可爱小女孩',
    gender: '女',
    preview: '大哥哥大姐姐好！我是萌宝，今年五岁，最喜欢吃糖糖啦！',
  },
  {
    id: 'Momo',
    name: '茉兔',
    desc: '俏皮可爱',
    gender: '女',
    preview: '嘿嘿，抓到你啦！我是茉兔，古灵精怪第一名！',
  },
  {
    id: 'Vivian',
    name: '十三',
    desc: '酷飒微辣',
    gender: '女',
    preview: '哟，来了？我是十三，有事说事，别磨磨唧唧的。',
  },
  {
    id: 'Katerina',
    name: '卡捷琳娜',
    desc: '成熟有气场',
    gender: '女',
    preview: '晚上好，我是卡捷琳娜。有什么心事，都可以慢慢跟我说。',
  },
  {
    id: 'Ethan',
    name: '晨煦',
    desc: '阳光男声',
    gender: '男',
    preview: '嘿！我是晨煦，要不要一起去冒险？青春就是要轰轰烈烈！',
  },
  {
    id: 'Moon',
    name: '月白',
    desc: '潇洒帅气',
    gender: '男',
    preview: '月色真美，我是月白。今晚的风很温柔，你也是。',
  },
  {
    id: 'Kai',
    name: '凯',
    desc: '治愈系男声',
    gender: '男',
    preview: '你好呀，我是凯。累了就歇一会儿，我在这里陪着你。',
  },
  {
    id: 'Nofish',
    name: '不吃鱼',
    desc: '设计师男声',
    gender: '男',
    preview: '你好，我是不吃鱼。设计和生活一样，都需要一点不将就的态度。',
  },
  {
    id: 'Ryan',
    name: '甜茶',
    desc: '戏剧张力男声',
    gender: '男',
    preview: '命运的齿轮开始转动——我是甜茶，准备好迎接这场大戏了吗？',
  },
];

export default function VoicePicker({ value, onChange }) {
  const [testingId, setTestingId] = useState(null);
  const [customVoices, setCustomVoices] = useState([]);
  const [designOpen, setDesignOpen] = useState(false);
  const audioRef = useRef(null);

  // 拉取用户定制音色
  useEffect(() => {
    api.listCustomVoices().then(setCustomVoices).catch(() => {});
  }, []);

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
    try {
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
      const audio = new Audio(`data:audio/mp3;base64,${r.audio}`);
      audioRef.current = audio;
      audio.onended = () => setTestingId(null);
      audio.onerror = () => setTestingId(null);
      await audio.play();
    } catch {
      setTestingId(null);
    }
  };

  return (
    <div>
      <div className="voice-grid">
        {VOICE_LIST.map((v) => (
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
