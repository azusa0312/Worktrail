import { existsSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDraft } from '../src/core/prompt/format.js';
import { listPrompts, loadPrompt, validatePrompt } from '../src/core/prompt/index.js';
import { Config } from '../src/core/schema/config.js';
import type { Task } from '../src/core/schema/task.js';
import { buildSummaryGuide } from '../src/core/summary/index.js';
import {
  commentSectionsForDate,
  createdLocalDate,
  formatJiraContent,
  jiraAllowedTools,
  leadingDate,
  sectionsForDate,
} from '../src/core/summary/jira.js';
import { emptyTask } from '../src/core/sync/merge.js';
import { makeEnv, type TestEnv } from './env.js';

describe('leadingDate', () => {
  it('解析各種日期寫法', () => {
    expect(leadingDate('2026/11/16', '2026')?.date).toBe('2026-11-16');
    expect(leadingDate('2026-11-16 進度', '2026')).toEqual({ date: '2026-11-16', rest: '進度' });
    expect(leadingDate('**2026.11.6**', '2026')?.date).toBe('2026-11-06');
    expect(leadingDate('## 11/16（一）', '2026')?.date).toBe('2026-11-16');
    expect(leadingDate('2026年11月16日', '2026')?.date).toBe('2026-11-16');
  });
  it('不是日期的行', () => {
    expect(leadingDate('* 處理防火牆IP => OK', '2026')).toBeNull();
    expect(leadingDate('13/40', '2026')).toBeNull();
    expect(leadingDate('1.2.3 版', '2026')).toBeNull();
  });
});

describe('sectionsForDate', () => {
  const single = '2026/11/16\n\n* 處理防火牆IP => OK  \n  說明 : SRE已經調整完畢，目前測試已經可以打通了，可以正常檢測。\n\n';

  it('整則留言以日期開頭', () => {
    const s = sectionsForDate(single, '2026-11-16');
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('處理防火牆IP => OK');
    expect(s[0]).toContain('SRE已經調整完畢');
    expect(sectionsForDate(single, '2026-11-15')).toEqual([]);
  });

  it('一則留言含多天段落，只取指定日期', () => {
    const body = '2026/11/13\n* 申請防火牆\n\n**2026/11/16**\n* 處理防火牆IP => OK\n* 11/20 要再確認\n\n11/17\n* 跑第一次掃描';
    const s = sectionsForDate(body, '2026-11-16');
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('處理防火牆IP');
    expect(s[0]).toContain('11/20 要再確認');
    expect(s[0]).not.toContain('申請防火牆');
    expect(s[0]).not.toContain('第一次掃描');
  });

  it('第一行日期後直接接文字', () => {
    expect(sectionsForDate('11/16 處理防火牆 OK\n補充說明', '2026-11-16')).toEqual(['處理防火牆 OK\n補充說明']);
  });

  it('沒有日期的留言不採用', () => {
    expect(sectionsForDate('請協助確認防火牆', '2026-11-16')).toEqual([]);
  });

  it('「M/D 進度」日期行（UI 複製 Jira 進度的格式）也能分段', () => {
    const body = '11/17 進度\n- [完成] 規劃 API\n\n11/18 進度\n- [卡住] 取得私鑰（等 SE 提供）';
    expect(sectionsForDate(body, '2026-11-17')).toEqual(['- [完成] 規劃 API']);
    expect(sectionsForDate(body, '2026-11-18')).toEqual(['- [卡住] 取得私鑰（等 SE 提供）']);
  });

  it('只有日期、沒有內容的段落不採用', () => {
    expect(sectionsForDate('2026/11/16\n\n', '2026-11-16')).toEqual([]);
  });
});

const TZ = 'Asia/Taipei';

