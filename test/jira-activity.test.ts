import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activityContent,
  candidatesJql,
  cleanCommentText,
  collectActivities,
  contentHash,
  createdJql,
  datesNeedingSync,
  dismissKey,
  eventsHash,
  fallbackItems,
  isUserEdited,
  jiraSessionId,
  keysToFetch,
  mergeNote,
  upsertNoteTickets,
  activityNote,
  myEventsOn,
  newJiraTask,
  NOTE_START,
  planJiraSync,
  readSyncState,
  updateSyncState,
  withJiraItems,
  type JiraActivity,
  type JiraIssueData,
} from '../src/core/jira-activity/index.js';
import { Config } from '../src/core/schema/config.js';
import { reresolveProject } from '../src/core/sync/projects.js';
import { makeEnv, type TestEnv } from './env.js';

const TZ = 'Asia/Taipei';
const ME = '712020:me';
const MARCIA = '606b:marcia';
const config = Config.parse({});

/** 依 TDDA-2015 實際結構簡化 */
const issue2015: JiraIssueData = {
  key: 'TDDA-2015',
  summary: '[發票開立] 審核通過通知信新增會計用 Excel 附件',
  type: '任務',
  status: 'Ready to prod',
  comments: [
    { author_id: MARCIA, author: 'Marcia Chou', created: '2026-11-25T10:04:44.215+0800', body: '後端已部署至測試台，麻煩 <custom data-type="mention">@albertweng</custom> 測試。' },
    {
      author_id: ME,
      author: 'albertweng',
      created: '2026-11-25T14:26:38.564+0800',
      body: '已在測試台測試 test pass\n\nS2609151431001\n\n![](blob:https://media/x?id=1)',
    },
  ],
  histories: [
    { author_id: ME, author: 'albertweng', created: '2026-11-25T14:26:30.999+0800', items: [{ field: 'assignee', from: 'albertweng', to: 'Marcia Chou' }] },
    {
      author_id: ME,
      author: 'albertweng',
      created: '2026-11-25T14:26:27.015+0800',
      items: [{ field: 'status', from: 'Verify in Test Environment', to: 'Ready to prod' }],
    },
    { author_id: MARCIA, author: 'Marcia Chou', created: '2026-11-25T10:04:00.000+0800', items: [{ field: 'status', from: 'In Progress', to: 'Verify in Test Environment' }] },
    { author_id: ME, author: 'albertweng', created: '2026-11-25T11:00:00.000+0800', items: [{ field: 'Rank', from: '', to: 'Ranked higher' }] },
    { author_id: ME, author: 'albertweng', created: '2026-11-24T17:00:00.000+0800', items: [{ field: 'status', from: 'A', to: 'B' }] },
  ],
};

describe('JQL', () => {
  it('候選與建立的 JQL 使用絕對日期與專案代碼', () => {
    const j = candidatesJql('2026-11-25', ['TDDA'], true);
    expect(j).toContain('issue in watchedIssues()');
    expect(j).toContain('status changed BY currentUser() DURING ("2026-11-25 00:00", "2026-11-26 00:00")');
    expect(j).toContain('project in (TDDA)');
    expect(j).toContain('updated >= "2026-11-25 00:00"');
    expect(candidatesJql('2026-11-25', [], false)).not.toContain('watchedIssues');
    expect(createdJql('2026-11-30', ['TDDA'])).toContain('created < "2026-12-01 00:00"');
  });

  it('要讀取的單號：候選＋建立的，去重', () => {
    expect(
      keysToFetch({ account_id: ME, candidates: [{ key: 'tdda-1', summary: '' }, { key: 'TDDA-2', summary: '' }], created_keys: ['TDDA-1', 'TDDA-3'] }),
    ).toEqual(['TDDA-1', 'TDDA-2', 'TDDA-3']);
  });
});

