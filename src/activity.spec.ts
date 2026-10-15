/**
 * 活动（签到/任务）单测（fake fetch，不打真上游）。
 * 重点：幂等（已签不发 claim）、前置条件不满足如实 skipped、**绝不伪造行为**。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WbActivity, renderClaim } from './activity.js';
import type { WbCredential } from './credential.js';

const CRED: WbCredential = {
  accessToken: 'at_test',
  refreshToken: 'rt_test',
  uid: 'uid-test-1234',
  expiresAt: Date.now() + 10 * 24 * 3600_000,
};

function makeActivity() {
  return new WbActivity('https://x.example', () => CRED, async () => CRED.accessToken);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panel（只读）', () => {
  it('解析上游字段（下划线 → 驼峰）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      code: 0,
      data: {
        active: true,
        today_checked_in: true,
        streak_days: 13,
        today_credit: 100,
        total_credits: 1300,
        activity_name: 'Buddy应用',
      },
    })));
    const p = await makeActivity().panel();
    expect(p).toEqual({
      active: true,
      todayCheckedIn: true,
      streak: 13,
      todayCredit: 100,
      totalCredits: 1300,
      activityName: 'Buddy应用',
    });
  });

  it('业务码非 0 抛错（带上游 msg）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 40001, msg: 'bad' })));
    await expect(makeActivity().panel()).rejects.toThrow(/bad/);
  });
});

describe('claimSignin', () => {
  it('★ 已签到时不发 claim（幂等）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls.push(String(u));
      return json({ code: 0, data: { active: true, today_checked_in: true, streak_days: 5 } });
    }));
    const r = await makeActivity().claimSignin();
    expect(r.outcome).toBe('already');
    expect(calls.length).toBe(1);
    expect(calls.some((c) => c.includes('daily-checkin'))).toBe(false);
  });

  it('活动未开 → unavailable，也不发 claim', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls.push(String(u));
      return json({ code: 0, data: { active: false } });
    }));
    const r = await makeActivity().claimSignin();
    expect(r.outcome).toBe('unavailable');
    expect(calls.some((c) => c.includes('daily-checkin'))).toBe(false);
  });

  it('可签时发 claim 并回报积分', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('checkin-activity-status')) {
        return json({ code: 0, data: { active: true, today_checked_in: false, streak_days: 4 } });
      }
      return json({ code: 0, data: { credit: 100, streak_days: 5 } });
    }));
    const r = await makeActivity().claimSignin();
    expect(r.outcome).toBe('claimed');
    expect(r.points).toBe(100);
    expect(r.streak).toBe(5);
  });

  it('★ 领取请求必带 x-user-id（上游要求）', async () => {
    let seen: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string> | undefined)?.['x-user-id'];
      if (String(_u).includes('checkin-activity-status')) return json({ code: 0, data: { active: true, today_checked_in: true } });
      return json({ code: 0, data: {} });
    }));
    await makeActivity().claimSignin();
    expect(seen).toBe(CRED.uid);
  });
});

describe('runTasks', () => {
  it('未接的先 accept（body 是复数 task_codes）', async () => {
    let acceptBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/tasks/accept')) {
        acceptBody = JSON.parse(String(init?.body ?? '{}'));
        return json({ code: 0, data: {} });
      }
      return json({ code: 0, data: { tasks: [{ task_code: 't1', title: '任务一', accept_status: 'not_accepted' }] } });
    }));
    const out = await makeActivity().runTasks();
    expect(acceptBody).toEqual({ task_codes: ['t1'] });
    expect(out.some((t) => t.outcome === 'accepted')).toBe(true);
  });

  it('★ 任务未完成 → skipped（如实记录，不当错误、不伪造）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/claim')) return json({ code: 400, msg: 'task not completed' }, 400);
      return json({ code: 0, data: { tasks: [{ task_code: 't1', title: 'T', accept_status: 'accepted', claim_status: 'claimable' }] } });
    }));
    const out = await makeActivity().runTasks();
    expect(out.find((x) => x.code === 't1')?.outcome).toBe('skipped');
  });

  it('已领过 → already', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/claim')) return json({ code: 0, data: { already_claimed: true, credit: 0 } });
      return json({ code: 0, data: { tasks: [{ task_code: 't1', title: 'T', claim_status: 'claimable' }] } });
    }));
    const out = await makeActivity().runTasks();
    expect(out.find((x) => x.code === 't1')?.outcome).toBe('already');
  });
});

describe('redeemStreak', () => {
  it('只对 available 的档发 POST', async () => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/streak')) {
        return json({
          code: 0,
          data: { redemption_status: { tier_7d_status: 'available', tier_14d_status: 'locked', tier_28d_status: 'claimed' } },
        });
      }
      if (init?.method === 'POST') posts.push(url);
      return json({ code: 0, data: {} });
    }));
    const out = await makeActivity().redeemStreak();
    expect(out.find((x) => x.tier === '7d')?.ok).toBe(true);
    expect(out.find((x) => x.tier === '14d')?.ok).toBe(false);
    expect(posts.length).toBe(1);
  });
});

describe('渲染', () => {
  it('renderClaim 三态', () => {
    expect(renderClaim({ outcome: 'claimed', points: 100, streak: 5, message: '签到成功 +100 积分。' })).toContain('✓');
    expect(renderClaim({ outcome: 'already', points: null, streak: 5, message: '今天已经签过了。' })).toContain('·');
    expect(renderClaim({ outcome: 'error', points: null, streak: null, message: '炸了' })).toContain('✗');
  });
});
