// v1.26.0: 语音设置（音色/语速/自动播放）
import { useState, useEffect } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import { useBuiltinVoices } from './VoicePicker.jsx';

const SPEEDS = [0.8, 1.0, 1.2, 1.5];

export function getVoiceSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('voice_settings') || '{}');
    return {
      voice: s.voice || 'Cherry',
      speed: s.speed || 1.0,
      autoplay: s.autoplay || false,
    };
  } catch {
    return { voice: 'Cherry', speed: 1.0, autoplay: false };
  }
}

export function saveVoiceSettings(s) {
  localStorage.setItem('voice_settings', JSON.stringify(s));
}

export default function VoiceSettings({ onClose }) {
  const [settings, setSettings] = useState(getVoiceSettings);
  const [testing, setTesting] = useState(false);
  // v1.29.2: 默认音色下拉动态拉取内置音色
  const builtinVoices = useBuiltinVoices();
  const voiceOptions = builtinVoices || [];
  // v1.29.2: 保存的音色不在当前列表里时，自动纠正为第一个并持久化
  useEffect(() => {
    if (builtinVoices && builtinVoices.length > 0 && !builtinVoices.some((v) => v.id === settings.voice)) {
      update({ voice: builtinVoices[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtinVoices]);
  // 保存的音色不在当前列表里时，回退到第一个
  const effectiveVoice = voiceOptions.some((v) => v.id === settings.voice)
    ? settings.voice
    : (voiceOptions[0] ? voiceOptions[0].id : settings.voice);

  const update = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveVoiceSettings(next);
  };

  const testVoice = async () => {
    setTesting(true);
    try {
      const v = voiceOptions.find((x) => x.id === effectiveVoice);
      const r = await api.voiceTts({
        text: v ? v.preview : '你好，我是你的专属助手，很高兴为你服务。',
        voice: effectiveVoice,
        speed: settings.speed,
        forceAll: true,
      });
      if (!r.skipped && r.audioUrl) {
        // v1.29.12: 用 HTTP 接口播（替代 data URL）
        const audio = new Audio(r.audioUrl);
        audio.onended = () => setTesting(false);
        audio.onerror = () => setTesting(false);
        await audio.play();
      } else {
        setTesting(false);
      }
    } catch {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>语音设置</h3>
          <button className="btn secondary small" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>默认音色（角色没单独设置时用这个）</label>
            <select
              value={effectiveVoice}
              onChange={(e) => update({ voice: e.target.value })}
            >
              {builtinVoices === null && (
                <option value="">加载中…</option>
              )}
              {voiceOptions.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.desc ? `（${v.desc}）` : ''}</option>
              ))}
            </select>
            {builtinVoices !== null && voiceOptions.length === 0 && (
              <p className="key-desc small">暂无内置音色，请联系管理员在模型管理中上传。</p>
            )}
          </div>
          <div className="form-group">
            <label>语速：{settings.speed}x</label>
            <div className="speed-row">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`btn small${settings.speed === s ? ' primary' : ' secondary'}`}
                  onClick={() => update({ speed: s })}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.autoplay}
                onChange={(e) => update({ autoplay: e.target.checked })}
              />
              AI 回复后自动朗读
            </label>
          </div>
          <button
            className="btn secondary"
            onClick={testVoice}
            disabled={testing}
          >
            {testing ? '试听中…' : '试听音色'}
          </button>
          <p className="form-hint">语音朗读时只播放角色对白部分，旁白会自动跳过。</p>
        </div>
      </div>
    </div>
  );
}
