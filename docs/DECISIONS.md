# 實作決策與紀錄檔格式觀察

記錄與原始規格（開發初期的 `docs/SPEC.md`，只留在本機、不進版控）不同、或規格未涵蓋的決定；文中的「規格 X.Y」指該文件的章節。目前的整體運作方式見 [架構與運作原理](架構與運作原理.md)。紀錄檔格式觀察的依據為 2026-11-16 以 se-webapi 的 22 個真實紀錄檔（Claude Code 2.1.x、Claude Desktop）執行 `worktrail analyze` 的結果。

## 紀錄檔格式（Claude Code 2.1.x）

- 每行一個 JSON。只有 `type: user | assistant` 的行是對話事件；另有 `queue-operation`、`attachment`、`api-request*`、`custom-title`、`agent-name`、`cost-state`、`system` 等，一律忽略（`custom-title` 用作標題候選）。
- 每個事件帶 `timestamp`、`sessionId`、`cwd`、`gitBranch`、`uuid`、`isSidechain`。
- assistant 的每個內容區塊（thinking / text / tool_use）通常各自一行。
- **分叉（fork）對話**：Desktop 分叉時把原對話訊息整份複製到新檔、改寫 `sessionId`，但保留 `uuid` 與原時間戳。新檔第一行（`queue-operation`）是建立時間，複製的訊息都早於它。→ 解析器以「檔案中第一個帶時間戳的行」為建立時間，早於它 1 秒以上的訊息標為 `copied`，不計時數、不認領 commit，但仍用於單號與標題。
- **中斷的工具呼叫**：應用程式關閉時執行中的工具，會在下次開啟時補寫一筆 `is_error: true`、內容為 `[Tool call interrupted …]` 的 tool_result，時間戳是重開的時間。
- Claude 常以 `git commit -q … && git log --oneline -1` 提交，輸出沒有 `[branch sha]` 行，只有 `sha 訊息`。

## 與規格不同的決定

| 規格 | 實作 | 原因 |
| --- | --- | --- |
| 6.2 tool_use → tool_result 一律整段計入 | 只計入正常回傳（非錯誤）的呼叫，且以工具的 `timeout`＋1 分鐘（無 timeout 時 120 分鐘）為上限；互動工具（AskUserQuestion、計畫模式）不適用 | 真實資料中一筆被中斷的 Bash 讓單日時數從 138 分變成 720 分 |
| 6.3 正規表示式 `\b…\b` | 改用前後瞻斷言 | `\b` 漏掉 `feature/TDDA-1869_fix` |
| 6.4 標題三個來源 | 在 Jira summary 與第一則訊息之間插入 Desktop 對話標題（`custom-title`） | 現成的語意標題，比截斷的訊息好 |
| 5.1 commit 取「first_activity 之後、作者為本人」 | 優先以對話中的 git commit 輸出認領；無證據時排除他人已認領者，且限定在活動時段內 | 同 repo 並行的對話會互相重複歸屬 commit |
| — | 沒有事件、只分到閒置寬限零頭（< 1 分鐘）的日子不建立任務日 | 隔幾天才回到同一對話時，中間的日子不該出現空任務 |
| 6.3 分數最高者為單號 | 只出現在 Claude 回應中的候選不得成為主單號或相關單號 | Claude 舉例或引用的單號不代表正在處理（例如本專案對話被判成 TDDA-1869） |
| 5.1 Stop 從 byte offset 增量讀取 | 每次完整重新解析，紀錄檔大小與修改時間未變時跳過 | 6 MB 完整解析約 50 ms；增量版本需保存工具執行時段等中間狀態，複雜且易錯 |
| 5.1 每回合執行 git log | 直接讀 `.git/HEAD`（含 worktree、packed-refs）取得 sha，HEAD 未變時沿用快取 | Windows 上每次 spawn git 約 200 ms；改善後 6 MB 紀錄檔 hook p50 由 1000 ms 降到 509 ms |
| 13.2 開機啟動用工作排程器 | 使用「啟動」資料夾捷徑（macOS 為 LaunchAgent） | ONLOGON 排程在一般權限下常被拒絕 |
| 12.2 端點 | 另加 `/api/ping`、`/api/shutdown`、`/api/restart`、`/api/search`、`/api/jobs`、`/api/tasks/restore`、`/api/prompts/validate`、`/api/reports/:type/:period/prepare`、`/api/prompts/:type/:name/preview` | 設定頁停止／重啟服務、指令面板、刪除復原、範本試跑 |
| 11.4 日誌：熱度圖＋連續的任務清單（載入更早） | 比照週報／績效／小交流改為雙欄：左欄月份清單，右欄熱度圖、篩選與所選月份（或點選日期）的任務；窄視窗改為頂部月份選單 | 各頁版型一致；以月份切換取代「載入更早的紀錄」 |
| 12.1 token 驗證 | SSE（`/api/events`）以 query 參數帶 token | EventSource 無法設定標頭 |
| 4.4 stale | 報告多存一個 `sources_version`（來源 id＋內容雜湊），即時比對 | 判斷來源是否變動，含新增與刪除 |
| 9.3 內建範本唯讀 | 以 `<類型>/builtin` 提供；`<類型>/default` 是使用者可改的複本，檔案不存在時退回內建 | 區分「內建」與「使用者的預設」 |
| 11.2 字體 | 使用系統字體堆疊（有安裝 Inter／Noto Sans TC／JetBrains Mono 就使用），不從網路載入 | 規格 15：除 `claude -p` 外不連網 |
| 14.1 React 18、execa、gray-matter | React 19；子程序用 node:child_process；前段 YAML 用 `yaml` 自行解析 | 版本為安裝時最新；gray-matter 會把日期轉成 Date；減少 hook 依賴 |

## 時數定位：AI 粗估、使用者在 UI 調整（2026-11-16 決定）

- 時數不追求自動精準。對話紀錄看不到 IDE、測試、等待 review 等對話外的工作，以真實資料比對，演算法普遍偏低（例如 09-30 跨 9 小時、10 個 commit，只算 2.5h）。
- 因此時數定位為**粗估**，最終值由使用者在 UI 中調整（規格 4.2 的 `hours_overridden` 已涵蓋）。
- M0 的「時數與體感差距 ≤ 20%」驗收標準改為：演算法輸出合理、無灌水（無中斷工具、分叉重複計時），不再要求逐筆比對。閒置門檻與寬限維持 15／2 分鐘（規格 17 待決事項第 2 項結案）。
- **已實作（M2）**：Claude 撰寫摘要時，依對話內容、commit 時間跨度與系統的 `active_minutes` 粗估時數，以 `worklog_save_summary` 的選填參數 `hours_estimate` 送出。`hours` 的採用順序：使用者修改 > AI 粗估 > 系統計算。任務檔新增 `hours_source: computed | ai | user`，UI 時數旁標示來源並顯示系統計算值供參考。

## 每日工時上限（2026-11-19 決定）

