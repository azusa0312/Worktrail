/**
 * Jira 每日活動同步：把「我當天在 Jira 上動過、但 Claude Code 沒涵蓋到」的單補成 Worktrail 任務。
 *
 * - 抓取由常駐服務以 `claude -p` 透過使用者已連線的 Jira MCP 進行（規格 1.3），模型只回原始 JSON。
 * - 這裡只做純程式判斷：事件過濾（作者、時區日期、忽略欄位）、內容整理、與既有任務合併的規劃、同步狀態。
 * - 設計見 docs/DECISIONS.md「Jira 每日活動同步」。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { addDays, localDate } from '../capture/tz.js';
import { weekday } from '../period/index.js';
import type { Config } from '../schema/config.js';
import { taskId, type Item, type Task } from '../schema/task.js';
import { readText, withLock, writeFileAtomic } from '../storage/fsutil.js';
import type { StoragePaths } from '../storage/paths.js';
import { createdLocalDate } from '../summary/jira.js';
import { maskSecrets } from '../summary/index.js';
import { emptyTask } from '../sync/merge.js';

// ───────────── 抓取（claude -p 指示與輸出）

/** 一次 claude -p 讀取的單號數上限 */
export const ISSUE_BATCH = 8;
/** 候選單號上限（超過時只處理最近更新的） */
export const MAX_CANDIDATES = 50;

export function candidatesAllowedTools(server: string): string[] {
  return ['atlassianUserInfo', 'getAccessibleAtlassianResources', 'searchJiraIssuesUsingJql'].map((t) => `mcp__${server}__${t}`);
}

export function issuesAllowedTools(server: string): string[] {
  return ['getAccessibleAtlassianResources', 'getJiraIssue'].map((t) => `mcp__${server}__${t}`);
}

const q = (s: string) => `"${s}"`;

/** 候選單號的 JQL（日期為絕對字串，見計畫書 3.1） */
export function candidatesJql(date: string, projectKeys: readonly string[], includeWatched: boolean): string {
  const from = `${date} 00:00`;
  const to = `${addDays(date, 1)} 00:00`;
  const who = [
    'reporter = currentUser()',
    'assignee = currentUser()',
    ...(includeWatched ? ['issue in watchedIssues()'] : []),
    `status changed BY currentUser() DURING (${q(from)}, ${q(to)})`,
  ].join(' OR ');
  const proj = projectKeys.length ? ` AND project in (${projectKeys.join(', ')})` : '';
  return `(${who})${proj} AND updated >= ${q(from)} ORDER BY updated DESC`;
}

export function createdJql(date: string, projectKeys: readonly string[]): string {
  const proj = projectKeys.length ? ` AND project in (${projectKeys.join(', ')})` : '';
  return `reporter = currentUser()${proj} AND created >= ${q(`${date} 00:00`)} AND created < ${q(`${addDays(date, 1)} 00:00`)}`;
}

export function buildCandidatesPrompt(date: string, server: string, projectKeys: readonly string[], includeWatched: boolean): string {
  return `請用 Jira MCP（${server}）查詢資料，不要修改任何 Jira 資料。

步驟：
1. 呼叫 atlassianUserInfo 取得目前使用者的 accountId。
2. 呼叫 getAccessibleAtlassianResources 取得 cloudId（選有 read:jira-work 權限的站台）。
3. 呼叫 searchJiraIssuesUsingJql：jql 原樣使用下面這行，fields=["summary"]，maxResults=${MAX_CANDIDATES}。
   ${candidatesJql(date, projectKeys, includeWatched)}
4. 呼叫 searchJiraIssuesUsingJql：jql 原樣使用下面這行，fields=["summary"]，maxResults=${MAX_CANDIDATES}。
   ${createdJql(date, projectKeys)}

只輸出一個 JSON 物件，不要有其他文字或 Markdown 程式碼框：
{"account_id": "步驟 1 的 accountId", "candidates": [{"key": "單號", "summary": "標題"}], "created_keys": ["步驟 4 查到的單號"]}
查詢失敗時輸出 {"error": "原因（含工具回傳的錯誤訊息）"}。`;
}

/**
 * 讀取單號：只請模型呼叫工具，不轉述內容。程式從 stream-json 直接取得 getJiraIssue 的原始回傳
 * （見 claude-cli 的 toolResultsFromStream 與 issuesFromRaw）。
 * 以前請模型把留言與 changelog 轉成 JSON 輸出，單子變更多時常被截斷（「JSON 不完整」）或放棄（「找不到 JSON」）。
 */
