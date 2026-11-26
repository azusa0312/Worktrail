/**
 * 手動任務「從 Jira 整理」：由 `claude -p` 透過使用者已連線的 Jira MCP 讀取單號留言，
 * Worktrail 自己不呼叫 Jira API（規格 1.3）。留言依「內文日期」過濾，內文沒寫日期時改看建立時間，詳見 docs/DECISIONS.md。
 */
import { z } from 'zod';
import { localDate } from '../capture/tz.js';
import { maskSecrets } from './index.js';

export const JiraComment = z.object({
  author: z.string().default(''),
  created: z.string().default(''),
  body: z.string().default(''),
});
export type JiraComment = z.infer<typeof JiraComment>;

export const JiraFetchResult = z.object({
  summary: z.string().default(''),
  comments: z.array(JiraComment).default([]),
});
export type JiraFetchResult = z.infer<typeof JiraFetchResult>;

/** `claude -p` 允許使用的 Jira MCP 工具（唯讀） */
export function jiraAllowedTools(server: string): string[] {
  return ['getAccessibleAtlassianResources', 'getJiraIssue'].map((t) => `mcp__${server}__${t}`);
}

export function buildJiraFetchPrompt(ticket: string, server: string): string {
  return `請用 Jira MCP（${server}）讀取 Jira 單號 ${ticket} 的標題與所有留言，不要修改任何 Jira 資料。

步驟：
1. 呼叫 getAccessibleAtlassianResources 取得 cloudId（選有 read:jira-work 權限的站台）。
2. 呼叫 getJiraIssue：issueIdOrKey="${ticket}"、fields=["summary","comment"]、responseContentFormat="markdown"。
   若留言總數（total）多於回傳數量，請繼續取得其餘留言。

只輸出一個 JSON 物件，不要有其他文字或 Markdown 程式碼框：
{"summary": "單號標題", "comments": [{"author": "留言者顯示名稱", "created": "留言建立時間（原樣）", "body": "留言內文（markdown 原文，保留換行，不要改寫或摘要）"}]}
讀取失敗時輸出 {"error": "原因"}。`;
}

const DATE_RE = /^(?:(\d{4})\s*[/\-.年]\s*)?(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?/;

/** 去掉行首的 Markdown 標記（標題、粗體、引用、清單符號） */
function stripMarks(line: string): string {
  return line.trim().replace(/^(?:[#>*_\-+]+\s*)+/, '').replace(/[*_]+$/, '').trim();
}

/** 解析行首日期，回傳 YYYY-MM-DD；年份省略時用 defaultYear */
export function leadingDate(line: string, defaultYear: string): { date: string; rest: string } | null {
  const s = stripMarks(line);
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const year = m[1] ?? defaultYear;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const rest = s.slice(m[0].length);
  // 日期後面緊接數字或分隔符＋數字（例如 11/16/2026、1.2.3 版本號）不算
  if (/^[/\-.]?\d/.test(rest)) return null;
  return { date: `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, rest: rest.trim() };
}

/** 只有日期（可帶星期、「進度」與冒號）的行，視為新段落的開頭；「11/18 進度」是 UI「複製 Jira 進度」的日期行 */
function isDateHeading(rest: string): boolean {
  return /^(?:[（(][^）)]{0,6}[）)])?\s*(?:進度)?\s*[:：]?\s*[*_]*$/.test(rest);
}

/**
 * 取出留言內文中屬於 date 的段落。
 * - 第一個非空行以日期開頭：該行起算一段（可在日期後接文字，例如「11/16 處理防火牆」）。
 * - 其他「只有日期」的行：開始新的一段，直到下一個日期行。
 * - 第一個日期行之前的內容不屬於任何日期。
 */
export function sectionsForDate(body: string, date: string): string[] {
  return dateSections(body, date.slice(0, 4))
    .filter((s) => s.date === date)
    .map((s) => s.lines.join('\n').trim())
    .filter(Boolean);
}

/** 依日期行切出的段落（不過濾）；沒有任何日期行時為空陣列 */
function dateSections(body: string, year: string): { date: string; lines: string[] }[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections: { date: string; lines: string[] }[] = [];
  let firstContent = true;
  for (const line of lines) {
    const isFirst = firstContent && line.trim() !== '';
    if (line.trim()) firstContent = false;
    const ld = line.trim() ? leadingDate(line, year) : null;
    if (ld && (isFirst || isDateHeading(ld.rest))) {
      sections.push({ date: ld.date, lines: ld.rest && !isDateHeading(ld.rest) ? [ld.rest] : [] });
      continue;
    }
    sections.at(-1)?.lines.push(line);
  }
  return sections;
}

/** 留言建立時間（Jira 格式如 2026-11-25T10:04:44.215+0800）在 tz 的日期；無法解析時回傳 null */
export function createdLocalDate(created: string, tz: string): string | null {
  const s = created.trim();
  if (!s) return null;
  const ts = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isFinite(ts)) return localDate(ts, tz);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * 取出留言中屬於 date 的內容：
 * - 內文有日期行：依內文日期分段（內文日期優先，留言建立時間不影響）。
 * - 內文完全沒有日期行：依留言建立時間（tz 時區）判斷，當天建立的整則留言納入。
 */
export function commentSectionsForDate(c: JiraComment, date: string, tz: string): string[] {
  if (dateSections(c.body, date.slice(0, 4)).length) return sectionsForDate(c.body, date);
  const body = c.body.trim();
  return body && createdLocalDate(c.created, tz) === date ? [body] : [];
}

/** 組成給摘要範本的「內容」區塊；沒有符合日期的留言時回傳 null */
export function formatJiraContent(
  ticket: string,
  fetched: JiraFetchResult,
  date: string,
  tz: string,
): { text: string; count: number } | null {
  const parts: string[] = [];
  for (const c of fetched.comments) {
    for (const s of commentSectionsForDate(c, date, tz)) parts.push(`### ${c.author || '（未知）'} 的留言\n${s}`);
  }
  if (!parts.length) return null;
  const head = `以下是 Jira 單號 ${ticket}${fetched.summary ? `「${fetched.summary}」` : ''}中屬於 ${date} 的留言（內文標示該日期，或內文未標日期但在當天建立；不是對話紀錄）。請依這些留言整理當天的工作子項，不要編造留言中沒有的內容。`;
  return { text: maskSecrets(`${head}\n\n${parts.join('\n\n')}`).text, count: parts.length };
}
