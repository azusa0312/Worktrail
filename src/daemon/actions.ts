/**
 * 以 `claude -p` 執行的工作：補寫摘要（規格 5.3）、產生報告（規格 9.6）、範本試跑（規格 11.4）。
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCliError,
  extractJson,
  findClaude,
  findMcpServerConfig,
  leanArgs,
  listMcpServers,
  type McpServerInfo,
  runClaudePrint,
  toolResultsFromStream,
} from '../core/claude-cli/index.js';
import { localDate } from '../core/capture/tz.js';
import type { Period } from '../core/period/index.js';
import { prepareReport, saveReport } from '../core/report/prepare.js';
import type { Config } from '../core/schema/config.js';
import type { ReportType } from '../core/schema/report.js';
import type { StoragePaths } from '../core/storage/paths.js';
import type { TaskRecord } from '../core/storage/tasks.js';
import { applySummary, buildSummaryGuide, condenseTranscript, SummaryInput } from '../core/summary/index.js';
import { buildJiraFetchPrompt, formatJiraContent, jiraAllowedTools, JiraFetchResult } from '../core/summary/jira.js';
import { maskSecrets } from '../core/summary/index.js';
import {
  activityContent,
  activityNote,
  buildCandidatesPrompt,
  buildIssuesPrompt,
  CandidatesOutput,
  candidatesAllowedTools,
  collectActivities,
  fallbackItems,
  isUserEdited,
  ISSUE_BATCH,
  issuesAllowedTools,
  issuesFromRaw,
  keysToFetch,
  mergeNote,
  upsertNoteTickets,
  newJiraTask,
  planJiraSync,
  readSyncState,
  updateSyncState,
  withJiraItems,
  type JiraActivity,
  type JiraIssueData,
} from '../core/jira-activity/index.js';
import { resolveProject } from '../core/capture/project.js';
import type { Item, Task } from '../core/schema/task.js';
import { ensureDir, withLock, writeFileAtomic } from '../core/storage/fsutil.js';
import { listTasks, readTask, taskLockKey, trashTask, writeTask } from '../core/storage/tasks.js';
import { applyResolvedProject } from '../core/sync/projects.js';
import { findTranscriptPath } from '../core/sync/locate.js';
import { prepareTalk, saveGeneratedTalk } from '../core/talk/index.js';
import {
  buildTicketInfoPrompt,
  parseTicketInfoOutput,
  readTicketCache,
  ticketInfoAllowedTools,
  updateTicketCache,
  type TicketInfo,
} from '../core/ticket-info/index.js';
import { parseTranscript } from '../core/transcript/index.js';
import type { JobContext } from './jobs.js';

/**
 * 讀取 Jira 的 claude -p 參數。精簡模式（預設）只載入 Jira MCP 並用小模型；
 * 找不到 Jira MCP 的設定（例如裝在別的 scope 或名稱不同）時退回完整模式，只限制 allowedTools。
 */
/** Claude Code 的使用者設定檔（~/.claude.json，MCP 伺服器設定在這裡）；讀不到時為 null */
function readClaudeJson(): unknown {
  try {
    return JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'), 'utf8'));
  } catch {
    return null;
  }
}

export interface JiraMcpStatus {
  /** 設定中的 Jira MCP 名稱 */
  server: string;
  /** Claude Code 設定中找得到這個 MCP */
  found: boolean;
  /** 讀不到 ~/.claude.json（無法判斷） */
  unknown: boolean;
  /** 已設定的 MCP（Jira 類排前面），供重新選擇 */
  servers: McpServerInfo[];
}

/** 檢查設定的 Jira MCP 是否存在；找不到時 UI 提示重新設定 */
export function jiraMcpStatus(config: Config): JiraMcpStatus {
  const server = config.claude_cli.jira_mcp_server || 'atlassian-rovo-mcp';
  const json = readClaudeJson();
  return { server, found: !!findMcpServerConfig(json, server), unknown: json === null, servers: listMcpServers(json) };
}

