/**
 * 呼叫 `claude -p`（規格 5.3、9.6）。以 WORKTRAIL_INTERNAL=1 執行，避免 hook 記錄自己。
 * 工作目錄固定在 `<storage>/.worktrail/claude-runs`，補漏掃描會排除。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ensureDir } from '../storage/fsutil.js';

export function findClaude(configured: string): Promise<string | null> {
  if (configured) return Promise.resolve(existsSync(configured) ? configured : null);
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, ['claude'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Windows 優先選 .exe，其次 .cmd
      const pick = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0];
      resolve(pick ?? null);
    });
  });
}

/** 解析 `claude auth status --json`：回傳 loggedIn；格式不符時為 null */
export function parseAuthStatus(out: string): boolean | null {
  try {
    const j = JSON.parse(out) as { loggedIn?: unknown };
    return typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
  } catch {
    return null;
  }
}

const loginCache = new Map<string, { at: number; value: boolean | null }>();
const LOGIN_CACHE_MS = 5 * 60_000;

/**
 * 是否已登入 Claude 帳號（`claude auth status`）。舊版 Claude Code 沒有這個指令或執行失敗時回傳 null（無法判斷）。
 * 結果快取 5 分鐘：設定頁的健康檢查會定期呼叫，不必每次都啟動 claude。
 */
export async function claudeLoginStatus(claudePath: string, opts: { fresh?: boolean } = {}): Promise<boolean | null> {
  const hit = loginCache.get(claudePath);
  if (!opts.fresh && hit && Date.now() - hit.at < LOGIN_CACHE_MS) return hit.value;
  const args = ['auth', 'status', '--json'];
  const value = await new Promise<boolean | null>((resolve) => {
    const done = (err: Error | null, stdout: string) => resolve(err && !stdout ? null : parseAuthStatus(stdout));
    const o = { windowsHide: true, timeout: 15_000, encoding: 'utf8' as const, env: { ...process.env, WORKTRAIL_INTERNAL: '1' } };
    if (/\.(cmd|bat)$/i.test(claudePath)) execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', shellCommand(claudePath, args)], { ...o, windowsVerbatimArguments: true }, (e, out) => done(e, out));
    else execFile(claudePath, args, o, (e, out) => done(e, out));
  });
  loginCache.set(claudePath, { at: Date.now(), value });
  return value;
}

export interface ClaudeRunOptions {
  claudePath: string;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (chars: number) => void;
  /** 額外的 CLI 參數，例如 ['--allowedTools', ...] */
  extraArgs?: string[];
  /** 'stream-json'：輸出每個事件（含工具原始回傳），由呼叫端用 toolResultsFromStream 解析 */
  outputFormat?: 'text' | 'stream-json';
  /** 額外的環境變數 */
  env?: Record<string, string>;
}

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
  }
}

