import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarRange,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Database,
  FileJson,
  Filter,
  Inbox,
  Layers3,
  LoaderCircle,
  MessageCircle,
  PanelRight,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  ShieldCheck,
  Users,
  Upload,
  X,
} from 'lucide-react';

const CATEGORY_LABELS = {
  course: '课程安排',
  assignment: '材料提交',
  exam: '考试测验',
  activity: '活动会议',
  admin: '行政手续',
  safety: '安全提醒',
  employment: '实习就业',
  resource: '资料资源',
  noise: '群聊噪声',
  other: '其他事项',
};

const RECORD_KIND_LABELS = {
  announcement: '公告事项',
  resource: '资料 / 技术分享',
  conversation: '普通对话',
  noise: '群聊噪声',
  other: '待确认事项',
};

const PRIORITY_META = {
  P0: { label: '马上处理', className: 'p0' },
  P1: { label: '近期处理', className: 'p1' },
  P2: { label: '排进日程', className: 'p2' },
  P3: { label: '留作参考', className: 'p3' },
};

const DEADLINE_META = {
  overdue: { label: '已超期', className: 'overdue' },
  due_today: { label: '今日截止', className: 'today' },
  near: { label: '临近', className: 'near' },
  ample: { label: '宽裕', className: 'ample' },
  unscheduled: { label: '未排期', className: 'unscheduled' },
  reference: { label: '日期参考', className: 'reference' },
  unknown: { label: '待确认', className: 'unknown' },
};

const ACTIVE_DEADLINE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'due_today', label: '今日截止' },
  { id: 'near', label: '临近 1–3 天' },
  { id: 'ample', label: '宽裕 4 天+' },
  { id: 'unscheduled', label: '未排期' },
];

const ARCHIVE_FILTERS = [
  { id: 'all', label: '全部归档' },
  { id: 'completed', label: '已完成' },
  { id: 'deadline_passed', label: '已超期' },
];

const defaultAsOf = formatDateInput(new Date());

const QUICK_RANGE_OPTIONS = [
  { id: 'day', label: '最近 1 天' },
  { id: 'week', label: '最近 7 天' },
  { id: 'calendar-week', label: '本周' },
  { id: 'all', label: '全部' },
];

function parseDateInput(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day);
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(value, offset) {
  const date = parseDateInput(value);
  date.setDate(date.getDate() + offset);
  return formatDateInput(date);
}

function getQuickRange(anchor, id) {
  if (id === 'day') return { from: anchor, to: anchor };
  if (id === 'week') return { from: shiftDate(anchor, -6), to: anchor };
  if (id === 'calendar-week') {
    const date = parseDateInput(anchor);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return { from: formatDateInput(date), to: anchor };
  }
  return { from: '', to: '' };
}

function formatRangeLabel(from, to) {
  if (from && to) return `${from} 至 ${to}`;
  if (from) return `${from} 起`;
  if (to) return `截至 ${to}`;
  return '完整归档';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatPercent(value) {
  return Math.round((value || 0) * 100) + '%';
}

function shortDate(value) {
  if (!value) return '未识别 DDL';
  if (value.includes('T')) return value.replace('T', ' ').slice(0, 16);
  return value;
}

function categoryLabel(value) {
  return CATEGORY_LABELS[value] || value || '未分类';
}

function recordKindLabel(value) {
  return RECORD_KIND_LABELS[value] || value || '未确认';
}

function itemTitle(item) {
  const text = item && item.preview ? item.preview : '未命名事项';
  return text.split(/\n|。|！|!/)[0].trim().slice(0, 58) || text.slice(0, 58);
}

function deadlineText(item) {
  const deadline = item && item.judgments && item.judgments.deadline && item.judgments.deadline.value;
  if (!deadline) return '没有明确 DDL';
  if (deadline.normalized) return shortDate(deadline.normalized);
  return deadline.raw ? '原文：' + deadline.raw.slice(0, 24) : '日期待复核';
}

function deadlineStatus(item) {
  const deadline = item && item.judgments && item.judgments.deadline && item.judgments.deadline.value;
  const decided = item && item.decision && item.decision.deadline_status;
  if (decided && decided !== 'upcoming') return decided;
  if (!deadline) return 'unscheduled';
  if (deadline.kind && deadline.kind !== 'deadline') return 'reference';
  const days = Number(deadline.days_from_as_of);
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 0) return 'overdue';
  if (days === 0) return 'due_today';
  if (days <= 3) return 'near';
  return 'ample';
}

function queueState(item) {
  return (item && item.decision && item.decision.queue_state) || (deadlineStatus(item) === 'overdue' ? 'archived' : 'active');
}

function archiveReason(item) {
  if (queueState(item) !== 'archived') return null;
  return (item && item.decision && item.decision.archive_reason) || 'deadline_passed';
}

function sortByQueueState(items) {
  const active = [];
  const completed = [];
  const overdue = [];
  items.forEach((item) => {
    if (queueState(item) === 'active') active.push(item);
    else if (archiveReason(item) === 'completed') completed.push(item);
    else overdue.push(item);
  });
  completed.sort((left, right) => String(right.decision.completed_at || '').localeCompare(String(left.decision.completed_at || '')));
  return [...active, ...completed, ...overdue];
}

function withItemDecision(result, key, decision) {
  if (!result) return result;
  const current = result.items.find((item) => item.item_key === key);
  if (!current) return result;
  const updated = { ...current, decision };
  const activeDelta = Number(queueState(updated) === 'active') - Number(queueState(current) === 'active');
  const completedDelta = Number(archiveReason(updated) === 'completed') - Number(archiveReason(current) === 'completed');
  const overdueDelta = Number(archiveReason(updated) === 'deadline_passed') - Number(archiveReason(current) === 'deadline_passed');
  const summary = result.summary || {};
  return {
    ...result,
    items: sortByQueueState(result.items.map((item) => item.item_key === key ? updated : item)),
    summary: {
      ...summary,
      active_count: Number(summary.active_count || 0) + activeDelta,
      archived_count: Number(summary.archived_count || 0) - activeDelta,
      completed_count: Number(summary.completed_count || 0) + completedDelta,
      overdue_count: Number(summary.overdue_count || 0) + overdueDelta,
      queue_state_counts: {
        ...summary.queue_state_counts,
        active: Number(summary.queue_state_counts?.active || 0) + activeDelta,
        archived: Number(summary.queue_state_counts?.archived || 0) - activeDelta,
      },
      archive_reason_counts: {
        ...summary.archive_reason_counts,
        completed: Number(summary.archive_reason_counts?.completed || 0) + completedDelta,
        deadline_passed: Number(summary.archive_reason_counts?.deadline_passed || 0) + overdueDelta,
      },
      needs_review_count: Number(summary.needs_review_count || 0) + (current.decision && current.decision.needs_review ? activeDelta : 0),
    },
  };
}

