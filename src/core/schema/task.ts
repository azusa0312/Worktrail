import { z } from 'zod';

/** 規格 4.3：子項狀態 */
export const ITEM_STATUSES = ['done', 'pending', 'todo', 'skipped', 'blocked'] as const;
export const ItemStatus = z.enum(ITEM_STATUSES);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  done: '完成',
  pending: '待進行',
  todo: '未開始',
  skipped: '暫不處理',
  blocked: '卡住',
};

/** 未完成狀態（carry over、open_items 用） */
export const OPEN_STATUSES: readonly ItemStatus[] = ['pending', 'todo', 'blocked'];

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD');
export const IsoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, '時間須為含時區的 ISO 8601');

export const Item = z
  .object({
    text: z.string().trim().min(1).max(200),
    status: ItemStatus,
    note: z.string().trim().min(1).optional(),
  })
  .refine((i) => !(i.status === 'skipped' || i.status === 'blocked') || !!i.note, {
    message: 'skipped 與 blocked 必須填寫 note（原因）',
    path: ['note'],
  });
export type Item = z.infer<typeof Item>;

export const Commit = z.object({
  sha: z.string().min(4),
  message: z.string(),
});
export type Commit = z.infer<typeof Commit>;

export const SummaryStatus = z.enum(['draft', 'done', 'stale']);
export type SummaryStatus = z.infer<typeof SummaryStatus>;

/** 使用者在 UI 改過後由擷取程式不再覆寫的共用欄位（hours 另以 hours_overridden 標記） */
export const LockableField = z.enum(['project', 'ticket']);
export type LockableField = z.infer<typeof LockableField>;

/** 規格 4.2：任務檔前段 YAML */
export const TaskFrontmatter = z.object({
  schema: z.literal(1),
  id: z.string().min(1),
  session_id: z.string().min(1),
  date: IsoDate,
  // 共用欄位
  /** 專案名稱（顯示用）；有 project_id 時跟著設定中的專案名稱更新 */
  project: z.string().default(''),
  /** 設定中專案規則的固定 ID；自由輸入或未對應的專案沒有 */
  project_id: z.string().optional(),
  project_unmapped: z.boolean().optional(),
  ticket: z.string().nullable().default(null),
  related_tickets: z.array(z.string()).default([]),
  hours: z.number().min(0).max(24).default(0),
  hours_overridden: z.boolean().default(false),
  /** hours 的來源：系統計算、AI 粗估（摘要時）、使用者修改。採用順序 user > ai > computed */
  hours_source: z.enum(['computed', 'ai', 'user']).default('computed'),
  /** AI 原本的粗估；hours 是依每日工時調整後的值（見 sync/day-hours.ts） */
  hours_estimate: z.number().min(0).max(24).optional(),
  locked_fields: z.array(LockableField).default([]),
  // 摘要欄位
  title: z.string().default(''),
  /** 標題來源；summary 以外的來源在摘要寫入前可被擷取程式更新 */
  title_source: z.enum(['summary', 'jira', 'custom_title', 'first_user_message', 'user']).optional(),
  items: z.array(Item).max(30).default([]),
  summary_status: SummaryStatus.default('draft'),
  summary_updated_at: IsoDateTime.optional(),
  summary_prompt: z.string().optional(),
  summary_prompt_hash: z.string().optional(),
  /** 使用者手動新增（不在 Claude Code 中進行的工作），沒有對話紀錄，擷取程式不會碰它 */
  manual: z.boolean().optional(),
  /** 任務來源：jira＝由「Jira 每日活動同步」自動建立（同時是 manual） */
  source: z.enum(['jira']).optional(),
  /** Jira 同步的指紋：events_hash 判斷活動有沒有變化，content_hash 判斷使用者有沒有改過 */
  jira_sync: z.object({ events_hash: z.string(), content_hash: z.string() }).optional(),
  /** 已合併：同一天、同專案、帶此標記的任務在清單與報告中視為一筆（見 sync/task-merge.ts） */
  merged: z.boolean().optional(),
  // 擷取欄位
  repo: z.string().default(''),
  branch: z.string().default(''),
  first_activity: IsoDateTime.optional(),
  last_activity: IsoDateTime.optional(),
  active_minutes: z.number().min(0).default(0),
  commits: z.array(Commit).default([]),
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;

export interface Task extends TaskFrontmatter {
  /** Markdown 內文（補充說明） */
  body: string;
}

/** 規格 4.1：檔名 `日期__單號__session 前 6 碼` */
export function taskId(date: string, ticket: string | null | undefined, sessionId: string): string {
  const t = ticket && ticket.trim() ? ticket.trim() : 'no-ticket';
  return `${date}__${t}__${sessionId.replace(/-/g, '').slice(0, 6)}`;
}
