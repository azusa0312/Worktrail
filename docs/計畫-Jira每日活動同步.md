# 計畫書：Jira 每日活動同步（草案，尚未實作）

> 狀態：已實作（2026-11-25）。待決事項定案：A 固定 0.5 小時；B 附加到既有任務補充說明；C 只算我動的；D 18:00＋補抓 7 天；E AI 整理、失敗用固定格式。實作細節以 `DECISIONS.md`「Jira 每日活動同步」為準。

## 1. 背景與目標

Worktrail 目前只從 Claude Code 對話擷取任務。沒用 Claude 處理的單（例如手動測試後在 Jira 留言「test pass」、移動狀態、別人請你測試），只能靠手動新增任務，很容易漏記。

**目標**：每天自動抓「我今天在 Jira 上動過的單」，把 Claude 沒涵蓋到的單補成 Worktrail 任務，讓日誌、週報、績效不漏。

做法參考既有排程 `qa-daily-jira-report-v3`（QA 日報）：
- 活動分成四類：建立、移動狀態、留言或編輯、指派進度。
- 去重的優先順序是 1 > 2 > 3 > 4，次要動作的重點併進主類別那一行。
- 用 changelog 的 author 確認「真的是我動的」：`updated` 時間不可信，例如同事整批調整 Rank。

## 2. 不做的事

- 不直接呼叫 Jira REST API。維持規格 1.3，一律由 `claude -p` 透過使用者已連線的 Jira MCP 讀取，只開放唯讀工具。
- 不修改 Jira 上的任何資料。
- 不取代 QA 日報。QA 日報寫的是 Excel，這個功能寫的是 Worktrail 任務，兩者獨立。

## 3. 整體流程

```
排程／手動觸發（日期 D）
  └─ 1. 抓取（claude -p + Jira MCP，只回原始 JSON，不讓模型判斷）
        ├─ atlassianUserInfo → 我的 accountId
        ├─ searchJiraIssuesUsingJql → 候選單號
        └─ getJiraIssue（summary、status、issuetype、comment、changelog）
  └─ 2. 判斷（src/core，純程式＋單元測試）
        ├─ 只留「作者是我、時間落在 D（依 time.timezone）」的事件
        ├─ 分類：建立／狀態變更／留言／欄位編輯；排除 Rank 等雜訊欄位
        └─ 每張單產生一筆「當日 Jira 活動」
  └─ 3. 併入 Worktrail
        ├─ D 已有同單號的 Claude 任務 → 不新增（見待決事項 B）
        ├─ 否則新增或更新一筆來源為 Jira 的任務（同一天同單號只會有一筆）
        └─ 子項：依活動內容產生（見待決事項 E）
```

和現有「從 Jira 整理」一樣分兩段處理：第一段由模型只負責取回原文，第二段由程式做日期判斷與過濾，結果可以測試、也穩定。

### 3.1 候選單號的 JQL（D 為絕對日期字串）

```
(reporter = currentUser() OR assignee = currentUser() OR issue in watchedIssues()
 OR status changed BY currentUser() DURING ("D 00:00", "D+1 00:00"))
AND updated >= "D 00:00"
```

- 用 `updated >= D` 而不是 `< D+1`，因為補抓過去的日期時，單子可能在之後又被更新過。
- 候選數量設上限（例如 50 張），超過時記錄警告。
- 只取設定中 `ticket.keys` 的專案代碼（預設 TDDA），避免抓到無關專案。

### 3.2 已知風險：JQL 工具的 schema 問題

QA 日報曾遇過 `searchJiraIssuesUsingJql` 因為 `searchResultMode` 參數被濾掉而全部失敗（2026-07）。實作前要先用 `atlassian-rovo-mcp`（mcp-remote）實測 JQL 能不能用。如果不能用：
- 改用 `search`（Rovo 搜尋）或者
- 退而求其次：只檢查「近期在 Worktrail 出現過的單號＋設定中的單號清單」，逐張用 `getJiraIssue` 查。

失敗時只記錄錯誤並在 UI 顯示，**不寫入佔位資料**。這是 QA 日報學到的教訓：靜默失敗會連續漏好幾天。

## 4. 資料模型

### 4.1 任務

沿用手動任務（`manual: true`）的結構，再加一個來源欄位：

| 欄位 | 值 |
|---|---|
| `source` | 新增 `'jira'`（既有任務沒有這個欄位，視為 `claude`／`manual`） |
| `session_id` | 用確定性的值 `jira-<單號>-<日期>`，重跑時會更新同一筆，不會重複新增 |
| `ticket` | 單號；`title` 用 Jira 標題（`title_source: 'jira'`） |
| `items` | 當日活動整理出的子項 |
| `hours` | 見待決事項 A |
| `jira_activity` | 原始事件摘要（類型、時間、狀態 A→B、留言前 200 字），供 UI 顯示與重新產生 |

- 使用者改過子項或時數後，重跑時不覆蓋（沿用 `locked_fields`／`hours_overridden`）。
- 使用者刪除後記錄在 `.worktrail/jira-sync.json` 的 `dismissed`，不會再自動建回來。

### 4.2 同步狀態檔 `.worktrail/jira-sync.json`

```json
{ "schema": 1,
  "days": { "2026-11-25": { "synced_at": "...", "tickets": ["TDDA-2015"], "error": null } },
  "dismissed": ["2026-11-25:TDDA-1999"] }
```