- 問題：AI 逐一任務各自粗估時數，看不到當天其他任務，常以 commit 時間跨度估算，同一天加總常超過 8 小時。
- 新增設定 `time.daily_hours`（預設 8，0 為不限制）。同一天加總超過時，依 AI 原本粗估的比例縮減 `hours_source: ai` 的任務，以 `time.rounding` 為單位（最大餘數法，加總剛好等於剩餘工時），每個任務至少一個單位。
- 使用者填寫（`user`）與系統計算（`computed`）的時數不縮減、先占用工時：前者是使用者的決定；後者只計對話中的活動，本來就偏低，且由 hook 每回合更新，若納入就得在 hook 中改寫其他任務檔。
- 任務檔新增 `hours_estimate` 保存 AI 原本的粗估，`hours` 為調整後的值；重新分配一律從原本的粗估計算，結果穩定，工時放寬或設為 0 時會回到原值。使用者改時數時清除此欄位。
- 重新分配的時機：寫入摘要（`applySummary`，涵蓋 MCP、UI 補寫、從 Jira 整理）、UI 改時數、新增／刪除／復原任務、修改每日工時或時數單位（套用到所有紀錄）；設定頁另有「套用到既有紀錄」按鈕。hook 擷取不觸發（只更新 `computed` 時數）。
- 事前引導：摘要範本的 `{{draft}}` 附上當天其他任務已記時數與剩餘工時；`worklog_save_summary` 回傳 `day_total_hours`、`daily_hours`，被縮減時附警告。MCP 直接寫入時 Claude 看不到其他任務，所以以事後的比例縮減為準。

## 已知限制

- 有 commit 證據的對話，不會再採用使用者在 IDE 手動做的 commit。
- 等待權限核准的時間，在舊版紀錄檔中無法與工具執行時間區分（以上限控制）。
- 這台開發機啟動 Node 本身約 290–490 ms（端點防護掃描），因此 hook 的 p95 約 620 ms，未達規格的 500 ms；hook 自身的耗時約 220 ms，仍在 2 秒上限內。
- 補漏掃描對每個 HEAD 有變動的 session 仍會啟動 git；首次掃描 102 個紀錄檔約 58 秒（背景執行）。
- 同一張單同一天有多個分叉對話時，各自是一個任務；週報統計以最後一個有子項的任務為準。

## 規格第 17 節待決事項

| 項目 | 結果 |
| --- | --- |
| 績效是否需符合公司考核表格式 | 結案：新增內建範本 `performance/appraisal`（見「年度考核表範本」） |
| 閒置門檻與寬限 | 結案：維持 15／2 分鐘，時數以 AI 粗估＋手動調整為主 |
| 使用的 Jira MCP | 結案：`atlassian-rovo-mcp`（工具名稱含 atlassian，預設規則即可辨識） |
| 其他 Jira 專案代碼 | 未定，預設只有 TDDA，可在設定頁新增 |
| Code 分頁是否使用 SSH 遠端模式 | 未定，目前以本機模式實作 |

## 名稱（2026-11-16 決定）

產品名稱只用英文 **Worktrail**，不使用中文名「工跡」。介面、文件、捷徑說明皆已移除中文名；原始規格書檔案保留原樣。

## 手動任務與專案清單（2026-11-16 新增，規格未涵蓋）

- UI 可「新增任務」記錄不在 Claude Code 中進行的工作。任務檔標記 `manual: true`，以隨機 UUID 為 session_id；時數、專案、單號皆視為使用者輸入（鎖定），摘要狀態直接為 done，不能補寫摘要。
- 新增 `POST /api/tasks`、`GET /api/projects`。專案清單＝設定中的專案（可只有名稱、沒有對應規則）＋任務中用過的名稱，供任務面板下拉建議。

## 手動任務「從 Jira 整理」（2026-11-16 新增，規格未涵蓋）

- 使用者不在 Claude Code 裡做的工作，習慣把當天進度寫在 Jira 留言，並在內文第一行寫日期（例如 `2026/11/16`）。手動任務面板新增「從 Jira 整理」按鈕，把該單號當天的留言整理成子項。
- 維持「Worktrail 不直接呼叫 Jira API」（規格 1.3）：由 `claude -p` 透過使用者已連線的 Jira MCP 讀取，只以 `--allowedTools` 開放唯讀的 `getAccessibleAtlassianResources`、`getJiraIssue`。MCP 名稱為設定 `claude_cli.jira_mcp_server`（預設 `atlassian-rovo-mcp`）。
- 分兩次呼叫：第一次只取回標題與留言原文（JSON）；日期過濾在 `src/core/summary/jira.ts` 以程式處理（可測試、不靠模型判斷）；第二次套用摘要範本（`summary.default_prompt`）產生子項，與補寫摘要同一套格式與「前次未完成項目」。
- 日期依**留言內文**而非留言建立時間：留言第一個非空行以日期開頭，或某行只有日期（可帶星期、冒號、粗體／標題標記），即開始一段，直到下一個日期行。支援 `2026/11/16`、`2026-11-16`、`2026.11.16`、`2026年11月16日`、省略年份的 `11/16`（年份取任務日期）。第一個日期行之前的文字不屬於任何日期。不過濾留言者。
  - （2026-11-25 補充）內文**完全沒有日期行**的留言（例如他人留的「已部署至測試台，麻煩測試」、自己留的「test pass」），改依留言建立時間判斷：建立時間換算成 `time.timezone` 的日期等於任務日期時，整則留言納入。內文有日期行的留言仍只看內文日期，不受建立時間影響（避免「一則留言累積多天」被整則算進建立當天）。Jira 的時間格式 `+0800`（無冒號）先補成 `+08:00` 再解析。
- 任務已有子項時 API 回 409（`needs_overwrite`），UI 確認後整批取代子項（補充說明可能一併更新）。時數、專案、單號仍維持使用者輸入；標題只在使用者填的就是單號本身時換成 Jira 標題。
- API：`POST /api/tasks/:id/jira-summarize`（`overwrite`），工作類型 `jira-summarize`。只接受有單號的手動任務。

## 多週一期的週報（2026-11-16 新增，規格未涵蓋）

- 使用者實際是雙週報，新增 `report.weekly.length_weeks`（1–4，預設 1）與 `report.weekly.anchor_date`。以「週數」而非「天數」設定，讓 `start_day` 仍有意義、每期都從同一個星期幾開始。
- 多週一期時需要相位：`anchor_date` 所在週（依 `start_day` 對齊）為某一期的第一週，往前往後都依此切分；空白時以 2026-01-05 所在週起算。
- 影響範圍：`current`／`previous`、週報頁左欄清單、績效的缺少週報檢查與週趨勢（每項為一整期）。多週期間的檔名為 `YYYY-MM-DD_YYYY-MM-DD`；ISO 週次標籤（`2026-W46`）仍只用於週一起算的單週。
- 改變週數或起算日後，既有週報檔不會搬動，仍以原期間列在週報清單中（與自訂期間的報告相同處理）。

## 小交流（2026-11-16 新增，規格未涵蓋）

- 使用者要在團隊「小交流」口頭報告，需要一份一眼看懂「勾選的那幾天在處理什麼」的簡短重點（每項一行、整份 15 行內），而不是書面週報。左側導覽在「今日」下方新增「小交流」頁（`/talk`）。
- 最初做成可照著念的口語講稿，使用者試用後認為太長，改為簡短重點；「念稿」大字模式與口說時間估算一併移除。
- 期間是使用者**勾選的任意幾天**（可不連續），因此不併入 `ReportType`／期間標籤機制，另立 `src/core/talk/`：
  - 檔案：`<storage>/talk/<id>.md`，id 為建立時間（設定時區）`YYYY-MM-DD-HHmm`，同一分鐘重複時加 `-2`。
  - 前段 YAML：`schema`、`type: talk`、`title`、`dates`（排序去重）、`prompt`、`prompt_hash`、`sources`、`sources_version`、`stats`、`created_at`、`generated_at`、`edited`。
  - 過期不寫入檔案，讀取時即時比對：勾選日期上任務的 `sources_version` 與產生時不同（含改了勾選日期）即為過期。
