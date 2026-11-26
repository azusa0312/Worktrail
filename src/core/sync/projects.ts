/**
 * 專案固定 ID 與名稱同步（見 DECISIONS「專案固定 ID」）。
 *
 * 任務檔同時存 `project`（名稱，方便閱讀與既有程式使用）與 `project_id`（設定中專案規則的 ID）。
 * 專案改名、合併或新增規則後，`syncTaskProjects` 依 ID 把任務的名稱改成設定中的名稱，
 * 並把名稱與規則相同、但還沒有 ID 的任務（舊資料、手動輸入）補上 ID。
 */
import { resolveProject, type ProjectResult } from '../capture/project.js';
import { assignProjectIds, type Config, type ProjectRule } from '../schema/config.js';
import type { Task } from '../schema/task.js';
import { withLock } from '../storage/fsutil.js';
import type { StoragePaths } from '../storage/paths.js';
import { readTask, taskLockKey, writeTask, type TaskRecord } from '../storage/tasks.js';
import type { TicketCache } from '../ticket-info/index.js';

export function ruleByName(config: Pick<Config, 'projects'>, name: string): ProjectRule | undefined {
  const n = name.trim();
  return n ? config.projects.find((r) => r.name === n) : undefined;
}

export function ruleById(config: Pick<Config, 'projects'>, id: string | undefined): ProjectRule | undefined {
  return id ? config.projects.find((r) => r.id === id) : undefined;
}

/** 使用者或 Claude 指定專案名稱：名稱符合設定中的專案時帶上它的 ID */
export function setProject<T extends Task>(t: T, name: string, config: Pick<Config, 'projects'>): T {
  const next = { ...t };
  assignProject(next, name, config);
  return next;
}

/** setProject 的就地版本 */
export function assignProject(t: Task, name: string, config: Pick<Config, 'projects'>): void {
  t.project = name.trim();
  t.project_unmapped = undefined;
  const r = ruleByName(config, name);
  if (r) t.project_id = r.id;
  else delete t.project_id;
}

/**
 * 套用自動判斷的專案（擷取、父卡片查到之後）。專案鎖定時不動。
 * 自動判斷「未對應」時，不覆蓋已經對應到專案的任務：例如規則調整後工作目錄不再符合，
 * 或單號資訊暫時查不到，都不該把分好的專案改回資料夾名稱。
 */
export function applyResolvedProject<T extends Task>(t: T, r: ProjectResult, isNew: boolean): T {
  if (t.locked_fields.includes('project')) return t;
  if (r.unmapped && !isNew && t.project_id) return t;
  const next = { ...t, project: r.project, project_unmapped: r.unmapped || undefined };
  if (r.project_id) next.project_id = r.project_id;
  else delete next.project_id;
  return next;
}

/** 依目前規則重新判斷專案（父卡片查到後）；沒有變化時回傳 null */
export function reresolveProject<T extends Task>(t: T, config: Config, cache: TicketCache): T | null {
  // 手動任務的專案是使用者填的；Jira 同步建立的任務則跟著單號規則自動判斷
  if ((t.manual && t.source !== 'jira') || t.locked_fields.includes('project')) return null;
  const r = resolveProject({
    cwd: t.repo || undefined,
    ticket: t.ticket,
    rules: config.projects,
    ticketInfo: t.ticket ? cache[t.ticket.toUpperCase()] : undefined,
  });
  const next = applyResolvedProject(t, r, false);
  return sameProject(t, next) ? null : next;
}

const sameProject = (a: Task, b: Task) =>
  a.project === b.project && a.project_id === b.project_id && !!a.project_unmapped === !!b.project_unmapped;

/**
 * 依設定同步一個任務的專案名稱與 ID；沒有變化時回傳 null。
 * @param remap 專案合併時，舊 ID → 新 ID
 */
