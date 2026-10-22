// Serialize writes: a response may acknowledge an older edit, never a newer one.
export class CanvasPersistence {
  constructor({ revision, read, write, onState, backup, delay = 1200 }) {
    Object.assign(this, { revision, read, write, onState, backup, delay });
    this.sequence = 0; this.saved = 0; this.timer = null; this.pending = null; this.blocked = false;
  }
  changed() {
    this.sequence++;
    try { this.backup?.(this.read()); } catch { /* Memory snapshot remains available for export. */ }
    this.onState('unsaved');
    clearTimeout(this.timer);
    if (!this.blocked) this.timer = setTimeout(()=>this.flush().catch(()=>{}), this.delay);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.pending) { await this.pending; return this.flush(); }
    if (this.blocked) throw new Error('请先处理画板版本冲突');
    if (this.saved === this.sequence) return;
    const sequence = this.sequence, data = this.read();
    this.onState('saving');
    this.pending = this.write({ ...data, expectedRevision: this.revision }).then(result=>{
      this.revision = result.revision; this.saved = sequence;
      this.onState(this.saved === this.sequence ? 'saved' : 'unsaved');
    }).catch(error=>{
      if (error.status === 409) this.blocked = true;
      this.onState(this.blocked ? 'conflict' : 'error', error);
      throw error;
    }).finally(()=>{ this.pending = null; });
    await this.pending;
    if (this.saved !== this.sequence) return this.flush();
  }
  dispose() { clearTimeout(this.timer); }
}
