/**
 * 規格 11.4「設定」：一般、儲存、記錄、單號與專案、報告、整合。修改後即時儲存並顯示「已儲存」。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FolderInput, FolderOpen, Moon, Plus, Power, RotateCw, Sun, XCircle, AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, get, post, put, type PromptInfo } from '../lib/api';
import { applyTheme, useDebounced, useRunningJob, useToast } from '../lib/app';
import { Banner, Button, Card, Confirm, cx, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, Tag } from '../components/ui';
import { Link } from 'react-router-dom';
import { JiraSyncButton, SweepButton } from './Today';

type Cfg = any;

const SECTIONS = [
  ['general', '一般'],
  ['storage', '儲存'],
  ['capture', '記錄'],
  ['jira', 'Jira'],
  ['projects', '專案'],
  ['report', '報告'],
  ['integration', '整合'],
] as const;

function setPath(obj: Cfg, path: string, value: unknown): Cfg {
  const next = structuredClone(obj);
  const keys = path.split('.');
  let o = next;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)!] = value;
  return next;
}
const getPath = (obj: Cfg, path: string) => path.split('.').reduce((o, k) => o?.[k], obj);

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['config'], queryFn: () => get<{ config: Cfg; error: { message: string; line?: number } | null; storage_root: string }>('/api/config') });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [status, setStatus] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const [fieldError, setFieldError] = useState('');

  const dirty = useRef(false);
  useEffect(() => {
    if (q.data && (!cfg || !dirty.current)) setCfg(q.data.config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  useEffect(() => {
    const hash = location.hash.slice(1);
    if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 200);
  }, []);

  const persist = useDebounced(async (next: Cfg) => {
    setStatus('saving');
    try {
      await put('/api/config', { config: next });
      dirty.current = false;
      setStatus('saved');
      setFieldError('');
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['prompts'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['unmapped-parents'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) {
      setStatus('error');
      setFieldError((e as Error).message);
    }
  }, 600);

  const set = (path: string, value: unknown) => {
    dirty.current = true;
    setCfg((c: Cfg) => {
      const next = setPath(c, path, value);
      persist.run(next);
      return next;
    });
  };

  /** 合併專案：先把尚未送出的修改存檔，再由服務合併並同步任務 */
  const mergeProject = async (from: string, to: string) => {
    persist.cancel();
    await put('/api/config', { config: cfg });
    dirty.current = false;
    const r = await post<{ config: Cfg; updated: number }>('/api/projects/merge', { from, to });
    setCfg(r.config);
    void qc.invalidateQueries({ queryKey: ['config'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    toast.show({ tone: 'success', message: `已合併專案，更新 ${r.updated} 個任務` });
  };

  if (q.isLoading || !cfg) return <Skeleton className="h-[600px]" />;
  const bind = (path: string) => ({ value: getPath(cfg, path) ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => set(path, e.target.value) });
  const num = (path: string) => ({
    type: 'number',
    value: getPath(cfg, path),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => e.target.value !== '' && set(path, Number(e.target.value)),
  });

  return (
    <>
      <PageHeader
        title="設定"
        subtitle={
          <span aria-live="polite" className={cx(status === 'error' && 'text-danger')}>
            {status === 'saving' ? '儲存中…' : status === 'saved' ? '✓ 已儲存' : status === 'error' ? `儲存失敗：${fieldError}` : '修改後自動儲存，立即生效。'}
          </span>
        }
      />
      {q.data?.error && (
        <Banner tone="danger" className="mb-6">
          config.yaml 有誤（第 {q.data.error.line ?? '?'} 行）：{q.data.error.message}。目前以預設值運作，在此修改任一設定會寫回正確的格式。
        </Banner>
      )}
      <nav className="mb-6 flex flex-wrap gap-1.5">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-hover">
            {label}
          </a>
        ))}
      </nav>

      <div className="space-y-6">
        <Section id="general" title="一般">
          <Row label="名字" hint="報告中使用的稱呼，對應範本變數 {{user_name}}">
            <Input {...bind('user_name')} placeholder="例如 Leo" />
          </Row>
          <Row label="主題">
            <div className="inline-flex gap-0.5 rounded-ctl border border-line p-0.5" role="radiogroup" aria-label="主題">
              {(
                [
                  ['light', '淺色', Sun],
                  ['dark', '深色', Moon],
                ] as const
              ).map(([value, label, Icon]) => {
                const active = (cfg.ui.theme === 'dark' ? 'dark' : 'light') === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      applyTheme(value);
                      set('ui.theme', value);
                    }}
                    className={cx(
                      'inline-flex h-8 items-center gap-1.5 rounded-[calc(var(--radius-ctl)-2px)] px-3 text-sm transition-colors duration-150',
                      active ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
                    )}
                  >
                    <Icon className="size-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="介面風格" hint="筆記本：橫線紙卡片、便利貼、手寫標題；淺色與深色都適用">
            <Select {...bind('ui.style')}>
              <option value="default">簡約</option>
              <option value="notebook">筆記本</option>
            </Select>
          </Row>
          <Row label="服務啟動時開啟 UI">
            <Toggle checked={!!cfg.ui.open_browser_on_start} onChange={(v) => set('ui.open_browser_on_start', v)} />
          </Row>
          <Row label="首次引導" hint="重新走一次名字、Jira 代碼、報告週期與外觀的設定步驟">
            <Link to="/welcome" className="inline-flex h-9 items-center rounded-ctl border border-line bg-card px-3.5 text-sm font-medium hover:bg-hover">
              重新執行引導
            </Link>
          </Row>
        </Section>

        <StorageSection root={q.data!.storage_root} />

        <Section id="capture" title="記錄">
          <Row label="摘要把關" hint="Claude 回應結束時，若有實質進展但日誌未更新，要求 Claude 先補寫">
            <Select {...bind('capture.guard')}>
              <option value="commit">出現新的 commit 時（建議）</option>
              <option value="edits">檔案編輯達一定次數時</option>
              <option value="off">關閉</option>
            </Select>
          </Row>
          {cfg.capture.guard === 'edits' && (
            <Row label="編輯次數門檻">
              <Input {...num('capture.guard_edit_threshold')} min={1} />
            </Row>
          )}
          <Row label="時數單位（小時）" hint="系統計算的時數四捨五入到此單位">
            <Select value={String(cfg.time.rounding)} onChange={(e) => set('time.rounding', Number(e.target.value))}>
              <option value="0.25">0.25</option>
              <option value="0.5">0.5</option>
              <option value="1">1</option>
            </Select>
          </Row>
          <Row
            label="每日工時（小時）"
            hint="AI 會各自粗估每個任務的時數；同一天加總超過此值時，依比例縮減 AI 粗估的時數，手動填寫的時數不變。0 為不限制。修改後自動套用到所有紀錄"
          >
            <div className="flex items-center gap-2">
              <Input {...num('time.daily_hours')} min={0} max={24} step={0.5} className="w-24" />
              <Button
                variant="ghost"
                onClick={async () => {
                  const r = await post<{ updated: number }>('/api/hours/rebalance', {});
                  void qc.invalidateQueries({ queryKey: ['tasks'] });
                  toast.show({ tone: 'success', message: r.updated ? `已調整 ${r.updated} 個任務的時數` : '所有紀錄都已符合每日工時' });
                }}
              >
                套用到既有紀錄
              </Button>
            </div>
          </Row>
          <Row label="最低記錄時間（分鐘）" hint="活躍時間低於此值、且沒有 commit 的對話不建立任務，避免把簡短提問也記成工作">
            <Input {...num('capture.min_active_minutes')} min={0} />
          </Row>
          <Row label="排除路徑" hint="符合的工作目錄不記錄，支援萬用字元，例如 D:/personal/**">
            <ListEditor values={cfg.capture.exclude_paths} onChange={(v) => set('capture.exclude_paths', v)} placeholder="D:/personal/**" mono />
          </Row>
          <details className="group">
            <summary className="cursor-pointer text-sm text-ink-2 select-none">進階：閒置計算、補漏排程、時區</summary>
            <div className="mt-5 space-y-5">
              <Row label="閒置門檻（分鐘）" hint="相鄰訊息間隔超過此值，視為離開，只計入寬限時間">
                <Input {...num('time.idle_threshold_minutes')} min={1} />
              </Row>
              <Row label="閒置寬限（分鐘）" hint="超過門檻的間隔計入的閱讀與思考時間">
                <Input {...num('time.idle_grace_minutes')} min={0} />
              </Row>
              <Row label="補漏掃描範圍（天）">
                <Input {...num('capture.sweep_days')} min={1} />
              </Row>
              <Row label="每日補漏時間">
                <Input type="time" {...bind('capture.sweep_time')} />
              </Row>
              <Row label="時區">
                <Input {...bind('time.timezone')} placeholder="Asia/Taipei" />
              </Row>
            </div>
          </details>
        </Section>

        <JiraSection cfg={cfg} set={set} bind={bind} num={num} />

        <Section id="projects" title="專案">
          <div>
            <div className="mb-1 text-sm font-medium">專案</div>
            <div className="mb-3 text-xs text-ink-3">點專案名稱可以直接改名，任務會跟著改。同一件事有兩張大型工作時，用「合併」併成一個專案。</div>
            <ProjectList rules={cfg.projects} onChange={(v) => set('projects', v)} onMerge={mergeProject} />
          </div>
        </Section>

        <ReportSection cfg={cfg} set={set} bind={bind} />

        <IntegrationSection cfg={cfg} bind={bind} />
      </div>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card className="scroll-mt-6 p-6" id={id}>
      <h2 className="mb-5 text-base font-semibold">{title}</h2>
      <div className="space-y-5">{children}</div>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[220px_1fr] sm:gap-6">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
      </div>
      <div className="max-w-md">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-60', checked ? 'bg-accent' : 'bg-line')}
    >
      <span className={cx('absolute top-0.5 size-5 rounded-full bg-card shadow-sm transition-transform duration-150', checked ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

function ListEditor({ values, onChange, placeholder, mono }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Tag key={v} mono={mono} className="pr-1">
            {v}
            <IconButton size="xs" className="rounded-full" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`移除 ${v}`}>
              <XCircle className="size-3" />
            </IconButton>
          </Tag>
        ))}
        {!values.length && <span className="text-xs text-ink-3">（無）</span>}
      </div>
      <div className="flex gap-2">
        <Input className={mono ? 'font-mono' : ''} value={input} placeholder={placeholder} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <Button onClick={add} disabled={!input.trim()}>
          新增
        </Button>
      </div>
    </div>
  );
}

