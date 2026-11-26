import { useQueryClient } from '@tanstack/react-query';
import { Bot, ClipboardCopy, Copy, GitCommit, MessageSquareText, Sparkles, User } from 'lucide-react';
import { ApiError, get, post, type Task } from '../lib/api';
import { jiraProgressText, tasksForTicket } from '../lib/jira-copy';
import { useJobs, useRunningJob, useToast } from '../lib/app';
import { fmtHours, hhmm } from '../lib/format';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { Button, Card, Confirm, IconButton, ProjectTag, StatusBadge, Tag, cx } from './ui';

export function SummaryStatusTag({ status }: { status: Task['summary_status'] }) {
  if (status === 'done') return null;
  return (
    <Tag tone={status === 'stale' ? 'warn' : 'default'}>
      {status === 'draft' ? '待補摘要' : '有新進度，可更新摘要'}
    </Tag>
  );
}

export function HoursSource({ task }: { task: Task }) {
  const Icon = task.hours_source === 'user' ? User : task.hours_source === 'ai' ? Bot : null;
  const label = task.hours_source === 'user' ? '手動調整' : task.hours_source === 'ai' ? 'AI 粗估' : '系統計算';
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-3" title={`${label}；系統計算 ${task.active_minutes} 分鐘`}>
      {Icon && <Icon className="size-3" />}
      {fmtHours(task.hours)}
    </span>
  );
}

export function TicketChip({ ticket }: { ticket: string | null }) {
  const toast = useToast();
  if (!ticket) return <span className="text-xs text-ink-3">無單號</span>;
  return (
    <button
      className="group inline-flex items-center gap-1 font-mono text-xs font-semibold text-accent hover:underline"
      title="點擊複製單號"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(ticket);
        toast.show({ message: `已複製 ${ticket}` });
      }}
    >
      {ticket}
      <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
    </button>
  );
}

export function SummarizeButton({ task, size = 'sm' }: { task: Task; size?: 'sm' | 'md' }) {
  const { track } = useJobs();
  const toast = useToast();
  const qc = useQueryClient();
  const running = useRunningJob('summarize', task.id);
  return (
    <Button
      size={size}
      variant={task.summary_status === 'done' ? 'secondary' : 'primary'}
      icon={<Sparkles className="size-3.5" />}
      loading={!!running}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          const r = await post<{ job_id: string }>(`/api/tasks/${encodeURIComponent(task.id)}/summarize`);
          track(r.job_id, (j) => {
            if (j.status === 'done') {
              toast.show({ tone: 'success', message: `已補寫摘要（${j.result?.items ?? 0} 個子項）` });
              void qc.invalidateQueries({ queryKey: ['tasks'] });
            }
          });
        } catch (err) {
          toast.show({ tone: 'error', message: (err as Error).message });
        }
      }}
    >
      {running ? running.progress ?? '撰寫中…' : task.summary_status === 'done' ? '重新產生摘要' : '補寫摘要'}
    </Button>
  );
}

/** 手動任務：經 claude CLI 的 Jira MCP 讀取單號留言，依留言內文日期整理成子項 */
export function JiraSummarizeButton({ task, size = 'sm' }: { task: Task; size?: 'sm' | 'md' }) {
  const { track } = useJobs();
  const toast = useToast();
  const qc = useQueryClient();
  const running = useRunningJob('jira-summarize', task.id);
  const [confirm, setConfirm] = useState(false);
  const run = async (overwrite = false) => {
    try {
      const r = await post<{ job_id: string }>(`/api/tasks/${encodeURIComponent(task.id)}/jira-summarize`, { overwrite });
      track(r.job_id, (j) => {
        if (j.status === 'done') {
          toast.show({ tone: 'success', message: `已從 ${task.ticket} 的 ${j.result?.comments ?? 0} 段留言整理出 ${j.result?.items ?? 0} 個子項` });
          void qc.invalidateQueries({ queryKey: ['tasks'] });
          void qc.invalidateQueries({ queryKey: ['task'] });
        }
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConfirm(true);
      else toast.show({ tone: 'error', message: (err as Error).message });
    }
  };
  return (
    <>
      <Button
        size={size}
        variant="secondary"
        icon={<MessageSquareText className="size-3.5" />}
        loading={!!running}
        disabled={!task.ticket}
        title={task.ticket ? `讀取 ${task.ticket} 中內文日期為 ${task.date} 的留言並整理成子項` : '請先填寫單號'}
        onClick={(e) => {
          e.stopPropagation();
          void run();
        }}
      >
        {running ? running.progress ?? '整理中…' : '從 Jira 整理'}
      </Button>
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title="取代現有子項"
        confirmLabel="整理並取代"
        onConfirm={() => void run(true)}
        message="這個任務已有子項，從 Jira 整理的結果會取代現有子項與補充說明。"
      />
    </>
  );
}

import { displayTitle } from '../lib/task-text';

export { displayTitle };

/** 複製當天這張單（同單號的所有任務）的進度，純文字貼到 Jira 留言。見 DECISIONS.md「複製 Jira 進度」 */
export function useCopyJiraProgress() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (task: Task) => {
    try {
      const day = await qc.fetchQuery({
        queryKey: ['tasks', 'day', task.date],
        queryFn: () => get<{ tasks: Task[] }>(`/api/tasks?from=${task.date}&to=${task.date}`),
        staleTime: 5_000,
      });
      const list = tasksForTicket(day.tasks, task);
      const r = jiraProgressText(list);
      await navigator.clipboard.writeText(r.text);
      const who = task.ticket ?? '這個任務';
      toast.show(
        r.titleOnly
          ? { tone: 'info', message: `${who} 還沒有子項，只複製了標題；可先補寫摘要` }
          : { tone: 'success', message: `已複製 ${who} 的 ${r.items} 個進度${list.length > 1 ? `（合併 ${list.length} 個任務）` : ''}，到 Jira 留言貼上即可` },
      );
    } catch (e) {
      toast.show({ tone: 'error', message: `複製失敗：${(e as Error).message}` });
    }
  };
}

export function CopyProgressButton({ task, label }: { task: Task; label?: boolean }) {
  const copy = useCopyJiraProgress();
  const title = task.ticket ? `複製 ${task.ticket} 今天的進度（純文字，貼到 Jira 留言）` : '複製這個任務的進度（純文字）';
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    void copy(task);
  };
  if (label)
    return (
      <Button variant="secondary" icon={<ClipboardCopy className="size-4" />} title={title} onClick={onClick}>
        複製 Jira 進度
      </Button>
    );
  return (
    <IconButton size="xs" className="opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={title} title={title} onClick={onClick}>
      <ClipboardCopy className="size-3.5" />
    </IconButton>
  );
}