- 範本新增類型 `talk`（`prompts/talk/*.md`，內建 `talk/default`「小交流重點」），設定新增 `report.talk.default_prompt`。可用變數同週報，另加 `{{dates}}`（例如 `11/10（二）、11/12（四）`）；`{{period}}` 為第一天到最後一天；`{{previous}}` 為最後一天早於本次第一天的最近一份小交流內容（內建範本未使用，供自訂範本參考）。範本同樣必須包含 `{{records}}`。
- API：`GET/POST /api/talks`、`GET/PUT/DELETE /api/talks/:id`（PUT 可改 `content`、`title`、`dates`，帶 `base_version`）、`POST /api/talks/restore`、`POST /api/talks/:id/generate`（`prompt`、`dates`、`overwrite`）、`POST /api/talks/:id/prepare`；範本試跑 `render` 可帶 `dates`，未帶時用最近 5 個有紀錄的日子。
- UI：日曆勾選（有紀錄的日子有底色並顯示時數）、快速選取（最近 1／3／5 天、本週、上週）、確認會納入的任務。
- 本版未提供 MCP 工具與 slash command，只能在 UI 產生。

## 摘要範本移除「未 commit」備註規則（2026-11-16）

- 規格 9.7 內建摘要範本原有「已完成但未 commit 的項目標為 done，備註『未 commit』」，來自使用者手寫日誌的習慣（規格 2.4）。實際使用後備註大量重複且是雜訊：非開發工作（手動任務、從 Jira 整理）本來就沒有 commit，模型仍逐項套上；開發任務的 commit 已由擷取流程記在任務上，逐項再註記既重複又難以準確對應。
- 內建範本（`src/templates/prompts.ts`）與規格 9.7 移除此規則；規格 2.4 的範例保留原文，僅示範備註欄位的用法。
- 使用者已安裝的 `prompts/summary/default.md` 一併移除該行；既有任務中的「未 commit」備註已清除（備註只剩這幾個字就整個移除，有其他說明的保留其餘文字）。

## 「從 Jira 整理」改用專用範本 summary/jira（2026-11-16）

- 原本「從 Jira 整理」套用 `summary.default_prompt`（為 Claude Code 對話設計），模型會看到分支、「今日 commit：無」、活躍時間 0 分、「對話內容」等與 Jira 留言無關的資訊，容易補上「非程式開發，故無 commit 紀錄」之類的雜訊，也會去估一個不會被採用的時數。
- 新增內建範本 `summary/jira`（「Jira 留言整理」）：只看單號、標題與當天留言；只整理留言寫到的事；依「待確認、等候回覆」等字眼判斷 pending／blocked；補充說明只在有決策、問題或風險時才寫；不估時數。
- 設定新增 `summary.jira_prompt`（預設 `summary/jira`），設定頁「從 Jira 整理範本」可改選其他摘要範本。
- 手動任務的 `{{draft}}` 改為只列日期、單號、專案、標題、時數（使用者填寫），不列分支、活動時段、活躍時間與 commit；兩份範本都受益。
- 內建範本除了 `<type>/default` 外可以有其他名稱。安裝時同樣複製到 `prompts/<type>/<name>.md`；舊安裝沒有該檔案時，`loadPrompt` 與範本清單以內建內容提供，且可編輯（儲存時才建立檔案），不像 `<type>/builtin` 是唯讀。

## 合併同專案任務（2026-11-17 新增，規格未涵蓋）

- 情境：同一個專案的不同工作開了不同對話，一天會出現好幾張同專案卡片，週報紀錄也被切成很多段。使用者要的呈現是「一天 → 專案 → 各任務 → 子項」。
- 只合併**同一天**的任務（維持一天一筆的日誌模型，時數歸屬與期間切分不受影響）。
- 做法是**標記**而非搬檔：被合併的任務前段 YAML 加 `merged: true`，並把 `project` 設成指定專案、加入 `locked_fields`。同一天、同專案、帶標記的任務即為一筆合併紀錄（`src/core/sync/task-merge.ts` 的 `groupMerged`）；同組只剩一個成員時當一般任務。
  - 不另建合併檔、不刪來源檔，因此擷取程式與摘要（MCP、補寫摘要、把關）完全不用改：對話之後繼續進行，進度仍寫回各自的任務檔，合併紀錄自然更新；`mergeCapture` 會保留 `merged`。
  - 在 UI 把已合併任務改到別的專案，即自動移出合併（`applyTaskPatch`）。
- 影響範圍：
  - `{{records}}`（週報、績效、小交流）：合併紀錄輸出為 `#### 專案｜總時數（合併 N 個任務）`，底下每個任務一個清單項（單號 標題｜時數），子項縮排列在下面。
  - 統計 `task_count`：合併紀錄算一個任務；時數、單號、子項統計不變（仍以各任務計算）。
  - MCP 工具與 `GET /api/tasks` 仍回傳個別任務（帶 `merged` 欄位）。
- API：`POST /api/tasks/merge`（`ids` 至少兩個且同一天、`project`）、`POST /api/tasks/unmerge`（`ids`）。
- UI：今日與日誌頁，當天同專案有兩個以上未全部合併的任務時，日期列出現「合併「專案」N 個任務」按鈕（可復原）；合併後顯示為一張卡片（a. b. c. 依開始時間），可整組「取消合併」或單一任務「移出」；任務面板標示「已合併」。專案空白的任務需先在面板指定專案才會出現在建議中。

## 筆記本介面風格（2026-11-17 新增，規格 11.2 未涵蓋）

- 情境：使用者覺得預設配色太單調，想要筆記本風格。
- 設定新增 `ui.style`（`default` 簡約／`notebook` 筆記本，預設 `default`），與 `ui.theme`（淺／深色）**獨立**，因此筆記本有淺色與深色（夜間筆記本）兩組 token。設定頁「一般 → 介面風格」切換。
- 套用方式：`<html>` 加 `.notebook` 類別，`styles.css` 覆寫色彩 token，並以少數掛勾類別（`wt-nav`、`wt-card`、`wt-task`、`wt-status`、`wt-heading` 等）加上裝飾；元件邏輯不分風格。`index.html` 依 `localStorage` 的 `wt.style` 提早套用，避免閃爍。
- 筆記本的視覺：側欄為皮革封面（內縮縫線框、目前頁面凹壓＋燙金字、只顯示置中的書名；2026-11-19 由牛皮紙封面＋右緣線圈孔＋索引標籤改來），打孔改在紙頁左緣、透出封面顏色；任務卡為橫線紙＋紅色邊線＋紙膠帶、待補摘要（虛線卡）改為便利貼、項目狀態為印章、頁面標題為手寫字＋螢光筆，主色改為鋼筆藍。
- 標題字型「霞鶩文楷」由 Google Fonts 載入；離線時退回系統楷體（標楷體等），不影響功能。這是 UI 第一個外部資源。
- 啟動畫面（splash）沿用原本配色，未套用筆記本風格。

## 專案標籤統一樣式與依專案上色（2026-11-17 新增，與規格 11.2／11.4 不同）

