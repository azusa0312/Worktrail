/**
 * 合併同一天、同專案的任務（後端 core/sync/task-merge.ts）。
 * 帶 merged 標記的同日同專案任務顯示為一張卡片：專案 → 各任務 → 子項。
 */
import { useQueryClient } from '@tanstack/react-query';
import { Layers, Ungroup } from 'lucide-react';
import { useState } from 'react';
import { post, type Task } from '../lib/api';
import { useToast } from '../lib/app';
import { fmtHours, hhmm } from '../lib/format';
import { CopyProgressButton, HoursSource, SummarizeButton, SummaryStatusTag, TaskCard, TicketColumn, displayTitle } from './TaskCard';
import { Button, Card, ProjectTag, StatusBadge, Tag, cx } from './ui';

export type TaskEntry = { kind: 'task'; task: Task } | { kind: 'group'; date: string; project: string; tasks: Task[]; hours: number };

const key = (t: Task) => `${t.date}\u0000${t.project}`;

/** 與後端 groupMerged 相同的規則：同組只剩一個成員時當一般任務 */
export function groupEntries(tasks: readonly Task[]): TaskEntry[] {
  const members = new Map<string, Task[]>();
  for (const t of tasks) if (t.merged && t.project) (members.get(key(t)) ?? members.set(key(t), []).get(key(t))!).push(t);
  const out: TaskEntry[] = [];
  const emitted = new Set<string>();
  for (const t of tasks) {
    const group = t.merged && t.project ? members.get(key(t)) : undefined;
    if (!group || group.length < 2) out.push({ kind: 'task', task: t });
    else if (!emitted.has(key(t))) {
      emitted.add(key(t));
      // 組內一律依開始時間排（日誌頁的清單是新到舊）
      group.sort((a, b) => (a.first_activity ?? '').localeCompare(b.first_activity ?? ''));
      out.push({ kind: 'group', date: t.date, project: t.project, tasks: group, hours: Math.round(group.reduce((a, x) => a + x.hours, 0) * 100) / 100 });
    }
  }
  return out;
}

/** 依清單顯示順序（合併組的成員排在一起），供 J／K 導覽 */
export function flattenEntries(entries: readonly TaskEntry[]): Task[] {
  return entries.flatMap((e) => (e.kind === 'group' ? e.tasks : [e.task]));
}

/** 同一天有兩個以上未全部合併的同專案任務 → 建議合併 */
export function mergeSuggestions(tasks: readonly Task[]): { project: string; ids: string[]; date: string }[] {
  const byKey = new Map<string, Task[]>();
  for (const t of tasks) if (t.project) (byKey.get(key(t)) ?? byKey.set(key(t), []).get(key(t))!).push(t);
  return [...byKey.values()]
    .filter((ts) => ts.length >= 2 && ts.some((t) => !t.merged))
    .map((ts) => ({ project: ts[0]!.project, date: ts[0]!.date, ids: ts.map((t) => t.id) }));
}

function useMergeActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tasks'] });
  const merge = async (ids: string[], project: string) => {
    try {
      const r = await post<{ tasks: Task[] }>('/api/tasks/merge', { ids, project });
      refresh();
      const before = new Set(ids);
      toast.show({
        tone: 'success',
        message: `已合併「${project}」的 ${ids.length} 個任務`,
        duration: 8000,
        action: {
          label: '復原',
          run: async () => {
            // 只取消這次新加入的（原本就在合併組裡的保持不變）
            const added = r.tasks.filter((t) => before.has(t.id)).map((t) => t.id);
            await post('/api/tasks/unmerge', { ids: added });
            refresh();
          },
        },
      });
    } catch (e) {
      toast.show({ tone: 'error', message: (e as Error).message });
    }
  };
  const unmerge = async (ids: string[], message: string) => {
    try {
      await post('/api/tasks/unmerge', { ids });
      refresh();
      toast.show({ message });
    } catch (e) {
      toast.show({ tone: 'error', message: (e as Error).message });
    }
  };
  return { merge, unmerge };
}

/** 當天可合併的專案：一顆按鈕合併該專案的所有任務 */
export function MergeSuggestions({ tasks, className }: { tasks: readonly Task[]; className?: string }) {
  const { merge } = useMergeActions();
  const [busy, setBusy] = useState<string | null>(null);
  const list = mergeSuggestions(tasks);
  if (!list.length) return null;
  return (
    <span className={cx('flex flex-wrap items-center gap-1.5', className)}>
      {list.map((s) => (
        <Button
          key={s.project}
          size="sm"
          variant="ghost"
          icon={<Layers className="size-3.5" />}
          loading={busy === s.project}
          title={`把 ${s.date} 「${s.project}」的 ${s.ids.length} 個任務合併成一筆；之後在週報與小交流也視為一筆`}
          onClick={async () => {
            setBusy(s.project);
            await merge(s.ids, s.project);
            setBusy(null);
          }}
        >
          合併「{s.project}」{s.ids.length} 個任務
        </Button>
      ))}
    </span>
  );
}