/** 標題前的單號欄；固定寬度讓各任務的標題與子項對齊（子項以 pl-[6.25rem] 縮排對齊標題） */
export function TicketColumn({ ticket }: { ticket: string | null }) {
  return (
    <span className="flex w-[5.75rem] shrink-0 pt-[3px]">
      {ticket ? <TicketChip ticket={ticket} /> : <span className="font-mono text-xs text-ink-3/70">無單號</span>}
    </span>
  );
}

export function TaskCard({ task, onOpen, selected, actions }: { task: Task; onOpen: () => void; selected?: boolean; actions?: ReactNode }) {
  const pending = task.summary_status !== 'done';
  return (
    <Card
      dashed={pending}
      className={cx('wt-task group cursor-pointer p-4 transition-shadow hover:shadow-sm', selected && 'ring-2 ring-accent')}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      tabIndex={0}
      role="button"
      aria-label={`${task.ticket ?? ''} ${task.title}`}
      data-task-id={task.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ProjectTag name={task.project} />
        {task.source === 'jira' ? <Tag title="由 Jira 每日活動同步自動建立">Jira</Tag> : task.manual && <Tag title="不在 Claude Code 中進行的工作">手動</Tag>}
        <SummaryStatusTag status={task.summary_status} />
        <span className="ml-auto flex items-center gap-3">
          {task.commits.length > 0 && (
            <span className="inline-flex items-center gap-1 text-ink-3" title={task.commits.map((c) => `${c.sha} ${c.message}`).join('\n')}>
              <GitCommit className="size-3" />
              {task.commits.length}
            </span>
          )}
          <span className="text-ink-3">
            {hhmm(task.first_activity)}–{hhmm(task.last_activity)}
          </span>
          <HoursSource task={task} />
          <CopyProgressButton task={task} />
        </span>
      </div>
      <div className="mt-2 flex items-start gap-2">
        <TicketColumn ticket={task.ticket} />
        <div className="wt-task-title min-w-0 flex-1 text-base font-semibold leading-snug">{displayTitle(task) || <span className="text-ink-3">（無標題）</span>}</div>
      </div>
      {task.items.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5 pl-[6.25rem]">
          {task.items.map((i, idx) => (
            <li key={idx} className="flex items-start gap-2 text-sm">
              <StatusBadge status={i.status} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                {i.text}
                {i.note && <span className="text-ink-3">（{i.note}）</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : task.manual ? (
        <div className="mt-2 pl-[6.25rem] text-sm text-ink-3">尚無子項，點擊卡片新增。</div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-3 pl-[6.25rem] text-sm text-ink-3">
          <span>尚未撰寫摘要。</span>
          <span className="flex items-center gap-2">
            {actions}
            <SummarizeButton task={task} />
          </span>
        </div>
      )}
      {task.items.length > 0 && task.summary_status === 'stale' && (
        <div className="mt-3 flex justify-end gap-2">
          {actions}
          <SummarizeButton task={task} />
        </div>
      )}
    </Card>
  );
}