export function syncProjectName<T extends Task>(t: T, config: Pick<Config, 'projects'>, remap: Record<string, string> = {}): T | null {
  const id = t.project_id ? (remap[t.project_id] ?? t.project_id) : undefined;
  const byId = ruleById(config, id);
  let next: T;
  if (byId) {
    next = { ...t, project: byId.name, project_id: byId.id, project_unmapped: undefined };
  } else {
    // 沒有 ID，或 ID 對應的專案已刪除：名稱與某個專案相同就歸到該專案（舊資料轉換也走這裡）
    const byName = ruleByName(config, t.project);
    if (!byName) return null;
    next = { ...t, project_id: byName.id, project_unmapped: undefined };
  }
  return sameProject(t, next) ? null : next;
}

/** 合併專案：把 from 的對應條件併入 to，並刪除 from。回傳新的專案清單 */
export function mergeProjectRules(rules: readonly ProjectRule[], fromId: string, toId: string): ProjectRule[] {
  if (fromId === toId) throw new Error('不能合併到同一個專案');
  const from = rules.find((r) => r.id === fromId);
  const to = rules.find((r) => r.id === toId);
  if (!from || !to) throw new Error('找不到要合併的專案');
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return rules
    .filter((r) => r.id !== fromId)
    .map((r) =>
      r.id === toId
        ? {
            ...r,
            match: {
              paths: union(to.match.paths, from.match.paths),
              ticket_keys: union(to.match.ticket_keys, from.match.ticket_keys),
              parents: union(to.match.parents, from.match.parents),
            },
          }
        : r,
    );
}

/**
 * 在檔案鎖內逐一改寫需要變更的任務。`change` 回傳 null 代表不需改寫。
 * 每個任務在鎖內重新讀檔，以最新內容計算，避免覆蓋同時進行的擷取。
 */
export async function rewriteTasks(
  paths: StoragePaths,
  tasks: readonly TaskRecord[],
  change: (t: TaskRecord) => Task | null,
): Promise<{ written: TaskRecord[]; previous: Map<string, string>; errors: string[] }> {
  const written: TaskRecord[] = [];
  const previous = new Map<string, string>();
  const errors: string[] = [];
  for (const t of tasks) {
    if (!change(t)) continue;
    try {
      const saved = await withLock(taskLockKey(paths, t.date, t.session_id), () => {
        const latest = readTask(t.path);
        if (!latest) return null;
        const next = change(latest);
        return next ? writeTask(paths, next, latest.path) : null;
      });
      if (saved) {
        written.push(saved);
        previous.set(saved.id, t.path);
      }
    } catch (e) {
      errors.push(`${t.id}：${(e as Error).message}`);
    }
  }
  return { written, previous, errors };
}

/** 依設定同步所有任務的專案名稱與 ID */
export function syncTaskProjects(
  paths: StoragePaths,
  config: Pick<Config, 'projects'>,
  tasks: readonly TaskRecord[],
  remap?: Record<string, string>,
) {
  return rewriteTasks(paths, tasks, (t) => syncProjectName(t, config, remap));
}

/** 每個專案的任務數（以 ID 計） */
export function projectTaskCounts(tasks: readonly Pick<Task, 'project_id'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) if (t.project_id) out[t.project_id] = (out[t.project_id] ?? 0) + 1;
  return out;
}

export interface UnmappedParent {
  key: string;
  summary: string;
  type: string;
  /** 屬於這張上層卡片、但沒有被父卡片規則對應的任務數 */
  task_count: number;
  tickets: string[];
}

/**
 * 還沒有專案規則的最上層卡片（設定頁「建立專案」建議）。
 * 只看沒鎖定、非手動、且沒有被父卡片規則對應的任務。
 */