export function buildIssuesPrompt(keys: readonly string[], server: string): string {
  return `請用 Jira MCP（${server}）讀取下列 Jira 單號，不要修改任何 Jira 資料。

單號：${keys.join(', ')}

步驟：
1. 呼叫 getAccessibleAtlassianResources 取得 cloudId（選有 read:jira-work 權限的站台）。
2. 對每個單號各呼叫一次 getJiraIssue：issueIdOrKey=單號、fields=["summary","status","issuetype","comment"]、expand="changelog"、responseContentFormat="markdown"。

結果由程式直接讀取工具回傳：不需要閱讀、整理或轉述內容（回傳被存成檔案時也不要去讀檔），每個單號都呼叫過後只回覆 OK。`;
}

/** ADF（Atlassian Document Format）物件轉純文字；沒有要求 markdown 時留言會是這種格式 */
function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type ?? '') ? `${inner}\n` : inner;
}

/**
 * 把 getJiraIssue 的原始回傳（`{issues:{nodes:[…]}}` 或單一 issue 物件）轉成 JiraIssueData。
 * 留言與變更紀錄全部保留，由 myEventsOn 依作者與日期過濾。
 */
export function issuesFromRaw(raw: unknown): JiraIssueData[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const issuesField = r.issues as { nodes?: unknown[] } | unknown[] | undefined;
  const nodes: unknown[] = Array.isArray(issuesField)
    ? issuesField
    : Array.isArray(issuesField?.nodes)
      ? issuesField.nodes
      : typeof r.key === 'string'
        ? [r]
        : [];
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const out: JiraIssueData[] = [];
  for (const node of nodes) {
    const n = node as {
      key?: unknown;
      fields?: Record<string, any>;
      changelog?: { histories?: any[] };
    };
    if (typeof n?.key !== 'string' || !n.key) continue;
    const f = n.fields ?? {};
    const comments = Array.isArray(f.comment?.comments) ? f.comment.comments : Array.isArray(f.comment) ? f.comment : [];
    out.push(
      JiraIssueData.parse({
        key: n.key,
        summary: s(f.summary),
        type: s(f.issuetype?.name),
        status: s(f.status?.name),
        comments: comments.map((c: any) => ({
          author_id: s(c?.author?.accountId),
          author: s(c?.author?.displayName),
          created: s(c?.created),
          body: adfText(c?.body).trim(),
        })),
        histories: (n.changelog?.histories ?? []).map((h: any) => ({
          author_id: s(h?.author?.accountId),
          author: s(h?.author?.displayName),
          created: s(h?.created),
          items: (Array.isArray(h?.items) ? h.items : []).map((i: any) => ({
            field: s(i?.field),
            from: s(i?.fromString),
            to: s(i?.toString),
          })),
        })),
      }),
    );
  }
  return out;
}

export const CandidatesOutput = z.object({
  account_id: z.string().min(1),
  candidates: z.array(z.object({ key: z.string(), summary: z.string().default('') })).default([]),
  created_keys: z.array(z.string()).default([]),
});
export type CandidatesOutput = z.infer<typeof CandidatesOutput>;

const str = z.string().nullish().transform((v) => v ?? '');

export const JiraHistory = z.object({
  author_id: str,
  author: str,
  created: str,
  items: z.array(z.object({ field: str, from: str, to: str })).default([]),
});
export const JiraIssueComment = z.object({ author_id: str, author: str, created: str, body: str });

export const JiraIssueData = z.object({
  key: z.string().min(1),
  summary: str,
  type: str,
  status: str,
  comments: z.array(JiraIssueComment).default([]),
  histories: z.array(JiraHistory).default([]),
});
export type JiraIssueData = z.infer<typeof JiraIssueData>;

export const IssuesOutput = z.object({
  issues: z.array(JiraIssueData).default([]),
  errors: z.array(z.object({ key: z.string(), error: z.string().default('查詢失敗') })).default([]),
});
export type IssuesOutput = z.infer<typeof IssuesOutput>;

export const normKey = (k: string) => k.trim().toUpperCase();

// ───────────── 事件

export type JiraEventKind = 'created' | 'status' | 'comment' | 'field';

export const JiraEvent = z.object({
  kind: z.enum(['created', 'status', 'comment', 'field']),
  /** ISO 時間（建立單沒有確切時間時為空字串） */
  time: z.string().default(''),
  field: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** 留言內文（已遮蔽密鑰，最多 1000 字） */
  text: z.string().optional(),
});
export type JiraEvent = z.infer<typeof JiraEvent>;