function jiraArgs(paths: StoragePaths, config: Config, allowedTools: string[]): string[] {
  const fallback = ['--allowedTools', ...allowedTools];
  if (!config.claude_cli.jira_lean) return fallback;
  const server = config.claude_cli.jira_mcp_server || 'atlassian-rovo-mcp';
  try {
    const conf = findMcpServerConfig(readClaudeJson(), server);
    if (!conf) return fallback;
    ensureDir(paths.claudeRuns);
    const file = join(paths.claudeRuns, 'jira-mcp.json');
    writeFileAtomic(file, JSON.stringify({ mcpServers: { [server]: conf } }, null, 2));
    return leanArgs({ mcpConfigPath: file, allowedTools, model: config.claude_cli.jira_model });
  } catch {
    return fallback;
  }
}

async function claudePath(config: Config): Promise<string> {
  const p = await findClaude(config.claude_cli.path);
  if (!p) throw new ClaudeCliError('找不到 claude CLI：請在設定 → 整合中指定路徑');
  return p;
}

/** 組出補寫摘要用的 prompt（試跑也用） */
export function summaryPromptFor(
  paths: StoragePaths,
  config: Config,
  task: TaskRecord,
  promptRef?: string,
  templateText?: string,
): { prompt: string; prompt_name: string; prompt_hash: string } {
  const transcriptPath = findTranscriptPath(paths, task.session_id, task.repo);
  if (!transcriptPath) throw new Error('找不到這個任務的對話紀錄檔，無法補寫摘要');
  const parsed = parseTranscript(readFileSync(transcriptPath, 'utf8'));
  const transcript = condenseTranscript(parsed.events, config.summary.max_input_chars, {
    date: task.date,
    timezone: config.time.timezone,
  });
  const g = buildSummaryGuide({
    paths,
    config,
    task,
    mode: 'json',
    transcript,
    prompt: promptRef,
    templateText,
    today: localDate(Date.now(), config.time.timezone),
  });
  return { prompt: g.guide, prompt_name: g.prompt_name, prompt_hash: g.prompt_hash };
}