export function unmappedParents(tasks: readonly Task[], cache: TicketCache, config: Pick<Config, 'projects'>): UnmappedParent[] {
  const out = new Map<string, UnmappedParent>();
  for (const t of tasks) {
    if (!t.ticket) continue;
    const info = cache[t.ticket.toUpperCase()];
    const top = info?.ancestors.at(-1);
    if (!top) continue;
    const r = resolveProject({ cwd: undefined, ticket: t.ticket, rules: config.projects, ticketInfo: info });
    if (r.rule === 'parent') continue;
    const e = out.get(top.key) ?? { key: top.key, summary: top.summary, type: top.type, task_count: 0, tickets: [] };
    e.task_count++;
    if (!e.tickets.includes(t.ticket)) e.tickets.push(t.ticket);
    out.set(top.key, e);
  }
  return [...out.values()].sort((a, b) => b.task_count - a.task_count || a.key.localeCompare(b.key));
}

/**
 * 自動建立專案：每張還沒有父卡片規則、也沒被使用者忽略的最上層卡片（大型工作），
 * 建立一個以卡片標題為名稱的專案。名稱與既有專案相同時，把卡片加進該專案的父卡片條件。
 * 沒有變化時回傳 null。
 */
export function autoProjectRules(
  tasks: readonly Task[],
  cache: TicketCache,
  config: Pick<Config, 'projects' | 'ticket'>,
): ProjectRule[] | null {
  const ignored = new Set(config.ticket.ignored_parents.map((k) => k.toUpperCase()));
  const candidates = unmappedParents(tasks, cache, config).filter((p) => !ignored.has(p.key));
  if (!candidates.length) return null;
  const rules = config.projects.map((r) => ({ ...r, match: { ...r.match, parents: [...r.match.parents] } }));
  const added: { name: string; match: ProjectRule['match'] }[] = [];
  for (const p of candidates) {
    const name = (p.summary || p.key).trim();
    const same = rules.find((r) => r.name === name) ?? added.find((r) => r.name === name);
    if (same) same.match.parents.push(p.key);
    else added.push({ name, match: { paths: [], ticket_keys: [], parents: [p.key] } });
  }
  return assignProjectIds([...rules, ...added]);
}

/** 所有專案規則的父卡片單號（大寫） */
const allParents = (rules: readonly ProjectRule[]) => new Set(rules.flatMap((r) => r.match.parents.map((k) => k.toUpperCase())));

/**
 * 使用者改設定時更新「不再自動建立」清單：
 * 從所有專案拿掉的父卡片加入清單（刪除專案或刪掉條件），重新加回的移出清單。
 */
export function trackIgnoredParents(before: readonly ProjectRule[], after: readonly ProjectRule[], ignored: readonly string[]): string[] {
  const prev = allParents(before);
  const next = allParents(after);
  const out = new Set(ignored.map((k) => k.toUpperCase()));
  for (const k of prev) if (!next.has(k)) out.add(k);
  for (const k of next) out.delete(k);
  return [...out].sort();
}

export interface ProjectRuleSummary {
  id: string;
  name: string;
  task_count: number;
  /** 父卡片條件，附上單號資訊快取中的標題（查不到時為空字串） */
  parents: { key: string; summary: string }[];
}

/** 設定頁的專案清單：每個專案的任務數與父卡片條件的標題 */
export function projectRuleSummaries(
  config: Pick<Config, 'projects'>,
  tasks: readonly Pick<Task, 'project_id'>[],
  cache: TicketCache,
): ProjectRuleSummary[] {
  const counts = projectTaskCounts(tasks);
  // 大型工作的標題：從快取中各單號與其上層卡片找
  const titles = new Map<string, string>();
  for (const info of Object.values(cache)) {
    if (info.summary) titles.set(info.key, info.summary);
    for (const a of info.ancestors) if (a.summary) titles.set(a.key, a.summary);
  }
  return config.projects.map((r) => ({
    id: r.id,
    name: r.name,
    task_count: counts[r.id] ?? 0,
    parents: r.match.parents.map((key) => ({ key, summary: titles.get(key.toUpperCase()) ?? '' })),
  }));
}