function deadlineRelativeText(item) {
  const deadline = item && item.judgments && item.judgments.deadline && item.judgments.deadline.value;
  const status = deadlineStatus(item);
  const days = deadline && Number(deadline.days_from_as_of);
  if (status === 'overdue' && Number.isFinite(days)) return `超期 ${Math.abs(days)} 天`;
  if (status === 'due_today') return '今天截止';
  if ((status === 'near' || status === 'ample') && Number.isFinite(days)) return `剩余 ${days} 天`;
  return (DEADLINE_META[status] || DEADLINE_META.unknown).label;
}

function matchesDeadlineFilter(item, filter) {
  const status = deadlineStatus(item);
  if (filter === 'all') return true;
  if (filter === 'unscheduled') return ['unscheduled', 'reference', 'unknown'].includes(status);
  return status === filter;
}

function confidence(item) {
  const values = Object.values((item && item.judgments) || {})
    .map((value) => Number(value && value.confidence))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getFilterCount(items, filter) {
  if (filter === 'all') return items.length;
  return items.filter((item) => item.decision && item.decision.priority === filter).length;
}

function DecisionRow({ label, type, value, confidence: score, tone = 'neutral' }) {
  return (
    <div className="decision-row">
      <div className="decision-name">
        <span className={'type-mark ' + tone}>{type}</span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <div className="confidence-track" aria-label={'置信度 ' + formatPercent(score)}>
        <span style={{ width: Math.max(4, Math.min(100, (score || 0) * 100)) + '%' }} />
      </div>
      <span className="confidence-value">{formatPercent(score)}</span>
    </div>
  );
}

function PriorityPill({ priority }) {
  const meta = PRIORITY_META[priority] || PRIORITY_META.P3;
  return <span className={'priority-pill ' + meta.className}>{priority}</span>;
}

function DeadlinePill({ item, compact = false, archived = false }) {
  const status = deadlineStatus(item);
  const meta = DEADLINE_META[status] || DEADLINE_META.unknown;
  return (
    <span className={'deadline-pill ' + meta.className + (archived ? ' archived-deadline' : '')} title={deadlineText(item)}>
      {compact ? meta.label : deadlineRelativeText(item)}
    </span>
  );
}

function ArchivePill({ item }) {
  const completed = archiveReason(item) === 'completed';
  return <span className={'archive-pill ' + (completed ? 'completed' : '')}>{completed ? '已完成' : '超期归档'}</span>;
}

function EmptyState({ onUpload }) {
  return (
    <div className="empty-state">
      <FileJson size={34} strokeWidth={1.4} />
      <h3>还没有载入群聊</h3>
      <p>选择一个导出的 messages.json，或者直接打开示例群聊。</p>
      <button className="button button-primary" onClick={onUpload}>
        <Upload size={16} /> 选择文件
      </button>
    </div>
  );
}

function RangeEmptyState({ dateRangeLabel, archiveCount, onReset, onOpenSettings }) {
  return (
    <section className="range-empty-state">
      <div className="range-empty-icon"><CalendarRange size={28} strokeWidth={1.5} /></div>
      <p className="eyebrow">NO MESSAGES IN RANGE</p>
      <h2>这个日期范围没有消息</h2>
      <p>当前选定的消息范围为 <strong>{dateRangeLabel}</strong>，没有可供分拣的聊天记录。完整归档共有 {formatNumber(archiveCount)} 条消息。</p>
      <div className="range-empty-actions">
        <button className="button button-primary" onClick={onReset}><RefreshCw size={16} /> 回到完整归档</button>
        <button className="button button-quiet" onClick={onOpenSettings}><SlidersHorizontal size={16} /> 调整范围</button>
      </div>
    </section>
  );
}

function App() {
  const [result, setResult] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [queueView, setQueueView] = useState('active');
  const [archiveFilter, setArchiveFilter] = useState('all');
  const [deadlineFilter, setDeadlineFilter] = useState('all');
  const [visibleCount, setVisibleCount] = useState(160);
  const [provider, setProvider] = useState('local');
  const [endpoint, setEndpoint] = useState('https://api.typesafe.ai/v1/systemone');
  const [model, setModel] = useState('jev-system-one');
  const [apiKey, setApiKey] = useState('');
  const [maxCandidates, setMaxCandidates] = useState('48');
  const [asOf, setAsOf] = useState(defaultAsOf);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [file, setFile] = useState(null);
  const [sourceMode, setSourceMode] = useState('file');
  const [wechatStatus, setWechatStatus] = useState(null);
  const [wechatGroups, setWechatGroups] = useState([]);
  const [wechatQuery, setWechatQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [resolveWechatFiles, setResolveWechatFiles] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [completionPending, setCompletionPending] = useState(() => new Set());
  const fileRef = useRef(null);

  const loadWechatGroups = async (query = wechatQuery, signal) => {
    setWechatLoading(true);
    setError('');
    try {
      const statusResponse = await fetch('/api/wechat/status', { signal });
      const statusPayload = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(statusPayload.detail || '无法读取微信状态');
      setWechatStatus(statusPayload);
      if (!statusPayload.ready) {
        setWechatGroups([]);
        return;
      }
      const groupsResponse = await fetch('/api/wechat/groups?q=' + encodeURIComponent(query || '') + '&limit=80', { signal });
      const groupsPayload = await groupsResponse.json();
      if (!groupsResponse.ok) throw new Error(groupsPayload.detail || '无法读取微信群列表');
      setWechatGroups(groupsPayload.groups || []);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      if (!signal || !signal.aborted) setWechatLoading(false);
    }
  };

  const loadSample = async (targetDate = asOf, targetFromDate = fromDate, targetToDate = toDate) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ as_of: targetDate });
      if (targetFromDate) params.set('from_date', targetFromDate);
      if (targetToDate) params.set('to_date', targetToDate);
      const response = await fetch('/api/sample?' + params.toString());
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || '示例加载失败');
      setResult(payload);
      setSelectedId(payload.items && payload.items.length ? payload.items[0].candidate_id : null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSample();
  }, []);

  useEffect(() => {
    if (!settingsOpen || sourceMode !== 'wechat') return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => loadWechatGroups(wechatQuery, controller.signal), 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [settingsOpen, sourceMode, wechatQuery]);

  const runAnalysis = async (overrides = {}) => {
    const effectiveAsOf = overrides.asOf ?? asOf;
    const effectiveFromDate = overrides.fromDate ?? fromDate;
    const effectiveToDate = overrides.toDate ?? toDate;
    setRunning(true);
    setError('');
    if (effectiveFromDate && effectiveToDate && effectiveFromDate > effectiveToDate) {
      setError('开始日期不能晚于结束日期');
      setRunning(false);
      return;
    }
    let request;
    if (sourceMode === 'wechat') {
      if (!selectedGroup) {
        setError('请先选择一个微信群');
        setRunning(false);
        return;
      }
      request = fetch('/api/wechat/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: selectedGroup.username,
          display_name: selectedGroup.display_name,
          provider,
          api_key: apiKey,
          endpoint,
          model,
          as_of: effectiveAsOf,
          from_date: effectiveFromDate,
          to_date: effectiveToDate,
          max_candidates: maxCandidates,
          resolve_files: resolveWechatFiles,
        }),
      });
    } else {
      const form = new FormData();
      if (file) {
        form.append('file', file);
        form.append('use_sample', 'false');
      } else {
        form.append('use_sample', 'true');
      }
      form.append('provider', provider);
      form.append('api_key', apiKey);
      form.append('endpoint', endpoint);
      form.append('model', model);
      form.append('as_of', effectiveAsOf);
      form.append('from_date', effectiveFromDate);
      form.append('to_date', effectiveToDate);
      form.append('max_candidates', maxCandidates);
      request = fetch('/api/analyze', { method: 'POST', body: form });
    }
    try {
      const response = await request;
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || '分拣失败');
      setResult(payload);
      setSelectedId(payload.items && payload.items.length ? payload.items[0].candidate_id : null);
      setFilter('all');
      setQueueView('active');
      setArchiveFilter('all');
      setDeadlineFilter('all');
      setReviewOnly(false);
      setCategoryFilter('all');
      setQuery('');
      setSettingsOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const rangeAnchor = (result && result.source && result.source.archive_end) || asOf || defaultAsOf;

  const applyQuickRange = (id) => {
    const nextRange = getQuickRange(rangeAnchor, id);
    setFromDate(nextRange.from);
    setToDate(nextRange.to);
    runAnalysis({ fromDate: nextRange.from, toDate: nextRange.to });
  };

  const activeItems = useMemo(
    () => ((result && result.items) || []).filter((item) => queueState(item) === 'active'),
    [result],
  );

  const archivedItems = useMemo(
    () => ((result && result.items) || []).filter((item) => queueState(item) === 'archived'),
    [result],
  );

  const deadlineScopedItems = useMemo(
    () => (queueView === 'archive'
      ? archivedItems.filter((item) => archiveFilter === 'all' || archiveReason(item) === archiveFilter)
      : activeItems.filter((item) => matchesDeadlineFilter(item, deadlineFilter))),
    [activeItems, archivedItems, queueView, deadlineFilter, archiveFilter],
  );

  const filteredItems = useMemo(() => {
    const priorityItems = queueView === 'archive' || filter === 'all' ? deadlineScopedItems : deadlineScopedItems.filter((item) => item.decision && item.decision.priority === filter);
    const categoryItems = categoryFilter === 'all'
      ? priorityItems
      : priorityItems.filter((item) => item.judgments && item.judgments.category && item.judgments.category.value === categoryFilter);
    const reviewItems = reviewOnly ? categoryItems.filter((item) => item.decision && item.decision.needs_review) : categoryItems;
    if (!query.trim()) return reviewItems;
    const needle = query.trim().toLowerCase();
    return reviewItems.filter((item) => (item.preview || '').toLowerCase().includes(needle));
  }, [deadlineScopedItems, queueView, filter, categoryFilter, reviewOnly, query]);

  const displayedItems = filteredItems.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(160);
  }, [result && result.source, queueView, deadlineFilter, archiveFilter, filter, categoryFilter, reviewOnly, query]);

  useEffect(() => {
    if (!filteredItems.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!filteredItems.some((item) => item.candidate_id === selectedId)) {
      setSelectedId(filteredItems[0].candidate_id);
    }
  }, [filteredItems, selectedId]);

  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.candidate_id === selectedId) || filteredItems[0] || null,
    [filteredItems, selectedId],
  );

  const onFileChange = (event) => {
    const nextFile = event.target.files && event.target.files[0] ? event.target.files[0] : null;
    setFile(nextFile);
    setSourceMode('file');
    if (nextFile) setSettingsOpen(true);
  };

  const archiveStale = result && result.summary && result.summary.archive_stale;
  const messageDateFilter = (result && result.source && result.source.message_date_filter) || {};
  const hasDateFilter = Boolean(messageDateFilter.from || messageDateFilter.to);
  const dateRangeLabel = formatRangeLabel(messageDateFilter.from, messageDateFilter.to);
  const draftDateRangeLabel = formatRangeLabel(fromDate, toDate);
  const providerLabel = provider === 'local' ? '本地 Jev 基线' : provider === 'jev' ? 'TypeSafe Jev' : '自定义 Jev API';
  const sourceLabel = result && result.source && result.source.source_kind === 'wechat-local' ? '本机微信只读导入' : 'messages.json 导入';
  const deadlineStatusCounts = (result && result.summary && result.summary.deadline_status_counts) || {};
  const sourceFiles = (result && result.source && result.source.files) || [];
  const categoryCounts = (result && result.summary && result.summary.category_counts) || {};
  const categoryOptions = Object.keys(CATEGORY_LABELS).filter((value) => categoryCounts[value]);
  const resolvedFileCount = result && result.source_export && result.source_export.resolved_file_count != null
    ? result.source_export.resolved_file_count
    : sourceFiles.filter((item) => item.local_available).length;
  const activeTotal = result && result.summary && Number.isFinite(Number(result.summary.active_count))
    ? Number(result.summary.active_count)
    : activeItems.length;
  const archivedTotal = result && result.summary && Number.isFinite(Number(result.summary.archived_count))
    ? Number(result.summary.archived_count)
    : archivedItems.length;
  const completedTotal = result && result.summary && Number.isFinite(Number(result.summary.completed_count))
    ? Number(result.summary.completed_count)
    : archivedItems.filter((item) => archiveReason(item) === 'completed').length;
  const overdueTotal = result && result.summary && Number.isFinite(Number(result.summary.overdue_count))
    ? Number(result.summary.overdue_count)
    : archivedItems.filter((item) => archiveReason(item) === 'deadline_passed').length;
  const activeUrgentCount = activeItems.filter((item) => ['P0', 'P1'].includes(item.decision && item.decision.priority)).length;
  const viewReviewCount = deadlineScopedItems.filter((item) => item.decision && item.decision.needs_review).length;
  const hasMessages = Boolean(result && result.source && Number(result.source.message_count || 0) > 0);
  const activeQuickRangeId = QUICK_RANGE_OPTIONS.find((option) => {
    const optionRange = getQuickRange(rangeAnchor, option.id);
    return optionRange.from === (messageDateFilter.from || '') && optionRange.to === (messageDateFilter.to || '');
  })?.id || '';
  const queueLimitLabel = queueView === 'archive'
    ? `已归档 ${formatNumber(deadlineScopedItems.length)} / ${formatNumber(archivedTotal)} 条`
    : `进行中 ${formatNumber(activeTotal)} 条`;
  const headline = result
    ? <>进行中 <em>{formatNumber(activeTotal)}</em> 件，已归档 <em>{formatNumber(archivedTotal)}</em> 件</>
    : <>正在建立截止矩阵</>;

  const selectQueueView = (view) => {
    setQueueView(view);
    setFilter('all');
    setDeadlineFilter('all');
    setArchiveFilter('all');
    setSelectedId(null);
  };

  const setItemCompleted = async (item, completed) => {
    const key = item.item_key;
    if (!key || completionPending.has(key)) return;
    const before = item.decision;
    const nextDecision = completed
      ? { ...before, queue_state: 'archived', archive_reason: 'completed', completed_at: new Date().toISOString() }
      : { ...before, queue_state: deadlineStatus(item) === 'overdue' ? 'archived' : 'active', archive_reason: deadlineStatus(item) === 'overdue' ? 'deadline_passed' : null, completed_at: null };
    setCompletionPending((previous) => new Set(previous).add(key));
    setError('');
    if (completed && queueView === 'active' && selectedItem && selectedItem.candidate_id === item.candidate_id) {
      const index = filteredItems.findIndex((value) => value.candidate_id === item.candidate_id);
      setSelectedId((filteredItems[index + 1] || filteredItems[index - 1] || {}).candidate_id || null);
    }
    setResult((previous) => withItemDecision(previous, key, nextDecision));
    try {
      const response = await fetch('/api/items/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_key: key, completed }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || '保存完成状态失败');
      if (completed) {
        setResult((previous) => withItemDecision(previous, key, { ...nextDecision, completed_at: payload.completed_at }));
      }
    } catch (err) {
      setResult((previous) => withItemDecision(previous, key, before));
      setError(err.message);
    } finally {
      setCompletionPending((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup" title="Attention Desk">
          <div className="brand-mark"><Radar size={22} strokeWidth={1.7} /></div>
          <span>AD</span>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <button className="nav-icon active" title="注意力队列"><Inbox size={19} /></button>
          <button className="nav-icon" title="群聊数据"><MessageCircle size={19} /></button>
          <button className="nav-icon" title="分类视图"><Layers3 size={19} /></button>
        </nav>
        <div className="side-bottom">
          <button className="nav-icon" title="帮助"><CircleHelp size={19} /></button>
          <button className={'nav-icon ' + (settingsOpen ? 'active' : '')} title="API 设置" onClick={() => setSettingsOpen(true)}><Settings2 size={19} /></button>
        </div>
      </aside>

      <main className="main-canvas">
        <header className="topbar">
          <div className="group-context">
            <div className="context-icon"><MessageCircle size={17} /></div>
            <div>
              <span className="context-label">正在查看</span>
              <strong>{(result && result.source && result.source.conversation) || '上传群聊'}</strong>
            </div>
            <ChevronDown size={15} className="muted-icon" />
          </div>
          <div className="topbar-actions">
            <label className="date-control" title="分析基准日">
              <Clock3 size={15} />
              <span className="date-control-label">判断日</span>
              <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
            </label>
            <button className="provider-button" onClick={() => setSettingsOpen(true)}>
              <span className={'status-dot ' + (provider === 'local' ? 'local' : 'remote')} />
              {providerLabel}
              <ChevronDown size={14} />
            </button>
            <button className="button button-quiet" title="上传 messages.json" onClick={() => fileRef.current && fileRef.current.click()}>
              <Upload size={16} /> 上传
            </button>
            <button className="button button-primary" onClick={runAnalysis} disabled={running}>
              {running ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {running ? '分拣中' : '开始分拣'}
            </button>
            <input ref={fileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={onFileChange} />
          </div>
        </header>

        <section className="page-heading">
          <div>
            <p className="eyebrow">ATTENTION QUEUE</p>
            <h1>{headline}</h1>
            <p className="heading-subtitle">
              {result ? formatNumber(result.summary.candidate_count) + ' 个候选事项，已按 Jev typed judgments 与本地 reducer 排序 · ' + sourceLabel + ' · 消息范围 ' + dateRangeLabel : '正在读取消息归档…'}
            </p>
          </div>
          <div className="heading-tools">
            <div className="system-readout" aria-label="运行状态">
              <span><i className="readout-dot" /> PIPELINE ONLINE</span>
              <span>JEV // {provider === 'local' ? 'LOCAL' : 'REMOTE'}</span>
              <span>{result ? formatNumber(result.summary.candidate_count) : '--'} ITEMS</span>
            </div>
            <div className="heading-actions">
              <button className="icon-button" title="刷新当前分拣" onClick={runAnalysis} disabled={running}><RefreshCw size={17} className={running ? 'spin' : ''} /></button>
              <button className="icon-button" title="筛选设置" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={17} /></button>
            </div>
          </div>
        </section>

        {error && (
          <div className="error-banner">
            <AlertTriangle size={17} />
            <span>{error}</span>
            <button className="icon-button small" title="关闭" onClick={() => setError('')}><X size={15} /></button>
          </div>
        )}

        {archiveStale && result && (
          <div className="archive-banner">
            <AlertTriangle size={17} />
            <span>这份归档截至 <strong>{result.source.archive_end}</strong>，早于分析基准日 {result.source.as_of}。队列只代表已有记录，不代表之后没有新通知。</span>
          </div>
        )}

        {result && (
          <div className="scope-bar">
            <div className="scope-copy">
              <span className="scope-kicker"><CalendarRange size={15} /> 消息范围</span>
              <strong>{dateRangeLabel}</strong>
              <span>{hasDateFilter ? `首尾日期均包含 · 纳入 ${formatNumber(result.source.message_count)} / ${formatNumber(result.source.archive_message_count || result.source.message_count)} 条` : `完整归档 · ${formatNumber(result.source.message_count)} 条消息`}</span>
            </div>
            <div className="scope-controls">
              <div className="quick-range-group" role="group" aria-label="快捷日期范围">
                {QUICK_RANGE_OPTIONS.map((option) => (
                  <button key={option.id} className={activeQuickRangeId === option.id ? 'active' : ''} onClick={() => applyQuickRange(option.id)} disabled={running}>
                    {option.label}
                  </button>
                ))}
              </div>
              <button className="scope-settings-button" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={14} /> 范围设置</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="loading-grid">
            <div className="loading-panel shimmer" />
            <div className="loading-panel shimmer" />
          </div>
        ) : !result ? (
          <EmptyState onUpload={() => fileRef.current && fileRef.current.click()} />
        ) : (
          <>
            <section className="metric-strip">
              <div className="metric-item">
                <span className="metric-label">{hasDateFilter ? '纳入消息' : '原始消息'}</span>
                <strong>{formatNumber(result.source.message_count)}</strong>
                <span className="metric-note">条</span>
              </div>
              <div className="metric-item">
                <span className="metric-label">进行中</span>
                <strong>{formatNumber(activeTotal)}</strong>
                <span className="metric-note">P0 / P1 {formatNumber(activeUrgentCount)} 条</span>
              </div>
              <div className="metric-item deadline-metric">
                <span className="metric-label">今日 / 临近</span>
                <strong>{formatNumber((deadlineStatusCounts.due_today || 0) + (deadlineStatusCounts.near || 0))}</strong>
                <span className="metric-note">未来 0–3 天</span>
              </div>
              <button type="button" className="metric-item archive-metric" onClick={() => selectQueueView('archive')}>
                <span className="metric-label">已归档</span>
                <strong>{formatNumber(archivedTotal)}</strong>
                <span className="metric-note">完成 {formatNumber(completedTotal)} / 超期 {formatNumber(overdueTotal)}</span>
              </button>
              <div className="metric-item accent">
                <span className="metric-label">需要复核</span>
                <strong>{formatNumber(result.summary.needs_review_count)}</strong>
                <span className="metric-note">条</span>
              </div>
              <div className="metric-item">
                <span className="metric-label">分析引擎</span>
                <strong className="metric-engine">{(result.provider && result.provider.label) || providerLabel}</strong>
                <span className="metric-note">{result.provider && result.provider.calls ? result.provider.calls + ' 次 typed call' : '本地计算'}</span>
              </div>
              {result.source && result.source.source_kind === 'wechat-local' && (
                <div className="metric-item">
                  <span className="metric-label">聊天文件</span>
                  <strong>{formatNumber(result.source.file_count)}</strong>
                  <span className="metric-note">{resolvedFileCount ? formatNumber(resolvedFileCount) + ' 个已在本机' : '仅元数据'}</span>
                </div>
              )}
            </section>

            {hasMessages ? <div className="workspace-grid">
              <section className={'queue-panel ' + (queueView === 'archive' ? 'is-archive' : '')}>
                <div className="queue-view-tabs" role="tablist" aria-label="事项状态分区">
                  <button role="tab" aria-selected={queueView === 'active'} className={queueView === 'active' ? 'active' : ''} onClick={() => selectQueueView('active')}>
                    <span className="view-index">01</span>
                    <span><strong>进行中</strong><small>当前行动队列</small></span>
                    <b>{formatNumber(activeTotal)}</b>
                  </button>
                  <button role="tab" aria-selected={queueView === 'archive'} className={queueView === 'archive' ? 'active archive' : 'archive'} onClick={() => selectQueueView('archive')}>
                    <span className="view-index">02</span>
                    <span><strong>已归档</strong><small>完成 / 超期</small></span>
                    <b>{formatNumber(archivedTotal)}</b>
                  </button>
                </div>
                <div className="panel-head">
                  <div>
                    <h2>{queueView === 'archive' ? '归档事项' : '注意力队列'}</h2>
                    <span>{queueLimitLabel}{categoryFilter !== 'all' ? ' · ' + categoryLabel(categoryFilter) : ''}{reviewOnly ? ' · 仅看待复核' : ''}{query ? ' · 搜索结果' : ''}</span>
                  </div>
                  <div className="panel-head-actions">
                    <div className="search-box">
                      <Search size={15} />
                      <input placeholder="搜索当前队列" aria-label="搜索当前队列" value={query} onChange={(event) => setQuery(event.target.value)} />
                      {query && <button className="search-clear" title="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}
                    </div>
                    <select className="queue-category-select" aria-label="按类别筛选" title="按类别筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                      <option value="all">全部类别</option>
                      {categoryOptions.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}
                    </select>
                    <button className={'queue-filter-button ' + (reviewOnly ? 'active' : '')} title="仅看待复核事项" aria-pressed={reviewOnly} onClick={() => setReviewOnly((value) => !value)}>
                      <Filter size={14} /> <span>复核</span><b>{formatNumber(viewReviewCount)}</b>
                    </button>
                  </div>
                </div>
                {queueView === 'active' && <div className="priority-tabs">
                  {['all', 'P0', 'P1', 'P2', 'P3'].map((tab) => (
                    <button key={tab} className={filter === tab ? 'active' : ''} onClick={() => setFilter(tab)}>
                      {tab === 'all' ? '全部' : tab}
                      <span>{formatNumber(getFilterCount(deadlineScopedItems, tab))}</span>
                    </button>
                  ))}
                </div>}
                {queueView === 'active' ? (
                  <div className="deadline-tabs" role="group" aria-label="按截止状态筛选">
                    {ACTIVE_DEADLINE_FILTERS.map((option) => (
                      <button key={option.id} className={deadlineFilter === option.id ? 'active' : ''} onClick={() => { setDeadlineFilter(option.id); setFilter('all'); }}>
                        {option.label}
                        <span>{formatNumber(option.id === 'all' ? activeTotal : activeItems.filter((item) => matchesDeadlineFilter(item, option.id)).length)}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="archive-filter-tabs" role="group" aria-label="按归档原因筛选">
                    {ARCHIVE_FILTERS.map((option) => (
                      <button key={option.id} className={archiveFilter === option.id ? 'active' : ''} onClick={() => setArchiveFilter(option.id)}>
                        {option.label}
                        <span>{formatNumber(option.id === 'all' ? archivedTotal : option.id === 'completed' ? completedTotal : overdueTotal)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="queue-list">
                  {displayedItems.map((item) => {
                    const priority = (item.decision && item.decision.priority) || 'P3';
                    const isSelected = item.candidate_id === (selectedItem && selectedItem.candidate_id);
                    return (
                      <div key={item.item_key || item.candidate_id} className={'queue-row ' + (isSelected ? 'selected' : '')}>
                        <span className={'priority-bar ' + (queueView === 'archive' ? 'archived' : ((PRIORITY_META[priority] && PRIORITY_META[priority].className) || 'p3'))} />
                        <button type="button" className="queue-select" onClick={() => setSelectedId(item.candidate_id)}>
                          <div className="queue-main">
                            <div className="queue-row-top">
                              {queueView === 'archive' ? <ArchivePill item={item} /> : <PriorityPill priority={priority} />}
                              <DeadlinePill item={item} archived={queueView === 'archive'} />
                              <span className="category-label">{categoryLabel(item.judgments && item.judgments.category && item.judgments.category.value)}</span>
                              {item.decision && item.decision.needs_review && <span className={'review-mark ' + (queueView === 'archive' ? 'archived' : '')}><AlertTriangle size={12} /> {queueView === 'archive' ? '历史复核' : '复核'}</span>}
                            </div>
                            <strong>{itemTitle(item)}</strong>
                            <p>{item.preview}</p>
                            <div className="queue-meta">
                              <span><Clock3 size={12} /> {deadlineText(item)}</span>
                              <span><Database size={12} /> {(item.message_ids && item.message_ids.length) || 0} 条证据</span>
                              <span><Check size={12} /> {formatPercent(confidence(item))}</span>
                            </div>
                          </div>
                          <ArrowUpRight size={16} className="row-arrow" />
                        </button>
                        {(queueView === 'active' || archiveReason(item) === 'completed') && (
                          <button
                            type="button"
                            className={'queue-complete ' + (queueView === 'archive' ? 'undo' : '')}
                            title={queueView === 'archive' ? '撤销完成' : '完成并归档'}
                            aria-label={`${queueView === 'archive' ? '撤销完成' : '完成并归档'}：${itemTitle(item)}`}
                            disabled={completionPending.has(item.item_key)}
                            onClick={() => setItemCompleted(item, queueView === 'active')}
                          >
                            {queueView === 'archive' ? <RotateCcw size={16} /> : <Check size={17} />}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {displayedItems.length < filteredItems.length && (
                    <button className="load-more" onClick={() => setVisibleCount((value) => value + 160)}>
                      显示更多 <span>{formatNumber(displayedItems.length)} / {formatNumber(filteredItems.length)}</span>
                    </button>
                  )}
                  {!filteredItems.length && <div className="no-results">{queueView === 'archive' && archiveFilter === 'completed' && !completedTotal ? '尚无已完成事项。' : '当前分区没有匹配事项。'}</div>}
                </div>
              </section>

              <aside className="inspector-panel">
                {selectedItem ? (
                  <>
                    <div className="inspector-head">
                      <div>
                        <span className="inspector-kicker"><PanelRight size={14} /> 决策轨迹</span>
                        <h2>{itemTitle(selectedItem)}</h2>
                      </div>
                      <div className="inspector-statuses">
                        <DeadlinePill item={selectedItem} archived={queueView === 'archive'} />
                        {queueView === 'archive' ? <ArchivePill item={selectedItem} /> : <PriorityPill priority={(selectedItem.decision && selectedItem.decision.priority) || 'P3'} />}
                        {(queueView === 'active' || archiveReason(selectedItem) === 'completed') && (
                          <button className="inspector-completion" disabled={completionPending.has(selectedItem.item_key)} onClick={() => setItemCompleted(selectedItem, queueView === 'active')}>
                            {queueView === 'archive' ? <RotateCcw size={14} /> : <Check size={14} />}
                            {queueView === 'archive' ? '撤销完成' : '完成并归档'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="inspector-copy">{selectedItem.preview}</div>
                    <div className="score-grid">
                      <div><span>重要性</span><strong>{(selectedItem.decision && selectedItem.decision.importance) || 0}</strong><small>/100</small></div>
                      <div><span>紧迫性</span><strong>{(selectedItem.decision && selectedItem.decision.urgency) || 0}</strong><small>/100</small></div>
                      <div><span>风险</span><strong>{(selectedItem.decision && selectedItem.decision.risk) || 0}</strong><small>/100</small></div>
                    </div>
                    <div className="trace-section">
                      <div className="section-label">JEV typed judgments</div>
                      <DecisionRow label="是否公告" type="noul" value={selectedItem.judgments && selectedItem.judgments.is_announcement && selectedItem.judgments.is_announcement.value ? '是' : '否'} confidence={selectedItem.judgments && selectedItem.judgments.is_announcement && selectedItem.judgments.is_announcement.confidence} tone="coral" />
                      <DecisionRow label="记录类型" type="choice" value={recordKindLabel(selectedItem.judgments && selectedItem.judgments.record_kind && selectedItem.judgments.record_kind.value)} confidence={selectedItem.judgments && selectedItem.judgments.record_kind && selectedItem.judgments.record_kind.confidence} tone="green" />
                      <DecisionRow label="事项类别" type="choice" value={categoryLabel(selectedItem.judgments && selectedItem.judgments.category && selectedItem.judgments.category.value)} confidence={selectedItem.judgments && selectedItem.judgments.category && selectedItem.judgments.category.confidence} tone="blue" />
                      <DecisionRow label={queueView === 'archive' ? '原始行动判断' : '是否需行动'} type="noul" value={selectedItem.judgments && selectedItem.judgments.action_required && selectedItem.judgments.action_required.value ? '需要' : '无需'} confidence={selectedItem.judgments && selectedItem.judgments.action_required && selectedItem.judgments.action_required.confidence} tone="amber" />
                      <DecisionRow label="受众" type="choice" value={(selectedItem.judgments && selectedItem.judgments.audience && selectedItem.judgments.audience.value) || '未知'} confidence={selectedItem.judgments && selectedItem.judgments.audience && selectedItem.judgments.audience.confidence} tone="green" />
                      <DecisionRow label="截止状态" type="state" value={deadlineRelativeText(selectedItem)} confidence={1} tone={deadlineStatus(selectedItem) === 'overdue' ? 'coral' : 'amber'} />
                      <DecisionRow label="DDL parser" type="app" value={deadlineText(selectedItem)} confidence={selectedItem.judgments && selectedItem.judgments.deadline && selectedItem.judgments.deadline.confidence} />
                    </div>
                    <div className="reducer-section">
                      <div className="section-label">Reducer 输出</div>
                      <div className="reducer-line">
                        <span className={'reducer-dot ' + (queueView === 'archive' ? 'archived' : '')} />
                        <div>
                          <strong>{queueView === 'archive' ? (archiveReason(selectedItem) === 'completed' ? '已标记完成' : '已自动归档') : PRIORITY_META[(selectedItem.decision && selectedItem.decision.priority) || 'P3'].label}</strong>
                          <p>{queueView === 'archive' ? `${archiveReason(selectedItem) === 'completed' ? '手动完成' : '截止日已过'} · 原判断 ${(selectedItem.decision && selectedItem.decision.priority) || 'P3'} · ${selectedItem.decision && selectedItem.decision.reason}` : selectedItem.decision && selectedItem.decision.reason}</p>
                        </div>
                      </div>
                      {queueView === 'active' && selectedItem.decision && selectedItem.decision.needs_review && (
                        <div className="manual-review">
                          <AlertTriangle size={15} />
                          <span>保留人工复核</span>
                          <button className="toggle on" aria-label="保留人工复核"><span /></button>
                        </div>
                      )}
                    </div>
                    <div className="evidence-section">
                      <div className="section-label">证据消息</div>
                      {((selectedItem.evidence) || []).slice(0, 3).map((evidence) => (
                        <div key={evidence.id} className="evidence-item">
                          <span>{evidence.id}</span>
                          <p>{evidence.content}</p>
                          <time>{evidence.timestamp}</time>
                        </div>
                      ))}
                      {(!selectedItem.evidence || !selectedItem.evidence.length) && <p className="muted-note">缓存结果保留了证据 ID，上传或重新分拣后可展开原文。</p>}
                    </div>
                  </>
                ) : (
                  <div className="inspector-empty"><PanelRight size={28} /><span>选择一条事项查看判断轨迹</span></div>
                )}
              </aside>
            </div> : (
              <RangeEmptyState
                dateRangeLabel={dateRangeLabel}
                archiveCount={result.source.archive_message_count || 0}
                onReset={() => applyQuickRange('all')}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
          </>
        )}
      </main>

      {settingsOpen && (
        <div className="drawer-backdrop" onClick={() => setSettingsOpen(false)}>
          <aside className="settings-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <span className="inspector-kicker"><Settings2 size={14} /> 工作台设置</span>
                <h2>连接与范围</h2>
              </div>
              <button className="icon-button" title="关闭" onClick={() => setSettingsOpen(false)}><X size={18} /></button>
            </div>
            <div className="form-section">
              <label className="field-label">数据源</label>
              <div className="source-switcher">
                <button className={sourceMode === 'file' ? 'source-option selected' : 'source-option'} onClick={() => setSourceMode('file')}>
                  <FileJson size={18} />
                  <span>导入文件</span>
                  <small>messages.json</small>
                </button>
                <button className={sourceMode === 'wechat' ? 'source-option selected' : 'source-option'} onClick={() => setSourceMode('wechat')}>
                  <MessageCircle size={18} />
                  <span>本机微信</span>
                  <small>导出器优先</small>
                </button>
              </div>
              {sourceMode === 'file' ? (
                <button className="upload-drop" onClick={() => fileRef.current && fileRef.current.click()}>
                  <FileJson size={22} />
                  <span>{file ? file.name : '选择 messages.json'}</span>
                  <small>{file ? Math.round(file.size / 1024) + ' KB' : '支持微信导出的对象格式或消息数组'}</small>
                </button>
              ) : (
                <div className="wechat-source-panel">
                  <div className="wechat-status-line">
                    <span className={'status-dot ' + (wechatStatus && wechatStatus.ready ? 'local' : 'remote')} />
                    <span>{wechatStatus ? (wechatStatus.ready ? (wechatStatus.exporter && wechatStatus.exporter.ready ? '微信导出器 / 本地归档可读' : '本地微信归档可读') : '微信数据源未就绪') : '正在检测微信数据源…'}</span>
                    {wechatStatus && <small>{wechatStatus.message_db_count || 0} 个消息分片</small>}
                  </div>
                  <div className="search-box group-search">
                    <Search size={15} />
                    <input placeholder="搜索群名或 username" aria-label="搜索微信群" value={wechatQuery} onChange={(event) => setWechatQuery(event.target.value)} />
                  </div>
                  <div className="wechat-group-list">
                    {wechatLoading && <div className="wechat-list-note"><LoaderCircle className="spin" size={15} /> 正在读取群列表</div>}
                    {!wechatLoading && wechatGroups.map((group) => (
                      <button
                        key={group.username}
                        className={'wechat-group-row ' + (selectedGroup && selectedGroup.username === group.username ? 'selected' : '')}
                        onClick={() => setSelectedGroup(group)}
                      >
                        <span className="group-avatar"><Users size={15} /></span>
                        <span className="wechat-group-copy">
                          <strong>{group.display_name}</strong>
                          <small>{group.message_count == null ? (group.has_messages ? '有消息' : '暂无消息') : formatNumber(group.message_count) + ' 条消息'} · {group.latest_date || '导出后显示日期'}</small>
                        </span>
                        {selectedGroup && selectedGroup.username === group.username && <Check size={15} />}
                      </button>
                    ))}
                    {!wechatLoading && !wechatGroups.length && <div className="wechat-list-note">没有匹配的微信群</div>}
                  </div>
                  {selectedGroup && (
                    <>
                      <div className="selected-group-note">
                        <ShieldCheck size={15} /> 已选择 <strong>{selectedGroup.display_name}</strong>，读取后会保存本地消息包并进入同一套分拣流程。
                      </div>
                      <label className="check-line">
                        <input type="checkbox" checked={resolveWechatFiles} onChange={(event) => setResolveWechatFiles(event.target.checked)} />
                        <span>尝试定位已经下载到本机的文件</span>
                      </label>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="form-section">
              <div className="field-label">
                <span>消息日期范围</span>
                <button
                  className="icon-button small"
                  title="清空日期范围"
                  onClick={() => { setFromDate(''); setToDate(''); }}
                  disabled={!fromDate && !toDate}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="date-range-fields">
                <div>
                  <label className="sub-field-label" htmlFor="from-date">开始日期</label>
                  <input id="from-date" className="text-input" type="date" value={fromDate} max={toDate || undefined} onInput={(event) => setFromDate(event.target.value)} onChange={(event) => setFromDate(event.target.value)} />
                </div>
                <div>
                  <label className="sub-field-label" htmlFor="to-date">结束日期</label>
                  <input id="to-date" className="text-input" type="date" value={toDate} min={fromDate || undefined} onInput={(event) => setToDate(event.target.value)} onChange={(event) => setToDate(event.target.value)} />
                </div>
              </div>
              <div className="quick-range-row" role="group" aria-label="快捷日期范围">
                {QUICK_RANGE_OPTIONS.map((option) => (
                  <button key={option.id} className={activeQuickRangeId === option.id ? 'active' : ''} onClick={() => applyQuickRange(option.id)} disabled={running}>
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="draft-range-note">当前设置：<strong>{draftDateRangeLabel}</strong></div>
              <p className="range-help">可只填一端；筛选先于候选聚类。分析基准日仍用于判断 DDL 是否临近或逾期。</p>
            </div>
            <p className="privacy-note">{sourceMode === 'wechat' ? '本机微信入口只读导出 JSON 或本地解密 SQLite；只有选择远程 Jev 时，候选片段才会发送到你填写的 API。' : 'Jev 模式会把候选消息片段发送到你选择的 API；本地模式不会上传聊天内容。'}</p>
            <div className="form-section">
              <label className="field-label">判断提供方</label>
              <div className="provider-options">
                <button className={provider === 'local' ? 'selected' : ''} onClick={() => setProvider('local')}>
                  <span><Database size={16} /> 本地 Jev 基线</span><small>规则 + typed reducer，不上传</small>
                </button>
                <button className={provider === 'jev' ? 'selected' : ''} onClick={() => setProvider('jev')}>
                  <span><Sparkles size={16} /> TypeSafe Jev</span><small>官方 System One endpoint</small>
                </button>
                <button className={provider === 'custom' ? 'selected' : ''} onClick={() => setProvider('custom')}>
                  <span><SlidersHorizontal size={16} /> 自定义 Jev API</span><small>兼容 state + questions</small>
                </button>
              </div>
            </div>
            {provider !== 'local' && (
              <>
                <div className="form-section">
                  <label className="field-label" htmlFor="endpoint">Endpoint</label>
                  <input id="endpoint" className="text-input" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
                </div>
                <div className="form-section inline-fields">
                  <div>
                    <label className="field-label" htmlFor="model">模型标识</label>
                    <input id="model" className="text-input" value={model} onChange={(event) => setModel(event.target.value)} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="max-candidates">API 调用上限</label>
                    <select id="max-candidates" className="text-input" value={maxCandidates} onChange={(event) => setMaxCandidates(event.target.value)}>
                      <option value="24">24 条</option>
                      <option value="48">48 条</option>
                      <option value="96">96 条</option>
                      <option value="160">160 条</option>
                    </select>
                  </div>
                </div>
                <div className="form-section">
                  <label className="field-label" htmlFor="api-key">API key <span>只在本次请求使用</span></label>
                  <input id="api-key" className="text-input" type="password" placeholder="粘贴到这里，不会写入文件" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                </div>
              </>
            )}
            <div className="drawer-footer">
              <button className="button button-quiet" onClick={() => setSettingsOpen(false)}>取消</button>
              <button className="button button-primary" onClick={runAnalysis} disabled={running}>
                {running ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                {running ? '运行中' : '应用并分拣'}
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