- 所有顯示專案的地方統一用 `ProjectTag`（`ui/src/components/ui.tsx`）：粗體、資料夾圖示、色票底色，外框一律相同；未分類為灰色。UI 不再標示「未對應專案」（使用者覺得照資料夾名稱即可，標記反而像樣式不一致）；API 仍回傳 `project_unmapped`，CLI `analyze` 也仍會提示。任務面板的專案欄位文字也用同一個顏色。
- 專案顏色由 `projectColor(name)` 以 FNV-1a 雜湊名稱對應到 8 組色票（`--p0`～`--p7`，各有 `-soft` 淡底），同名專案在每個頁面、每次開啟都是同一色；簡約淺／深色、筆記本淺／深色各有一組色票。
- 規格 11.4 原本要求專案環圈圖「以強調色深淺區分、避免裝飾性多色」；改為使用與專案標籤相同的顏色，讓圖表和卡片能對得起來。不同專案可能雜湊到同一色（8 色），屬可接受的取捨。

## UI 視覺 token 統一（2026-11-17 新增，補充規格 11.2）

- 情境：盤點發現各頁面直接寫 Tailwind 色票（red／amber／emerald…）、色碼、規格外字級（10／11／13／15 px）與多種圓角，深色與筆記本風格都不會跟著換。
- 顏色：`styles.css` 新增語意色 token，簡約淺／深色、筆記本淺／深色各一組：`danger`、`warn`、`success`、`muted`（各有 `-soft` 淡底，danger／warn 另有 `-line` 邊框）、`on-accent`（強調色上的文字）、`overlay`（遮罩）。項目狀態標籤改用這些 token（未開始＝`hover` 底＋`ink-2`）。元件與頁面不再直接寫色票或色碼。
- 字級：維持規格 12／14／16／20／28；**新增 `text-2xs`（11 px）**，只給密集的輔助標記（快捷鍵、日曆格的星期與時數、計數徽章、熱度圖圖例、圖表刻度）。任務標題由 15 px 改為 16 px；Markdown 預覽標題改為 20／16／14，行內程式碼與表格 12；編輯器 14。筆記本風格的手寫字也改用字級 token（側欄 16、品牌 20、任務標題 16）。
- 圓角：只用 `rounded-card`（12）、`rounded-ctl`（8，按鈕、輸入框、可點的列與圖示按鈕）、`rounded-sm`（4，色塊、行內程式碼、筆記本的印章與標籤）、`rounded-full`（標籤、徽章）。
- 陰影只有兩級：`shadow-pop`（下拉、toast、tooltip、拖曳中）、`shadow-overlay`（對話框、指令面板、任務面板）；遮罩統一 `bg-overlay`（35% 黑）。層級改用 `--z-sticky／raised／panel／modal／toast／popover`。
- 共用元件（`ui.tsx`）新增：`IconButton`、`LinkButton`、`Segmented`、`ErrorText`、`PageTitle`、`Tag tone="warn"`、`Banner tone="danger"`、`Button variant="soft"`，以及 `TITLE_FIELD`、`INPUT_CLASS` 樣式常數。週報／績效、小交流、Prompt 頁的標題改用 `PageTitle`，筆記本風格的手寫標題也會套用。
- Heatmap 的 tooltip 改成與圖表相同的卡片外觀。

## 一鍵快照（2026-11-18 新增，規格未涵蓋）

- 情境：使用者想把小交流、週報／績效直接貼到 Telegram，不想手動截圖。
- 小交流與週報／績效工具列新增「複製圖片」：按下後在畫面外渲染**專用分享卡片**（`ui/src/components/ShareCard.tsx`），轉成 PNG 寫入剪貼簿，到 TG 按 `Ctrl+V` 即可。今日頁與單一任務卡片不提供。
- 卡片內容：種類標記、標題（內文開頭的一級標題會拆出來當標題，避免重複）、期間／日期與 `user_name`、總時數／任務數／完成率；週報與績效另有專案時數環圈圖；Markdown 內文；頁尾「Worktrail・產生於 時間」。固定寬 720 CSS px，輸出 2 倍（1440 px 寬）。
- **一律淺色**：深色模式下也用淺色 token（TG 不論深淺主題白底都清楚）；介面風格（簡約／筆記本）照目前設定。做法是 `.force-light` 類別重新宣告淺色 token（`:root, .force-light`、`.notebook, .notebook .force-light`），並把 `@theme` 的色彩別名改成 `@theme inline`，讓 utilities 直接引用 `var(--ink)` 等，子樹覆寫 token 才會生效。主畫面的外觀不變。
- 截圖用 `modern-screenshot`（SVG foreignObject，由瀏覽器排版），支援 Tailwind 4 的 `oklch` 與網路字型；`html2canvas` 不支援 `oklch`。
- 剪貼簿：在點擊事件內同步呼叫 `navigator.clipboard.write`，`ClipboardItem` 直接收 PNG 的 Promise，才不會失去使用者手勢。寫入失敗（瀏覽器不支援、權限）時改為下載 PNG。
- 卡片掛上後以 `setTimeout` 等待 150 ms（讓 Recharts 量測尺寸），不用 `requestAnimationFrame`：視窗在背景時 rAF 暫停，截圖會卡住。
- 長圖：TG 壓縮圖片的最長邊約 2560 px，卡片高度超過 2560 CSS px 時，提示貼上時取消勾選「壓縮圖片」以原圖傳送。

## 專案固定 ID（2026-11-18 新增，規格 4.2、10 未涵蓋）

- `projects[].id`：專案規則的固定 ID。設定檔未填時由名稱產生（`p_` + 名稱 SHA-1 前 8 碼），同名結果一致；服務啟動與每次存檔都會寫回設定檔。UI 新增專案時直接產生隨機 ID。
- 任務檔新增 `project_id`，`project` 仍保留名稱（方便閱讀，其他程式照舊使用名稱）。
- **改名**：存檔後依 ID 把所有任務的 `project` 改成新名稱（含已鎖定、已合併的任務）。
- **舊資料轉換**：沒有 `project_id`、但名稱與某個專案相同的任務自動補上 ID（含原本「未對應」、以資料夾名稱為專案的任務：建立同名專案即可收編）。
- **合併專案**（`POST /api/projects/merge`）：來源的對應條件併入目標、刪除來源，任務改到目標。
- **刪除專案**：任務保留原名稱與已失效的 ID，之後改名不再跟著更新；日後再建立同名專案會重新收編。
- 手動指定名稱（任務面板、手動任務、合併任務、`worklog_save_summary` 的 `project`）：名稱符合設定中的專案時帶上 ID，否則清掉 ID。
- 自動判斷為「未對應」時，不覆蓋已經對應到專案的任務（例如規則調整後工作目錄不再符合、或父卡片暫時查不到），避免分好的專案被改回資料夾名稱。

## 依 Jira 父卡片分類專案（2026-11-18 新增，與規格 6.5 不同）

| 規格 6.5 | 實作 | 原因 |
| --- | --- | --- |
| 路徑 → 單號代碼 → 資料夾名稱 | **父卡片** → 路徑 → 單號代碼 → 最上層卡片標題 → 資料夾名稱 | 任務多來自 Jira，同一個 repo 常同時處理不同 Epic 的單，父卡片比工作目錄準 |

