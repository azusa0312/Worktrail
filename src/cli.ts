#!/usr/bin/env node
/**
 * 規格 13.1：CLI 進入點（打包為 dist/cli.cjs）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import { analyzeSession, type SessionDraft } from './core/capture/analyze.js';
import { committedShas } from './core/capture/commits.js';
import { getCommits } from './core/capture/git.js';
import { parseConfig } from './core/config/load.js';
import { VERSION } from './core/program.js';
import { defaultConfig, type Config } from './core/schema/config.js';
import { parseTranscript } from './core/transcript/index.js';

const program = new Command();
program.name('worktrail').description('Worktrail：Claude Code 本機工作日誌').version(VERSION);

program
  .command('install')
  .description('安裝：註冊 hook、MCP、指令、CLAUDE.md 規則與捷徑')
  .option('--storage <dir>', '儲存資料夾')
  .option('-y, --yes', '不詢問，使用預設值')
  .option('--no-shortcuts', '不建立桌面捷徑')
  .option('--autostart', '開機自動啟動服務')
  .option('--no-autostart', '不要開機自動啟動')
  .action(async (o: { storage?: string; yes?: boolean; shortcuts: boolean; autostart?: boolean }) => {
    const { install } = await import('./installer/install.js');
    await install({ storage: o.storage, yes: o.yes, shortcuts: o.shortcuts, autostart: o.autostart });
    const { doctor } = await import('./installer/doctor.js');
    console.log('');
    await doctor();
  });

program
  .command('uninstall')
  .description('移除所有設定（預設保留日誌資料）')
  .option('--purge', '連同儲存資料夾一起刪除（需再次確認）')
  .option('-y, --yes', '不詢問')
  .action(async (o: { purge?: boolean; yes?: boolean }) => {
    const { uninstall } = await import('./installer/install.js');
    await uninstall({ purge: o.purge, yes: o.yes });
  });

program
  .command('doctor')
  .description('檢查安裝狀態並列出修復建議')
  .action(async () => {
    const { doctor } = await import('./installer/doctor.js');
    process.exitCode = await doctor();
  });

program
  .command('start', { hidden: true })
  .description('在背景啟動常駐服務、不開視窗（啟動器與開機自動啟動使用；一般請用 open）')
  .option('--foreground', '在目前的終端機執行（不分離）')
  .action(async (o: { foreground?: boolean }) => {
    if (o.foreground) {
      const { runDaemonForeground } = await import('./daemon/main.js');
      await runDaemonForeground();
      return;
    }
    const { startDaemonDetached, uiUrl } = await import('./daemon/client.js');
    const info = await startDaemonDetached();
    if (!info) {
      console.error('服務啟動失敗，請執行 worktrail doctor 檢查');
      process.exitCode = 1;
    } else console.log(`Worktrail 服務執行中：${uiUrl(info.port)}`);
  });

program
  .command('stop')
  .description('停止常駐服務')
  .action(async () => {
    const { stopDaemon } = await import('./daemon/client.js');
    console.log((await stopDaemon()) ? '已停止' : '服務沒有在執行');
  });

program
  .command('open')
  .description('開啟 Worktrail（服務未執行或是舊版時會自動啟動）')
  .action(async () => {
    const { launcherMain } = await import('./launcher/main.js');
    await launcherMain([]);
  });

program
  .command('sweep')
  .description('立即執行補漏掃描')
  .action(async () => {
    const { storageRoot, StoragePaths } = await import('./core/storage/paths.js');
    const { loadConfig } = await import('./core/storage/config-store.js');
    const { sweep } = await import('./core/sync/sweep.js');
    const root = storageRoot();
    if (!root) throw new Error('尚未安裝：請先執行 worktrail install');
    const paths = new StoragePaths(root);
    const r = await sweep({ paths, config: loadConfig(paths).config });
    console.log(`掃描 ${r.scanned} 個紀錄檔，擷取 ${r.captured} 個，待補摘要 ${r.pending.length} 個`);
    for (const e of r.errors) console.error(`  ⚠ ${e}`);
  });

program
  .command('jira-sync')
  .description('同步某一天的 Jira 活動（預設今天），補上沒用 Claude 處理的單')
  .option('--date <YYYY-MM-DD>', '要同步的日期')
  .option('--failed', '只列出讀取失敗的單號（不執行同步）')
  .option('--retry-failed', '只重新讀取該日期先前失敗的單號')
  .action(async (opts: { date?: string; failed?: boolean; retryFailed?: boolean }) => {
    const { storageRoot, StoragePaths } = await import('./core/storage/paths.js');
    const { loadConfig } = await import('./core/storage/config-store.js');
    const { localDate } = await import('./core/capture/tz.js');
    const { readSyncState } = await import('./core/jira-activity/index.js');
    const root = storageRoot();
    if (!root) throw new Error('尚未安裝：請先執行 worktrail install');
    const paths = new StoragePaths(root);
    const config = loadConfig(paths).config;
    const state = readSyncState(paths);
    if (opts.failed) {
      const days = Object.entries(state.days)
        .filter(([d, s]) => (!opts.date || d === opts.date) && (s.failed.length || s.error))
        .sort((a, b) => a[0].localeCompare(b[0]));
      if (!days.length) console.log('沒有讀取失敗的單號');
      for (const [d, s] of days) {
        if (s.error) console.log(`${d}：整次同步失敗（${s.error}）`);
        for (const f of s.failed) console.log(`${d}  ${f.key.padEnd(10)}  ${f.error}`);
      }
      return;
    }
    const { syncJiraActivity } = await import('./daemon/actions.js');
    const date = opts.date ?? localDate(Date.now(), config.time.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式須為 YYYY-MM-DD');
    let onlyKeys: string[] | undefined;
    if (opts.retryFailed) {
      onlyKeys = (state.days[date]?.failed ?? []).map((f) => f.key);
      if (!onlyKeys.length) return console.log(`${date} 沒有讀取失敗的單號`);
      console.log(`重新讀取：${onlyKeys.join('、')}`);
    }
    const ctx = { signal: new AbortController().signal, progress: (m: string) => console.log(m) };
    const r = await syncJiraActivity(paths, config, date, ctx, { onlyKeys });
    console.log(
      `${date}：活動 ${r.activities} 張，新增 ${r.created.length}、更新 ${r.updated.length}、附加 ${r.appended.length}、移除 ${r.removed.length}`,
    );
    for (const [label, list] of [['新增', r.created], ['更新', r.updated], ['附加到既有任務', r.appended], ['略過', r.skipped]] as const) {
      if (list.length) console.log(`  ${label}：${list.join('、')}`);
    }
    for (const e of r.errors) console.error(`  ⚠ ${e}`);
    console.log('（常駐服務執行中時，UI 會在下次重新整理後顯示）');
  });

program
  .command('hook', { hidden: true })
  .description('給 Claude Code hook 呼叫的進入點（使用者不需直接執行）')
  .argument('<event>', 'session-start | stop | session-end')
  .action(async (event: string) => {
    const { hookMain } = await import('./hook/main.js');
    await hookMain(event);
  });

program
  .command('mcp', { hidden: true })
  .description('MCP Server 進入點（由 Claude Code 啟動）')
  .action(async () => {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer();
  });

program
  .command('analyze')
  .description('分析 Claude Code 紀錄檔，輸出每日活躍時間、單號、標題與專案（不寫入任何檔案）')
  .argument('<paths...>', '紀錄檔（.jsonl）或包含紀錄檔的資料夾')
  .option('-c, --config <path>', 'config.yaml 路徑（未指定則用預設值）')
  .option('-k, --keys <keys>', '覆寫 Jira 專案代碼白名單，以逗號分隔，例如 TDDA,BMS')
  .option('--idle <minutes>', '覆寫閒置門檻（分鐘）')
  .option('--grace <minutes>', '覆寫閒置寬限（分鐘）')
  .option('--no-git', '不讀取 git commit')
  .option('--json', '以 JSON 輸出')
  .option('--table', '依日期列出每個任務日')
  .action(async (args: string[], opts: AnalyzeOpts) => {
    const config = loadAnalyzeConfig(opts);
    const files = args.flatMap((p) =>
      statSync(p).isDirectory()
        ? readdirSync(p)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => join(p, f))
        : [p],
    );
    const parsedAll = files.map((file) => ({ file, parsed: parseTranscript(readFileSync(file, 'utf8')) }));
    const evidence = parsedAll.map((p) => committedShas(p.parsed.events.filter((e) => !e.copied)));
    const results: SessionDraft[] = [];
    for (const [i, { file, parsed }] of parsedAll.entries()) {
      const own = parsed.events.filter((e) => !e.copied);
      let commits: Awaited<ReturnType<typeof getCommits>> = [];
      if (opts.git && parsed.meta.cwd && own.length) {
        commits = await getCommits({ cwd: parsed.meta.cwd, since: own[0]!.ts, until: own.at(-1)!.ts + 60 * 60_000 });
      }
      const claimedElsewhere = evidence.filter((_, j) => j !== i).flat();
      results.push(analyzeSession({ parsed, config, commits, claimedElsewhere, sessionIdFallback: basename(file, '.jsonl') }));
    }
    if (opts.json) console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    else if (opts.table) printTable(results);
    else for (const [i, r] of results.entries()) printDraft(files[i]!, r);
  });

interface AnalyzeOpts {
  config?: string;
  keys?: string;
  idle?: string;
  grace?: string;
  git: boolean;
  json?: boolean;
  table?: boolean;
}

function loadAnalyzeConfig(opts: AnalyzeOpts): Config {
  let config = defaultConfig();
  if (opts.config) {
    const r = parseConfig(readFileSync(opts.config, 'utf8'));
    if (r.error) console.error(`設定檔有誤（第 ${r.error.line ?? '?'} 行）：${r.error.message}，改用預設值`);
    config = r.config;
  }
  if (opts.keys) config.ticket.keys = opts.keys.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (opts.idle) config.time.idle_threshold_minutes = Number(opts.idle);
  if (opts.grace) config.time.idle_grace_minutes = Number(opts.grace);
  return config;
}

function printTable(results: SessionDraft[]): void {
  const rows = results
    .flatMap((r) => r.days.map((d) => ({ r, d })))
    .sort((a, b) => a.d.date.localeCompare(b.d.date) || a.d.first_activity.localeCompare(b.d.first_activity));
  console.log('日期        時段         分鐘  時數  commit  單號        session   標題');
  for (const { r, d } of rows) {
    const title = r.title?.title ?? '';
    console.log(
      [
        d.date,
        `${d.first_activity.slice(11, 16)}–${d.last_activity.slice(11, 16)}`,
        String(d.active_minutes).padStart(5),
        String(d.hours).padStart(4),
        String(d.commits.length).padStart(6),
        ` ${(r.ticket ?? 'no-ticket').padEnd(10)}`,
        r.session_id.slice(0, 8),
        [...title].length > 40 ? [...title].slice(0, 40).join('') + '…' : title,
      ].join('  '),
    );
  }
}

function printDraft(file: string, r: SessionDraft): void {
  const out: string[] = [];
  out.push(`■ ${basename(file)}`);
  out.push(`  session   ${r.session_id}`);
  out.push(`  repo      ${r.repo}  (${r.branch || '—'})`);
  out.push(`  project   ${r.project}${r.project_unmapped ? '  ⚠ 未對應專案' : ''}`);
  out.push(`  ticket    ${r.ticket ?? '— (no-ticket)'}${r.related_tickets.length ? `  related: ${r.related_tickets.join(', ')}` : ''}`);
  if (r.ticket_scores.length) {
    const s = r.ticket_scores
      .slice(0, 5)
      .map((t) => `${t.ticket}=${t.score} {${Object.entries(t.sources).map(([k, v]) => `${k}:${v}`).join(' ')}}`);
    out.push(`  scores    ${s.join('\n            ')}`);
  }
  out.push(`  title     ${r.title ? `${r.title.title}  [${r.title.source}]` : '—'}`);
  const total = r.days.reduce((a, d) => a + d.active_minutes, 0);
  out.push(`  days      ${r.days.length} 天，合計 ${total} 分鐘`);
  for (const d of r.days) {
    out.push(
      `    ${d.date}  ${String(d.active_minutes).padStart(4)} 分 → ${d.hours}h  ` +
        `${d.first_activity.slice(11, 16)}–${d.last_activity.slice(11, 16)}` +
        (d.commits.length ? `  commits: ${d.commits.length}` : ''),
    );
    for (const c of d.commits) out.push(`      ${c.sha} ${c.message}`);
  }
  for (const w of r.warnings) out.push(`  ⚠ ${w}`);
  console.log(out.join('\n') + '\n');
}

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
