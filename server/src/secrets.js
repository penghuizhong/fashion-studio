// v0.2.0: AES-256-GCM 密钥托管（从 auth.js 抽离，零依赖，供 db/registry/image 复用）
// 存储格式：ivBase64:tagBase64:cipherBase64；空值存 NULL，解密空值返回 ''
import crypto from 'node:crypto';

export function encryptSecret(masterKeyHex, plaintext) {
  if (!plaintext) return null;
  const key = Buffer.from(masterKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(masterKeyHex, stored) {
  if (!stored) return '';
  const parts = String(stored).split(':');
  if (parts.length !== 3) return '';
  try {
    const key = Buffer.from(masterKeyHex, 'hex');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'));
    d.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// 前端展示用掩码：有值 → '••••••••'，无值 → ''
export function maskSecret(stored) {
  return stored ? '••••••••' : '';
}