- 規則新增 `match.parents`：列出的單號是這張單本身或其任一層上層卡片時符合。
- **單號資訊快取**（`<storage>/.worktrail/ticket-info.json`）：常駐服務以 `claude -p` 透過 Jira MCP（`claude_cli.jira_mcp_server`，只允許 `getAccessibleAtlassianResources`、`getJiraIssue`）查詢標題、類型與上層卡片（最多 4 層），每次最多 15 張單。Worktrail 本身仍不呼叫 Jira API（規格 1.3）。
- 查詢時機：服務啟動後與之後每 10 分鐘（補漏掃描進行中時略過），只查近 60 天任務的單號中沒有快取、超過 7 天、或上次失敗超過 6 小時者；設定頁可手動「立即查詢父卡片」。`ticket.fetch_parents: false` 關閉自動查詢。
- 查詢失敗時保留先前成功的上層資料，只記錄錯誤。
- hook 擷取只讀快取，不連線，不影響 2 秒上限；新單號在快取查到之前照舊以路徑、單號代碼分類，查到後由服務重新判斷未鎖定、非手動的任務。
- 都不符合、但有上層卡片時，以最上層卡片的標題當專案名稱（標示未對應）；設定頁列出「尚未建立專案的上層卡片」，可一鍵建立專案。

## 大型工作自動建立專案（2026-11-18）

- 原本查到父卡片後，要使用者在「尚未建立專案的上層卡片」逐一按「建立專案」；使用者回饋畫面難懂，改成自動建立。
- `ticket.auto_projects`（預設開）：查詢父卡片結束、服務啟動時，每張沒有父卡片規則的最上層卡片（Jira 中文介面稱「大型工作」）自動建立以卡片標題為名的專案；標題與既有專案相同時，把卡片加到該專案的父卡片條件。
- `ticket.ignored_parents`：使用者刪除專案或從條件拿掉的大型工作記到這裡，之後不再自動建立；重新加回條件時移出。由 `PUT /api/config` 比較前後設定自動維護，UI 不直接編輯。
- 設定頁改為專案清單：名稱可直接改、下方列出大型工作單號與標題，「條件」展開工作目錄／Jira 代碼等進階條件，「合併」「刪除」用文字按鈕。拿掉建議清單。
- 設定頁沒有未送出的修改時，服務端改了設定（例如自動建立專案）會同步到畫面，避免舊畫面送出時把自動建立的專案刪掉並記入忽略清單。

## 介面簡化（2026-11-18）

| 規格 | 實作 | 原因 |
| --- | --- | --- |
| 11.4 今日頁右上角「立即掃描」 | 移到設定 → 整合與指令面板；今日頁有待補摘要時改顯示提示條，連到「待補摘要」頁 | hook 即時擷取、每日補漏已涵蓋，一般使用者不知道何時該按；待補摘要原本只有側欄小徽章，行動版沒有入口 |
| 11.4 設定 → 一般有「語言」 | 移除 UI 欄位與預設 config 的 `language`；schema 保留欄位以相容舊設定檔 | 沒有任何功能讀取這個設定 |
| 11.4 設定 → 記錄平鋪所有參數 | 閒置門檻、閒置寬限、補漏範圍、補漏時間、時區收進預設收合的「進階」 | 這幾項很少需要調整 |
| 刪除前確認 | 任務、小交流、自訂範本刪除，以及待補頁「全部不需要摘要」都直接執行，以 8 秒復原取代確認框 | 已能復原，確認框只是多按一次；覆蓋已編輯報告、停止服務等不可復原的操作仍保留確認 |

- 用詞統一：沒有單號一律顯示「無單號」；`stale` 顯示為「有新進度，可更新摘要」；待補頁批次按鈕改叫「全部不需要摘要」，與單筆「不需要摘要」一致。
- 今日頁副標的任務數改算實際任務數（合併組不再只算 1 個）。

## 寫日誌一次呼叫完成（2026-11-18，與規格 5.2、7.2、7.2.1、8 不同）

| 規格 | 實作 | 原因 |
| --- | --- | --- |
| 5.2、8：先呼叫 `worklog_get_summary_guide`，再依範本呼叫 `worklog_save_summary` 並帶回 `prompt_name`、`prompt_hash` | 直接呼叫 `worklog_save_summary` 即可；`get_summary_guide` 改為選用 | 每次寫日誌都要兩次呼叫、抄回範本代碼，Claude 常漏帶，日誌就被標成「未套用範本」 |
| 7.2 Session 對應：省略 `session_id` 時取同工作目錄、10 分鐘內有活動的唯一 session | 先從紀錄檔找出呼叫端，找不到才用原規則 | 原規則在同資料夾開兩個對話、或一次回應超過 10 分鐘時會失敗，所以規則、指令、範本到處都要 Claude 去找 session_id |
| 7.2.1 未帶 `prompt_hash` 記為 `summary_prompt: none` 並警告 | 未帶時記為設定的預設摘要範本，不再警告 | 預設範本的撰寫規則已在工具說明中 |
| 8：CLAUDE.md 規則三行、「收到 [Worktrail] 開頭的提示時，先更新日誌」 | 縮成兩行，只針對「要求更新日誌」的提示 | 對話開頭的 `[Worktrail] session_id=…` 也是這個開頭，Claude 可能一開場就去寫日誌 |

- **找出呼叫端**（`findCallingSession`，`src/core/sync/locate.ts`）：Claude Code 執行工具前就把 tool_use 寫入紀錄檔。MCP 讀取同一工作目錄（資料夾名稱不分大小寫）中、10 分鐘內有更新的紀錄檔尾端 256 KB，找出尚未回覆、名稱為 `mcp__*__<工具名>` 的呼叫；多個時取呼叫時間最新的。原始格式的解析放在 `src/core/transcript/`（`pendingToolUses`）。子代理在自己的紀錄檔中呼叫時找不到，退回原規則。
- **撰寫規則放進工具說明**：MCP 啟動時，從設定的預設摘要範本取出「## 撰寫規則」段落，附在 `worklog_save_summary` 的說明中。範本沒有這一段時，說明改為要求先呼叫 `worklog_get_summary_guide`。修改範本後，新的對話才會讀到。
- **前次未完成項目**：`worklog_save_summary` 寫入後，比對同單號前次未完成的項目（去除空白後比對文字）。有遺漏時，回應帶 `previous_open_items` 與 `next_step`，請 Claude 補進清單再呼叫一次。MCP 說明不再要求對話開頭呼叫 `worklog_carry_over`，工具本身保留。
- **把關訊息**改為「請先呼叫 worklog_save_summary 更新子項與狀態後再結束」；`/worklog` 指令同步簡化。
- 錯誤訊息改成說明原因與處理方式（找不到對話紀錄、參數有誤）。
- 已安裝的使用者要重新執行一鍵安裝，才會更新 `~/.claude/CLAUDE.md`、`/worklog` 指令；MCP 說明在新的對話中生效。

## 擷取時少啟動 git（2026-11-18）

- 規格 5.1 以 `git config user.email` 與 `git log --author` 取得本人的 commit，每次擷取依序啟動兩次 git。Windows 忙碌時每次 spawn 可達 1～3 秒，Stop hook 容易超過 2 秒上限而放棄本次擷取。
- 改為：
  - 作者 email 直接讀 repo 的 `.git/config`（含 worktree 的 commondir），其次 `~/.gitconfig`、`$XDG_CONFIG_HOME/git/config`。
  - 設定檔用了 `include`／`includeIf` 時無法單靠讀檔判斷，才改問 git，並與 `git log` 同時執行。
  - `git log` 輸出作者 email（`%ae`），在程式中比對，不再用 `--author`。
- 工作目錄不是 git 專案（或已不存在）時不啟動 git。
- `runHook` 新增選填的時間上限參數，正式執行仍固定 2 秒；測試放寬，避免把機器忙碌造成的逾時誤判為功能錯誤。2 秒上限由「打包後的 hook 實際執行」測試驗證。

