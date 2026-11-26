/**
 * 以 `claude -p` 執行的工作：補寫摘要（規格 5.3）、產生報告（規格 9.6）、範本試跑（規格 11.4）。
 */
import { readFileSync } from 'node:fs';
import { ClaudeCliError, extractJson, findClaude, runClaudePrint } from '../core/claude-cli/index.js';
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
  IssuesOutput,
  issuesAllowedTools,
  type IssuesOutput as IssuesOutputData,
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
import { withLock } from '../core/storage/fsutil.js';
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
    extraArgs: ['--allowedTools', ...jiraAllowedTools(server)],
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
        extraArgs: ['--allowedTools', ...ticketInfoAllowedTools(server)],
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
  const out = await runClaudePrint({ claudePath: claude, prompt: g.guide, cwd: paths.claudeRuns, signal: ctx.signal, timeoutMs: 5 * 60_000 });
  const input = SummaryInput.parse(extractJson(out));
  return input.items;
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

    ctx.progress(`查詢 ${date} 的 Jira 活動…`);
    const raw = await runClaudePrint({
      claudePath: claude,
      prompt: buildCandidatesPrompt(date, server, config.ticket.keys, ja.include_watched),
      cwd: paths.claudeRuns,
      signal: ctx.signal,
      timeoutMs: 5 * 60_000,
      extraArgs: ['--allowedTools', ...candidatesAllowedTools(server)],
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
      try {
        // 偶爾模型沒有照格式輸出：重試一次
        let parsed: IssuesOutputData | undefined;
        for (let attempt = 1; !parsed; attempt++) {
          try {
            const out = await runClaudePrint({
              claudePath: claude,
              prompt: buildIssuesPrompt(batch, date, server, candidates.account_id),
              cwd: paths.claudeRuns,
              signal: ctx.signal,
              timeoutMs: 8 * 60_000,
              extraArgs: ['--allowedTools', ...issuesAllowedTools(server)],
            });
            parsed = IssuesOutput.parse(extractJson(out));
          } catch (e) {
            if (attempt >= 2 || ctx.signal.aborted) throw e;
          }
        }
        issues.push(...parsed.issues);
        for (const e of parsed.errors) {
          result.errors.push(`${e.key}：${e.error}`);
          failed.set(e.key.trim().toUpperCase(), e.error.slice(0, 200));
        }
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        const msg = (e as Error).message.slice(0, 200);
        result.errors.push(`${batch.join(', ')}：${msg}`);
        for (const k of batch) failed.set(k, msg);
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
        return await aiItemsFor(paths, config, claude, t, activityContent(a, date, tz), ctx);
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