describe('formatJiraContent', () => {
  it('組出內容並遮蔽密鑰；沒有符合的留言回傳 null', () => {
    const fetched = {
      summary: '[源碼檢測] Fortify',
      comments: [
        { author: 'Leo', created: '2026-11-16T16:33:42.713+0800', body: '2026/11/16\n* 設定 password=abc123 完成' },
        { author: 'SRE', created: '2026-11-16T10:00:00.000+0800', body: '2026/11/15\n* 開防火牆' },
      ],
    };
    const r = formatJiraContent('TDDA-1971', fetched, '2026-11-16', TZ);
    expect(r?.count).toBe(1);
    expect(r?.text).toContain('TDDA-1971「[源碼檢測] Fortify」');
    expect(r?.text).toContain('### Leo 的留言');
    expect(r?.text).not.toContain('abc123');
    expect(r?.text).not.toContain('開防火牆');
    expect(formatJiraContent('TDDA-1971', fetched, '2026-11-17', TZ)).toBeNull();
  });

  it('內文沒有日期行時，依留言建立時間（時區）納入整則留言', () => {
    const fetched = {
      summary: '[發票開立] 審核通過通知信',
      comments: [
        { author: 'Marcia', created: '2026-11-25T10:04:44.215+0800', body: '後端已部署至測試台，麻煩測試。\n\n## 請測試\n* 附件欄位' },
        { author: 'Albert', created: '2026-11-25T14:26:38.564+0800', body: '已在測試台測試 test pass' },
        { author: 'Old', created: '2026-11-24T23:59:00.000+0800', body: '前一天的留言' },
      ],
    };
    const r = formatJiraContent('TDDA-2015', fetched, '2026-11-25', TZ);
    expect(r?.count).toBe(2);
    expect(r?.text).toContain('## 請測試');
    expect(r?.text).toContain('test pass');
    expect(r?.text).not.toContain('前一天');
  });

  it('內文有日期行時以內文為準，不看建立時間', () => {
    const c = { author: 'SRE', created: '2026-11-16T10:00:00.000+0800', body: '2026/11/15\n* 開防火牆' };
    expect(commentSectionsForDate(c, '2026-11-16', TZ)).toEqual([]);
    expect(commentSectionsForDate(c, '2026-11-15', TZ)).toEqual(['* 開防火牆']);
  });

  it('建立時間依設定時區換算日期', () => {
    // UTC 11/24 17:00 = 台北 11/25 01:00
    expect(createdLocalDate('2026-11-24T17:00:00.000+0000', TZ)).toBe('2026-11-25');
    expect(createdLocalDate('2026-11-25T01:00:00.000+0800', 'UTC')).toBe('2026-11-24');
    expect(createdLocalDate('', TZ)).toBeNull();
    expect(createdLocalDate('不是時間', TZ)).toBeNull();
  });

  it('建立時間無法解析或內文空白時不採用', () => {
    expect(commentSectionsForDate({ author: 'x', created: '', body: '沒有日期' }, '2026-11-25', TZ)).toEqual([]);
    expect(commentSectionsForDate({ author: 'x', created: '2026-11-25T10:00:00+0800', body: '  ' }, '2026-11-25', TZ)).toEqual([]);
  });
});

it('jiraAllowedTools 只允許唯讀工具', () => {
  expect(jiraAllowedTools('atlassian-rovo-mcp')).toEqual([
    'mcp__atlassian-rovo-mcp__getAccessibleAtlassianResources',
    'mcp__atlassian-rovo-mcp__getJiraIssue',
  ]);
});

describe('Jira 專用摘要範本（summary/jira）', () => {
  let env: TestEnv;
  beforeAll(() => {
    env = makeEnv();
  });
  afterAll(() => env.cleanup());

  const manual = (): Task => ({
    ...emptyTask('manual-1', '2026-11-16'),
    manual: true,
    ticket: 'TDDA-1971',
    title: '[源碼檢測] Fortify',
    hours: 1,
    hours_source: 'user',
  });

  it('內建範本可載入、通過驗證，安裝時複製一份，設定預設指向它', () => {
    const p = loadPrompt(env.paths, 'summary/jira');
    expect(p.type).toBe('summary');
    expect(validatePrompt('summary/x', p.text).errors).toEqual([]);
    expect(existsSync(env.paths.promptFile('summary', 'jira'))).toBe(true);
    expect(Config.parse({}).summary.jira_prompt).toBe('summary/jira');
  });

  it('舊安裝沒有 jira.md：退回內建內容、列在清單中且可編輯', () => {
    rmSync(env.paths.promptFile('summary', 'jira'));
    const p = loadPrompt(env.paths, 'summary/jira');
    expect(p.builtin).toBe(false);
    expect(p.body).toContain('Jira 留言');
    expect(listPrompts(env.paths).filter((x) => x.ref === 'summary/jira')).toHaveLength(1);
    expect(() => loadPrompt(env.paths, 'summary/nope')).toThrow('找不到範本');
  });

  it('手動任務的 {{draft}} 不列分支、活躍時間與 commit；開發任務照舊', () => {
    const d = formatDraft(manual());
    expect(d).toContain('TDDA-1971');
    expect(d).toContain('使用者填寫');
    expect(d).not.toMatch(/commit|分支|活躍時間/);
    expect(formatDraft({ ...manual(), manual: false })).toContain('今日 commit：無');
  });

  it('套用 jira 範本組出的指示不提 commit', () => {
    const g = buildSummaryGuide({ paths: env.paths, config: Config.parse({}), task: manual(), mode: 'json', prompt: 'summary/jira', transcript: '留言內容', today: '2026-11-16' });
    expect(g.prompt_name).toBe('summary/jira');
    expect(g.guide).toContain('留言內容');
    expect(g.guide).not.toMatch(/commit/i);
  });
});
