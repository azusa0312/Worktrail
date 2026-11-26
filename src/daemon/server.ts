/**
 * 規格 12：常駐服務的 HTTP API、SSE、靜態 UI。
 * 只綁定 127.0.0.1；檢查 Host 標頭；所有 API 需 Bearer token；不開 CORS。
 */
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addDays, localDate } from '../core/capture/tz.js';
import { formatPeriod, parsePeriodId, periodId, resolvePeriod, type Period } from '../core/period/index.js';
import { defaultPromptRefs, deletePrompt, listPrompts, loadPrompt, promptDeleteError, savePrompt, splitRef, validatePrompt } from '../core/prompt/index.js';
import { editedReport, listReportPeriods, weeklyHours } from '../core/report/list.js';
import { isReportStale, prepareReport, ReportConflictError } from '../core/report/prepare.js';
import { ReportFileCache, searchReports, type ReportSource } from '../core/report/source.js';
import { getReport, reportPath, writeReport } from '../core/report/store.js';
import { ReportType } from '../core/schema/report.js';
import { computeStats } from '../core/stats/index.js';
import { loadConfig, saveConfig } from '../core/storage/config-store.js';
import { contentVersion, ensureDir, readText, withLock, writeFileAtomic } from '../core/storage/fsutil.js';
import { writeLog } from '../core/storage/log.js';
import { pointerPath, StoragePaths } from '../core/storage/paths.js';
import { restoreTask, taskLockKey, trashTask, writeTask, type TaskRecord } from '../core/storage/tasks.js';
import type { Task } from '../core/schema/task.js';
import { markMerged, MergeInput, mergeError, UnmergeInput, unmarkMerged } from '../core/sync/task-merge.js';
import { buildSummaryGuide } from '../core/summary/index.js';
import { pendingSummaries, recaptureSessions, sweep } from '../core/sync/sweep.js';
import { applyTicketKeyAction, suggestTicketKeys, tasksMentioningKey } from '../core/capture/ticket.js';
import { applyTicketKeySelection, previewPeriods, ticketKeyChoices } from '../core/onboarding/index.js';
import { applyTaskPatch, TaskPatch } from '../core/sync/task-edit.js';
import { isAdjustable, rebalanceDay } from '../core/sync/day-hours.js';
import { createManualTask, ManualTaskInput, projectNames } from '../core/sync/manual.js';
import {
  autoProjectRules,
  mergeProjectRules,
  projectRuleSummaries,
  reresolveProject,
  rewriteTasks as rewriteTaskFiles,
  syncTaskProjects,
  trackIgnoredParents,
  unmappedParents,
} from '../core/sync/projects.js';
import { readTicketCache, ticketsNeedingRefresh } from '../core/ticket-info/index.js';
import { Config as ConfigSchema, type Config } from '../core/schema/config.js';
import { openFolder } from '../launcher/open.js';
import { runChecks } from '../installer/doctor.js';
import { setAutostart, shortcutStatus } from '../installer/shortcuts.js';
import {
  createTalk,
  getTalk,
  applyTalkEdit,
  isTalkStale,
  listTalks,
  normalizeDates,
  prepareTalk,
  readTalk,
  talkIdFromTrash,
  talkLabel,
  talkPath,
  TalkConflictError,
  talkStatus,
  tasksOnDates,
  trashTalk,
  writeTalk,
  type TalkRecord,
} from '../core/talk/index.js';
import { generateReport, generateTalk, jiraSummarizeTask, previewOutput, refreshTicketInfo, summarizeTask, summaryPromptFor, syncJiraActivity, type JiraSyncResult } from './actions.js';
import { datesNeedingSync, readSyncState } from '../core/jira-activity/index.js';
import { TaskIndex, type ChangeEvent } from './index-cache.js';
import { JobManager, type Job } from './jobs.js';

export interface DaemonOptions {
  paths: StoragePaths;
  port: number;
  token: string;
  uiDir: string;
  /** 測試時不啟動檔案監看與排程 */
  watch?: boolean;
  /** 健康檢查是否以 `claude auth status` 檢查登入（預設是；測試關閉，避免啟動真正的 claude） */
  checkLogin?: boolean;
  onShutdown?: () => void;
  onRestart?: () => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export function createDaemon(opts: DaemonOptions) {
  const { paths, token } = opts;
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  const index = new TaskIndex(paths);
  index.load();
  // 報告清單、過期判斷與搜尋用記憶體中的任務與報告快取，不每次重讀所有檔案
  const reportCache = new ReportFileCache(paths);
  const source: ReportSource = {
    tasks: (from, to) => index.query({ from, to }).reverse(),
    reports: (type) => reportCache.list(type),
  };
  const jobs = new JobManager();
  const sseClients = new Set<FastifyReply>();

  const cfg = () => loadConfig(paths);
  const today = () => localDate(Date.now(), cfg().config.time.timezone);

  // ───────────── SSE
  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.raw.write(msg);
  };
  jobs.on('job', (j: Job) => broadcast('job', j));
  index.on('change', (e: ChangeEvent) => {
    broadcast('change', e);
    if (e.kind === 'task' || e.kind === 'weekly') void refreshStale(e);
  });

  /** 來源變動時，將涵蓋該日期的報告標為 stale（規格 4.4） */
  async function refreshStale(e: ChangeEvent) {
    try {
      const date = e.id?.slice(0, 10);
      const types: ReportType[] = e.kind === 'task' ? ['weekly'] : ['performance'];
      for (const type of types) {
        for (const r of source.reports(type)) {
          if (r.stale) continue;
          if (e.kind === 'task' && date && (date < r.period_start || date > r.period_end)) continue;
          if (isReportStale(paths, r, source)) {
            await withLock(r.path, () => writeReport(paths, { ...r, stale: true }));
          }
        }
      }
    } catch (err) {
      writeLog(paths, 'daemon', 'warn', `stale 更新失敗：${(err as Error).message}`);
    }
  }