describe('事件過濾', () => {
  it('只留我在當天的事件；排除別人、前一天與忽略欄位；依時間排序', () => {
    const ev = myEventsOn(issue2015, ME, '2026-11-25', TZ, { ignoreFields: ['Rank'], createdKeys: new Set() });
    expect(ev.map((e) => e.kind)).toEqual(['status', 'field', 'comment']);
    expect(ev[0]).toMatchObject({ from: 'Verify in Test Environment', to: 'Ready to prod' });
    expect(ev[1]).toMatchObject({ field: 'assignee', to: 'Marcia Chou' });
    expect(ev[2]!.text).toContain('test pass');
    expect(ev[2]!.text).not.toContain('blob:');
  });

  it('建立的單加上 created 事件', () => {
    const ev = myEventsOn(issue2015, ME, '2026-11-25', TZ, { ignoreFields: [], createdKeys: new Set(['TDDA-2015']) });
    expect(ev[0]!.kind).toBe('created');
    expect(ev.some((e) => e.field === 'Rank')).toBe(true);
  });

  it('沒有我的事件的單不列入活動', () => {
    const other: JiraIssueData = { ...issue2015, key: 'TDDA-9', histories: issue2015.histories.filter((h) => h.author_id === MARCIA), comments: issue2015.comments.slice(0, 1) };
    const acts = collectActivities({
      candidates: { account_id: ME, candidates: [], created_keys: [] },
      issues: [issue2015, other],
      date: '2026-11-25',
      tz: TZ,
      ignoreFields: ['Rank'],
    });
    expect(acts.map((a) => a.ticket)).toEqual(['TDDA-2015']);
  });

  it('留言文字清理', () => {
    expect(cleanCommentText('請 <custom data-type="mention">@albert</custom> 看 [連結](http://x)\n\n\n\n![](blob:1)')).toBe('請 @albert 看 連結');
    expect(cleanCommentText('檔名\\_yyyy')).toBe('檔名_yyyy');
    expect(cleanCommentText('test pass ![](blob:https://media/?id=1&height=309...（已截斷，超過 2000 字）')).toBe('test pass');
  });

  it('同一次變更的多個附件合併成一筆', () => {
    const iss: JiraIssueData = {
      ...issue2015,
      comments: [],
      histories: [
        {
          author_id: ME,
          author: 'me',
          created: '2026-11-25T15:11:00.000+0800',
          items: [
            { field: 'Attachment', from: '', to: 'a.png' },
            { field: 'Attachment', from: '', to: 'b.png' },
            { field: 'status', from: 'A', to: 'B' },
          ],
        },
      ],
    };
    const ev = myEventsOn(iss, ME, '2026-11-25', TZ, { ignoreFields: [], createdKeys: new Set() });
    expect(ev).toEqual([
      { kind: 'status', time: '2026-11-25T15:11:00.000+0800', from: 'A', to: 'B' },
      { kind: 'field', time: '2026-11-25T15:11:00.000+0800', field: 'Attachment', to: 'a.png 等 2 項' },
    ]);
  });
});

const act = (): JiraActivity =>
  collectActivities({
    candidates: { account_id: ME, candidates: [], created_keys: [] },
    issues: [issue2015],
    date: '2026-11-25',
    tz: TZ,
    ignoreFields: ['Rank'],
  })[0]!;

describe('內容整理', () => {
  it('給範本的內容含時間與狀態', () => {
    const c = activityContent(act(), '2026-11-25', TZ);
    expect(c).toContain('TDDA-2015「[發票開立]');
    expect(c).toContain('狀態 Verify in Test Environment → Ready to prod（14:26）');
    expect(c).toContain('test pass');
  });

  it('固定格式子項', () => {
    expect(fallbackItems(act()).map((i) => i.text)).toEqual([
      '狀態 Verify in Test Environment → Ready to prod',
      '留言：已在測試台測試 test pass',
      '更新欄位：assignee',
    ]);
  });

  it('補充說明區塊：附加、取代、移除，保留使用者內容', () => {
    const a = mergeNote('我的筆記', `${NOTE_START}\n舊\n<!-- /worktrail:jira-activity -->`);
    expect(a).toContain('我的筆記');
    const b = mergeNote(a, `${NOTE_START}\n新\n<!-- /worktrail:jira-activity -->`);
    expect(b).toContain('新');
    expect(b).not.toContain('舊');
    expect(mergeNote(b, '')).toBe('我的筆記');
  });
});

describe('Jira 任務', () => {
  it('session_id 固定、預設 0.5 小時、填入子項後記錄指紋', () => {
    expect(jiraSessionId('2026-11-25', 'tdda-2015')).toBe(jiraSessionId('2026-11-25', 'TDDA-2015'));
    expect(jiraSessionId('2026-11-25', 'TDDA-2015')).not.toBe(jiraSessionId('2026-11-26', 'TDDA-2015'));
    const t = withJiraItems(newJiraTask(act(), '2026-11-25', config), act(), fallbackItems(act()), TZ);
    expect(t).toMatchObject({ manual: true, source: 'jira', ticket: 'TDDA-2015', hours: 0.5, hours_source: 'user', summary_status: 'done' });
    expect(t.id).toMatch(/^2026-11-25__TDDA-2015__/);
    expect(t.body).toContain('Jira 活動 TDDA-2015');
    expect(isUserEdited(t)).toBe(false);
    expect(isUserEdited({ ...t, hours: 1 })).toBe(true);
    expect(isUserEdited({ ...t, items: [{ text: '改過', status: 'done' }] })).toBe(true);
    expect(contentHash(t)).toBe(t.jira_sync!.content_hash);
  });

  it('Jira 任務會依單號規則重新判斷專案；一般手動任務不會', () => {
    const cfg = Config.parse({ projects: [{ name: '雲力', match: { ticket_keys: ['TDDA'] } }] });
    const t = newJiraTask(act(), '2026-11-25', cfg);
    expect(reresolveProject(t, cfg, {})?.project).toBe('雲力');
    expect(reresolveProject({ ...t, source: undefined }, cfg, {})).toBeNull();
  });
});

