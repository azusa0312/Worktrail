/**
 * 任務檔讀寫（規格 4.1、4.2）。
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TaskFrontmatter, type Task } from '../schema/task.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { contentVersion, ensureDir, readText, removeFile, writeFileAtomic } from './fsutil.js';
import type { StoragePaths } from './paths.js';

export interface TaskRecord extends Task {
  path: string;
  version: string;
}

/** 前段 YAML 欄位的固定輸出順序（與規格 4.2 範例一致） */
const KEY_ORDER = [
  'schema', 'id', 'session_id', 'date', 'project', 'project_id', 'project_unmapped', 'ticket', 'related_tickets', 'title',
  'title_source', 'repo', 'branch', 'first_activity', 'last_activity', 'active_minutes', 'hours', 'hours_overridden',
  'hours_source', 'hours_estimate', 'locked_fields', 'commits', 'summary_status', 'summary_updated_at', 'summary_prompt',
  'summary_prompt_hash', 'manual', 'source', 'jira_sync', 'merged', 'items',
];

export function serializeTask(task: Task): string {
  const { body, ...fm } = task as Task & { path?: string; version?: string };
  delete (fm as Record<string, unknown>).path;
  delete (fm as Record<string, unknown>).version;
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (k in fm) ordered[k] = (fm as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(fm)) if (!(k in ordered)) ordered[k] = v;
  return stringifyFrontmatter(ordered, body ?? '');
}

export function parseTaskText(text: string, path: string): TaskRecord | null {
  const { data, body } = parseFrontmatter(text);
  const r = TaskFrontmatter.safeParse(data);
  if (!r.success) return null;
  return { ...r.data, body, path, version: contentVersion(text) };
}

export function readTask(path: string): TaskRecord | null {
  const text = readText(path);
  return text === null ? null : parseTaskText(text, path);
}

/** 寫入任務檔；id 改變（例如單號更新）時會移除舊檔 */
export function writeTask(paths: StoragePaths, task: Task, previousPath?: string): TaskRecord {
  const path = paths.taskFile(task.id, task.date);
  const text = serializeTask(task);
  writeFileAtomic(path, text);
  if (previousPath && previousPath !== path) removeFile(previousPath);
  return { ...task, path, version: contentVersion(text) };
}

const sid6 = (sessionId: string) => sessionId.replace(/-/g, '').slice(0, 6);

/** 依日期與 session 找任務檔（檔名 `日期__單號__session前6碼.md`） */
export function findTaskFile(paths: StoragePaths, date: string, sessionId: string): string | null {
  const dir = paths.taskDir(date);
  if (!existsSync(dir)) return null;
  const suffix = `__${sid6(sessionId)}.md`;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${date}__`) && f.endsWith(suffix)) {
      const t = readTask(join(dir, f));
      if (t && t.session_id === sessionId) return t.path;
    }
  }
  return null;
}

export function findTaskById(paths: StoragePaths, id: string): TaskRecord | null {
  const date = id.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return readTask(paths.taskFile(id, date));
}

/** 任務檔的鎖定鍵：同一 session 同一天共用（檔名可能因單號改變） */
export function taskLockKey(paths: StoragePaths, date: string, sessionId: string): string {
  return join(paths.taskDir(date), `.${date}__${sid6(sessionId)}`);
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}/${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** 列出期間內（含頭尾）的任務，依日期、首次活動排序 */
export function listTasks(paths: StoragePaths, from: string, to: string): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const ym of monthsBetween(from, to)) {
    const dir = join(paths.tasks, ym);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const date = f.slice(0, 10);
      if (date < from || date > to) continue;
      const t = readTask(join(dir, f));
      if (t) out.push(t);
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.first_activity ?? '').localeCompare(b.first_activity ?? ''),
  );
}

/** 所有任務的日期範圍（掃描資料夾，不讀內容） */
export function allTaskDates(paths: StoragePaths): string[] {
  if (!existsSync(paths.tasks)) return [];
  const dates = new Set<string>();
  for (const y of readdirSync(paths.tasks)) {
    const yd = join(paths.tasks, y);
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of readdirSync(yd)) {
      const md = join(yd, m);
      if (!/^\d{2}$/.test(m)) continue;
      for (const f of readdirSync(md)) if (f.endsWith('.md')) dates.add(f.slice(0, 10));
    }
  }
  return [...dates].sort();
}

/** 刪除：移到 .worktrail/trash/（可復原） */
export function trashTask(paths: StoragePaths, task: TaskRecord): string {
  ensureDir(paths.trash);
  const dest = join(paths.trash, `${Date.now()}__${basename(task.path)}`);
  renameSync(task.path, dest);
  return dest;
}

export function restoreTask(paths: StoragePaths, trashPath: string): TaskRecord | null {
  const t = readTask(trashPath);
  if (!t) return null;
  const dest = paths.taskFile(t.id, t.date);
  ensureDir(paths.taskDir(t.date));
  renameSync(trashPath, dest);
  return readTask(dest);
}
