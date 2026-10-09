// v1.26.0: 语音设置（音色/语速/自动播放）
import { useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import { VOICE_LIST } from './VoicePicker.jsx';

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

  const update = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveVoiceSettings(next);
  };

  const testVoice = async () => {
    setTesting(true);
    try {
      const v = VOICE_LIST.find((x) => x.id === settings.voice);
      const r = await api.voiceTts({
        text: v ? v.preview : '你好，我是你的专属助手，很高兴为你服务。',
        voice: settings.voice,
        speed: settings.speed,
        forceAll: true,
      });
      if (!r.skipped && r.audio) {
        const audio = new Audio(`data:audio/mp3;base64,${r.audio}`);
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
              value={settings.voice}
              onChange={(e) => update({ voice: e.target.value })}
            >
              {VOICE_LIST.map((v) => (
                <option key={v.id} value={v.id}>{v.name}（{v.desc}）</option>
              ))}
            </select>
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