export async function summarizeTask(
  paths: StoragePaths,
  config: Config,
  task: TaskRecord,
  ctx: JobContext,
): Promise<{ task_id: string; items: number; warnings: string[] }> {
  ctx.progress('整理對話紀錄…');
  const { prompt, prompt_name, prompt_hash } = summaryPromptFor(paths, config, task);
  ctx.progress('Claude 撰寫中…');
  const out = await runClaudePrint({
    claudePath: await claudePath(config),
    prompt,
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    onProgress: (n) => ctx.progress(`Claude 撰寫中…（${n} 字）`),
  });
  let parsed: unknown;
  try {
    parsed = extractJson(out);
  } catch (e) {
    throw new Error(`Claude 的輸出不是有效的 JSON，已保留草稿：${(e as Error).message}`);
  }
  const input = SummaryInput.safeParse({ ...(parsed as object), prompt_name, prompt_hash });
  if (!input.success) {
    throw new Error(`摘要格式不正確，已保留草稿：${input.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  }
  const r = await applySummary(paths, config, task.path, input.data);
  return { task_id: r.task.id, items: r.task.items.length, warnings: r.warnings };
}

/** 手動任務「從 Jira 整理」：claude -p 經 Jira MCP 讀留言 → 依內文日期（未標日期則依建立時間）過濾 → 套摘要範本產生子項 */
export async function jiraSummarizeTask(
  paths: StoragePaths,
  config: Config,
  task: TaskRecord,
  ctx: JobContext,
): Promise<{ task_id: string; items: number; comments: number; warnings: string[] }> {
  if (!task.ticket) throw new Error('這個任務沒有填單號');
  const claude = await claudePath(config);
  const server = config.claude_cli.jira_mcp_server || 'atlassian-rovo-mcp';
  ctx.progress(`讀取 ${task.ticket} 的留言…`);
  const raw = await runClaudePrint({
    claudePath: claude,
    prompt: buildJiraFetchPrompt(task.ticket, server),
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    timeoutMs: 5 * 60_000,
    extraArgs: jiraArgs(paths, config, jiraAllowedTools(server)),
  });
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    throw new Error(`無法讀取 Jira 留言（請確認 claude CLI 能使用 ${server}）：${raw.slice(0, 300)}`);
  }
  if (json && typeof json === 'object' && 'error' in json) throw new Error(`讀取 Jira 失敗：${String((json as { error: unknown }).error)}`);
  const fetched = JiraFetchResult.parse(json);
  const content = formatJiraContent(task.ticket, fetched, task.date, config.time.timezone);
  if (!content) {
    throw new Error(`${task.ticket} 共 ${fetched.comments.length} 則留言，沒有內文標示或在 ${task.date.replaceAll('-', '/')} 建立的留言`);
  }
  ctx.progress(`整理 ${content.count} 段留言…`);
  const g = buildSummaryGuide({
    paths,
    config,
    task,
    mode: 'json',
    prompt: config.summary.jira_prompt,
    transcript: content.text,
    today: localDate(Date.now(), config.time.timezone),
  });
  const out = await runClaudePrint({
    claudePath: claude,
    prompt: g.guide,
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    onProgress: (n) => ctx.progress(`Claude 撰寫中…（${n} 字）`),
  });
  let parsed: unknown;
  try {
    parsed = extractJson(out);
  } catch (e) {
    throw new Error(`Claude 的輸出不是有效的 JSON：${(e as Error).message}`);
  }
  const input = SummaryInput.safeParse({ ...(parsed as object), prompt_name: g.prompt_name, prompt_hash: g.prompt_hash });
  if (!input.success) throw new Error(`摘要格式不正確：${input.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  // 手動任務的標題是使用者填的；只有標題就是單號本身時，才換成 Jira 標題
  const keepTitle = task.title.trim().toUpperCase() !== task.ticket;
  const data = { ...input.data, title: keepTitle ? undefined : fetched.summary || input.data.title };
  const r = await applySummary(paths, config, task.path, data);
  return { task_id: r.task.id, items: r.task.items.length, comments: content.count, warnings: r.warnings };
}

export async function generateReport(
  paths: StoragePaths,
  config: Config,
  args: { type: ReportType; period: Period; prompt?: string; overwrite?: boolean },
  ctx: JobContext,
): Promise<{ report_id: string; warnings: string[] }> {
  ctx.progress('準備資料…');
  const today = localDate(Date.now(), config.time.timezone);
  const p = prepareReport({ paths, config, type: args.type, period: args.period, prompt: args.prompt, today });
  ctx.progress('Claude 撰寫中…');
  const out = await runClaudePrint({
    claudePath: await claudePath(config),
    prompt: `${p.rendered_prompt}\n\n---\n只輸出報告的 Markdown 內文，不要加上前言、說明或程式碼框。`,
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    onProgress: (n) => ctx.progress(`Claude 撰寫中…（${n} 字）`),
  });
  const content = out.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m, '$1');
  const r = saveReport({
    paths,
    config,
    type: args.type,
    period: p.period,
    prompt_name: p.prompt_name,
    prompt_hash: p.prompt_hash,
    sources: p.sources,
    stats: p.stats,
    content,
    overwrite: args.overwrite,
    sources_version: p.sources_version,
  });
  return { report_id: r.id, warnings: p.warnings };
}

/** 小交流：依勾選的日期產生簡短重點 */
export async function generateTalk(
  paths: StoragePaths,
  config: Config,
  args: { id: string; dates: string[]; prompt?: string; overwrite?: boolean },
  ctx: JobContext,
): Promise<{ talk_id: string; warnings: string[] }> {
  ctx.progress('準備資料…');
  const today = localDate(Date.now(), config.time.timezone);
  const p = prepareTalk({ paths, config, dates: args.dates, prompt: args.prompt, excludeId: args.id, today });
  ctx.progress('Claude 撰寫中…');
  const out = await runClaudePrint({
    claudePath: await claudePath(config),
    prompt: `${p.rendered_prompt}\n\n---\n只輸出重點的 Markdown 內文，不要加上前言、說明或程式碼框。`,
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    onProgress: (n) => ctx.progress(`Claude 撰寫中…（${n} 字）`),
  });
  const content = out.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m, '$1');
  const t = saveGeneratedTalk({ paths, config, id: args.id, prepared: p, content, overwrite: args.overwrite });
  return { talk_id: t.id, warnings: p.warnings };
}

/** 一次 claude -p 查詢的單號數上限 */
const TICKET_BATCH = 15;

/** 透過 Jira MCP 查詢單號的父卡片並寫入快取；回傳這次查詢的結果 */
export async function refreshTicketInfo(
  paths: StoragePaths,
  config: Config,
  tickets: readonly string[],
  ctx: JobContext,
): Promise<{ fetched: TicketInfo[]; errors: string[] }> {
  if (!tickets.length) return { fetched: [], errors: [] };
  const claude = await claudePath(config);
  const server = config.claude_cli.jira_mcp_server || 'atlassian-rovo-mcp';
  const fetched: TicketInfo[] = [];
  const errors: string[] = [];
  for (let i = 0; i < tickets.length; i += TICKET_BATCH) {
    if (ctx.signal.aborted) break;
    const batch = tickets.slice(i, i + TICKET_BATCH);
    ctx.progress(`查詢父卡片 ${Math.min(i + batch.length, tickets.length)}/${tickets.length}…`);
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    let infos: TicketInfo[];
    try {
      const raw = await runClaudePrint({
        claudePath: claude,
        prompt: buildTicketInfoPrompt(batch, server),
        cwd: paths.claudeRuns,
        signal: ctx.signal,
        timeoutMs: 5 * 60_000,
        extraArgs: jiraArgs(paths, config, ticketInfoAllowedTools(server)),
      });
      const json = extractJson(raw);
      if (json && typeof json === 'object' && 'error' in json && !('tickets' in json)) {
        throw new Error(String((json as { error: unknown }).error));
      }
      infos = parseTicketInfoOutput(json, batch, now);
    } catch (e) {
      if (ctx.signal.aborted) break;
      const msg = (e as Error).message.slice(0, 300);
      errors.push(`${batch.join(', ')}：${msg}`);
      infos = batch.map((key) => ({ key, summary: '', type: '', ancestors: [], fetched_at: now, error: msg }));
    }
    await updateTicketCache(paths, infos);
    fetched.push(...infos);
  }
  return { fetched, errors };
}

/** 試跑：以 prompt 產生輸出但不存檔 */
export async function previewOutput(config: Config, paths: StoragePaths, prompt: string, ctx: JobContext): Promise<{ output: string }> {
  ctx.progress('Claude 撰寫中…');
  const output = await runClaudePrint({
    claudePath: await claudePath(config),
    prompt,
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    onProgress: (n) => ctx.progress(`Claude 撰寫中…（${n} 字）`),
  });
  return { output };
}

// ───────────── Jira 每日活動同步

export interface JiraSyncResult {
  date: string;
  activities: number;
  created: string[];
  updated: string[];
  appended: string[];
  removed: string[];
  skipped: string[];
  errors: string[];
}

/**
 * 請 claude -p 呼叫 getJiraIssue，從 stream-json 直接取得原始回傳（不經模型轉述）。
 * 回傳太大時 Claude Code 會存成檔案，這裡讀檔後刪除。
 */
async function fetchIssuesRaw(
  claude: string,
  server: string,
  keys: readonly string[],
  paths: StoragePaths,
  config: Config,
  signal: AbortSignal,
): Promise<{ issues: JiraIssueData[]; errors: Map<string, string> }> {
  const stream = await runClaudePrint({
    claudePath: claude,
    prompt: buildIssuesPrompt(keys, server),
    cwd: paths.claudeRuns,
    signal,
    timeoutMs: 5 * 60_000,
    outputFormat: 'stream-json',
    extraArgs: jiraArgs(paths, config, issuesAllowedTools(server)),
  });
  const issues: JiraIssueData[] = [];
  const errors = new Map<string, string>();
  for (const r of toolResultsFromStream(stream)) {
    if (!r.name.endsWith('__getJiraIssue')) continue;
    const asked = String((r.input as { issueIdOrKey?: unknown } | null)?.issueIdOrKey ?? '').trim().toUpperCase();
    let text = r.text;
    if (r.persistedPath) {
      try {
        text = readFileSync(r.persistedPath, 'utf8');
      } catch (e) {
        if (asked) errors.set(asked, `讀不到工具回傳檔：${(e as Error).message.slice(0, 120)}`);
        continue;
      }
      try {
        unlinkSync(r.persistedPath);
      } catch {
        /* 刪不掉不影響結果 */
      }
    }
    if (r.isError) {
      if (asked) errors.set(asked, text.replace(/\s+/g, ' ').slice(0, 200) || 'getJiraIssue 失敗');
      continue;
    }
    try {
      const got = issuesFromRaw(JSON.parse(text));
      if (!got.length && asked) errors.set(asked, '回傳中沒有這張單');
      issues.push(...got);
    } catch (e) {
      if (asked) errors.set(asked, `無法解析 getJiraIssue 回傳：${(e as Error).message.slice(0, 120)}`);
    }
  }
  return { issues, errors };
}

/** 以 summary.jira_prompt 範本請 Claude 整理子項；失敗時丟出錯誤（由呼叫端退回固定格式） */
async function aiItemsFor(
  paths: StoragePaths,
  config: Config,
  claude: string,
  task: Task,
  content: string,
  ctx: JobContext,
): Promise<Item[]> {
  const g = buildSummaryGuide({
    paths,
    config,
    task,
    mode: 'json',
    prompt: config.summary.jira_prompt,
    transcript: content,
    today: localDate(Date.now(), config.time.timezone),
  });
  const out = await runClaudePrint({
    claudePath: claude,
    prompt: g.guide,
    cwd: paths.claudeRuns,
    signal: ctx.signal,
    timeoutMs: 5 * 60_000,
    // 只是依範本整理子項：不需要任何工具、MCP 或使用者設定
    extraArgs: config.claude_cli.jira_lean ? leanArgs({ mcpConfigPath: null, allowedTools: [] }) : [],
  });
  const json = extractJson(out);
  // 模型認為沒有值得列的項目時會回空陣列：交給呼叫端改用固定格式，不算失敗
  if (json && typeof json === 'object' && Array.isArray((json as { items?: unknown }).items) && !(json as { items: unknown[] }).items.length) return [];
  return SummaryInput.parse(json).items;
}

/**
 * 同步某一天的 Jira 活動：claude -p 讀取 → 程式過濾 → 新增／更新 Jira 任務，或附加到同單號的既有任務。
 * 讀取失敗時只記錄錯誤，不寫入任何佔位資料。
 */
/**
 * 同步某一天的 Jira 活動。
 * onlyKeys：只重新讀取這幾張單（重試先前讀取失敗的單），其他單的紀錄維持不動。
 */
export async function syncJiraActivity(
  paths: StoragePaths,
  config: Config,
  date: string,
  ctx: JobContext,
  opts: { onlyKeys?: readonly string[] } = {},
): Promise<JiraSyncResult> {
  const tz = config.time.timezone;
  const ja = config.jira_activity;
  const result: JiraSyncResult = { date, activities: 0, created: [], updated: [], appended: [], removed: [], skipped: [], errors: [] };
  const recordFailure = async (msg: string) =>
    updateSyncState(paths, (s) => {
      const prev = s.days[date];
      s.days[date] = {
        synced_at: new Date().toISOString(),
        tickets: prev?.tickets ?? [],
        created: prev?.created ?? [],
        error: msg.slice(0, 300),
        failed: prev?.failed ?? [],
        attempts: (prev?.attempts ?? 0) + 1,
      };
    });
  try {
    const claude = await claudePath(config);
    const server = config.claude_cli.jira_mcp_server || 'atlassian-rovo-mcp';
    // 找不到 Jira MCP 時直接停下（不呼叫 claude，免得白花 token）；claude.ai 連接器不在 ~/.claude.json，不檢查
    const mcp = jiraMcpStatus(config);
    if (!mcp.found && !mcp.unknown && !/^claude[._ ]ai/i.test(server)) {
      throw new Error(`找不到 Jira MCP「${server}」，請到設定 → Jira 重新選擇`);
    }

    ctx.progress(`查詢 ${date} 的 Jira 活動…`);
    const raw = await runClaudePrint({
      claudePath: claude,
      prompt: buildCandidatesPrompt(date, server, config.ticket.keys, ja.include_watched),
      cwd: paths.claudeRuns,
      signal: ctx.signal,
      timeoutMs: 5 * 60_000,
      extraArgs: jiraArgs(paths, config, candidatesAllowedTools(server)),
    });
    const json = extractJson(raw);
    if (json && typeof json === 'object' && 'error' in json && !('account_id' in json)) {
      throw new Error(`查詢 Jira 失敗：${String((json as { error: unknown }).error)}`);
    }
    const candidates = CandidatesOutput.parse(json);
    const only = opts.onlyKeys ? new Set(opts.onlyKeys.map((k) => k.trim().toUpperCase())) : null;
    const keys = only ? [...only] : keysToFetch(candidates);

    const issues: JiraIssueData[] = [];
    const failed = new Map<string, string>();
    for (let i = 0; i < keys.length; i += ISSUE_BATCH) {
      if (ctx.signal.aborted) throw new Error('已取消');
      const batch = keys.slice(i, i + ISSUE_BATCH);
      ctx.progress(`讀取單號 ${Math.min(i + batch.length, keys.length)}/${keys.length}…`);
      // 沒取到的單（模型漏呼叫、工具出錯）再試一次
      let pending = batch;
      let lastErr = new Map<string, string>();
      for (let attempt = 1; attempt <= 2 && pending.length; attempt++) {
        if (ctx.signal.aborted) throw new Error('已取消');
        try {
          const got = await fetchIssuesRaw(claude, server, pending, paths, config, ctx.signal);
          issues.push(...got.issues);
          const done = new Set(got.issues.map((x) => x.key.toUpperCase()));
          lastErr = got.errors;
          pending = pending.filter((k) => !done.has(k));
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          lastErr = new Map(pending.map((k) => [k, (e as Error).message.slice(0, 200)]));
        }
      }
      for (const k of pending) {
        const msg = lastErr.get(k) ?? '沒有取得 getJiraIssue 的結果';
        failed.set(k, msg);
        result.errors.push(`${k}：${msg}`);
      }
    }

    const all = collectActivities({ candidates, issues, date, tz, ignoreFields: ja.ignore_fields });
    const activities = only ? all.filter((a) => only.has(a.ticket)) : all;
    result.activities = activities.length;
    const state = readSyncState(paths);
    const tasks = listTasks(paths, date, date);
    const plan = planJiraSync({
      date,
      activities,
      tasks,
      previouslyCreated: state.days[date]?.created ?? [],
      dismissed: state.dismissed,
    });

    const cache = readTicketCache(paths);
    const makeItems = async (t: Task, a: JiraActivity): Promise<Item[]> => {
      const fallback = fallbackItems(a);
      if (!ja.ai_items) return fallback.length ? fallback : [{ text: `處理 ${a.ticket}`, status: 'done' }];
      try {
        ctx.progress(`整理 ${a.ticket} 的子項…`);
        const items = await aiItemsFor(paths, config, claude, t, activityContent(a, date, tz), ctx);
        if (items.length) return items;
        return fallback.length ? fallback : [{ text: `處理 ${a.ticket}`, status: 'done' }];
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        result.errors.push(`${a.ticket} 子項整理失敗，改用固定格式：${(e as Error).message.slice(0, 120)}`);
        return fallback.length ? fallback : [{ text: `處理 ${a.ticket}`, status: 'done' }];
      }
    };
    const byId = new Map(tasks.map((t) => [t.id, t]));

    for (const action of plan) {
      if (ctx.signal.aborted) throw new Error('已取消');
      switch (action.kind) {
        case 'create': {
          const a = action.activity;
          let t = newJiraTask(a, date, config);
          const r = resolveProject({ cwd: undefined, ticket: a.ticket, rules: config.projects, ticketInfo: cache[a.ticket] });
          if (!r.unmapped) t = applyResolvedProject(t, r, true);
          t = withJiraItems(t, a, await makeItems(t, a), tz);
          await withLock(taskLockKey(paths, date, t.session_id), () => writeTask(paths, t));
          result.created.push(a.ticket);
          break;
        }
        case 'update': {
          const a = action.activity;
          const cur = byId.get(action.taskId);
          if (!cur) break;
          const items = await makeItems(cur, a);
          await withLock(taskLockKey(paths, date, cur.session_id), () => {
            const latest = readTask(cur.path);
            // 讀取到寫入之間被使用者改過：不覆蓋
            if (!latest || isUserEdited(latest)) return;
            const next = withJiraItems({ ...latest, title: maskSecrets(a.summary || latest.title).text }, a, items, tz);
            writeTask(paths, next, latest.path);
            result.updated.push(a.ticket);
          });
          break;
        }
        case 'append': {
          const cur = byId.get(action.taskId);
          if (!cur) break;
          await withLock(taskLockKey(paths, date, cur.session_id), () => {
            const latest = readTask(cur.path);
            if (!latest) return;
            const body = only
              ? upsertNoteTickets(latest.body, action.activities, tz)
              : mergeNote(latest.body, activityNote(action.activities, tz));
            if (body === latest.body) return;
            writeTask(paths, { ...latest, body }, latest.path);
            result.appended.push(...action.activities.map((a) => a.ticket));
          });
          break;
        }
        case 'remove': {
          const cur = byId.get(action.taskId);
          if (!cur) break;
          trashTask(paths, cur);
          result.removed.push(cur.ticket ?? cur.id);
          break;
        }
        case 'skip':
          result.skipped.push(`${action.ticket}（${{ edited: '已手動修改', unchanged: '沒有變化', dismissed: '已刪除過' }[action.reason]}）`);
          break;
      }
    }

    await updateSyncState(paths, (s) => {
      const prev = s.days[date];
      const found = activities.map((a) => a.ticket);
      // 重試部分單號：保留其他單的紀錄，只更新這次重試的單
      const prevFailed = (prev?.failed ?? []).filter((f) => !only || !only.has(f.key));
      s.days[date] = {
        synced_at: only && prev ? prev.synced_at : new Date().toISOString(),
        tickets: only ? [...new Set([...(prev?.tickets ?? []), ...found])] : found,
        created: [...new Set([...(prev?.created ?? []), ...result.created])],
        // 讀取失敗的單只列出、不自動重試（避免整天重讀耗用大量 token）
        error: null,
        failed: [...prevFailed, ...[...failed].map(([key, error]) => ({ key, error }))],
        attempts: 0,
      };
    });
    return result;
  } catch (e) {
    if (!ctx.signal.aborted) await recordFailure((e as Error).message);
    throw e;
  }
}
