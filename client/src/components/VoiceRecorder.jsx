// v1.26.0: 按住说话录音组件
import { useRef, useState, useEffect } from 'react';
import Icon from './icons.jsx';

// 录音最大时长 60s
const MAX_SECONDS = 60;

export default function VoiceRecorder({ onResult, disabled }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0); // 音量 0-1
  const mediaRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const startTsRef = useRef(0);

  // 清理
  useEffect(() => () => stopAll(), []);

  const stopAll = () => {
    clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch {}
    }
    if (mediaRef.current) {
      mediaRef.current.getTracks().forEach((t) => t.stop());
      mediaRef.current = null;
    }
    setRecording(false);
    setSeconds(0);
    setLevel(0);
  };

  const startRecording = async (e) => {
    if (e) e.preventDefault();
    if (disabled || recording) return;
    // 防抖：300ms 内重复按下忽略
    const now = Date.now();
    if (now - startTsRef.current < 300) return;
    startTsRef.current = now;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRef.current = stream;

      // 音量监测
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = { analyser, ctx };
      const data = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length / 255;
        setLevel(Math.min(1, avg * 2));
        rafRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        cancelAnimationFrame(rafRef.current);
        if (analyserRef.current) {
          try { analyserRef.current.ctx.close(); } catch {}
          analyserRef.current = null;
        }
        const blob = new Blob(chunksRef.current, { type: mime });
        const dur = (Date.now() - startTsRef.current) / 1000;
        // 太短（<0.5s）视为误触
        if (blob.size > 0 && dur >= 0.5) {
          const buf = await blob.arrayBuffer();
          const b64 = btoa(
            new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), '')
          );
          onResult && onResult({ audio: b64, mimeType: mime, duration: dur });
        }
        // 停止音轨
        if (mediaRef.current) {
          mediaRef.current.getTracks().forEach((t) => t.stop());
          mediaRef.current = null;
        }
        setRecording(false);
        setSeconds(0);
        setLevel(0);
      };
      rec.start();
      setRecording(true);
      setSeconds(0);

      // 计时 + 60s 自动截断
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) {
            clearInterval(timerRef.current);
            if (recorderRef.current && recorderRef.current.state !== 'inactive') {
              recorderRef.current.stop();
            }
            return MAX_SECONDS;
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      console.warn('[voice] 麦克风权限失败:', err);
      stopAll();
    }
  };

  const stopRecording = (e) => {
    if (e) e.preventDefault();
    clearInterval(timerRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  return (
    <>
      <button
        className={`mic-btn${recording ? ' recording' : ''}`}
        onPointerDown={startRecording}
        onPointerUp={stopRecording}
        onPointerLeave={recording ? stopRecording : undefined}
        onContextMenu={(e) => e.preventDefault()}
        disabled={disabled}
        title="按住说话"
      >
        <Icon name="mic" size={18} />
      </button>
      {recording && (
        <div className="recording-overlay">
          <div className="recording-box">
            <div className="recording-wave" style={{ '--level': level }}>
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="recording-time">{seconds}s / {MAX_SECONDS}s</div>
            <div className="recording-tip">松开发送 · 上滑取消</div>
          </div>
        </div>
      )}
    </>
  );
}