寫入一律用 `writeFileAtomic` 加 `withLock`。

### 4.3 設定 `config.yaml`

```yaml
jira_activity:
  enabled: true
  time: "18:00"          # 每日同步時間（同一天可以手動重跑）
  lookback_days: 7       # 啟動時補抓最近幾天沒同步到的工作日
  include_watched: true  # 候選單號是否包含關注中的單
  ignore_fields: [Rank, Sprint]   # 這些欄位的變更不算「我的編輯」
  default_hours: 0       # Jira 任務預設時數（見待決事項 A）
  ai_items: true         # 子項用 summary/jira 範本請 Claude 整理；false 則用固定格式
```

## 5. 子項產生方式

兩段式，跟「從 Jira 整理」共用範本：
1. 程式把當日事件組成內容，例如：「狀態：開發中 → 測試中」「我的留言：已在測試台測試 test pass」「Marcia 請我測試（10:04）」。
2. `ai_items: true` 時套用 `summary/jira` 範本，請 `claude -p` 整理成 3–10 個子項。設成 false，或 Claude 呼叫失敗時，改用固定格式：
   - `建立 TDDA-xxxx`
   - `狀態 開發中 → 測試中`
   - `留言：<第一行，最多 60 字>`

別人在當天提到我（`@albertweng`）的留言要不要算，見待決事項 C。

## 6. 觸發時機

| 時機 | 行為 |
|---|---|
| 每日排程（`jira_activity.time`） | 同步今天，掛在現有的 30 秒排程迴圈上，用 `jobs` 避免同時重複執行 |
| 常駐服務啟動 | 補抓 `lookback_days` 內還沒成功同步的工作日（跳過週六日） |
| UI「同步 Jira 活動」按鈕 | 今日頁和日誌頁都有，可以指定日期重跑 |
| CLI `worktrail jira-sync [--date YYYY-MM-DD]` | 除錯和補資料用 |
| API `POST /api/jira-sync`（`date`） | 工作類型 `jira-sync`，進度透過 SSE 回報 |

`claude -p` 每次只處理一天，候選單號分批，每批最多 15 張，避免輸出太長或逾時。

## 7. UI

- 任務卡片加上「Jira」標籤，區分 Claude、手動、Jira 三種來源。
- 任務面板顯示當日 Jira 事件時間軸，並提供「重新整理子項」按鈕。
- 今日頁頂端：同步失敗時顯示警告，例如「Jira 活動同步失敗：…（重試）」。
- 設定頁 Jira 區塊：開關、時間、補抓天數、忽略欄位、預設時數。

## 8. 程式結構

| 位置 | 內容 |
|---|---|
| `src/core/jira-activity/fetch-prompt.ts` | 組 `claude -p` 指示、allowedTools、解析輸出（zod） |
| `src/core/jira-activity/events.ts` | 事件過濾（作者、時區日期、忽略欄位）、分類、去重 |
| `src/core/jira-activity/merge.ts` | 和既有任務比對（`ticket`／`related_tickets`）、建立或更新 Jira 任務、處理 dismissed |
| `src/core/jira-activity/state.ts` | `jira-sync.json` 讀寫 |
| `src/daemon/actions.ts` | `syncJiraActivity(date)` 串接上面幾支 |
| `src/daemon/server.ts` | 排程、API、啟動補抓 |
| `ui/src/...` | 標籤、按鈕、設定、警告 |
| `test/jira-activity.test.ts` | 用 TDDA-2015 這類真實結構做 fixture，測過濾、分類、Rank 排除、時區、合併、dismissed、重跑不重複 |

`src/core/` 依專案規範不依賴 MCP、HTTP、UI；`claude -p` 的呼叫只放在 daemon。

## 9. 實作步驟

1. **先驗證**：用 `claude -p` 和 `atlassian-rovo-mcp` 實測 JQL、changelog、`atlassianUserInfo` 能不能用，確認輸出結構（半天）。
2. core：events、merge、state 與單元測試。
3. daemon：抓取、`syncJiraActivity`、API、CLI。
4. 排程與啟動補抓。
5. UI：標籤、按鈕、設定、警告。
6. 文件：`DECISIONS.md`、`架構與運作原理.md`、`使用說明.md`。
7. 用 2026-11-25（TDDA-2015 等單）實際跑一次對照，再補跑最近一週。

## 10. 待決事項（請確認）

- **A. 時數**：Jira 任務預設幾小時？
  - (1) 0 小時，自己補；
  - (2) 固定值，例如 0.5；
  - (3) 讓 Claude 依活動量估計，並和 Claude 任務一起依每日工時比例縮減。
- **B. 同一張單已有 Claude 任務時**：
  - (1) 跳過；
  - (2) 把 Jira 活動附加到該任務的補充說明（不動子項）；
  - (3) 另外建一筆 Jira 任務。
  - 建議選 (2)。
- **C. 要算哪些活動**：
  - 只算「我動的」（建立、狀態、留言、編輯）？
  - 還是也算「別人 @我或指派給我、當天有進度」（QA 日報的第 4 類）？
  - 建議預設只算我動的，第 4 類做成選項。
- **D. 同步時間與補抓範圍**：預設 18:00 加啟動補抓 7 天，可以嗎？
- **E. 子項由 AI 整理還是固定格式**：AI 比較好讀，但每天會多一次 `claude -p`。