describe('合併規劃', () => {
  const a = act();
  const base = { related_tickets: [] as string[], title: '', items: [], hours: 0, body: '' };
  const jiraTask = () => ({ ...withJiraItems(newJiraTask(a, '2026-11-25', config), a, fallbackItems(a), TZ) });

  it('沒有任務：新增', () => {
    expect(planJiraSync({ date: '2026-11-25', activities: [a], tasks: [], previouslyCreated: [], dismissed: [] })).toEqual([{ kind: 'create', activity: a }]);
  });

  it('同單號已有 Claude 任務（含 related_tickets）：附加到該任務', () => {
    const claude = { ...base, id: 'c1', ticket: 'TDDA-1', related_tickets: ['TDDA-2015'] };
    expect(planJiraSync({ date: '2026-11-25', activities: [a], tasks: [claude], previouslyCreated: [], dismissed: [] })).toEqual([
      { kind: 'append', taskId: 'c1', activities: [a] },
    ]);
  });

  it('Claude 任務後來才出現：未改過的 Jira 任務移除，改附加', () => {
    const own = jiraTask();
    const claude = { ...base, id: 'c1', ticket: 'TDDA-2015' };
    const plan = planJiraSync({ date: '2026-11-25', activities: [a], tasks: [own, claude], previouslyCreated: ['TDDA-2015'], dismissed: [] });
    expect(plan).toContainEqual({ kind: 'remove', taskId: own.id });
    expect(plan).toContainEqual({ kind: 'append', taskId: 'c1', activities: [a] });
  });

  it('既有 Jira 任務：沒變化略過、有變化更新、使用者改過不動', () => {
    const own = jiraTask();
    const p = (t: typeof own, activity = a) => planJiraSync({ date: '2026-11-25', activities: [activity], tasks: [t], previouslyCreated: [], dismissed: [] });
    expect(p(own)).toEqual([{ kind: 'skip', ticket: 'TDDA-2015', reason: 'unchanged' }]);
    const more = { ...a, events: [...a.events, { kind: 'comment' as const, time: '2026-11-25T17:00:00+0800', text: '再補充' }] };
    expect(eventsHash(more)).not.toBe(eventsHash(a));
    expect(p(own, more)).toEqual([{ kind: 'update', activity: more, taskId: own.id }]);
    expect(p({ ...own, hours: 2 }, more)).toEqual([{ kind: 'skip', ticket: 'TDDA-2015', reason: 'edited' }]);
  });

  it('使用者刪除過（先前建立過但檔案不在、或列在 dismissed）：不再建立', () => {
    expect(planJiraSync({ date: '2026-11-25', activities: [a], tasks: [], previouslyCreated: ['TDDA-2015'], dismissed: [] })[0]).toMatchObject({ reason: 'dismissed' });
    expect(
      planJiraSync({ date: '2026-11-25', activities: [a], tasks: [], previouslyCreated: [], dismissed: [dismissKey('2026-11-25', 'TDDA-2015')] })[0],
    ).toMatchObject({ reason: 'dismissed' });
  });
});

