/**
 * 與常駐服務溝通（規格 12）。token 由服務注入頁面。
 */
declare global {
  interface Window {
    __WORKTRAIL__?: { token: string; port: number };
  }
}

const token = () => window.__WORKTRAIL__?.token ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401) reloadForNewToken();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data?.data);
  return data as T;
}

/** 服務重新啟動後 token 會換新：重新載入頁面取得新 token（10 秒內只重試一次，避免迴圈） */
function reloadForNewToken() {
  try {
    const last = Number(sessionStorage.getItem('wt.reload') ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('wt.reload', String(Date.now()));
  } catch {
    // 無法使用 sessionStorage 時仍嘗試重新載入一次
  }
  location.reload();
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

export function eventSource(): EventSource {
  return new EventSource(`/api/events?token=${encodeURIComponent(token())}`);
}

// ───────────── 型別（與後端一致）

export type ItemStatus = 'done' | 'pending' | 'todo' | 'skipped' | 'blocked';
export interface Item {
  text: string;
  status: ItemStatus;
  note?: string;
}
export interface Task {
  id: string;
  session_id: string;
  date: string;
  project: string;
  /** 設定中專案的固定 ID */
  project_id?: string;
  project_unmapped?: boolean;
  ticket: string | null;
  related_tickets: string[];
  title: string;
  title_source?: string;
  repo: string;
  branch: string;
  first_activity?: string;
  last_activity?: string;
  active_minutes: number;
  hours: number;
  hours_overridden: boolean;
  hours_source: 'computed' | 'ai' | 'user';
  /** AI 原本的粗估；hours 是依每日工時調整後的值 */
  hours_estimate?: number;
  locked_fields: ('project' | 'ticket')[];
  commits: { sha: string; message: string }[];
  summary_status: 'draft' | 'done' | 'stale';
  summary_updated_at?: string;
  summary_prompt?: string;
  items: Item[];
  body: string;
  /** 手動新增（不在 Claude Code 中進行的工作） */
  manual?: boolean;
  /** jira＝由 Jira 每日活動同步自動建立 */
  source?: 'jira';
  /** 已合併：同一天、同專案、帶此標記的任務顯示為一筆 */
  merged?: boolean;
  path: string;
  version: string;
}

export interface Stats {
  total_hours: number;
  days_worked: number;
  task_count: number;
  ticket_count: number;
  hours_by_project: { project: string; hours: number; ratio: number }[];
  hours_by_ticket: { ticket: string; title: string; hours: number }[];
  hours_by_date: { date: string; hours: number }[];
  items_by_status: Record<ItemStatus, number>;
  completion_rate: number | null;
  open_items: { ticket: string | null; text: string; status: ItemStatus; note?: string; date: string }[];
}

export interface Period {
  start: string;
  end: string;
}

export interface ReportListItem {
  id: string;
  period: Period;
  label: string;
  status: 'none' | 'generated' | 'edited' | 'stale';
  task_count: number;
}

export interface Report {
  id: string;
  type: 'weekly' | 'performance';
  period_start: string;
  period_end: string;
  prompt: string;
  prompt_hash: string;
  body: string;
  edited: boolean;
  stale: boolean;
  generated_at: string;
  version: string;
}

export interface PromptInfo {
  ref: string;
  type: 'summary' | 'weekly' | 'performance' | 'talk';
  name: string;
  title: string;
  description: string;
  body: string;
  hash: string;
  builtin: boolean;
}

export interface TalkListItem {
  id: string;
  title: string;
  label: string;
  dates: string[];
  status: 'none' | 'generated' | 'edited' | 'stale';
  created_at: string;
}

export interface Talk {
  id: string;
  title: string;
  label: string;
  dates: string[];
  prompt: string;
  prompt_hash: string;
  body: string;
  edited: boolean;
  stale: boolean;
  created_at: string;
  generated_at?: string;
  version: string;
}

export interface Job {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress?: string;
  result?: any;
  error?: string;
}