/** 組成 cmd.exe 的指令字串，含空白或特殊字元的參數加上引號 */
export function shellCommand(cmd: string, args: string[]): string {
  const quote = (a: string) => (/^[\w\-./:\\@=]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  return [`"${cmd}"`, ...args.map(quote)].join(' ');
}

/** 以 stdin 傳入 prompt，回傳文字輸出 */
export function runClaudePrint(opts: ClaudeRunOptions): Promise<string> {
  ensureDir(opts.cwd);
  return new Promise((resolve, reject) => {
    const format = opts.outputFormat ?? 'text';
    const args = ['-p', '--output-format', format, ...(format === 'stream-json' ? ['--verbose'] : []), ...(opts.extraArgs ?? [])];
    const spawnOpts = { cwd: opts.cwd, env: { ...process.env, ...opts.env, WORKTRAIL_INTERNAL: '1' }, windowsHide: true };
    // .cmd 必須經由 cmd.exe 執行；以完整指令字串呼叫（Node 已棄用 shell 模式搭配參數陣列）
    const child = /\.(cmd|bat)$/i.test(opts.claudePath)
      ? spawn(shellCommand(opts.claudePath, args), { ...spawnOpts, shell: true })
      : spawn(opts.claudePath, args, spawnOpts);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClaudeCliError('claude -p 執行逾時'));
    }, opts.timeoutMs ?? 10 * 60_000);
    const onAbort = () => {
      child.kill();
      reject(new ClaudeCliError('已取消'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      opts.onProgress?.(out.length);
    });
    child.stderr.on('data', (d: string) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ClaudeCliError(`無法執行 claude：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return;
      if (code === 0) resolve(out.trim());
      else reject(new ClaudeCliError(`claude -p 結束碼 ${code}`, err.slice(-2000)));
    });
    child.stdin.end(opts.prompt, 'utf8');
  });
}

/**
 * 從 ~/.claude.json 找出某個 MCP 伺服器的設定（使用者層級優先，其次任一專案層級）。
 * 精簡模式用 --strict-mcp-config 只載入這一個伺服器。
 */
export function findMcpServerConfig(claudeJson: unknown, server: string): Record<string, unknown> | null {
  if (!claudeJson || typeof claudeJson !== 'object') return null;
  const j = claudeJson as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  const hit = j.mcpServers?.[server];
  if (hit && typeof hit === 'object') return hit as Record<string, unknown>;
  for (const p of Object.values(j.projects ?? {})) {
    const s = p?.mcpServers?.[server];
    if (s && typeof s === 'object') return s as Record<string, unknown>;
  }
  return null;
}

export interface McpServerInfo {
  name: string;
  scope: 'user' | 'project';
  /** 名稱或指令看起來是 Jira／Atlassian 的 MCP */
  jira: boolean;
}

/** 列出 ~/.claude.json 中設定的 MCP 伺服器（同名只列一次，使用者層級優先），Jira 類的排在前面 */
export function listMcpServers(claudeJson: unknown): McpServerInfo[] {
  if (!claudeJson || typeof claudeJson !== 'object') return [];
  const j = claudeJson as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  const out = new Map<string, McpServerInfo>();
  const add = (name: string, conf: unknown, scope: McpServerInfo['scope']) => {
    if (out.has(name)) return;
    const text = `${name} ${JSON.stringify(conf ?? '')}`.toLowerCase();
    out.set(name, { name, scope, jira: /atlassian|jira/.test(text) });
  };
  for (const [n, c] of Object.entries(j.mcpServers ?? {})) add(n, c, 'user');
  for (const p of Object.values(j.projects ?? {})) for (const [n, c] of Object.entries(p?.mcpServers ?? {})) add(n, c, 'project');
  return [...out.values()].sort((a, b) => Number(b.jira) - Number(a.jira) || a.name.localeCompare(b.name));
}

/** 精簡模式的系統提示：取代 Claude Code 預設的長篇系統提示（只需要照指示呼叫工具或輸出 JSON） */
export const LEAN_SYSTEM_PROMPT =
  'You are a non-interactive helper run by a program. Follow the user instructions exactly. ' +
  'Use only the tools you are told to use, never modify any data, and reply in the requested format only. ' +
  'If a needed tool is not loaded yet, load it with ToolSearch first.';

/**
 * 精簡模式的 CLI 參數：不載入使用者的其他 MCP、skills、CLAUDE.md 等，只留需要的工具。
 * 實測讀取 Jira 單：完整設定每張約 0.28 美元；精簡＋Haiku 約 0.01 美元。
 * - mcpConfigPath：只含所需 MCP 伺服器的設定檔；null 表示不需要 MCP。
 * - allowedTools：允許的 MCP 工具（完整名稱）。
 * - model：空字串時用 Claude Code 預設模型。
 */
export function leanArgs(o: { mcpConfigPath: string | null; allowedTools: readonly string[]; model?: string }): string[] {
  return [
    '--no-session-persistence',
    '--strict-mcp-config',
    ...(o.mcpConfigPath ? ['--mcp-config', o.mcpConfigPath] : []),
    '--disable-slash-commands',
    // MCP 工具是延遲載入的，需要 ToolSearch；不需要 MCP 時關閉所有內建工具
    '--tools',
    o.mcpConfigPath ? 'ToolSearch' : '',
    '--system-prompt',
    LEAN_SYSTEM_PROMPT,
    ...(o.model ? ['--model', o.model] : []),
    ...(o.allowedTools.length ? ['--allowedTools', ...o.allowedTools] : []),
  ];
}

export interface ToolResult {
  /** 工具名稱（例如 mcp__server__getJiraIssue） */
  name: string;
  input: unknown;
  /** 工具回傳的文字；太大時 Claude Code 會存成檔案，這裡是提示文字 */
  text: string;
  /** 回傳太大被存成檔案時的完整路徑（由呼叫端讀取） */
  persistedPath?: string;
  isError: boolean;
}

/**
 * 從 `--output-format stream-json` 的輸出取出工具呼叫的原始回傳。
 * 讓程式直接讀取 MCP 工具的結果，不必請模型轉述（大量留言、changelog 轉述既慢又容易截斷）。
 */
export function toolResultsFromStream(stream: string): ToolResult[] {
  const uses = new Map<string, { name: string; input: unknown }>();
  const out: ToolResult[] = [];
  for (const line of stream.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let msg: { message?: { content?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      continue;
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'tool_use' && typeof b.id === 'string') uses.set(b.id, { name: String(b.name ?? ''), input: b.input });
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const use = uses.get(b.tool_use_id);
      if (!use) continue;
      const c = b.content;
      const text = Array.isArray(c)
        ? (c as { type?: string; text?: string }[]).map((x) => (x.type === 'text' ? (x.text ?? '') : '')).join('')
        : String(c ?? '');
      // 兩種存檔提示：「<persisted-output> … Full output saved to: 路徑」與
      // 「Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to 路徑.」
      const persisted = /saved to:?\s+(\S[^\r\n]*?\.(?:txt|json))(?=\.?\s*$)/m.exec(text);
      out.push({ ...use, text, persistedPath: persisted?.[1], isError: b.is_error === true });
    }
  }
  return out;
}

/** 從模型輸出中取出第一個 JSON 物件（容忍前後文字與程式碼框） */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('輸出中找不到 JSON');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('JSON 不完整');
}
