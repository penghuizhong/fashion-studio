// Keep only URL readiness metadata, never retain large decoded Image objects.
const ready = new Map(), LIMIT = 48, TTL = 5 * 60 * 1000;
export function previewIsReady(key) {
  const at = ready.get(key);
  if (!at || Date.now() - at > TTL) { ready.delete(key); return false; }
  ready.delete(key); ready.set(key, at); return true;
}
export function rememberPreview(key) {
  ready.delete(key); ready.set(key, Date.now());
  while (ready.size > LIMIT) ready.delete(ready.keys().next().value);
}
export function clearStudioPreviewCache() { ready.clear(); }
if (typeof window !== 'undefined') {
  window.addEventListener('soulchat-unauthorized', clearStudioPreviewCache);
  window.addEventListener('studio-images-changed', clearStudioPreviewCache);
}
