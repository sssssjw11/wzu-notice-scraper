import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCheck,
  Globe2,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import './official.css';

const STATUS = {
  not_checked: { label: '待检查', className: 'idle' },
  ok: { label: '正常', className: 'ok' },
  empty: { label: '暂无公告', className: 'idle' },
  auth_required: { label: '需认证', className: 'warn' },
  partial: { label: '部分可用', className: 'warn' },
  error: { label: '检查失败', className: 'error' },
};

const RANGES = [
  { id: '7', label: '近 7 天' },
  { id: '30', label: '近 30 天' },
  { id: 'all', label: '全部' },
];

function shortTime(value) {
  return value ? value.replace('T', ' ').slice(0, 16) : '未检查';
}

function dateFloor(days) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - days + 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || '操作失败');
  return data;
}

export default function OfficialMonitor() {
  const [overview, setOverview] = useState(null);
  const [selectedSource, setSelectedSource] = useState('all');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState('30');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = async (signal) => {
    try {
      const response = await fetch('/api/official/overview', { signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || '无法读取官网监测状态');
      setOverview(payload);
      setError('');
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => refresh(), overview?.scan?.running ? 2000 : 30000);
    return () => window.clearInterval(timer);
  }, [overview?.scan?.running]);

  const sources = overview?.sources || [];
  const summary = overview?.summary || {};
  const scan = overview?.scan || {};
  const currentSource = sources.find((source) => source.id === selectedSource);
  const currentUnread = currentSource ? currentSource.unread_count : summary.unread_count;
  const filteredNotices = useMemo(() => {
    const floor = range === 'all' ? '' : dateFloor(Number(range));
    const needle = query.trim().toLowerCase();
    return (overview?.notices || []).filter((notice) => {
      if (selectedSource !== 'all' && notice.source_id !== selectedSource) return false;
      if (unreadOnly && notice.read !== false) return false;
      if (floor && (notice.published_at || notice.first_seen?.slice(0, 10) || '') < floor) return false;
      if (needle && !`${notice.title} ${notice.source_name} ${notice.column}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [overview?.notices, selectedSource, unreadOnly, query, range]);

  const startScan = async (all = false) => {
    setBusy('scan');
    setError('');
    try {
      await postJson('/api/official/scan', all || selectedSource === 'all' ? {} : { source_ids: [selectedSource] });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const setRead = async (notice, read) => {
    const key = notice ? notice.url : 'all';
    setBusy(key);
    setError('');
    try {
      await postJson('/api/official/read', {
        ...(selectedSource !== 'all' && !notice ? { source_id: selectedSource } : {}),
        ...(notice ? { source_id: notice.source_id, url: notice.url } : {}),
        read,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const setIntervalHours = async (hours) => {
    setBusy('interval');
    try {
      await postJson('/api/official/settings', { auto_interval_hours: Number(hours) });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <header className="topbar official-topbar">
        <div className="group-context">
          <div className="context-icon"><Globe2 size={18} /></div>
          <div><span className="context-label">公开来源</span><strong>温州大学 · 学院官网</strong></div>
        </div>
        <div className="topbar-actions">
          <label className="official-interval-label" htmlFor="official-interval">自动检查</label>
          <select id="official-interval" className="official-interval" value={summary.auto_interval_hours ?? 12} onChange={(event) => setIntervalHours(event.target.value)} disabled={busy === 'interval'}>
            <option value={0}>关闭</option>
            <option value={6}>每 6 小时</option>
            <option value={12}>每 12 小时</option>
            <option value={24}>每 24 小时</option>
          </select>
          <button className="button button-primary" onClick={() => startScan(true)} disabled={scan.running || busy === 'scan'}>
            {scan.running || busy === 'scan' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
            {scan.running ? '检查中' : '检查全部'}
          </button>
        </div>
      </header>

      <section className="page-heading official-heading">
        <div>
          <p className="eyebrow">OFFICIAL SOURCES / 02</p>
          <h1>学院官网监测</h1>
          <p className="heading-subtitle">上次全量检查 {shortTime(summary.last_full_scan_at)}</p>
        </div>
        <a className="official-catalog-link" href={overview?.catalog_url || 'https://www.wzu.edu.cn/xxgk/xysz.htm'} target="_blank" rel="noopener noreferrer">
          官方学院名录 <ArrowUpRight size={16} />
        </a>
      </section>

      {error && <div className="error-banner official-error"><AlertTriangle size={16} /><span>{error}</span><button className="icon-button small" title="关闭" onClick={() => setError('')}><X size={14} /></button></div>}
      {scan.error && <div className="error-banner official-error"><AlertTriangle size={16} /><span>{scan.error}</span></div>}

      {scan.running && (
        <section className="official-progress" aria-live="polite">
          <div><strong>正在检查 {scan.current || '学院站点'}</strong><span>{scan.done || 0} / {scan.total || 0} · 失败 {scan.failed || 0}</span></div>
          <div className="official-progress-track"><span style={{ width: `${scan.total ? (scan.done / scan.total) * 100 : 0}%` }} /></div>
        </section>
      )}

      <div className="official-summarybar">
        <span><strong>{summary.checked_count || 0} / {summary.source_count || 0}</strong> 学院已检查</span>
        <span className="official-summary-unread"><strong>{summary.unread_count || 0}</strong> 条未读</span>
        <span><strong>{summary.error_count || 0}</strong> 个来源需关注</span>
      </div>

      <div className="official-workspace">
        <aside className="official-sources" aria-label="学院来源">
          <div className="official-panel-head"><h2>来源</h2><span>{sources.length} 个学院</span></div>
          <div className="official-source-scroll">
            <button className={'official-source ' + (selectedSource === 'all' ? 'active' : '')} onClick={() => setSelectedSource('all')}>
              <span className="official-source-main"><strong>全部学院</strong><small>聚合公告</small></span>
              <b>{summary.unread_count || 0}</b>
            </button>
            {sources.map((source, index) => (
              <button key={source.id} className={'official-source ' + (selectedSource === source.id ? 'active' : '')} onClick={() => setSelectedSource(source.id)} title={source.error || source.name}>
                <span className="official-source-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="official-source-main"><strong>{source.name}</strong><small><i className={'official-status-dot ' + (STATUS[source.status]?.className || 'idle')} />{STATUS[source.status]?.label || source.status} · {source.notice_count} 条</small></span>
                {source.unread_count > 0 && <b>{source.unread_count}</b>}
              </button>
            ))}
          </div>
        </aside>

        <section className="official-feed" aria-label="学院公告">
          <div className="official-feed-head">
            <div><h2>{currentSource?.name || '全部学院公告'}</h2><span>{currentSource ? `${STATUS[currentSource.status]?.label || ''} · 上次检查 ${shortTime(currentSource.checked_at)}` : `${filteredNotices.length} 条匹配公告`}</span></div>
            <div className="official-feed-actions">
              {currentSource && <a href={currentSource.list_url || currentSource.home} target="_blank" rel="noopener noreferrer" className="official-source-link" title="打开学院官网"><ArrowUpRight size={16} /></a>}
              <button className="icon-button" title={currentSource ? '检查当前学院' : '检查全部学院'} onClick={() => startScan(false)} disabled={scan.running || busy === 'scan'}><RefreshCw size={16} className={scan.running ? 'spin' : ''} /></button>
            </div>
          </div>

          {currentSource?.error && <div className="official-source-error"><AlertTriangle size={15} /> {currentSource.error}</div>}

          <div className="official-filterbar">
            <div className="official-range" role="group" aria-label="发布日期范围">
              {RANGES.map((option) => <button key={option.id} className={range === option.id ? 'active' : ''} onClick={() => setRange(option.id)}>{option.label}</button>)}
            </div>
            <div className="official-search"><Search size={15} /><input aria-label="搜索学院公告" placeholder="搜索标题、学院或栏目" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button title="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}</div>
            <label className="official-unread-toggle"><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />未读</label>
            <button className="official-mark-all" onClick={() => setRead(null, true)} disabled={!currentUnread || busy === 'all'} title="将当前来源的公告全部标记已读"><CheckCheck size={16} /> 全部已读</button>
          </div>

          <div className="official-feed-columns"><span>发布日期</span><span>学院 / 栏目</span><span>公告标题</span><span>状态</span></div>
          <div className="official-feed-scroll">
            {filteredNotices.map((notice) => (
              <div className={'official-notice ' + (notice.read === false ? 'unread' : '')} key={`${notice.source_id}:${notice.url}`}>
                <time>{notice.published_at || '日期待核'}</time>
                <div className="official-notice-origin"><strong>{notice.source_name}</strong><small>{notice.column || '公告'}</small></div>
                <a href={notice.url} target="_blank" rel="noopener noreferrer" title={notice.title} onClick={() => { if (notice.read === false) setRead(notice, true); }}>{notice.title}<ArrowUpRight size={14} /></a>
                <button title={notice.read === false ? '标记已读' : '标记未读'} aria-label={`${notice.read === false ? '标记已读' : '标记未读'}：${notice.title}`} onClick={() => setRead(notice, notice.read === false)} disabled={busy === notice.url}>
                  {notice.read === false ? <Check size={16} /> : <RotateCcw size={15} />}
                </button>
              </div>
            ))}
            {!filteredNotices.length && (
              <div className="official-empty">
                <Globe2 size={26} strokeWidth={1.5} />
                <h3>{!summary.checked_count ? '尚未检查学院官网' : '没有匹配的公告'}</h3>
                {!summary.checked_count && <button className="button button-primary" onClick={() => startScan(true)} disabled={scan.running}>检查全部学院</button>}
                {summary.checked_count > 0 && (query || unreadOnly || range !== 'all') && <button className="button button-quiet" onClick={() => { setQuery(''); setUnreadOnly(false); setRange('all'); }}>清除筛选</button>}
              </div>
            )}
          </div>
          <div className="official-feed-footer"><span>显示 {filteredNotices.length} 条 · 仅保存公开页面的标题与链接</span></div>
        </section>
      </div>
    </>
  );
}