export function MergedGroupCard({ entry, onOpen, selected }: { entry: Extract<TaskEntry, { kind: 'group' }>; onOpen: (id: string) => void; selected?: string | null }) {
  const { unmerge } = useMergeActions();
  const first = entry.tasks.map((t) => t.first_activity).filter(Boolean).sort()[0];
  const last = entry.tasks.map((t) => t.last_activity).filter(Boolean).sort().at(-1);
  return (
    <Card className="p-4" data-merged-group={entry.project}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ProjectTag name={entry.project} icon={<Layers className="size-3" aria-hidden />} />
        <span className="text-ink-3">合併 {entry.tasks.length} 個任務</span>
        <span className="ml-auto flex items-center gap-3">
          {first && (
            <span className="text-ink-3">
              {hhmm(first)}–{hhmm(last)}
            </span>
          )}
          <span className="font-semibold text-ink-2">{fmtHours(entry.hours)}</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<Ungroup className="size-3.5" />}
            title="拆回各自獨立的任務"
            onClick={() => void unmerge(entry.tasks.map((t) => t.id), `已取消合併「${entry.project}」`)}
          >
            取消合併
          </Button>
        </span>
      </div>
      <ol className="mt-2 divide-y divide-line">
        {entry.tasks.map((t) => (
          <li key={t.id} className="py-2.5 first:pt-1 last:pb-0">
            <div
              role="button"
              tabIndex={0}
              data-task-id={t.id}
              aria-label={`${t.ticket ?? ''} ${t.title}`}
              className={cx('group -mx-2 cursor-pointer rounded-ctl px-2 py-1 hover:bg-hover', selected === t.id && 'ring-2 ring-accent')}
              onClick={() => onOpen(t.id)}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}
            >
              <div className="flex items-start gap-2">
                <TicketColumn ticket={t.ticket} />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="wt-task-title text-base font-semibold leading-snug">{displayTitle(t) || <span className="text-ink-3">（無標題）</span>}</span>
                  {t.source === 'jira' ? <Tag title="由 Jira 每日活動同步自動建立">Jira</Tag> : t.manual && <Tag title="不在 Claude Code 中進行的工作">手動</Tag>}
                  <SummaryStatusTag status={t.summary_status} />
                </span>
                <span className="flex shrink-0 items-center gap-1 pt-[3px]">
                  <HoursSource task={t} />
                  <CopyProgressButton task={t} />
                  <button
                    className="rounded-ctl px-1.5 text-xs text-ink-3 opacity-0 hover:bg-card hover:text-ink group-hover:opacity-100 focus:opacity-100"
                    title="把這個任務移出合併"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 只剩兩個時移出一個，另一個也就不成組，一併取消
                      const ids = entry.tasks.length <= 2 ? entry.tasks.map((x) => x.id) : [t.id];
                      void unmerge(ids, `已將「${t.title || t.ticket || '任務'}」移出合併`);
                    }}
                  >
                    移出
                  </button>
                </span>
              </div>
              {t.items.length > 0 ? (
                <ul className="mt-1.5 space-y-1.5 pl-[6.25rem]">
                  {t.items.map((i, k) => (
                    <li key={k} className="flex items-start gap-2 text-sm">
                      <StatusBadge status={i.status} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        {i.text}
                        {i.note && <span className="text-ink-3">（{i.note}）</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1.5 flex items-center justify-between gap-3 pl-[6.25rem] text-sm text-ink-3">
                  <span>{t.manual ? '尚無子項，點擊新增。' : '尚未撰寫摘要。'}</span>
                  {!t.manual && <SummarizeButton task={t} />}
                </div>
              )}
              {t.items.length > 0 && t.summary_status === 'stale' && (
                <div className="mt-2 flex justify-end">
                  <SummarizeButton task={t} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** 任務清單：合併的任務收成一張卡片 */
export function TaskEntries({ entries, onOpen, selected }: { entries: readonly TaskEntry[]; onOpen: (id: string) => void; selected?: string | null }) {
  return (
    <div className="space-y-3">
      {entries.map((e) =>
        e.kind === 'group' ? (
          <MergedGroupCard key={`g:${e.date}:${e.project}`} entry={e} onOpen={onOpen} selected={selected} />
        ) : (
          <TaskCard key={e.task.id} task={e.task} onOpen={() => onOpen(e.task.id)} selected={selected === e.task.id} />
        ),
      )}
    </div>
  );
}
