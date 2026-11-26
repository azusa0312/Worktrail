/**
 * Jira MCP 設定檢查：設定的 MCP 名稱在 Claude Code 設定（~/.claude.json）中找不到時，
 * 提示使用者從已設定的 MCP 重新選擇，或提供新增指令。今日頁與設定頁共用。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, put } from '../lib/api';
import { useToast } from '../lib/app';
import { Banner, Button, Input, Select } from './ui';

export interface JiraMcpStatus {
  server: string;
  found: boolean;
  unknown: boolean;
  servers: { name: string; scope: 'user' | 'project'; jira: boolean }[];
}

/** 新增 Atlassian 官方 Jira MCP 的指令（使用者層級，所有專案共用） */
export const ADD_JIRA_MCP_COMMAND = 'claude mcp add --scope user atlassian-rovo-mcp -- npx -y mcp-remote https://mcp.atlassian.com/v2/mcp';

export function useJiraMcp() {
  return useQuery({ queryKey: ['jira-mcp'], queryFn: () => get<JiraMcpStatus>('/api/jira-mcp'), refetchInterval: 5 * 60_000 });
}

/** 是否需要提示：確定讀得到 Claude Code 設定、但找不到這個 MCP（claude.ai 連接器不在設定檔中，不提示） */
export function needsJiraMcpSetup(s: JiraMcpStatus | undefined): boolean {
  return !!s && !s.found && !s.unknown && !/^claude[._ ]ai/i.test(s.server);
}

/** 選擇或輸入 Jira MCP 名稱並儲存 */
export function JiraMcpPicker({ status, compact }: { status: JiraMcpStatus; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const jiraLike = status.servers.filter((s) => s.jira);
  const options = jiraLike.length ? jiraLike : status.servers;
  const [value, setValue] = useState(status.found ? status.server : (options[0]?.name ?? ''));
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!custom) setValue(status.found ? status.server : (options[0]?.name ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.server, status.found, status.servers.length]);

  const save = async () => {
    const name = value.trim();
    if (!name) return;
    setSaving(true);
    try {
      const r = await put<JiraMcpStatus>('/api/jira-mcp', { server: name });
      qc.setQueryData(['jira-mcp'], r);
      void qc.invalidateQueries({ queryKey: ['config'] });
      toast.show({ tone: r.found ? 'success' : 'error', message: r.found ? `Jira MCP 已改為 ${name}` : `已儲存，但仍找不到 ${name}` });
    } catch (e) {
      toast.show({ tone: 'error', message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const changed = value.trim() && value.trim() !== status.server;
  return (
    <div className={compact ? 'mt-2 space-y-2' : 'space-y-2'}>
      <div className="flex flex-wrap items-center gap-2">
        {options.length && !custom ? (
          <Select className="font-mono" value={value} onChange={(e) => setValue(e.target.value)}>
            {options.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
                {s.scope === 'project' ? '（專案層級）' : ''}
              </option>
            ))}
          </Select>
        ) : (
          <Input className="w-64 font-mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="atlassian-rovo-mcp" />
        )}
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={!changed && status.found}>
          {status.found && !changed ? '使用中' : '套用'}
        </Button>
        {options.length > 0 && (
          <button type="button" className="text-xs text-ink-3 underline" onClick={() => setCustom((v) => !v)}>
            {custom ? '從清單選擇' : '自行輸入名稱'}
          </button>
        )}
      </div>
      {!jiraLike.length && (
        <div className="text-xs text-ink-3">
          Claude Code 裡還沒有 Jira MCP。在終端機執行下列指令新增並登入 Atlassian，完成後回到這裡按「套用」：
          <code className="mt-1 block select-all break-all rounded bg-card px-2 py-1 text-ink-2 font-mono">{ADD_JIRA_MCP_COMMAND}</code>
        </div>
      )}
    </div>
  );
}

/** 今日頁頂端：找不到 Jira MCP 時的提示 */
export function JiraMcpWarning() {
  const q = useJiraMcp();
  if (!q.data || !needsJiraMcpSetup(q.data)) return null;
  return (
    <Banner tone="danger" className="mb-4">
      <div>
        找不到 Jira MCP「<b className="font-mono">{q.data.server}</b>」，Jira 活動同步、從 Jira 整理、大型工作查詢都無法使用。請重新選擇
        {q.data.servers.some((s) => s.jira) ? '' : '或新增'} Jira MCP（也可以到
        <Link to="/settings#jira" className="mx-1 underline">
          設定 → Jira
        </Link>
        調整）：
      </div>
      <JiraMcpPicker status={q.data} compact />
    </Banner>
  );
}