export interface JiraActivity {
  ticket: string;
  summary: string;
  type: string;
  status: string;
  events: JiraEvent[];
}

const COMMENT_MAX = 1000;

/** 留言轉成純文字摘錄：去掉圖片、連結語法與 mention 標記 */
export function cleanCommentText(body: string): string {
  return body
    // 圖片（含被截斷、沒有右括號的連結）
    .replace(/!\[[^\]]*\]\([^)]*(?:\)|$)/g, '')
    .replace(/（已截斷[^）]*）/g, '')
    .replace(/<custom[^>]*>([^<]*)<\/custom>/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\([_*[\]()#+\-.!])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 從一張單取出「我在 date 當天」的事件，依時間排序 */
export function myEventsOn(
  issue: JiraIssueData,
  accountId: string,
  date: string,
  tz: string,
  opts: { ignoreFields: readonly string[]; createdKeys: ReadonlySet<string> },
): JiraEvent[] {
  const ignore = new Set(opts.ignoreFields.map((f) => f.trim().toLowerCase()));
  const onDate = (created: string) => createdLocalDate(created, tz) === date;
  const events: JiraEvent[] = [];
  if (opts.createdKeys.has(normKey(issue.key))) events.push({ kind: 'created', time: '' });
  for (const h of issue.histories) {
    if (h.author_id !== accountId || !onDate(h.created)) continue;
    // 同一次變更裡同欄位的多個項目（例如一次上傳多張附件）合併成一筆
    const byField = new Map<string, { from: string; to: string; n: number }>();
    for (const it of h.items) {
      const field = it.field.trim();
      if (!field || ignore.has(field.toLowerCase())) continue;
      if (field.toLowerCase() === 'status') {
        events.push({ kind: 'status', time: h.created, from: it.from, to: it.to });
        continue;
      }
      const g = byField.get(field);
      if (g) g.n++;
      else byField.set(field, { from: it.from, to: it.to, n: 1 });
    }
    for (const [field, g] of byField) {
      events.push(
        g.n > 1
          ? { kind: 'field', time: h.created, field, to: `${g.to || g.from} 等 ${g.n} 項` }
          : { kind: 'field', time: h.created, field, from: g.from, to: g.to },
      );
    }
  }
  for (const c of issue.comments) {
    if (c.author_id !== accountId || !onDate(c.created)) continue;
    const text = maskSecrets(cleanCommentText(c.body)).text.slice(0, COMMENT_MAX);
    if (text) events.push({ kind: 'comment', time: c.created, text });
  }
  const ts = (e: JiraEvent) => (e.time ? Date.parse(e.time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : 0);
  return events.sort((a, b) => ts(a) - ts(b));
}

/** 整理所有單號當天的活動；沒有我的事件的單號不列入 */
export function collectActivities(args: {
  candidates: CandidatesOutput;
  issues: readonly JiraIssueData[];
  date: string;
  tz: string;
  ignoreFields: readonly string[];
}): JiraActivity[] {
  const createdKeys = new Set(args.candidates.created_keys.map(normKey));
  const out: JiraActivity[] = [];
  for (const issue of args.issues) {
    const events = myEventsOn(issue, args.candidates.account_id, args.date, args.tz, {
      ignoreFields: args.ignoreFields,
      createdKeys,
    });
    if (!events.length) continue;
    out.push({ ticket: normKey(issue.key), summary: issue.summary, type: issue.type, status: issue.status, events });
  }
  return out.sort((a, b) => a.ticket.localeCompare(b.ticket));
}

/** 被建立但沒在候選清單裡的單號也要讀取（理論上不會發生，保險） */
export function keysToFetch(c: CandidatesOutput): string[] {
  return [...new Set([...c.candidates.map((x) => normKey(x.key)), ...c.created_keys.map(normKey)])].slice(0, MAX_CANDIDATES);
}

// ───────────── 內容整理

const hhmm = (iso: string, tz: string): string => {
  const ts = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(ts)) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
};

function eventLine(e: JiraEvent, tz: string): string {
  const at = e.time ? `（${hhmm(e.time, tz)}）` : '';
  switch (e.kind) {
    case 'created':
      return '建立這張單';
    case 'status':
      return `狀態 ${e.from || '—'} → ${e.to || '—'}${at}`;
    case 'field':
      return e.from && e.to ? `${e.field}：${e.from} → ${e.to}${at}` : `${e.field}：${e.to || e.from || '更新'}${at}`;
    case 'comment':
      return `留言${at}：\n${e.text ?? ''}`;
  }
}

/** 給摘要範本的「內容」區塊（見 summary/jira 範本） */
export function activityContent(a: JiraActivity, date: string, tz: string): string {
  const head = `以下是我在 ${date} 對 Jira 單號 ${a.ticket}${a.summary ? `「${a.summary}」` : ''}的操作紀錄（不是對話紀錄）。請依這些紀錄整理當天的工作子項，不要編造紀錄中沒有的內容。`;
  return `${head}\n\n${a.events.map((e) => `- ${eventLine(e, tz)}`).join('\n')}`;
}

const firstLine = (s: string, max: number) => {
  const line = s.split('\n').map((l) => l.replace(/^[#>*\-+\s]+/, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** 不經 AI 的固定格式子項（AI 關閉或失敗時使用） */
export function fallbackItems(a: JiraActivity): Item[] {
  const items: Item[] = [];
  const fields = new Set<string>();
  for (const e of a.events) {
    if (e.kind === 'created') items.push({ text: `建立 ${a.ticket}`, status: 'done' });
    else if (e.kind === 'status') items.push({ text: `狀態 ${e.from || '—'} → ${e.to || '—'}`, status: 'done' });
    else if (e.kind === 'comment') {
      const t = firstLine(e.text ?? '', 60);
      if (t) items.push({ text: `留言：${t}`, status: 'done' });
    } else if (e.field) fields.add(e.field);
  }
  if (fields.size) items.push({ text: `更新欄位：${[...fields].join('、')}`.slice(0, 200), status: 'done' });
  return items.slice(0, 10);
}

/** 附加到既有任務補充說明的區塊 */
export const NOTE_START = '<!-- worktrail:jira-activity -->';
export const NOTE_END = '<!-- /worktrail:jira-activity -->';

export function activityNote(activities: readonly JiraActivity[], tz: string): string {
  const lines = activities.flatMap((a) => [
    `**Jira 活動 ${a.ticket}**`,
    ...a.events.map((e) => `- ${eventLine(e, tz).replace(/：\n/, '：').replace(/\n+/g, ' ').slice(0, 300)}`),
  ]);
  return `${NOTE_START}\n${lines.join('\n')}\n${NOTE_END}`;
}

/** 把 Jira 活動區塊放進補充說明（取代舊的區塊）；note 為空字串時移除區塊 */
export function mergeNote(body: string, note: string): string {
  const start = body.indexOf(NOTE_START);
  const end = body.indexOf(NOTE_END);
  let rest = body;
  if (start >= 0 && end > start) rest = `${body.slice(0, start)}${body.slice(end + NOTE_END.length)}`;
  rest = rest.replace(/\n{3,}/g, '\n\n').trim();
  if (!note) return rest;
  return rest ? `${rest}\n\n${note}` : note;
}

/**
 * 只更新補充說明中這幾張單的 Jira 活動段落，保留其他單的段落
 * （重試部分讀取失敗的單時使用，避免把先前附加的其他單蓋掉）。
 */
export function upsertNoteTickets(body: string, activities: readonly JiraActivity[], tz: string): string {
  const start = body.indexOf(NOTE_START);
  const end = body.indexOf(NOTE_END);
  const sections = new Map<string, string[]>();
  if (start >= 0 && end > start) {
    let cur: string[] | undefined;
    for (const line of body.slice(start + NOTE_START.length, end).split('\n')) {
      const m = /^\*\*Jira 活動 (\S+)\*\*$/.exec(line.trim());
      if (m) sections.set(m[1]!, (cur = [line.trim()]));
      else if (cur && line.trim()) cur.push(line);
    }
  }
  for (const a of activities) {
    const block = activityNote([a], tz);
    sections.set(a.ticket, block.slice(NOTE_START.length + 1, block.length - NOTE_END.length - 1).split('\n'));
  }
  const lines = [...sections.values()].flat();
  return mergeNote(body, lines.length ? NOTE_START + '\n' + lines.join('\n') + '\n' + NOTE_END : '');
}

// ───────────── 任務

/** Jira 任務的 session_id：同一天同單號固定，重跑時更新同一筆 */
export function jiraSessionId(date: string, ticket: string): string {
  return createHash('sha1').update(`jira|${date}|${normKey(ticket)}`).digest('hex');
}

/** 使用者是否改過自動產生的內容（標題、子項、時數） */
export function contentHash(t: Pick<Task, 'title' | 'items' | 'hours'>): string {
  return createHash('sha1')
    .update(JSON.stringify([t.title, t.items.map((i) => [i.text, i.status, i.note ?? '']), t.hours]))
    .digest('hex')
    .slice(0, 12);
}

/** 事件內容的指紋：沒變就不必重新整理子項 */
export function eventsHash(a: JiraActivity): string {
  return createHash('sha1').update(JSON.stringify([a.summary, a.events])).digest('hex').slice(0, 12);
}

export const isUserEdited = (t: Task) => !!t.jira_sync && contentHash(t) !== t.jira_sync.content_hash;

/** 新的 Jira 任務（尚未有子項；子項由呼叫端產生後以 withJiraItems 填入） */
export function newJiraTask(a: JiraActivity, date: string, config: Pick<Config, 'jira_activity'>): Task {
  const sessionId = jiraSessionId(date, a.ticket);
  const base = emptyTask(sessionId, date);
  return {
    ...base,
    id: taskId(date, a.ticket, sessionId),
    manual: true,
    source: 'jira',
    ticket: a.ticket,
    title: maskSecrets(a.summary || a.ticket).text,
    title_source: 'jira',
    hours: config.jira_activity.default_hours,
    hours_overridden: true,
    hours_source: 'user',
    summary_status: 'done',
    summary_prompt: 'none',
  };
}

/** 填入子項並記錄指紋（之後用來判斷使用者有沒有改過） */
export function withJiraItems(t: Task, a: JiraActivity, items: Item[], tz: string): Task {
  const next: Task = {
    ...t,
    items,
    summary_status: 'done',
    summary_updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    body: mergeNote(t.body, activityNote([a], tz)),
  };
  next.jira_sync = { events_hash: eventsHash(a), content_hash: contentHash(next) };
  return next;
}

// ───────────── 合併規劃

export type SyncAction =
  /** 新增 Jira 任務 */
  | { kind: 'create'; activity: JiraActivity }
  /** 更新既有的 Jira 任務（使用者沒改過、活動有變化） */
  | { kind: 'update'; activity: JiraActivity; taskId: string }
  /** 同單號已有 Claude 或手動任務：把活動附加到它的補充說明 */
  | { kind: 'append'; activities: JiraActivity[]; taskId: string }
  /** 先前建的 Jira 任務已被 Claude 任務涵蓋（且使用者沒改過）：移除 */
  | { kind: 'remove'; taskId: string }
  /** 不處理：原因供記錄 */
  | { kind: 'skip'; ticket: string; reason: 'edited' | 'unchanged' | 'dismissed' };

type PlanTask = Pick<Task, 'id' | 'ticket' | 'related_tickets' | 'source' | 'jira_sync' | 'title' | 'items' | 'hours' | 'body'>;

const touches = (t: PlanTask, key: string) =>
  normKey(t.ticket ?? '') === key || t.related_tickets.some((r) => normKey(r) === key);

export function planJiraSync(args: {
  date: string;
  activities: readonly JiraActivity[];
  /** 當天所有任務 */
  tasks: readonly PlanTask[];
  /** 先前在這一天自動建立過的單號（檔案不在了＝使用者刪除） */
  previouslyCreated: readonly string[];
  dismissed: readonly string[];
}): SyncAction[] {
  const actions: SyncAction[] = [];
  const appendTo = new Map<string, JiraActivity[]>();
  const dismissed = new Set(args.dismissed);
  const prev = new Set(args.previouslyCreated.map(normKey));
  for (const a of args.activities) {
    const key = a.ticket;
    const own = args.tasks.find((t) => t.source === 'jira' && normKey(t.ticket ?? '') === key);
    const covering = args.tasks.find((t) => t.source !== 'jira' && touches(t, key));
    if (covering) {
      appendTo.set(covering.id, [...(appendTo.get(covering.id) ?? []), a]);
      if (own && !isUserEdited(own as Task)) actions.push({ kind: 'remove', taskId: own.id });
      continue;
    }
    if (own) {
      if (isUserEdited(own as Task)) actions.push({ kind: 'skip', ticket: key, reason: 'edited' });
      else if (own.jira_sync?.events_hash === eventsHash(a)) actions.push({ kind: 'skip', ticket: key, reason: 'unchanged' });
      else actions.push({ kind: 'update', activity: a, taskId: own.id });
      continue;
    }
    if (dismissed.has(dismissKey(args.date, key)) || prev.has(key)) {
      actions.push({ kind: 'skip', ticket: key, reason: 'dismissed' });
      continue;
    }
    actions.push({ kind: 'create', activity: a });
  }
  for (const [taskId, activities] of appendTo) actions.push({ kind: 'append', taskId, activities });
  return actions;
}

export const dismissKey = (date: string, ticket: string) => `${date}:${normKey(ticket)}`;

// ───────────── 同步狀態檔

const DayState = z.object({
  synced_at: z.string(),
  /** 這次同步找到的活動單號 */
  tickets: z.array(z.string()).default([]),
  /** 自動建立過 Jira 任務的單號（累積） */
  created: z.array(z.string()).default([]),
  /** 整次同步失敗的原因（部分單號失敗時為 null，改記在 failed） */
  error: z.string().nullable().default(null),
  /** 讀取失敗的單號：只列出、不自動重試，由使用者決定要不要重試 */
  failed: z.array(z.object({ key: z.string(), error: z.string() })).default([]),
  /** 連續整次失敗的次數（自動重試上限用） */
  attempts: z.number().int().default(0),
});
export type DayState = z.infer<typeof DayState>;

const SyncFile = z.object({
  schema: z.literal(1).default(1),
  days: z.record(z.string(), DayState).default({}),
  dismissed: z.array(z.string()).default([]),
});
export type SyncState = z.infer<typeof SyncFile>;

export const syncStatePath = (paths: StoragePaths) => join(paths.internal, 'jira-sync.json');

export function readSyncState(paths: StoragePaths): SyncState {
  const text = readText(syncStatePath(paths));
  const empty: SyncState = { schema: 1, days: {}, dismissed: [] };
  if (!text) return empty;
  try {
    const r = SyncFile.safeParse(JSON.parse(text));
    return r.success ? r.data : empty;
  } catch {
    return empty;
  }
}

export async function updateSyncState<T>(paths: StoragePaths, fn: (s: SyncState) => T): Promise<T> {
  const file = syncStatePath(paths);
  return withLock(file, () => {
    const s = readSyncState(paths);
    const r = fn(s);
    // 只保留最近 90 天的紀錄
    const keep = Object.keys(s.days).sort().slice(-90);
    s.days = Object.fromEntries(keep.map((d) => [d, s.days[d]!]));
    s.dismissed = s.dismissed.filter((k) => k.slice(0, 10) >= (keep[0] ?? '')).slice(-500);
    writeFileAtomic(file, `${JSON.stringify(s, null, 2)}\n`);
    return r;
  });
}

// ───────────── 排程

const isWeekend = (date: string) => {
  const w = weekday(date);
  return w === 0 || w === 6;
};

/**
 * 需要同步的日期（舊到新）：
 * - 過去 lookback_days 內的工作日：尚未在「那天結束之後」成功同步過（當天 18:00 同步後的工作也要補上）。
 * - 今天：已過同步時間且今天還沒同步過。
 * - 失敗的日期一小時後才重試。
 */
/** 整次同步失敗時，自動重試的總次數上限（含第一次） */
export const MAX_AUTO_ATTEMPTS = 2;

export function datesNeedingSync(args: {
  state: SyncState;
  now: number;
  tz: string;
  config: Pick<Config, 'jira_activity'>;
}): string[] {
  const { state, now, tz } = args;
  const cfg = args.config.jira_activity;
  if (!cfg.enabled) return [];
  const today = localDate(now, tz);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const out: string[] = [];
  // 整次失敗：一小時後自動重試，最多 MAX_AUTO_ATTEMPTS 次；部分單號失敗不自動重試（只列出）
  const recentFailure = (d: DayState) =>
    !!d.error && (d.attempts >= MAX_AUTO_ATTEMPTS || now - Date.parse(d.synced_at) < 60 * 60_000);
  for (let i = cfg.lookback_days; i >= 1; i--) {
    const date = addDays(today, -i);
    if (cfg.skip_weekends && isWeekend(date)) continue;
    const d = state.days[date];
    if (d && recentFailure(d)) continue;
    const final = d && !d.error && localDate(Date.parse(d.synced_at), tz) > date;
    if (!final) out.push(date);
  }
  if (hm >= cfg.time && !(cfg.skip_weekends && isWeekend(today))) {
    const d = state.days[today];
    if (!d || (d.error && !recentFailure(d))) out.push(today);
  }
  return out;
}