## 安裝後免手動步驟（2026-11-18）

- **更新後自動重啟服務**：`daemon.json` 新增 `build`（服務啟動時 `cli.cjs` 的修改時間）。重新建置後兩者不同，代表服務還在跑舊程式。
  - `worktrail install` 結束時、啟動器開啟時都會檢查，舊版就先停止再以新程式啟動。
  - 沒有 `build` 欄位的舊服務一律視為過期，所以這版之後第一次更新也會自動重啟。
- **一鍵安裝只問必要問題**：只有安裝 Node.js、Claude Code 會詢問。
  - 腳本改以 `install --yes` 執行：日誌資料夾沿用上次位置，第一次為 `~/Worktrail`；開機自動啟動預設開啟；安裝完直接開啟 UI。
  - 手動執行 `worktrail install`（不帶 `--yes`）仍會詢問。
  - 設定 → 整合新增「開機自動啟動」開關（`GET/PUT /api/autostart`）。
- **Claude 登入**：
  - 一鍵安裝以 `claude auth status --json` 檢查，未登入時直接執行 `claude auth login`。舊版 Claude Code 沒有這個指令時略過。
  - `doctor` 與設定 → 整合多一項「已登入 Claude 帳號」（結果快取 5 分鐘）。
  - 測試以 `checkLogin: false` 關閉這項檢查：在暫存的 `CLAUDE_CONFIG_DIR` 下執行真正的 claude，會改寫暫存的 settings.json。
- **偵測新的 Jira 專案代碼**（`suggestTicketKeys`）：近 30 天任務的分支、commit 訊息、標題中，出現不在 `ticket.keys` 的代碼時，今日頁詢問是否加入。
  - 建議門檻：分支出現 1 次，或只在 commit／標題出現但跨 2 個以上任務。
  - 不建議 UTF、SHA、CVE 等常見的非單號代碼。
  - 按「加入」後，重新擷取提到該代碼的 session，補上單號。
  - 按「不是單號」後記到 `ticket.ignored_keys`，之後不再詢問。

## MCP 工具與 CLI 精簡（2026-11-18，與規格 7、13.1 不同）

- **週報、績效存檔**：`worklog_report_save` 只需要 `type`、`period_id`（prepare 回傳）、`content`、`overwrite`。
  - 原本要 Claude 把 `period`、`stats`、`sources`、`prompt_name`、`prompt_hash` 原樣抄回，耗 token 也可能抄錯。
  - 現在由伺服器依 `period_id` 重新計算統計、來源與範本雜湊；prepare 用的範本記在 MCP 程序內，save 時沿用。
  - prepare 的回應不再列出 `sources`、`prompt_name`、`prompt_hash`，改附 `next_step` 說明怎麼存檔。
- **MCP 工具從 9 個減為 7 個**：
  - 移除 `worklog_carry_over`：前次未完成項目已由 `worklog_get_summary_guide` 的 `previous_items` 與 `worklog_save_summary` 的提示提供。
  - 移除 `worklog_list_prompts`、`worklog_get_config`，新增 `worklog_open_ui`：啟動服務（若未執行）並開啟視窗，`/worklog-ui` 改呼叫它。
- **CLI**：`start`、`hook`、`mcp` 只給啟動器與 Claude Code 使用，不列在 `--help` 中（仍可執行）。使用者開啟用 `open`，它已包含啟動服務與舊版自動重啟。

## 介面結構精簡（2026-11-18，與規格 11.3、11.4 不同）

- **導覽列**：小交流、週報、績效合併成一個「報告」（`/talk`、`/weekly`、`/performance` 都算這一項），頁首以分頁切換，小交流在最左邊，點「報告」預設開小交流。主要導覽為 今日、日誌、報告、提示詞（2026-11-19 由「Prompt」改名，頁面標題與指令面板為「提示詞範本」）。
- **側欄重新排版**：
  - 待補摘要從底部的小徽章改成主要導覽的第一個項目，右側顯示數量；只在有待補（或正在看該頁）時出現。收合時數量改成圖示右上角的小標。
  - 底部只有「設定」與右側的收合按鈕；收合時兩者上下排列。行動版選單為主要導覽與設定。
- **主題只有淺色、深色**，移到設定 → 一般切換，側欄不再放主題按鈕；指令面板仍可切換。
  - `ui.theme` 移除 `system`（跟隨系統），舊設定檔的 `system` 讀取時視為淺色，預設為淺色。
  - 三頁共用的狀態標示、範本選單與編輯模式抽到 `ui/src/components/DocShared.tsx`。
  - 編輯／預覽／並排改成三頁共用一個偏好（`wt.doc.mode`，第一次讀取時沿用舊的 `wt.report.mode`、`wt.talk.mode`）。
  - 兩頁的產生、存檔、衝突處理流程仍各自實作：小交流多了日期選擇，合成一個元件的風險較高，這次沒做。
- **預設範本只在 Prompt 頁設定**：設定 → 報告移除四個預設範本下拉，改成連到 Prompt 頁。
  - 「從 Jira 整理的範本」移到設定 → Jira。
  - 產生頁的範本選單只在有兩個以上可選範本時顯示。內建範本與預設範本內容相同，不列入選項。
- **內建範本直接修改**：編輯內建範本時，自動另存成「我的版本」（檔名 `my-<時間>`）並設為預設，再切換過去。
  - 「複製為新範本」只需填名稱，檔名自動產生。
- **試跑**：一鍵「試跑」就填入資料並產生預覽，完整 prompt 收在可展開的區塊。另有「只看 prompt」，不使用 Claude 額度。
- **設定頁**：Jira 專案代碼、依大型工作建立專案、從 Jira 整理的範本、Jira MCP 名稱集中到「Jira」區塊；「單號與專案」改名「專案」。
  - 「依大型工作自動建立專案」仍同時寫入 `ticket.fetch_parents` 與 `ticket.auto_projects`。合併成一個設定欄位要遷移舊設定檔，這次沒做。
- **任務面板**：今日、待補摘要、日誌三頁都以網址參數 `?task=` 開啟（`useOpenTask`），重新整理或分享網址會停在同一個任務。
  - 工作目錄、Session ID、摘要範本收進預設收合的「詳細資訊」。
  - 任務卡片移除「未套用範本」圖示。
- **日誌頁**移除「摘要狀態」篩選，改成連到待補摘要頁。

## 實際驗證時修正（2026-11-18）

- **一鍵安裝第 1 步在 Windows PowerShell 5.1 失敗**（原有問題）：以 `node -p 'process.versions.node.split(".")[0]'` 取版本時，5.1 傳給外部程式會吃掉內層雙引號，node 收到無效程式碼並寫入 stderr；加上 `$ErrorActionPreference = 'Stop'`，被重新導向的 stderr 會變成例外，安裝直接中止。
  - 改為 `node -p process.versions.node` 後在 PowerShell 解析版本。
  - 外部程式的查詢一律經 `Invoke-Quiet`：暫時改回 `Continue`，忽略 stderr 與失敗。
- **重複安裝時，settings.json 只是鍵的順序不同也會備份並改寫**：Claude Code 會以不同順序改寫設定檔。比較改用不受鍵順序影響的 `stableJson`，內容相同時不再備份。

## 複製 Jira 進度（2026-11-18 新增，規格 11.4 未涵蓋）