describe('排程', () => {
  const at = (iso: string) => Date.parse(iso);
  const cfg = Config.parse({ jira_activity: { lookback_days: 3 } });
  const empty = { schema: 1 as const, days: {}, dismissed: [] };

  it('補抓過去工作日（跳過週末）；今天要到同步時間才跑', () => {
    // 2026-11-25 是週三
    expect(datesNeedingSync({ state: empty, now: at('2026-11-25T10:00:00+08:00'), tz: TZ, config: cfg })).toEqual(['2026-11-23', '2026-11-24']);
    expect(datesNeedingSync({ state: empty, now: at('2026-11-25T18:01:00+08:00'), tz: TZ, config: cfg })).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
    ]);
    // 週一往前三天：週五（週六日略過）
    expect(datesNeedingSync({ state: empty, now: at('2026-11-23T09:00:00+08:00'), tz: TZ, config: cfg })).toEqual(['2026-11-20']);
  });

  it('當天結束後同步過才算完成；當天 18:00 同步過的隔天會再補一次', () => {
    const state = {
      ...empty,
      days: {
        '2026-11-23': { synced_at: '2026-11-24T01:00:00Z', tickets: [], created: [], error: null, failed: [], attempts: 0 },
        '2026-11-24': { synced_at: '2026-11-24T10:00:00Z', tickets: [], created: [], error: null, failed: [], attempts: 0 },
        '2026-11-25': { synced_at: '2026-11-25T10:00:00Z', tickets: [], created: [], error: null, failed: [], attempts: 0 },
      },
    };
    expect(datesNeedingSync({ state, now: at('2026-11-25T19:00:00+08:00'), tz: TZ, config: cfg })).toEqual(['2026-11-24']);
  });

  it('整次失敗一小時內不重試、最多自動重試一次；關閉時不同步', () => {
    const failDay = (attempts: number) => ({ synced_at: '2026-11-25T01:30:00Z', tickets: [], created: [], error: 'x', failed: [], attempts });
    const state = { ...empty, days: { '2026-11-24': failDay(1) } };
    expect(datesNeedingSync({ state, now: at('2026-11-25T10:00:00+08:00'), tz: TZ, config: cfg })).toEqual(['2026-11-23']);
    expect(datesNeedingSync({ state, now: at('2026-11-25T11:00:00+08:00'), tz: TZ, config: cfg })).toEqual(['2026-11-23', '2026-11-24']);
    const capped = { ...empty, days: { '2026-11-24': failDay(2) } };
    expect(datesNeedingSync({ state: capped, now: at('2026-11-25T15:00:00+08:00'), tz: TZ, config: cfg })).toEqual(['2026-11-23']);
    const off = Config.parse({ jira_activity: { enabled: false } });
    expect(datesNeedingSync({ state: empty, now: at('2026-11-25T19:00:00+08:00'), tz: TZ, config: off })).toEqual([]);
  });
});

describe('部分單號讀取失敗', () => {
  it('已在當天結束後同步過：只列出失敗單號，不自動重跑整天', () => {
    const cfg = Config.parse({ jira_activity: { lookback_days: 3 } });
    const state = {
      schema: 1 as const,
      dismissed: [],
      days: {
        '2026-11-23': { synced_at: '2026-11-24T01:00:00Z', tickets: [], created: [], error: null, failed: [], attempts: 0 },
        '2026-11-24': {
          synced_at: '2026-11-25T01:00:00Z',
          tickets: ['TDDA-1'],
          created: [],
          error: null,
          failed: [{ key: 'TDDA-2', error: '輸出中找不到 JSON' }],
          attempts: 0,
        },
      },
    };
    expect(datesNeedingSync({ state, now: Date.parse('2026-11-25T12:00:00+08:00'), tz: TZ, config: cfg })).toEqual([]);
  });

  it('重試部分單號時只更新那幾張單的附註段落', () => {
    const other = { ...act(), ticket: 'TDDA-1', summary: '別張' };
    const body = '我的筆記\n\n' + activityNote([other, act()], TZ);
    const retried = { ...act(), events: [{ kind: 'comment' as const, time: '2026-11-25T17:00:00+0800', text: '重試後的留言' }] };
    const next = upsertNoteTickets(body, [retried], TZ);
    expect(next).toContain('我的筆記');
    expect(next).toContain('Jira 活動 TDDA-1');
    expect(next).toContain('重試後的留言');
    // TDDA-1 段落保留原內容；TDDA-2015 段落換成重試後的內容
    expect(next.match(/test pass/g)).toHaveLength(1);
    expect(next.match(/Jira 活動 TDDA-2015/g)).toHaveLength(1);
  });
});

describe('同步狀態檔', () => {
  let env: TestEnv;
  beforeAll(() => {
    env = makeEnv();
  });
  afterAll(() => env.cleanup());

  it('讀寫與累積建立過的單號', async () => {
    expect(readSyncState(env.paths).days).toEqual({});
    await updateSyncState(env.paths, (s) => {
      s.days['2026-11-25'] = { synced_at: '2026-11-25T10:00:00Z', tickets: ['TDDA-2015'], created: ['TDDA-2015'], error: null, failed: [], attempts: 0 };
      s.dismissed.push(dismissKey('2026-11-25', 'TDDA-1'));
    });
    const s = readSyncState(env.paths);
    expect(s.days['2026-11-25']!.created).toEqual(['TDDA-2015']);
    expect(s.dismissed).toEqual(['2026-11-25:TDDA-1']);
  });
});
