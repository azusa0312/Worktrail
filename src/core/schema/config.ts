import { createHash } from 'node:crypto';
import { z } from 'zod';

const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間格式須為 HH:mm');

export const ProjectRuleInput = z.object({
  /** 固定 ID：專案改名時任務靠它跟著更新（見 DECISIONS「專案固定 ID」）。省略時由名稱產生 */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, '專案 ID 只能有英數字、底線與連字號').optional(),
  name: z.string().trim().min(1, '專案名稱不可空白'),
  match: z
    .object({
      paths: z.array(z.string()).default([]),
      ticket_keys: z.array(z.string()).default([]),
      /** Jira 父卡片（或更上層，例如 Epic）的單號 */
      parents: z.array(z.string()).default([]),
    })
    .prefault({}),
});
export type ProjectRule = z.infer<typeof ProjectRuleInput> & { id: string };

/** 由名稱產生的預設 ID：同名得到同一個 ID，手寫 YAML 未填 id 時每次讀取結果一致 */
export function projectIdFromName(name: string): string {
  return `p_${createHash('sha1').update(name.trim()).digest('hex').slice(0, 8)}`;
}

/** 補上缺少的 ID；重複的 ID（例如兩條同名規則）加上序號。已填 ID 的規則優先保留原 ID */
export function assignProjectIds(rules: readonly z.infer<typeof ProjectRuleInput>[]): ProjectRule[] {
  const taken = new Set<string>();
  const out: ProjectRule[] = rules.map((r) => ({ ...r, id: '' }));
  rules.forEach((r, i) => {
    if (r.id && !taken.has(r.id)) {
      taken.add(r.id);
      out[i]!.id = r.id;
    }
  });
  out.forEach((r) => {
    if (r.id) return;
    const base = projectIdFromName(r.name);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    r.id = id;
  });
  return out;
}

export const ProjectRule = ProjectRuleInput;