interface Rule {
  id?: string;
  name: string;
  match: { paths: string[]; ticket_keys: string[]; parents?: string[] };
}

const newId = () => `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
function newRule(name: string, match: Partial<Rule['match']> = {}): Rule {
  return { id: newId(), name, match: { paths: [], ticket_keys: [], parents: [], ...match } };
}

interface RuleInfo {
  id: string;
  name: string;
  task_count: number;
  parents?: { key: string; summary: string }[];
}

function useProjectRules() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => get<{ projects: string[]; rules?: RuleInfo[] }>('/api/projects'),
    staleTime: 10_000,
  });
}

const TEXT_BTN = 'rounded px-1.5 py-0.5 text-xs text-ink-2 hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent';

/** 專案清單：大型工作自動建立的專案與手動新增的專案，可改名、合併、刪除 */
function ProjectList({ rules, onChange, onMerge }: { rules: Rule[]; onChange: (r: Rule[]) => void; onMerge: (from: string, to: string) => Promise<void> }) {
  const split = (s: string) => s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  const update = (i: number, r: Rule) => onChange(rules.map((x, j) => (j === i ? r : x)));
  const info = new Map((useProjectRules().data?.rules ?? []).map((r) => [r.id, r]));
  const [open, setOpen] = useState<string | null>(null);
  const [merging, setMerging] = useState<Rule | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<number | null>(null);
  const toast = useToast();
  const dup = (name: string, i: number) => rules.some((r, j) => j !== i && r.name.trim() === name.trim());
  const count = (r: Rule | null | undefined) => (r?.id ? (info.get(r.id)?.task_count ?? 0) : 0);
  const title = (r: Rule, key: string) => (r.id ? info.get(r.id)?.parents?.find((p) => p.key === key)?.summary : '') ?? '';

  const doMerge = async () => {
    if (!merging?.id || !target) return;
    setBusy(true);
    setError('');
    try {
      await onMerge(merging.id, target);
      setMerging(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!rules.length ? (
        <div className="rounded-ctl border border-dashed border-line px-3 py-4 text-center text-xs text-ink-3">還沒有專案。查到 Jira 大型工作後會自動出現在這裡，也可以自己新增。</div>
      ) : (
        <ul className="divide-y divide-line rounded-ctl border border-line">
          {rules.map((r, i) => {
            const key = r.id ?? `i${i}`;
            const parents = r.match.parents ?? [];
            const expanded = open === key;
            return (
              <li key={`${key}:${r.name}`} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <input
                      className={cx(
                        '-mx-1.5 w-[calc(100%+0.75rem)] rounded px-1.5 py-0.5 font-medium outline-none hover:bg-hover focus:bg-hover',
                        dup(r.name, i) && 'text-danger',
                      )}
                      defaultValue={r.name}
                      aria-label="專案名稱"
                      title={dup(r.name, i) ? '與其他專案同名，建議合併' : '點一下改名'}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (!name) {
                          e.target.value = r.name;
                          toast.show({ tone: 'error', message: '專案名稱不可空白' });
                        } else if (name !== r.name) update(i, { ...r, name });
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                    <div className="mt-0.5 space-y-0.5 text-xs text-ink-3">
                      {parents.map((k) => (
                        <div key={k} className="truncate">
                          <span className="font-mono">{k}</span>
                          {title(r, k) && ` ${title(r, k)}`}
                        </div>
                      ))}
                      {!!r.match.paths.length && <div className="truncate">工作目錄：{r.match.paths.join(', ')}</div>}
                      {!!r.match.ticket_keys.length && <div className="truncate">Jira 代碼：{r.match.ticket_keys.join(', ')}</div>}
                      {!parents.length && !r.match.paths.length && !r.match.ticket_keys.length && <div>手動選擇用，不會自動分類</div>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="mr-1 text-xs text-ink-3">{r.id ? `${count(r)} 個任務` : ''}</span>
                    <button type="button" className={TEXT_BTN} onClick={() => setOpen(expanded ? null : key)} aria-expanded={expanded}>
                      條件
                    </button>
                    <button
                      type="button"
                      className={TEXT_BTN}
                      disabled={!r.id || rules.length < 2}
                      onClick={() => {
                        setMerging(r);
                        setTarget(rules.find((x) => x.id && x.id !== r.id)?.id ?? '');
                        setError('');
                      }}
                    >
                      合併
                    </button>
                    <button type="button" className={cx(TEXT_BTN, 'hover:text-danger')} onClick={() => setRemoving(i)}>
                      刪除
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="mt-2 grid gap-2 rounded-ctl bg-hover/50 p-2 sm:grid-cols-3">
                    <Field label="大型工作單號" hint="底下所有單的任務都歸到這個專案">
                      <Input
                        className="font-mono"
                        defaultValue={parents.join(', ')}
                        onBlur={(e) => update(i, { ...r, match: { ...r.match, parents: split(e.target.value).map((s) => s.toUpperCase()) } })}
                        placeholder="TDDA-100"
                      />
                    </Field>
                    <Field label="工作目錄" hint="在這些資料夾的對話，支援 *">
                      <Input className="font-mono" defaultValue={r.match.paths.join(', ')} onBlur={(e) => update(i, { ...r, match: { ...r.match, paths: split(e.target.value) } })} placeholder="C:/proj/se-*" />
                    </Field>
                    <Field label="Jira 代碼" hint="這個代碼開頭的所有單">
                      <Input
                        className="font-mono"
                        defaultValue={r.match.ticket_keys.join(', ')}
                        onBlur={(e) => update(i, { ...r, match: { ...r.match, ticket_keys: split(e.target.value).map((s) => s.toUpperCase()) } })}
                        placeholder="TDDA"
                      />
                    </Field>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rules, newRule('新專案')])}>
          新增專案
        </Button>
        <RefreshTickets />
      </div>

      <Modal
        open={!!merging}
        onClose={() => !busy && setMerging(null)}
        title={`合併「${merging?.name ?? ''}」`}
        footer={
          <>
            <Button onClick={() => setMerging(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void doMerge()} loading={busy} disabled={!target}>
              合併
            </Button>
          </>
        }
      >
        <p className="mb-3 text-ink-2">把「{merging?.name}」併入：</p>
        <Select className="w-full" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="併入的專案">
          {rules
            .filter((x) => x.id && x.id !== merging?.id)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </Select>
        <p className="mt-3 text-xs text-ink-3">「{merging?.name}」的 {count(merging)} 個任務和之後的新任務，都會歸到選擇的專案。</p>
        {error && <p className="mt-2 text-danger">{error}</p>}
      </Modal>

      <Confirm
        open={removing !== null}
        title="刪除專案"
        message={
          removing !== null
            ? `刪除「${rules[removing]?.name}」？已記錄的 ${count(rules[removing])} 個任務保留目前的名稱${
                rules[removing]?.match.parents?.length ? '，它的大型工作之後也不會再自動建立專案' : ''
              }。想把任務歸到別的專案，請改用「合併」。`
            : ''
        }
        confirmLabel="刪除"
        danger
        onConfirm={() => {
          if (removing !== null) onChange(rules.filter((_, j) => j !== removing));
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

/** 立即查詢 Jira 上層卡片 */
function RefreshTickets() {
  const qc = useQueryClient();
  const toast = useToast();
  const running = useRunningJob('tickets', 'tickets');
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    }
    wasRunning.current = !!running;
  }, [running, qc]);
  const refresh = async () => {
    try {
      const r = await post<{ job_id: string | null }>('/api/tickets/refresh', { force: false });
      if (!r.job_id) toast.show({ message: '近期任務的單號都已經查過了' });
    } catch (e) {
      toast.show({ tone: 'error', message: (e as Error).message });
    }
  };
  return (
    <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} loading={!!running} onClick={() => void refresh()}>
      {running ? (running.progress ?? '查詢中…') : '立即查詢 Jira'}
    </Button>
  );
}

function StorageSection({ root }: { root: string }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'move' | 'pointer'>('move');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      await post('/api/config/move-storage', { target, mode });
      toast.show({ message: '已更換儲存資料夾，服務重新啟動中…', duration: 5000 });
      setTimeout(() => location.reload(), 4000);
    } catch (e) {
      toast.show({ tone: 'error', message: (e as Error).message });
      setBusy(false);
    }
  };
  return (
    <Section id="storage" title="儲存">
      <Row label="資料夾位置" hint="所有日誌、週報、績效、範本與設定都在這裡，格式為 Markdown">
        <Input readOnly value={root} className="font-mono text-xs" title={root} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            icon={<FolderOpen className="size-4" />}
            onClick={() => void post('/api/open-folder', { which: 'root' }).catch((e: Error) => toast.show({ tone: 'error', message: e.message }))}
          >
            開啟資料夾
          </Button>
          <Button icon={<FolderInput className="size-4" />} onClick={() => setOpen(true)}>
            更換
          </Button>
        </div>
      </Row>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="更換儲存資料夾"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={!target.trim()} onClick={() => void submit()}>
              確定
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input className="font-mono" placeholder="D:\Worktrail" value={target} onChange={(e) => setTarget(e.target.value)} autoFocus />
          <label className="flex cursor-pointer gap-3 rounded-ctl border border-line p-3">
            <input type="radio" className="mt-1 accent-accent" checked={mode === 'move'} onChange={() => setMode('move')} />
            <div>
              <div className="font-medium">搬移現有資料</div>
              <div className="text-xs text-ink-3">把目前資料夾的所有內容搬到新位置（新資料夾必須是空的）。</div>
            </div>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-ctl border border-line p-3">
            <input type="radio" className="mt-1 accent-accent" checked={mode === 'pointer'} onChange={() => setMode('pointer')} />
            <div>
              <div className="font-medium">只改指向</div>
              <div className="text-xs text-ink-3">改用新位置（例如已同步好的資料夾），目前資料夾保持不動。</div>
            </div>
          </label>
        </div>
      </Modal>
    </Section>
  );
}

function ReportSection({ cfg, set, bind }: { cfg: Cfg; set: (p: string, v: unknown) => void; bind: (p: string) => object }) {
  return (
    <Section id="report" title="報告">
      <Row label="每週起始日">
        <Select {...bind('report.weekly.start_day')}>
          {[
            ['monday', '週一'],
            ['sunday', '週日'],
            ['saturday', '週六'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="週報週期" hint="雙週報選「每 2 週」；本期、上期與週報清單都會依此切分">
        <Select value={String(cfg.report.weekly.length_weeks ?? 1)} onChange={(e) => set('report.weekly.length_weeks', Number(e.target.value))}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              每 {n} 週
            </option>
          ))}
        </Select>
      </Row>
      {(cfg.report.weekly.length_weeks ?? 1) > 1 && (
        <Row label="週期起算日" hint="選任一期第一週內的某一天，決定從哪一週開始算；空白以 2026-01-05 所在週起算">
          <Input type="date" className="w-auto" {...bind('report.weekly.anchor_date')} />
        </Row>
      )}
      <Row label="績效週期">
        <Select {...bind('report.performance.period')}>
          <option value="monthly">每月</option>
          <option value="quarterly">每季</option>
          <option value="half_yearly">每半年</option>
          <option value="yearly">每年</option>
          <option value="custom">自訂</option>
        </Select>
      </Row>
      <Row label="考核年度起始月" hint="季與半年以此月份起算，支援非曆年的考核年度">
        <Select value={String(cfg.report.performance.year_start_month)} onChange={(e) => set('report.performance.year_start_month', Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1} 月
            </option>
          ))}
        </Select>
      </Row>
      <Row label="預設範本" hint="摘要、週報、績效、小交流各用哪個範本">
        <Link to="/prompts" className="text-sm text-accent underline">
          在 Prompt 頁以「設為預設」選擇
        </Link>
      </Row>
    </Section>
  );
}

/** Jira 相關設定集中在一起：專案代碼、依大型工作建立專案、從 Jira 整理的範本與 MCP */
function JiraSection({
  cfg,
  set,
  bind,
  num,
}: {
  cfg: Cfg;
  set: (p: string, v: unknown) => void;
  bind: (p: string) => object;
  num: (p: string) => object;
}) {
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: () => get<{ prompts: PromptInfo[] }>('/api/prompts') });
  const summaryPrompts = (prompts.data?.prompts ?? []).filter((p) => p.type === 'summary');
  return (
    <Section id="jira" title="Jira">
      <Row label="Jira 專案代碼" hint="只接受這些代碼開頭的單號，避免把 UTF-8、SHA-256 誤判為單號。分支或 commit 出現新的代碼時，今日頁會詢問是否加入">
        <ListEditor values={cfg.ticket.keys} onChange={(v) => set('ticket.keys', v.map((s) => s.toUpperCase()))} placeholder="TDDA" mono />
      </Row>
      <Row label="依大型工作自動建立專案" hint="每 10 分鐘查詢近期任務單號的最上層卡片（大型工作），查到新的就建立同名專案">
        <Toggle
          checked={!!cfg.ticket.fetch_parents && cfg.ticket.auto_projects !== false}
          onChange={(v) => {
            set('ticket.fetch_parents', v);
            set('ticket.auto_projects', v);
          }}
        />
      </Row>
      <Row label="每日活動同步" hint="每天抓你在 Jira 上動過的單（建立、移動狀態、留言、編輯），沒用 Claude 處理的單自動補成任務；同單號已有任務時，活動附加到它的補充說明">
        <div className="flex flex-wrap items-center gap-2">
          <Toggle checked={cfg.jira_activity?.enabled !== false} onChange={(v) => set('jira_activity.enabled', v)} />
          <JiraSyncButton size="sm" variant="ghost" />
        </div>
      </Row>
      {cfg.jira_activity?.enabled !== false && (
        <>
          <Row label="同步時間" hint="每天這個時間同步今天；服務啟動時也會補抓最近幾天還沒同步完整的日期">
            <div className="flex flex-wrap items-center gap-2">
              <Input type="time" {...bind('jira_activity.time')} />
              <span className="text-xs text-ink-3">補抓</span>
              <Input className="w-20" min={0} max={30} {...num('jira_activity.lookback_days')} />
              <span className="text-xs text-ink-3">天</span>
            </div>
          </Row>
          <Row label="Jira 任務預設時數" hint="自動建立的 Jira 任務時數，之後可在任務上修改">
            <Input className="w-24" min={0} max={24} step={0.5} {...num('jira_activity.default_hours')} />
          </Row>
          <Row label="略過週末" hint="週六、週日不同步">
            <Toggle checked={cfg.jira_activity?.skip_weekends !== false} onChange={(v) => set('jira_activity.skip_weekends', v)} />
          </Row>
          <Row label="包含關注中的單" hint="候選單號也包含你關注（watch）的單；仍只計算你自己的操作">
            <Toggle checked={cfg.jira_activity?.include_watched !== false} onChange={(v) => set('jira_activity.include_watched', v)} />
          </Row>
          <Row label="子項由 Claude 整理" hint="開啟時用「從 Jira 整理的範本」整理子項；關閉或失敗時用固定格式（狀態變更、留言第一行）">
            <Toggle checked={cfg.jira_activity?.ai_items !== false} onChange={(v) => set('jira_activity.ai_items', v)} />
          </Row>
          <Row label="忽略的欄位" hint="這些欄位的變更不算你的活動（例如排序 Rank、Sprint）">
            <ListEditor values={cfg.jira_activity?.ignore_fields ?? []} onChange={(v) => set('jira_activity.ignore_fields', v)} placeholder="Rank" />
          </Row>
        </>
      )}
      <Row label="從 Jira 整理的範本" hint="手動任務按「從 Jira 整理」時，用來把當天留言整理成子項的範本">
        <Select {...bind('summary.jira_prompt')}>
          {summaryPrompts.map((p) => (
            <option key={p.ref} value={p.ref}>
              {p.title}
              {p.builtin ? '（內建）' : ''}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Jira MCP 名稱" hint="查詢大型工作、「從 Jira 整理」時，claude CLI 透過這個 MCP 讀取 Jira（claude mcp list 中的名稱）">
        <Input className="font-mono" {...bind('claude_cli.jira_mcp_server')} placeholder="atlassian-rovo-mcp" />
      </Row>
    </Section>
  );
}

function IntegrationSection({ bind }: { cfg: Cfg; bind: (p: string) => object }) {
  const toast = useToast();
  const health = useQuery({ queryKey: ['health'], queryFn: () => get('/api/health') });
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null);
  const checks: { id: string; label: string; ok: boolean; detail?: string; fix?: string; optional?: boolean }[] = health.data?.checks ?? [];
  const service = async (action: 'stop' | 'restart') => {
    try {
      await post(action === 'stop' ? '/api/shutdown' : '/api/restart');
      toast.show({ message: action === 'stop' ? '服務已停止。點擊 Worktrail 捷徑可重新啟動。' : '服務重新啟動中…', duration: 6000 });
      if (action === 'restart') setTimeout(() => location.reload(), 3000);
    } catch (e) {
      if (!(e instanceof ApiError)) toast.show({ message: '服務已停止' });
    }
  };
  return (
    <Section id="integration" title="整合">
      <Row label="claude CLI 路徑" hint="UI 一鍵產生報告與補寫摘要時使用。空白表示從 PATH 自動尋找">
        <div className="flex gap-2">
          <Input className="font-mono" {...bind('claude_cli.path')} placeholder="自動尋找" />
          <Button onClick={() => void health.refetch()} loading={health.isFetching}>
            測試
          </Button>
        </div>
      </Row>
      <div>
        <div className="mb-2 text-sm font-medium">安裝狀態</div>
        {health.isLoading ? (
          <Skeleton className="h-40" />
        ) : (
          <ul className="divide-y divide-line rounded-ctl border border-line">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : c.optional ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
                <div className="min-w-0 flex-1">
                  <div>{c.label}</div>
                  {c.detail && <div className="truncate font-mono text-xs text-ink-3" title={c.detail}>{c.detail}</div>}
                  {!c.ok && c.fix && <div className="text-xs text-ink-2">→ {c.fix}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {(health.data?.recent_errors?.length ?? 0) > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-ink-2">最近的錯誤與警告（{health.data.recent_errors.length}）</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-ctl bg-hover p-2 font-mono whitespace-pre-wrap">{health.data.recent_errors.join('\n')}</pre>
          </details>
        )}
      </div>
      <AutostartRow />
      <Row label="補漏掃描" hint="平常由 hook 即時擷取，並在每天補漏時間自動掃描。對話結束後一直沒出現紀錄時，可以手動掃描一次。">
        <div>
          <SweepButton />
        </div>
      </Row>
      <Row label="常駐服務" hint={`pid ${health.data?.pid ?? '?'}。關閉 UI 視窗不會停止服務，自動擷取與補漏排程會繼續運作。`}>
        <div className="flex gap-2">
          <Button icon={<RotateCw className="size-4" />} onClick={() => setConfirm('restart')}>
            重新啟動服務
          </Button>
          <Button variant="danger" icon={<Power className="size-4" />} onClick={() => setConfirm('stop')}>
            停止服務
          </Button>
        </div>
      </Row>
      <Confirm
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm === 'stop' ? '停止服務' : '重新啟動服務'}
        danger={confirm === 'stop'}
        message={confirm === 'stop' ? '停止後 UI 將無法使用，每日補漏掃描也會暫停（hook 擷取不受影響）。' : '服務會在幾秒內重新啟動。'}
        onConfirm={() => confirm && void service(confirm)}
      />
    </Section>
  );
}

/** 開機自動啟動：一鍵安裝預設開啟，這裡可以關閉或重新開啟 */
function AutostartRow() {
  const q = useQuery({ queryKey: ['autostart'], queryFn: () => get<{ supported: boolean; enabled: boolean }>('/api/autostart') });
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!q.data?.supported) return null;
  return (
    <Row label="開機自動啟動" hint="開機後在背景啟動服務，每日補漏掃描與 UI 才會隨時可用。hook 擷取不受影響。">
      <Toggle
        checked={q.data.enabled}
        disabled={busy}
        onChange={async (v) => {
          setBusy(true);
          try {
            const r = await put<{ enabled: boolean }>('/api/autostart', { enabled: v });
            qc.setQueryData(['autostart'], { supported: true, enabled: r.enabled });
          } catch (e) {
            toast.show({ tone: 'error', message: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      />
    </Row>
  );
}