- 情境：使用者習慣在 Jira 卡片留言當天進度，想直接從 Worktrail 複製文字貼上。
- 以**單號**為單位：按鈕複製當天同一個單號（不分大小寫）所有任務的子項，依開始時間排序，相同的子項只列一次。沒有單號的任務只複製它自己。
- 入口：任務卡片右上角（滑過時出現）、合併組裡每個任務列、任務側欄底部「複製 Jira 進度」。不提供「複製今日全部」，因為要分別貼到各張卡片。
- 格式固定為**乾淨純文字**（只寫 `text/plain`，不放 HTML、Markdown 粗體、反引號或 emoji），使用者明確要求：
  ```
  2026/11/18
  - [完成] 子項內容
  - [卡住] 子項內容（備註）
  ```
  狀態標籤與介面相同（完成、待進行、未開始、暫不處理、卡住）；子項內的換行改成空白。沒有子項時改列標題，並提示可先補寫摘要。
- 日期行用「YYYY/MM/DD」（原本是「M/D 進度」，使用者要求改成完整日期），能被「從 Jira 整理」讀回，同一則留言裡累積多天的段落也會被正確分段。`isDateHeading` 仍允許日期後接「進度」，相容手寫的「11/18 進度」。
- Worktrail 仍不呼叫 Jira API（規格 1.3），只複製到剪貼簿，由使用者自行貼上。
- 純函式在 `ui/src/lib/jira-copy.ts`；`STATUS_LABEL` 與 `displayTitle` 移到不引入其他模組的 `ui/src/lib/task-text.ts`（`format.ts` 轉出），讓後端的 vitest 能直接載入。

## 報告清單與搜尋不重讀檔案（2026-11-19）

- 原本開「報告」頁時，每份已產生的報告都以 `listTasks` 重讀期間內的任務檔來判斷是否過期；搜尋則每次查詢都把所有週報、績效報告讀進來比對內文。報告累積越多越慢。
- 新增 `ReportSource`（`src/core/report/source.ts`）：報告的準備與過期判斷可改用注入的資料來源，預設仍直接讀檔（MCP、CLI、背景產生報告不變）。
- daemon 的來源：任務用記憶體索引 `TaskIndex`；報告用 `ReportFileCache`，每次仍列資料夾並 stat，只有修改時間或大小變動的檔案才重讀。不依賴檔案監看，MCP 寫入或手動編輯後下一次查詢就會反映。
- 報告清單每期的任務數改為對排序後的日期二分搜尋（`countInRange`），不再每期跑一次 `index.query`。

## daemon 路由只做轉接（2026-11-19）

- 依「業務邏輯放 `src/core/` 並附單元測試」的原則，把 `src/daemon/server.ts` 路由裡的整理邏輯搬到 core，路由只負責解析參數、取檔案鎖、寫檔與推播：
  - 報告清單、績效每週時數、手動編輯後的報告內容 → `src/core/report/list.ts`（`listReportPeriods`、`weeklyHours`、`editedReport`）
  - 設定頁的專案清單 → `projectRuleSummaries`（`src/core/sync/projects.ts`）
  - 加入／忽略 Jira 專案代碼、找出提到該代碼的任務 → `applyTicketKeyAction`、`tasksMentioningKey`（`src/core/capture/ticket.ts`）
  - 小交流的狀態、編輯、垃圾桶還原 id → `talkStatus`、`applyTalkEdit`、`talkIdFromTrash`（`src/core/talk/index.ts`）
  - 預設範本清單與刪除檢查 → `defaultPromptRefs`、`promptDeleteError`（`src/core/prompt/index.ts`）
- 行為不變，單元測試在 `test/daemon-logic.test.ts`。

## 年度考核表範本（2026-11-19）

- 公司年度績效評核表的「I. 工作專案與日常任務」每個專案一列，三欄為「專案/日常任務」「執行內容/要項」「請描述達成狀況」，達成狀況依 STAR 寫成「情境 (Situation)」「任務 (Task)」「執行內容 (Action)」「量化成果 (Result)」四段。
- 新增內建範本 `performance/appraisal`（「年度考核表（STAR）」），不取代 `performance/default`；在報告頁的範本選單選用。輸入與標準績效相同（期間內的週報＋統計數字），不需改程式。
- 輸出以 `##` 分專案、`###` 分欄（UI 中 `###` 與 `####` 幾乎一樣大，專案與欄位分不出層級）；欄內只用「一、」「1.」「- 」開頭、不用粗體與程式碼區塊，原始文字就能直接貼進 Excel 儲存格（程式碼區塊在 UI 會橫向捲動，不適合長段中文）。
- 量化成果的數字只能來自統計或週報；找不到時寫質化成果並加註「（可補充數據）」，由使用者補上，避免模型編造數字。
- 只處理第 I 部分；OKR 與正負評回饋屬主觀內容，仍由使用者自行填寫。
- 預覽改成考核表的三欄表格（使用者回饋：一般 Markdown 預覽要自己找哪段該貼到哪格，不直覺）：
  - `ui/src/lib/appraisal.ts` 的 `parseAppraisal` 依內容判斷（`##` 專案底下有「執行內容/要項」或「請描述達成狀況」的 `###`），不看範本名稱，使用者另存或修改過的範本也適用；不符合結構時退回一般 Markdown 預覽。
  - 每格顯示的就是要貼進儲存格的純文字（保留換行、去掉粗體），滑過儲存格時右上角才出現複製圖示，只複製這一格（原本常駐的「複製」文字鈕佔一整行且突兀，使用者回饋後改掉）。不做「整列複製成三格」：考核表的達成狀況欄是合併儲存格，貼上多欄會被 Excel 拒絕。
  - 預覽欄窄於 48rem（例如並排模式）時改為上下排列，每格標出欄名。
  - 複製先用 Clipboard API，被拒時退回隱藏文字框＋`execCommand('copy')`。

## 首次引導（2026-11-20 新增，規格未涵蓋）

- 原本安裝後要使用者自己到設定頁改名字、Jira 代碼等；預設的 Jira 代碼 `TDDA` 對其他團隊一定是錯的，而沒列入的代碼不會被認成單號，直接影響紀錄正確性。改成第一次開啟 UI 時先走四步引導：你是誰（名字、每日工時）→ Jira 代碼 → 報告週期 → 外觀與完成（主題、風格、環境檢查、提醒開新對話）。
- 只放「預設值大多數人不能直接用、使用者一看就知道答案」的設定。閒置門檻、把關、補漏時間、儲存資料夾、專案對應規則等留在設定頁：預設值可用，或新手沒有判斷依據。
- **觸發條件**：`ui.onboarding`（`pending`／`done`）。新建立的 `config.yaml`（`DEFAULT_CONFIG_YAML`）寫入 `pending`；schema 預設為 `done`，所以舊版建立、沒有這個欄位的設定檔視為已完成，升級的人不會跳出引導。不用「有沒有任務」之類的推測：安裝後啟動補漏會立刻建立任務，推測不可靠。
- **Jira 代碼候選**（`ticketKeyChoices`，`src/core/onboarding/`）：設定中的代碼＋`suggestTicketKeys` 偵測到的新代碼。新代碼預先勾選；設定中的代碼近期有出現才勾，近期完全沒有任何代碼時保留原設定（可能只是還沒有紀錄）。啟動補漏還在執行時頁面提示「正在掃描」，掃描結束後自動更新清單（使用者還沒動過勾選時）。
- 送出時（`applyTicketKeySelection`）勾選的成為 `ticket.keys`；列出卻沒勾的偵測代碼記到 `ignored_keys`，今日頁不會再問一次；原有代碼沒勾只移除、不列入忽略。加入或移除的代碼，讓提到它的近期任務重新擷取。
- 報告週期即時顯示本期週報與績效範圍（`previewPeriods`），由服務端以 core 的期間函式計算，UI 不重寫期間邏輯。
- 每一步按「下一步」就以服務端最新設定為底、只寫入該步負責的欄位，中途關掉不會遺失，也不會蓋掉背景自動建立的專案。主題與風格點選即套用到畫面，完成或「稍後再設定」時一併存檔。
- 設定 → 一般 →「重新執行引導」開啟 `/welcome`，不改 `ui.onboarding`。
- 示範資料（`scripts/demo/seed.mts`）設為 `done`，錄 GIF 時不會停在引導頁。