/** 規格 10：config.yaml。所有欄位都有預設值，空物件即可得到完整設定。 */
export const Config = z.object({
  schema: z.literal(1).default(1),
  user_name: z.string().default(''),
  /** 保留以相容舊的 config.yaml；目前沒有功能使用，UI 不再顯示 */
  language: z.string().default('zh-TW'),

  capture: z
    .object({
      guard: z.enum(['commit', 'edits', 'off']).default('commit'),
      guard_edit_threshold: z.number().int().positive().default(10),
      min_active_minutes: z.number().min(0).default(5),
      sweep_days: z.number().int().positive().default(7),
      sweep_time: HHmm.default('18:00'),
      exclude_paths: z.array(z.string()).default([]),
    })
    .prefault({}),

  time: z
    .object({
      timezone: z.string().default('Asia/Taipei'),
      idle_threshold_minutes: z.number().positive().default(15),
      idle_grace_minutes: z.number().min(0).default(2),
      rounding: z.number().positive().default(0.5),
      /** 每日工時：同一天 AI 粗估的時數加總超過時依比例縮減；0 為不限制 */
      daily_hours: z.number().min(0).max(24).default(8),
    })
    .prefault({}),

  ticket: z
    .object({
      keys: z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)).default(['TDDA']),
      /** 背景透過 Jira MCP 查詢單號的父卡片，用於專案分類 */
      fetch_parents: z.boolean().default(true),
      /** 查到新的最上層卡片（大型工作）時自動建立專案 */
      auto_projects: z.boolean().default(true),
      /** 使用者刪除過的自動專案的上層卡片：不再自動建立 */
      ignored_parents: z.array(z.string()).default([]),
      /** 使用者表示「不是單號」的代碼：不再建議加入 Jira 專案代碼 */
      ignored_keys: z.array(z.string()).default([]),
    })
    .prefault({}),

  /** Jira 每日活動同步：把當天在 Jira 上動過、Claude Code 沒涵蓋到的單補成任務 */
  jira_activity: z
    .object({
      enabled: z.boolean().default(true),
      /** 每日同步時間（今天）；過去的日期在服務啟動與排程時補抓 */
      time: HHmm.default('18:00'),
      /** 補抓最近幾天還沒在當天結束後同步過的日期 */
      lookback_days: z.number().int().min(0).max(30).default(7),
      skip_weekends: z.boolean().default(true),
      /** 候選單號是否包含關注中的單 */
      include_watched: z.boolean().default(true),
      /** 這些欄位的變更不算「我的活動」 */
      ignore_fields: z.array(z.string()).default(['Rank', 'Sprint']),
      /** Jira 任務的預設時數 */
      default_hours: z.number().min(0).max(24).default(0.5),
      /** 子項用 summary.jira_prompt 範本請 Claude 整理；false 或失敗時用固定格式 */
      ai_items: z.boolean().default(true),
    })
    .prefault({}),

  projects: z.array(ProjectRuleInput).default([]).transform(assignProjectIds),

  report: z
    .object({
      weekly: z
        .object({
          start_day: z
            .enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
            .default('monday'),
          /** 每期週報涵蓋幾週（雙週報為 2） */
          length_weeks: z.number().int().min(1).max(4).default(1),
          /** 多週一期時的週期起點：落在任一期第一週的日期；空白以 2026-01-05 所在週為起點 */
          anchor_date: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD')]).default(''),
          default_prompt: z.string().default('weekly/default'),
        })
        .prefault({}),
      performance: z
        .object({
          period: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly', 'custom']).default('quarterly'),
          year_start_month: z.number().int().min(1).max(12).default(1),
          default_prompt: z.string().default('performance/default'),
        })
        .prefault({}),
      /** 小交流：勾選幾天產生簡短重點 */
      talk: z
        .object({
          default_prompt: z.string().default('talk/default'),
        })
        .prefault({}),
    })
    .prefault({}),

  summary: z
    .object({
      default_prompt: z.string().default('summary/default'),
      /** 手動任務「從 Jira 整理」使用的摘要範本 */
      jira_prompt: z.string().default('summary/jira'),
      max_input_chars: z.number().int().positive().default(60000),
    })
    .prefault({}),

  claude_cli: z
    .object({
      path: z.string().default(''),
      /** 「從 Jira 整理」使用的 Jira MCP 伺服器名稱（claude mcp list 中的名稱） */
      jira_mcp_server: z.string().default('atlassian-rovo-mcp'),
      /**
       * 讀取 Jira 時用精簡模式：只載入 Jira MCP、不載入其他 MCP／skills／CLAUDE.md，並取代預設系統提示。
       * 找不到 Jira MCP 設定時自動退回完整模式。
       */
      jira_lean: z.boolean().default(true),
      /** 讀取 Jira 用的模型（只負責呼叫工具與輸出 JSON，用小模型即可）；空字串為 Claude Code 預設模型 */
      jira_model: z.string().default('haiku'),
    })
    .prefault({}),

  ui: z
    .object({
      port: z.number().int().min(1).max(65535).default(4870),
      /** 只有淺色、深色；舊設定檔的 system（跟隨系統）視為淺色 */
      theme: z.preprocess((v) => (v === 'system' ? 'light' : v), z.enum(['light', 'dark']).default('light')),
      /** 介面風格：default 為簡約、notebook 為筆記本（與淺／深色獨立） */
      style: z.enum(['default', 'notebook']).default('default'),
      open_browser_on_start: z.boolean().default(false),
      /**
       * 首次引導：新建立的 config.yaml 寫入 pending，開啟 UI 時先顯示引導頁；完成或略過後改為 done。
       * 欄位不存在（舊版建立的設定檔）視為 done，已在使用的人升級後不會跳出引導。
       */
      onboarding: z.enum(['pending', 'done']).default('done'),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export function defaultConfig(): Config {
  return Config.parse({});
}