  // ───────────── 安全（規格 12.1）
  const allowedHosts = new Set([`localhost:${opts.port}`, `127.0.0.1:${opts.port}`]);
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(String(req.headers.host ?? ''))) {
      return reply.code(403).send({ error: 'Host 不允許' });
    }
    if (!req.url.startsWith('/api/')) return;
    const auth = req.headers.authorization;
    const queryToken = req.url.startsWith('/api/events') ? new URL(req.url, 'http://x').searchParams.get('token') : null;
    if (auth !== `Bearer ${token}` && queryToken !== token) {
      return reply.code(401).send({ error: '未授權' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, data: err.data });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') });
    if (err instanceof ReportConflictError || err instanceof TalkConflictError) return reply.code(409).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) writeLog(paths, 'daemon', 'error', err.stack ?? err.message);
    return reply.code(status).send({ error: err.message });
  });

  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => schema.parse(req.body ?? {});
  const qs = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const param = (req: FastifyRequest, k: string) => (req.params as Record<string, string>)[k]!;

  // ───────────── 基本
  app.get('/api/ping', async () => ({ ok: true }));

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(`event: hello\ndata: {}\n\n`);
    sseClients.add(reply);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      sseClients.delete(reply);
    });
  });

  app.get('/api/health', async () => {
    const { checks, errors } = await runChecks({ includeDaemon: false, checkLogin: opts.checkLogin });
    const { config, error } = cfg();
    return {
      checks,
      recent_errors: errors,
      config_error: error ?? null,
      storage_root: paths.root,
      // 與 UI「待補摘要」頁相同的範圍（30 天）
      pending_summaries: pendingSummaries(paths, config, Date.now(), 30).length,
      jobs: jobs.list().filter((j) => j.status === 'running'),
      pid: process.pid,
    };
  });

  // 開機自動啟動（一鍵安裝預設開啟，這裡讓使用者事後關閉或重新開啟）
  app.get('/api/autostart', async () => {
    const supported = process.platform === 'win32' || process.platform === 'darwin';
    return { supported, enabled: supported ? (await shortcutStatus()).autostart : false };
  });
  app.put('/api/autostart', async (req) => {
    const b = body(z.object({ enabled: z.boolean() }), req);
    await setAutostart(process.execPath, b.enabled);
    return { enabled: (await shortcutStatus()).autostart };
  });

  // 偵測到還沒加入的 Jira 專案代碼（分支、commit、標題中出現），讓使用者一鍵加入或忽略
  const recentForKeys = () => {
    const since = addDays(localDate(Date.now(), cfg().config.time.timezone), -30);
    return index.all().filter((t) => t.date >= since && !t.manual);
  };
  app.get('/api/ticket-keys/suggestions', async () => {
    const { config } = cfg();
    return { suggestions: suggestTicketKeys(recentForKeys(), config.ticket.keys, config.ticket.ignored_keys) };
  });
  app.post('/api/ticket-keys', async (req) => {
    const b = body(z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]+$/), action: z.enum(['add', 'ignore']) }), req);
    const config = cfg().config;
    const saved = await saveConfig(paths, { ...config, ticket: applyTicketKeyAction(config.ticket, b.key, b.action) });
    if (b.action === 'ignore') return { config: saved };
    // 讓近期提到這個代碼的任務重新擷取，辨識出單號
    const sessions = tasksMentioningKey(recentForKeys(), b.key).map((x) => x.session_id);
    const job = jobs.start('recapture', b.key, async (ctx) => {
      const n = await recaptureSessions(paths, cfg().config, sessions, ctx.signal);
      index.load();
      broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
      return { captured: n };
    });
    return { config: saved, job_id: job.id };
  });

  // ───────────── 首次引導
  app.get('/api/onboarding/ticket-keys', async () => {
    const { config } = cfg();
    return {
      ...ticketKeyChoices(recentForKeys(), config.ticket.keys, config.ticket.ignored_keys),
      // 服務剛啟動時的補漏掃描還沒結束，近期任務可能還不完整；結束後 UI 會重新查詢
      scanning: !!jobs.findRunning('sweep', 'sweep'),
    };
  });
  app.post('/api/onboarding/ticket-keys', async (req) => {
    const b = body(z.object({ keys: z.array(z.string()), offered: z.array(z.string()).default([]) }), req);
    const config = cfg().config;
    const { ticket, changed } = applyTicketKeySelection(config.ticket, b.keys, b.offered);
    const saved = await saveConfig(paths, { ...config, ticket });
    // 加入或移除的代碼：讓提到它的近期任務重新擷取，補上或拿掉單號
    const recent = recentForKeys();
    const sessions = [...new Set(changed.flatMap((k) => tasksMentioningKey(recent, k).map((t) => t.session_id)))];
    if (!sessions.length) return { config: saved };
    const job = jobs.start('recapture', changed.join(','), async (ctx) => {
      const n = await recaptureSessions(paths, cfg().config, sessions, ctx.signal);
      index.load();
      broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
      return { captured: n };
    });
    return { config: saved, job_id: job.id };
  });
  app.post('/api/onboarding/periods', async (req) => {
    const b = body(z.object({ report: z.unknown() }), req);
    const config = ConfigSchema.parse({ ...cfg().config, report: b.report });
    return previewPeriods(config, today());
  });

  app.post('/api/shutdown', async () => {
    setTimeout(() => opts.onShutdown?.(), 100);
    return { ok: true };
  });
  app.post('/api/restart', async () => {
    setTimeout(() => opts.onRestart?.(), 100);
    return { ok: true };
  });

  // ───────────── 任務
  app.get('/api/tasks', async (req) => {
    const q = qs(req);
    return { tasks: index.query({ from: q.from, to: q.to, project: q.project, ticket: q.ticket, status: q.status, q: q.q }) };
  });

  /** 手動新增任務（不在 Claude Code 中進行的工作） */
  app.post('/api/tasks', async (req) => {
    const task = createManualTask(body(ManualTaskInput, req), cfg().config);
    const saved = writeTask(paths, task);
    index.upsert(saved);
    broadcast('change', { kind: 'task', action: 'add', path: saved.path, id: saved.id } satisfies ChangeEvent);
    await rebalanceDates([saved.date]);
    return { task: saved };
  });

  /** 專案名稱清單（任務面板的下拉建議）、設定中的專案與任務數 */
  app.get('/api/projects', async () => {
    const { config } = cfg();
    const tasks = index.all();
    return { projects: projectNames(config, tasks), rules: projectRuleSummaries(config, tasks, readTicketCache(paths)) };
  });

  /** 依設定同步任務的專案名稱與 ID（改名、合併、新增規則後） */
  const syncProjects = async (config: Config, remap?: Record<string, string>) => {
    const r = await syncTaskProjects(paths, config, index.all(), remap);
    for (const t of r.written) index.upsert(t, r.previous.get(t.id));
    for (const e of r.errors) writeLog(paths, 'daemon', 'warn', `同步專案名稱失敗：${e}`);
    if (r.written.length) broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
    return r.written.length;
  };

  /** 合併專案：from 的任務與對應條件併入 to，並刪除 from */
  app.post('/api/projects/merge', async (req) => {
    const b = body(z.object({ from: z.string().min(1), to: z.string().min(1) }), req);
    const { config } = cfg();
    let projects;
    try {
      projects = mergeProjectRules(config.projects, b.from, b.to);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const saved = await saveConfig(paths, { ...config, projects });
    const updated = await syncProjects(saved, { [b.from]: b.to });
    return { config: saved, updated };
  });

  /** 單號資訊快取中、還沒有專案規則的最上層卡片 */
  app.get('/api/tickets/unmapped-parents', async () => ({
    parents: unmappedParents(index.all(), readTicketCache(paths), cfg().config),
  }));

  /** 查詢父卡片：預設只查快取中沒有或過期的單號；force 時重查近期所有單號 */
  app.post('/api/tickets/refresh', async (req) => {
    const b = body(z.object({ force: z.boolean().optional() }), req);
    const job = startTicketRefresh('手動', b.force);
    if (!job) return { job_id: null, tickets: 0 };
    return { job_id: job.id };
  });

  /** 依每日工時重新分配指定日期 AI 粗估的時數（見 core/sync/day-hours.ts） */
  const rebalanceDates = async (dates: Iterable<string>) => {
    const { config } = cfg();
    let n = 0;
    for (const d of new Set(dates)) {
      const r = await rebalanceDay(paths, config, d);
      for (const t of r.written) index.upsert(t, t.path);
      n += r.written.length;
    }
    if (n) broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
    return n;
  };
  const adjustableDates = () => index.all().filter(isAdjustable).map((t) => t.date);

  /** 把目前的每日工時套用到所有 AI 粗估的紀錄 */
  app.post('/api/hours/rebalance', async () => ({ updated: await rebalanceDates(adjustableDates()) }));

  const getTask = (id: string) => {
    const t = index.byId(id);
    if (!t) throw new HttpError(404, `找不到任務 ${id}`);
    return t;
  };

  app.get('/api/tasks/:id', async (req) => ({ task: getTask(param(req, 'id')) }));

  app.patch('/api/tasks/:id', async (req) => {
    const b = body(TaskPatch.extend({ base_version: z.string() }), req);
    const current = getTask(param(req, 'id'));
    const r = await withLock(join(paths.taskDir(current.date), `.${current.date}__${current.session_id.replace(/-/g, '').slice(0, 6)}`), () => {
      const latest = index.byId(current.id) ?? current;
      const onDisk = readText(latest.path);
      const version = onDisk === null ? null : contentVersion(onDisk);
      if (version !== b.base_version) throw new HttpError(409, '此內容已在別處更新', { task: latest });
      const { base_version: _bv, ...patch } = b;
      const { task, warnings } = applyTaskPatch(latest, patch, cfg().config);
      const saved = writeTask(paths, task, latest.path);
      index.upsert(saved, latest.path);
      broadcast('change', { kind: 'task', action: 'change', path: saved.path, id: saved.id } satisfies ChangeEvent);
      return { task: saved, warnings };
    });
    // 使用者改了時數：同一天其他 AI 粗估的任務依剩餘工時重新分配
    if (b.hours !== undefined) await rebalanceDates([r.task.date]);
    return r;
  });

  /** 逐一在檔案鎖內改寫任務（合併／取消合併） */
  const rewriteTasks = async (ids: string[], fn: (t: TaskRecord) => Task) => {
    const out: TaskRecord[] = [];
    for (const id of ids) {
      const current = getTask(id);
      out.push(
        await withLock(taskLockKey(paths, current.date, current.session_id), () => {
          const latest = index.byId(current.id) ?? current;
          const saved = writeTask(paths, fn(latest), latest.path);
          index.upsert(saved, latest.path);
          return saved;
        }),
      );
    }
    broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
    return out;
  };

  /** 合併同一天的任務成一筆（同專案；見 core/sync/task-merge.ts） */
  app.post('/api/tasks/merge', async (req) => {
    const b = body(MergeInput, req);
    const ids = [...new Set(b.ids)];
    const err = mergeError(ids.map(getTask));
    if (err) throw new HttpError(400, err);
    return { tasks: await rewriteTasks(ids, (t) => markMerged(t, b.project, cfg().config)) };
  });

  app.post('/api/tasks/unmerge', async (req) => {
    const b = body(UnmergeInput, req);
    return { tasks: await rewriteTasks([...new Set(b.ids)], (t) => unmarkMerged(t)) };
  });

  app.delete('/api/tasks/:id', async (req) => {
    const t = getTask(param(req, 'id'));
    const trash = trashTask(paths, t);
    index.remove(t.path);
    await rebalanceDates([t.date]);
    return { trash_path: trash };
  });

  app.post('/api/tasks/restore', async (req) => {
    const b = body(z.object({ trash_path: z.string() }), req);
    if (!resolve(b.trash_path).startsWith(resolve(paths.trash))) throw new HttpError(400, '路徑不正確');
    const t = restoreTask(paths, b.trash_path);
    if (!t) throw new HttpError(404, '找不到要復原的任務');
    index.upsert(t);
    await rebalanceDates([t.date]);
    return { task: index.byId(t.id) ?? t };
  });

  app.post('/api/tasks/:id/summarize', async (req) => {
    const t = getTask(param(req, 'id'));
    if (t.manual) throw new HttpError(400, '手動新增的任務沒有對話紀錄，請直接編輯子項');
    const running = jobs.findRunning('summarize', t.id);
    if (running) return { job_id: running.id };
    const job = jobs.start('summarize', t.id, (ctx) => summarizeTask(paths, cfg().config, t, ctx));
    return { job_id: job.id };
  });

  app.post('/api/tasks/:id/jira-summarize', async (req) => {
    const t = getTask(param(req, 'id'));
    if (!t.manual) throw new HttpError(400, '只有手動新增的任務可以從 Jira 整理');
    if (!t.ticket) throw new HttpError(400, '請先填寫單號');
    const b = body(z.object({ overwrite: z.boolean().optional() }), req);
    if (t.items.length && !b.overwrite) throw new HttpError(409, '任務已有子項，整理結果會取代現有子項', { needs_overwrite: true });
    const running = jobs.findRunning('jira-summarize', t.id);
    if (running) return { job_id: running.id };
    const job = jobs.start('jira-summarize', t.id, (ctx) => jiraSummarizeTask(paths, cfg().config, t, ctx));
    return { job_id: job.id };
  });

  app.get('/api/tasks/:id/summary-prompt', async (req) => {
    const t = getTask(param(req, 'id'));
    return summaryPromptFor(paths, cfg().config, t);
  });

  // ───────────── Jira 每日活動同步
  app.get('/api/jira-sync', async () => {
    const s = readSyncState(paths);
    const days = Object.entries(s.days)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 14)
      .map(([date, d]) => ({ date, ...d }));
    const running = jobs.findRunning('jira-sync', 'jira-sync');
    return { enabled: cfg().config.jira_activity.enabled, days, running: running ? running.id : null };
  });
  app.post('/api/jira-sync', async (req) => {
    const b = body(
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), retry_failed: z.boolean().optional() }),
      req,
    );
    const date = b.date ?? today();
    if (b.retry_failed) {
      const keys = (readSyncState(paths).days[date]?.failed ?? []).map((f) => f.key);
      if (!keys.length) throw new HttpError(400, `${date} 沒有讀取失敗的單號`);
      return { job_id: startJiraSync([date], '重試失敗單號', keys).id };
    }
    const job = startJiraSync([date], '手動');
    return { job_id: job.id };
  });

  app.post('/api/sweep', async () => {
    const running = jobs.findRunning('sweep', 'sweep');
    if (running) return { job_id: running.id };
    const job = jobs.start('sweep', 'sweep', async (ctx) => {
      const r = await sweep({ paths, config: cfg().config, signal: ctx.signal, onProgress: (d, n) => ctx.progress(`掃描 ${d}/${n}`) });
      index.load();
      broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
      return { scanned: r.scanned, captured: r.captured, created: r.created.length, errors: r.errors, pending: r.pending.map((t) => t.id) };
    });
    return { job_id: job.id };
  });

  app.get('/api/stats', async (req) => {
    const q = qs(req);
    const tasks = index.query({ from: q.from, to: q.to });
    return { stats: computeStats([...tasks].reverse()) };
  });

  // ───────────── 報告
  const reportType = (req: FastifyRequest) => ReportType.parse(param(req, 'type'));
  const reportPeriod = (req: FastifyRequest): { id: string; period: Period } => {
    const type = reportType(req);
    const id = param(req, 'period');
    const period = parsePeriodId(type, id, cfg().config);
    if (!period) throw new HttpError(400, `無法辨識的期間：${id}`);
    return { id: periodId(type, period, cfg().config), period };
  };

  app.get('/api/reports', async (req) => {
    const type = ReportType.parse(qs(req).type ?? 'weekly');
    const taskDates = index.all().map((t) => t.date);
    return { reports: listReportPeriods({ paths, config: cfg().config, type, taskDates, today: today(), source }) };
  });

  app.get('/api/reports/:type/:period', async (req) => {
    const type = reportType(req);
    const { id, period } = reportPeriod(req);
    const { config } = cfg();
    const r = getReport(paths, type, id);
    const tasks = index.query({ from: period.start, to: period.end }).reverse();
    const stats = computeStats(tasks);
    let weekly_trend: { id: string; start: string; hours: number }[] | undefined;
    let missing_weeks: { id: string; period: Period }[] | undefined;
    if (type === 'performance') {
      weekly_trend = weeklyHours(period, config, tasks, today());
      const prepared = prepareReport({ paths, config, type, period, today: today(), source });
      missing_weeks = (prepared.missing_weeks ?? []).map((w) => ({ id: periodId('weekly', w, config), period: w }));
    }
    return {
      id,
      period,
      label: formatPeriod(period),
      report: r ? { ...r, stale: isReportStale(paths, r, source) } : null,
      stats,
      weekly_trend,
      missing_weeks,
      pending_summaries: tasks.filter((t) => t.summary_status !== 'done').length,
    };
  });

  app.put('/api/reports/:type/:period', async (req) => {
    const type = reportType(req);
    const { id, period } = reportPeriod(req);
    const b = body(z.object({ content: z.string(), base_version: z.string().nullable().optional() }), req);
    return withLock(reportPath(paths, type, id), () => {
      const r = getReport(paths, type, id);
      if (r && b.base_version && r.version !== b.base_version) throw new HttpError(409, '此內容已在別處更新', { report: r });
      const saved = writeReport(paths, editedReport({ paths, type, id, period, existing: r, content: b.content, now: new Date(), source }));
      return { report: saved };
    });
  });

  app.post('/api/reports/:type/:period/generate', async (req) => {
    const type = reportType(req);
    const { id, period } = reportPeriod(req);
    const b = body(z.object({ prompt: z.string().optional(), overwrite: z.boolean().optional() }), req);
    const existing = getReport(paths, type, id);
    if (existing?.edited && !b.overwrite) throw new HttpError(409, '報告已手動編輯過，重新產生會覆蓋你的修改', { needs_overwrite: true });
    const running = jobs.findRunning('generate', `${type}/${id}`);
    if (running) return { job_id: running.id };
    const job = jobs.start('generate', `${type}/${id}`, (ctx) =>
      generateReport(paths, cfg().config, { type, period, prompt: b.prompt, overwrite: b.overwrite }, ctx),
    );
    return { job_id: job.id };
  });

  app.post('/api/reports/:type/:period/prepare', async (req) => {
    const type = reportType(req);
    const { period } = reportPeriod(req);
    const b = body(z.object({ prompt: z.string().optional() }), req);
    const p = prepareReport({ paths, config: cfg().config, type, period, prompt: b.prompt, today: today(), source });
    return { ...p, missing_weeks: p.missing_weeks?.map((w) => ({ id: periodId('weekly', w, cfg().config), period: w })) };
  });

  // ───────────── 小交流（勾選幾天產生簡短重點）
  const talkView = (t: TalkRecord) => {
    const { path: _p, ...rest } = t;
    return { ...rest, label: talkLabel(t), stale: isTalkStale(paths, t) };
  };
  const getTalkOr404 = (req: FastifyRequest) => {
    const id = param(req, 'id');
    const t = getTalk(paths, id);
    if (!t) throw new HttpError(404, `找不到小交流 ${id}`);
    return t;
  };
  const Dates = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD')).max(62, '最多勾選 62 天');

  app.get('/api/talks', async () => ({
    talks: listTalks(paths).map((t) => {
      const v = talkView(t);
      return {
        id: v.id,
        title: v.title,
        label: v.label,
        dates: v.dates,
        status: talkStatus(t, v.stale),
        created_at: v.created_at,
      };
    }),
  }));

  app.post('/api/talks', async (req) => {
    const b = body(z.object({ dates: Dates.min(1, '請至少勾選一天'), title: z.string().max(100).optional() }), req);
    const t = createTalk(paths, cfg().config, b);
    return { talk: talkView(t) };
  });

  app.get('/api/talks/:id', async (req) => {
    const t = getTalkOr404(req);
    const tasks = tasksOnDates(paths, t.dates);
    return { talk: talkView(t), stats: computeStats(tasks), pending_summaries: tasks.filter((x) => x.summary_status !== 'done').length };
  });

  app.put('/api/talks/:id', async (req) => {
    const b = body(
      z.object({ content: z.string().optional(), title: z.string().max(100).optional(), dates: Dates.optional(), base_version: z.string().nullable().optional() }),
      req,
    );
    const id = param(req, 'id');
    if (!getTalk(paths, id)) throw new HttpError(404, `找不到小交流 ${id}`);
    return withLock(talkPath(paths, id), () => {
      const t = getTalk(paths, id);
      if (!t) throw new HttpError(404, `找不到小交流 ${id}`);
      if (b.base_version && t.version !== b.base_version) throw new HttpError(409, '此內容已在別處更新', { talk: talkView(t) });
      const saved = writeTalk(paths, applyTalkEdit(t, b));
      return { talk: talkView(saved) };
    });
  });

  app.delete('/api/talks/:id', async (req) => {
    const t = getTalkOr404(req);
    return { trash_path: trashTalk(paths, t) };
  });

  app.post('/api/talks/restore', async (req) => {
    const b = body(z.object({ trash_path: z.string() }), req);
    if (!resolve(b.trash_path).startsWith(resolve(paths.trash))) throw new HttpError(400, '路徑不正確');
    const t = readTalk(b.trash_path);
    if (!t) throw new HttpError(404, '找不到要復原的小交流');
    const saved = writeTalk(paths, { ...t, id: talkIdFromTrash(b.trash_path) });
    rmSync(b.trash_path, { force: true });
    return { talk: talkView(saved) };
  });

  app.post('/api/talks/:id/generate', async (req) => {
    const t = getTalkOr404(req);
    const b = body(z.object({ prompt: z.string().optional(), overwrite: z.boolean().optional(), dates: Dates.optional() }), req);
    const dates = b.dates ? normalizeDates(b.dates) : t.dates;
    if (!dates.length) throw new HttpError(400, '請至少勾選一天');
    if (t.edited && t.body.trim() && !b.overwrite) throw new HttpError(409, '內容已手動編輯過，重新產生會覆蓋你的修改', { needs_overwrite: true });
    const running = jobs.findRunning('generate', `talk/${t.id}`);
    if (running) return { job_id: running.id };
    const job = jobs.start('generate', `talk/${t.id}`, (ctx) => generateTalk(paths, cfg().config, { id: t.id, dates, prompt: b.prompt, overwrite: true }, ctx));
    return { job_id: job.id };
  });

  app.post('/api/talks/:id/prepare', async (req) => {
    const t = getTalkOr404(req);
    const b = body(z.object({ prompt: z.string().optional(), dates: Dates.optional() }), req);
    return prepareTalk({ paths, config: cfg().config, dates: b.dates ?? t.dates, prompt: b.prompt, excludeId: t.id, today: today() });
  });

  // ───────────── Prompt 範本
  app.get('/api/prompts', async () => ({
    prompts: listPrompts(paths).map(({ text: _t, ...p }) => p),
    defaults: defaultPromptRefs(cfg().config),
  }));

  const promptRef = (req: FastifyRequest) => `${param(req, 'type')}/${param(req, 'name')}`;

  app.get('/api/prompts/:type/:name', async (req) => {
    const p = loadPrompt(paths, promptRef(req));
    return { prompt: p, validation: validatePrompt(p.ref, p.text) };
  });

  app.put('/api/prompts/:type/:name', async (req) => {
    const b = body(z.object({ text: z.string(), base_hash: z.string().optional() }), req);
    const ref = promptRef(req);
    splitRef(ref);
    if (b.base_hash) {
      try {
        const cur = loadPrompt(paths, ref);
        if (!cur.builtin && cur.hash !== b.base_hash) throw new HttpError(409, '此範本已在別處更新', { prompt: cur });
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
    }
    try {
      return { prompt: savePrompt(paths, ref, b.text), validation: validatePrompt(ref, b.text) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/api/prompts/validate', async (req) => {
    const b = body(z.object({ ref: z.string(), text: z.string() }), req);
    return validatePrompt(b.ref, b.text);
  });

  app.delete('/api/prompts/:type/:name', async (req) => {
    const ref = promptRef(req);
    const err = promptDeleteError(cfg().config, ref);
    if (err) throw new HttpError(400, err);
    const text = readText(paths.promptFile(param(req, 'type'), param(req, 'name')));
    deletePrompt(paths, ref);
    return { ok: true, text };
  });

  /** 試跑：回傳填入資料後的完整 prompt（可帶尚未儲存的範本內文） */
  app.post('/api/prompts/:type/:name/render', async (req) => {
    const b = body(
      z.object({
        text: z.string().optional(),
        period: z.object({ start: z.string(), end: z.string() }).optional(),
        task_id: z.string().optional(),
        dates: z.array(z.string()).optional(),
      }),
      req,
    );
    const { config } = cfg();
    const ref = promptRef(req);
    const { type } = splitRef(ref);
    if (type === 'summary') {
      const task = b.task_id ? getTask(b.task_id) : index.query({}).find((t) => t.repo);
      if (!task) throw new HttpError(400, '沒有可用來試跑的任務');
      try {
        return { rendered: summaryPromptFor(paths, config, task, ref, b.text).prompt, task_id: task.id };
      } catch {
        // 找不到紀錄檔時，以佔位文字代替對話內容
        const g = buildSummaryGuide({ paths, config, task, mode: 'json', prompt: ref, templateText: b.text, transcript: '（找不到對話紀錄檔）', today: today() });
        return { rendered: g.guide, task_id: task.id };
      }
    }
    if (type === 'talk') {
      // 沒指定日期時，以最近 5 個有任務的日子試跑
      const dates = b.dates?.length ? b.dates : [...new Set(index.all().map((t) => t.date))].sort().reverse().slice(0, 5);
      if (!dates.length) throw new HttpError(400, '沒有可用來試跑的任務');
      const prepared = prepareTalk({ paths, config, dates, prompt: ref, templateText: b.text, today: today() });
      return { rendered: prepared.rendered_prompt, period: prepared.period, warnings: prepared.warnings };
    }
    const period = b.period ?? resolvePeriod(type, 'current', config, today());
    const prepared = prepareReport({ paths, config, type, period, prompt: ref, templateText: b.text, today: today(), source });
    return { rendered: prepared.rendered_prompt, period: prepared.period, warnings: prepared.warnings };
  });

  app.post('/api/prompts/:type/:name/preview', async (req) => {
    const b = body(z.object({ rendered: z.string().min(1) }), req);
    const job = jobs.start('preview', promptRef(req), (ctx) => previewOutput(cfg().config, paths, b.rendered, ctx));
    return { job_id: job.id };
  });

  // ───────────── 設定
  app.get('/api/config', async () => {
    const { config, error } = cfg();
    return { config, error: error ?? null, storage_root: paths.root, raw: readText(paths.config) ?? '' };
  });

  app.put('/api/config', async (req) => {
    const b = body(z.object({ config: z.unknown() }), req);
    let saved: Config;
    const before = cfg().config;
    try {
      // 使用者從專案拿掉的大型工作，記到「不再自動建立」清單
      const parsed = ConfigSchema.parse(b.config);
      const ignored_parents = trackIgnoredParents(before.projects, parsed.projects, before.ticket.ignored_parents);
      saved = await saveConfig(paths, { ...parsed, ticket: { ...parsed.ticket, ignored_parents } });
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
    // 專案改名或規則變動：同步任務名稱，並依新規則重新判斷父卡片已知的任務
    const updated = (await syncProjects(saved)) + (await reresolveFromCache(saved));
    // 每日工時或時數單位改變：套用到所有 AI 粗估的紀錄
    const hoursChanged = saved.time.daily_hours !== before.time.daily_hours || saved.time.rounding !== before.time.rounding;
    const hours_updated = hoursChanged ? await rebalanceDates(adjustableDates()) : 0;
    return { config: saved, projects_updated: updated, hours_updated };
  });

  /** 在檔案總管中開啟儲存資料夾（只允許儲存資料夾與其固定子資料夾，不接受任意路徑） */
  app.post('/api/open-folder', async (req) => {
    const b = body(z.object({ which: z.enum(['root', 'tasks', 'weekly', 'performance', 'talk', 'prompts', 'logs']).default('root') }), req);
    const target = b.which === 'root' ? paths.root : b.which === 'logs' ? paths.logs : join(paths.root, b.which);
    ensureDir(target);
    openFolder(target);
    return { ok: true, path: target };
  });

  app.post('/api/config/move-storage', async (req) => {
    const b = body(z.object({ target: z.string().min(1), mode: z.enum(['move', 'pointer']) }), req);
    const target = resolve(b.target);
    if (normalize(target).toLowerCase() === normalize(paths.root).toLowerCase()) throw new HttpError(400, '新位置與目前相同');
    if (b.mode === 'move') {
      if (existsSync(target) && (await import('node:fs')).readdirSync(target).length) throw new HttpError(400, '目標資料夾不是空的');
      cpSync(paths.root, target, { recursive: true });
      rmSync(paths.root, { recursive: true, force: true });
    } else {
      ensureDir(target);
    }
    writeFileAtomic(pointerPath(), `${JSON.stringify({ storage_root: target }, null, 2)}\n`);
    setTimeout(() => opts.onRestart?.(), 200);
    return { ok: true, storage_root: target };
  });

  // ───────────── 工作
  app.get('/api/jobs', async () => ({ jobs: jobs.list() }));
  app.get('/api/jobs/:id', async (req) => {
    const j = jobs.get(param(req, 'id'));
    if (!j) throw new HttpError(404, '找不到工作');
    return { job: j };
  });
  app.delete('/api/jobs/:id', async (req) => ({ cancelled: jobs.cancel(param(req, 'id')) }));

  // ───────────── 搜尋（指令面板）
  app.get('/api/search', async (req) => {
    const q = (qs(req).q ?? '').trim();
    if (!q) return { tasks: [], reports: [] };
    const tasks = index.query({ q }).slice(0, 20);
    return { tasks, reports: searchReports(source, q) };
  });

  // ───────────── 靜態 UI
  const indexHtml = () => {
    const file = join(opts.uiDir, 'index.html');
    const html = existsSync(file)
      ? readFileSync(file, 'utf8')
      : '<!doctype html><meta charset="utf-8"><title>Worktrail</title><body style="font-family:sans-serif;padding:40px">UI 尚未建置：請在專案資料夾執行 <code>npm run build</code>。</body>';
    // 依設定的主題寫死 color-scheme：維持 "light dark" 時，Chromium 在頁面腳本執行前會先依系統深色畫一格深底，
    // 系統深色、UI 淺色時開啟就會閃一下（實測 Edge 獨立視窗）
    let theme = 'light';
    try {
      theme = cfg().config.ui.theme;
    } catch {
      // 設定檔讀不到時用預設的淺色
    }
    return html
      .replace('<meta name="color-scheme" content="light dark" />', `<meta name="color-scheme" content="${theme}" />`)
      .replace('</head>', `<script>window.__WORKTRAIL__=${JSON.stringify({ token, port: opts.port })}</script></head>`);
  };

  app.get('/*', async (req, reply) => {
    const url = decodeURIComponent(req.url.split('?')[0]!);
    if (url.startsWith('/api/')) throw new HttpError(404, '找不到 API');
    const file = normalize(join(opts.uiDir, url));
    if (file.startsWith(normalize(opts.uiDir)) && extname(file) && existsSync(file)) {
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      reply.header('cache-control', url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.type(type).send(readFileSync(file));
    }
    reply.header('cache-control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(indexHtml());
  });

  // ───────────── 排程（規格 5.3）
  let lastSweepDate = '';
  let timer: NodeJS.Timeout | undefined;
  const runScheduledSweep = (reason: string) => {
    if (jobs.findRunning('sweep', 'sweep')) return;
    jobs.start('sweep', 'sweep', async (ctx) => {
      const r = await sweep({ paths, config: cfg().config, signal: ctx.signal });
      index.load();
      broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
      writeLog(paths, 'daemon', 'info', `補漏掃描（${reason}）：掃描 ${r.scanned}、擷取 ${r.captured}、待補摘要 ${r.pending.length}`);
      return { scanned: r.scanned, captured: r.captured, pending: r.pending.length };
    });
  };

  // ───────────── Jira 每日活動同步（排程與補抓）
  let lastJiraCheck = 0;
  const startJiraSync = (dates: string[], reason: string, onlyKeys?: string[]): Job => {
    const running = jobs.findRunning('jira-sync', 'jira-sync');
    if (running) return running;
    return jobs.start('jira-sync', 'jira-sync', async (ctx) => {
      const results: JiraSyncResult[] = [];
      const failed: string[] = [];
      for (const date of dates) {
        if (ctx.signal.aborted) break;
        try {
          const r = await syncJiraActivity(paths, cfg().config, date, ctx, { onlyKeys });
          results.push(r);
          const changed = r.created.length + r.updated.length + r.appended.length + r.removed.length;
          writeLog(
            paths,
            'daemon',
            r.errors.length ? 'warn' : 'info',
            `Jira 活動同步（${reason}）${date}：活動 ${r.activities}、新增 ${r.created.length}、更新 ${r.updated.length}、附加 ${r.appended.length}、移除 ${r.removed.length}` +
              (r.errors.length ? `；${r.errors.join('；')}` : ''),
          );
          if (changed) {
            index.load();
            broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
            await rebalanceDates([date]);
          }
        } catch (e) {
          if (ctx.signal.aborted) break;
          failed.push(`${date}：${(e as Error).message.slice(0, 200)}`);
          writeLog(paths, 'daemon', 'warn', `Jira 活動同步（${reason}）${date} 失敗：${(e as Error).message.slice(0, 300)}`);
        }
      }
      if (failed.length && !results.length) throw new Error(failed.join('；'));
      return { results, failed };
    });
  };
  const runScheduledJiraSync = (reason: string) => {
    lastJiraCheck = Date.now();
    if (jobs.findRunning('jira-sync', 'jira-sync') || jobs.findRunning('sweep', 'sweep')) return;
    const { config, error } = cfg();
    if (error) return;
    const dates = datesNeedingSync({ state: readSyncState(paths), now: Date.now(), tz: config.time.timezone, config });
    if (dates.length) startJiraSync(dates, reason);
  };

  // ───────────── 父卡片查詢（單號資訊快取）
  /** 近期任務的單號才查詢，避免一次查太多 */
  const TICKET_LOOKBACK_DAYS = 60;
  let lastTicketRefresh = 0;

  /** 依快取重新判斷專案；回傳改寫的任務數 */
  const reresolveFromCache = async (config: Config, only?: Set<string>) => {
    const cache = readTicketCache(paths);
    const targets = index.all().filter((t) => t.ticket && (!only || only.has(t.ticket.toUpperCase())));
    const r = await rewriteTaskFiles(paths, targets, (t) => reresolveProject(t, config, cache));
    for (const t of r.written) index.upsert(t, r.previous.get(t.id));
    for (const e of r.errors) writeLog(paths, 'daemon', 'warn', `重新判斷專案失敗：${e}`);
    if (r.written.length) broadcast('change', { kind: 'task', action: 'change', path: paths.tasks } satisfies ChangeEvent);
    return r.written.length;
  };

  /** 新的大型工作自動建立專案；回傳改寫的任務數 */
  const applyAutoProjects = async () => {
    const { config, error } = cfg();
    if (error || !config.ticket.auto_projects) return 0;
    const projects = autoProjectRules(index.all(), readTicketCache(paths), config);
    if (!projects) return 0;
    const saved = await saveConfig(paths, { ...config, projects });
    writeLog(paths, 'daemon', 'info', `自動建立專案：${projects.length - config.projects.length} 個`);
    return (await syncProjects(saved)) + (await reresolveFromCache(saved));
  };

  const startTicketRefresh = (reason: string, force = false): Job | null => {
    const running = jobs.findRunning('tickets', 'tickets');
    if (running) return running;
    const { config } = cfg();
    if (!config.ticket.fetch_parents && reason !== '手動') return null;
    lastTicketRefresh = Date.now();
    const since = addDays(today(), -TICKET_LOOKBACK_DAYS);
    const recent = index.all().filter((t) => t.date >= since && t.ticket).map((t) => t.ticket!.toUpperCase());
    const tickets = force ? [...new Set(recent)].sort() : ticketsNeedingRefresh(recent, readTicketCache(paths), Date.now());
    if (!tickets.length) return null;
    return jobs.start('tickets', 'tickets', async (ctx) => {
      const r = await refreshTicketInfo(paths, cfg().config, tickets, ctx);
      const created = await applyAutoProjects();
      const updated = (await reresolveFromCache(cfg().config, new Set(r.fetched.filter((f) => !f.error).map((f) => f.key)))) + created;
      if (r.errors.length) writeLog(paths, 'daemon', 'warn', `查詢父卡片（${reason}）失敗：${r.errors.join('；')}`);
      return { tickets: tickets.length, fetched: r.fetched.filter((f) => !f.error).length, errors: r.errors, updated };
    });
  };

  return {
    app,
    index,
    jobs,
    async start() {
      // 專案規則補上固定 ID 並寫回設定；舊任務依名稱補上 ID
      try {
        const { config, error } = cfg();
        if (!error) {
          const raw = readText(paths.config) ?? '';
          if (config.projects.length && !config.projects.every((p) => raw.includes(p.id))) await saveConfig(paths, config);
          await syncProjects(config);
          await applyAutoProjects();
        }
      } catch (err) {
        writeLog(paths, 'daemon', 'warn', `專案 ID 轉換失敗：${(err as Error).message}`);
      }
      if (opts.watch !== false) {
        index.watch();
        runScheduledSweep('啟動');
        timer = setInterval(() => {
          const { config } = cfg();
          const now = new Date();
          const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          const d = today();
          if (hhmm >= config.capture.sweep_time && lastSweepDate !== d) {
            lastSweepDate = d;
            runScheduledSweep('每日排程');
          }
          if (Date.now() - lastTicketRefresh >= 10 * 60_000 && !jobs.findRunning('sweep', 'sweep')) startTicketRefresh('排程');
          if (Date.now() - lastJiraCheck >= 60_000) runScheduledJiraSync('排程');
        }, 30_000);
        // 啟動當天若已過排程時間，不再重複（啟動時已掃描）
        const { config } = cfg();
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (hhmm >= config.capture.sweep_time) lastSweepDate = today();
      }
      await app.listen({ host: '127.0.0.1', port: opts.port });
    },
    async stop() {
      clearInterval(timer);
      for (const c of sseClients) c.raw.end();
      await index.close();
      await app.close();
    },
  };
}