## Jira 每日活動同步（2026-11-25 新增，規格未涵蓋）

- 起因：只從 Claude Code 對話擷取任務，沒用 Claude 處理的單（手動測試後留言 test pass、移動狀態）會漏記。參考使用者既有的「QA 日報」排程（JQL 找候選＋看 changelog 作者確認是本人）。計畫書見 `docs/計畫-Jira每日活動同步.md`。
- 抓取（`claude -p`，只回原始 JSON）：第一次以 `atlassianUserInfo` 取 accountId，並用兩個 JQL 找候選單號（我建立／指派給我／關注中／當天我改過狀態，且 `updated >= 當天`；限定 `ticket.keys` 的專案）與當天我建立的單；第二次起每 8 張單呼叫 `getJiraIssue`（comment＋changelog）。JQL 用絕對日期字串。
- 判斷在 `src/core/jira-activity/` 以程式處理：只留作者是我、建立時間換算 `time.timezone` 後是當天的留言與變更；`ignore_fields`（預設 Rank、Sprint）不算。`updated` 時間不可信（同事整批調整排序也會更新）。
- 合併：同單號（含 `related_tickets`）已有 Claude 或手動任務時，不另建任務，把活動寫進該任務補充說明的 `<!-- worktrail:jira-activity -->` 區塊（重跑時取代，不動使用者其他內容）；否則建立 Jira 任務：`manual: true`、`source: jira`、session_id 為 `sha1(jira|日期|單號)`（同一天同單號固定一筆）、時數 `jira_activity.default_hours`（使用者指定 0.5，`hours_source: user`，不參與每日工時縮減）、專案依單號規則判斷（`reresolveProject` 對 Jira 任務不跳過）。
- 子項預設以 `summary.jira_prompt` 範本請 Claude 整理，失敗或關閉 `ai_items` 時用固定格式（狀態 A → B、留言第一行、更新欄位）。
- 使用者修改的保護：`jira_sync.content_hash` 記錄自動產生時的標題＋子項＋時數；之後不一致即視為改過，不再覆蓋。`events_hash` 沒變就不重新整理。Claude 任務後來才出現時，未改過的 Jira 任務移到垃圾桶並改為附加。使用者刪除的 Jira 任務：`jira-sync.json` 的 `created` 記錄過、檔案不在了，就不再建立。
- 排程：`jira_activity.time`（預設 18:00）同步今天；過去 `lookback_days`（預設 7）天內、尚未在「那天結束之後」成功同步的工作日也會補抓（當天 18:00 之後的工作隔天補上）。失敗一小時後重試；任何失敗只記錄並在今日頁顯示警告，不寫入佔位資料（QA 日報曾因 JQL 工具壞掉靜默漏了一週）。
- 2026-11-25 修訂（重試會耗用大量 token）：原本只要有一張單讀取失敗，整天就標記失敗、每小時重讀全部單號。改為：
  - 部分單號讀取失敗：記在 `jira-sync.json` 的 `failed`（單號＋原因），那天視為已同步，**不自動重試**。今日頁列出失敗單號，按「重試這 N 張」只重新讀取那幾張（CLI：`jira-sync --failed` 列出、`--retry-failed` 重試）。重試時附加到既有任務的附註只更新該單的段落。
  - 整次失敗（例如 JQL 查詢失敗）：一小時後自動重試，總共最多 2 次（`attempts`），之後只顯示警告。
- 2026-11-26 修訂（讀取單號失敗率高）：原本請模型把留言與 changelog 轉成 JSON 輸出。一張單的 getJiraIssue 回傳常有 50–65KB，Claude Code 會把它存成檔案只給模型路徑，模型得分段讀檔再轉述，常被截斷（「JSON 不完整」）或改寫腳本處理而沒輸出（「找不到 JSON」）。改為：
  - `claude -p --output-format stream-json --verbose`，模型只負責呼叫工具並回覆 OK；程式用 `toolResultsFromStream` 取得 getJiraIssue 的原始回傳，太大被存成檔案時（`<persisted-output>…saved to:` 或 `Error: result … exceeds maximum allowed tokens. Output has been saved to …`）直接讀檔後刪除。
  - `issuesFromRaw` 解析原始 `{issues:{nodes:[…]}}`（也接受單一 issue、ADF 留言），作者與日期過濾仍由 `myEventsOn` 處理。
  - 每批改為 8 張；沒取到的單再試一次。實測：11/18–11/25 先前失敗的 16 張全部讀取成功，每批約 1–2 分鐘。
- 2026-11-26 修訂（token 用量）：`claude -p` 預設會載入使用者全部設定（41 個內建工具、所有 MCP、22 個 skills、CLAUDE.md／記憶、Claude Code 完整系統提示），每輪約 43k token，讀一張單約 0.28 美元。改為精簡模式（`claude_cli.jira_lean`，預設開啟）：
  - `--strict-mcp-config --mcp-config <只含 Jira MCP 的設定>`（從 `~/.claude.json` 取出，寫到 `claude-runs/jira-mcp.json`）、`--disable-slash-commands`、`--tools ToolSearch`（MCP 工具延遲載入需要它；不給 ToolSearch 時 MCP 還在連線中，模型拿不到工具）、`--system-prompt` 換成短提示、`--no-session-persistence`。
  - 讀取 Jira 只需呼叫工具與輸出 JSON，模型用 `claude_cli.jira_model`（預設 haiku）。實測讀 3 張單：Sonnet 精簡 0.069 美元、Haiku 精簡 0.030 美元（完整設定讀 1 張就 0.28 美元）。
  - 套用到：候選單號查詢、讀取單號、單號資訊（父卡片）查詢、「從 Jira 整理」。子項整理也用精簡模式（不載入任何工具與 MCP），但維持預設模型以保持文字品質。
  - 找不到 Jira MCP 設定時自動退回完整模式。
- 2026-11-26 找不到 Jira MCP 時提示重新設定：`GET /api/jira-mcp` 檢查 `claude_cli.jira_mcp_server` 是否在 `~/.claude.json`（使用者層級或任一專案層級）中，並列出已設定的 MCP（名稱或指令含 atlassian／jira 的排前面）。找不到時：
  - 今日頁頂端顯示紅色提示，可直接從下拉選單選擇已設定的 Jira MCP 並套用（`PUT /api/jira-mcp`）；完全沒有 Jira MCP 時顯示新增指令。設定頁 Jira 區塊同樣顯示狀態與選單。
  - Jira 活動同步在呼叫 claude 之前就停下並記錄錯誤，不白花 token。
  - 讀不到 `~/.claude.json`（無法判斷）或名稱是 claude.ai 連接器時不提示。
  - 子項整理回傳空陣列時改用固定格式，不再記為失敗。
