// v0.2.0: 资产库——所有生成图聚合浏览 / 筛选 / 批量删除
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';

const LIMIT = 48;
const imgUrl = (p) => (p ? `/${p}` : '');

function AssetDetail({ asset, onClose, onChanged, showToast }) {
  const [busy, setBusy] = useState(false);
  const doRate = async (rating) => {
    setBusy(true);
    try {
      await api.studio.rate(asset.id, rating);
      showToast(rating === 'liked' ? '已选用' : '已删除');
      onChanged();
      onClose();
    } catch (e) {
      showToast(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const replicate = async () => {
    setBusy(true);
    try {
      await api.studio.generate(asset.template_id, { seed: asset.seed });
      showToast('已复刻，可去设计台查看');
      onClose();
    } catch (e) {
      showToast(e.message || '复刻失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box studio-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{asset.template_name || '未知模板'}</span>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="asset-detail">
          <img src={imgUrl(asset.image_path)} alt="" />
          <div className="asset-meta">
            <div>操作：{asset.op}</div>
            <div>模型：{asset.model_id} · 尺寸：{asset.size} · seed：{asset.seed}</div>
            <div>评价：{asset.user_rating === 'liked' ? '已选用' : asset.user_rating === 'deleted' ? '已删除' : '未评价'}</div>
            {asset.prompt_snapshot && <div className="dim">prompt：{asset.prompt_snapshot.slice(0, 200)}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn secondary" disabled={busy} onClick={() => doRate('liked')}>选用</button>
          <button className="btn danger" disabled={busy} onClick={() => doRate('deleted')}>删除</button>
          <button className="btn primary" disabled={busy} onClick={replicate}>复刻</button>
        </div>
      </div>
    </div>
  );
}

export default function AssetView({ showToast, onOpenSidebar }) {
  const [assets, setAssets] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [templates, setTemplates] = useState([]);
  const [tplFilter, setTplFilter] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [selected, setSelected] = useState([]);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (pg = page) => {
    try {
      const r = await api.studio.assets({ template_id: tplFilter || undefined, rating: ratingFilter || undefined, page: pg, limit: LIMIT });
      setAssets(r.assets || []);
      setTotal(r.total || 0);
      setPage(r.page || 1);
      setSelected([]);
    } catch (e) {
      showToast(e.message || '加载失败');
    }
  }, [page, tplFilter, ratingFilter, showToast]);

  useEffect(() => {
    api.studio.listTemplates().then((r) => setTemplates(r.templates || [])).catch(() => {});
  }, []);
  useEffect(() => { load(1); }, [tplFilter, ratingFilter]);

  const toggleSelect = (id) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const toggleAll = () => {
    setSelected((s) => (s.length === assets.length ? [] : assets.map((a) => a.id)));
  };
  const bulkDelete = async () => {
    if (selected.length === 0 || busy) return;
    if (!window.confirm(`确定删除选中的 ${selected.length} 张吗？`)) return;
    setBusy(true);
    try {
      const r = await api.studio.bulkDelete(selected);
      showToast(`已删除 ${r.deleted} 张`);
      await load();
    } catch (e) {
      showToast(e.message || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="studio-view">
      <div className="studio-head">
        <div className="studio-head-left">
          <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
            <Icon name="menu" size={22} />
          </button>
          <h2>资产库 <span className="dim" style={{ fontSize: 13, fontWeight: 400 }}>共 {total} 张</span></h2>
        </div>
        {selected.length > 0 && (
          <button className="btn danger" disabled={busy} onClick={bulkDelete}>
            删除选中（{selected.length}）
          </button>
        )}
      </div>
      <div className="asset-filters">
        <select className="text-input" value={tplFilter} onChange={(e) => setTplFilter(e.target.value)}>
          <option value="">全部模板</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="text-input" value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value)}>
          <option value="">全部评价</option>
          <option value="liked">已选用</option>
          <option value="unrated">未评价</option>
          <option value="deleted">已删除</option>
        </select>
        {assets.length > 0 && (
          <button className="btn secondary small" onClick={toggleAll}>
            {selected.length === assets.length ? '取消全选' : '全选'}
          </button>
        )}
      </div>
      {assets.length === 0 ? (
        <div className="studio-empty">
          <Icon name="sparkles" size={40} />
          <p>还没有资产</p>
          <p className="dim">去设计台生成第一张图吧</p>
        </div>
      ) : (
        <div className="studio-grid">
          {assets.map((a) => (
            <div key={a.id} className="studio-card asset-card" onClick={() => setDetail(a)}>
              <div className="studio-card-cover">
                {a.thumb_path || a.image_path ? (
                  <img src={imgUrl(a.thumb_path || a.image_path)} alt="" loading="lazy" />
                ) : (
                  <div className="studio-card-nocover"><span className="dim">已删</span></div>
                )}
                <button
                  className={`asset-check${selected.includes(a.id) ? ' on' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleSelect(a.id); }}
                >
                  {selected.includes(a.id) ? '✓' : ''}
                </button>
                {a.user_rating === 'liked' && <span className="rated liked">♥</span>}
              </div>
              <div className="studio-card-body">
                <div className="studio-card-name">{a.template_name || '未知模板'}</div>
                <div className="studio-card-tags">
                  <span className="tag">{a.op}</span>
                  <span className="tag dim">{a.size}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="asset-pager">
          <button className="btn secondary small" disabled={page <= 1} onClick={() => load(page - 1)}>上一页</button>
          <span className="dim">{page} / {pages}</span>
          <button className="btn secondary small" disabled={page >= pages} onClick={() => load(page + 1)}>下一页</button>
        </div>
      )}
      {detail && (
        <AssetDetail asset={detail} onClose={() => setDetail(null)} onChanged={() => load(page)} showToast={showToast} />
      )}
    </div>
  );
}
