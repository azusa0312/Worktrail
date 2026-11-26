/**
 * config.yaml 讀寫（規格 10）。讀取時格式錯誤改用預設值並回報錯誤；寫入時保留註解以外的內容。
 */
import { parseDocument, stringify } from 'yaml';
import { parseConfig, type ConfigLoadResult } from '../config/load.js';
import { Config, defaultConfig } from '../schema/config.js';
import { readText, withLock, writeFileAtomic } from './fsutil.js';
import type { StoragePaths } from './paths.js';

export function loadConfig(paths: StoragePaths): ConfigLoadResult {
  const text = readText(paths.config);
  if (text === null) return { config: defaultConfig() };
  return parseConfig(text);
}

export const DEFAULT_CONFIG_YAML = `# Worktrail 設定檔。所有欄位都可在 UI 的「設定」頁修改。
schema: 1
user_name: ""                  # 報告中使用的名字

capture:
  guard: commit                 # commit / edits / off：何時要求 Claude 補寫日誌
  guard_edit_threshold: 10
  min_active_minutes: 5         # 低於此分鐘數的 session 不建立任務
  sweep_days: 7
  sweep_time: "18:00"
  exclude_paths: []

time:
  timezone: Asia/Taipei
  idle_threshold_minutes: 15
  idle_grace_minutes: 2
  rounding: 0.5                 # 小時
  daily_hours: 8                # 每日工時：AI 粗估的時數當天加總超過時依比例縮減，0 為不限制

ticket:
  keys: [TDDA]                  # 接受的 Jira 專案代碼

jira_activity:                  # Jira 每日活動同步：補上沒用 Claude 處理的單
  enabled: true
  time: "18:00"                 # 每日同步今天的時間
  lookback_days: 7              # 補抓最近幾天
  skip_weekends: true
  include_watched: true         # 候選單號包含關注中的單
  ignore_fields: [Rank, Sprint] # 這些欄位的變更不算我的活動
  default_hours: 0.5            # Jira 任務預設時數
  ai_items: true                # 子項由 Claude 整理；false 用固定格式

projects: []
#  - name: 社交工程
#    match:
#      paths: [C:/proj/se-*]
#      ticket_keys: []

report:
  weekly:
    start_day: monday
    length_weeks: 1             # 每期幾週；雙週報填 2
    anchor_date: ""             # 多週一期時，任一期第一週內的日期（決定從哪一週起算）
    default_prompt: weekly/default
  performance:
    period: quarterly           # monthly / quarterly / half_yearly / yearly / custom
    year_start_month: 1
    default_prompt: performance/default
  talk:
    default_prompt: talk/default   # 小交流重點

summary:
  default_prompt: summary/default
  jira_prompt: summary/jira     # 手動任務「從 Jira 整理」使用的範本
  max_input_chars: 60000

claude_cli:
  path: ""                      # 空白表示從 PATH 自動尋找
  jira_mcp_server: atlassian-rovo-mcp   # 「從 Jira 整理」使用的 Jira MCP 名稱
  jira_lean: true               # 讀取 Jira 時只載入 Jira MCP（不載入其他 MCP、skills、CLAUDE.md），大幅節省 token
  jira_model: haiku             # 讀取 Jira 用的模型；空白為 Claude Code 預設模型

ui:
  port: 4870
  theme: light                  # light / dark
  style: default                # default（簡約）/ notebook（筆記本）
  open_browser_on_start: false
  onboarding: pending           # 首次引導；完成後為 done，改回 pending 會再顯示一次
`;

/**
 * 寫入設定：以既有檔案為基礎逐欄更新，保留使用者的註解。
 * 回傳驗證後的設定；驗證失敗時丟出錯誤，不寫檔。
 */
export async function saveConfig(paths: StoragePaths, next: unknown): Promise<Config> {
  const config = Config.parse(next);
  await withLock(paths.config, () => {
    const text = readText(paths.config) ?? DEFAULT_CONFIG_YAML;
    const doc = parseDocument(text);
    if (doc.errors.length) {
      writeFileAtomic(paths.config, stringify(config));
      return;
    }
    setDeep(doc, [], config as unknown as Record<string, unknown>);
    writeFileAtomic(paths.config, doc.toString({ lineWidth: 0 }));
  });
  return config;
}

type Doc = ReturnType<typeof parseDocument>;

function setDeep(doc: Doc, path: (string | number)[], value: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(value)) {
    const p = [...path, k];
    if (v && typeof v === 'object' && !Array.isArray(v) && doc.getIn(p, true) && isMap(doc.getIn(p, true))) {
      setDeep(doc, p, v as Record<string, unknown>);
    } else {
      const current = doc.getIn(p);
      if (JSON.stringify(toPlain(current)) !== JSON.stringify(v)) doc.setIn(p, doc.createNode(v));
    }
  }
}

function isMap(node: unknown): boolean {
  return !!node && typeof node === 'object' && 'items' in node && (node as { constructor: { name: string } }).constructor.name === 'YAMLMap';
}

function toPlain(v: unknown): unknown {
  return v && typeof v === 'object' && 'toJSON' in v ? (v as { toJSON(): unknown }).toJSON() : v;
}
