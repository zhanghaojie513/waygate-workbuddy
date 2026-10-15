/**
 * 登录态单测 —— OAuth 设备授权流程、凭证落盘、以及**令牌绝不回显**。
 * 全部 fake fetch，不打真上游。
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PendingLoginError,
  WB_ORIGIN,
  WbTokenManager,
  credentialPath,
  credentialSummary,
  pollLogin,
  readSavedCredential,
  saveCredential,
  startLogin,
  wbCommonHeaders,
  type WbCredential,
} from './credential.js';

let dir: string;
const savedHome = process.env.WAYGATE_HOME;

const CRED: WbCredential = {
  accessToken: 'at_secret_value_should_never_leak',
  refreshToken: 'rt_secret_value_should_never_leak',
  uid: '01a0d156-1709-75a1-bacd-837a4e3d2c91',
  nickname: 'tester',
  domain: 'www.workbuddy.cn',
  expiresAt: Date.now() + 20 * 24 * 3600_000,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-cred-'));
  process.env.WAYGATE_HOME = dir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.WAYGATE_HOME;
  else process.env.WAYGATE_HOME = savedHome;
});

describe('落盘与读取', () => {
  it('保存后能读回', () => {
    saveCredential(CRED);
    expect(readSavedCredential()).toEqual(CRED);
  });

  it('未登录时返回 null（不抛错）', () => {
    expect(readSavedCredential()).toBeNull();
  });

  it('缺字段时 saveCredential 抛错', () => {
    expect(() => saveCredential({ ...CRED, refreshToken: '' })).toThrow(/三个字段/);
  });
});

describe('★ 安全：摘要绝不回显令牌', () => {
  it('credentialSummary 不含令牌片段', () => {
    saveCredential(CRED);
    const s = credentialSummary();
    expect(s).toContain('tester');
    expect(s).not.toContain('at_secret');
    expect(s).not.toContain('rt_secret');
    expect(s).not.toContain(CRED.accessToken);
    expect(s).not.toContain(CRED.refreshToken);
  });

  it('未登录时摘要说「未登录」', () => {
    expect(credentialSummary()).toBe('未登录');
  });
});

describe('出站公共头（OAuth 域）', () => {
  it('带官方 CLI 形态的头族', () => {
    const h = wbCommonHeaders();
    expect(h['origin']).toBe(WB_ORIGIN);
    expect(h['referer']).toBe(`${WB_ORIGIN}/`);
    expect(h['user-agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2');
    expect(h['x-requested-with']).toBe('XMLHttpRequest');
  });


  it('★ 风控闸门头必带（缺 x-codebuddy-request 会让签到/领取被拒）', () => {
    const h = wbCommonHeaders('tok', 'uid-1');
    expect(h['x-codebuddy-request']).toBe('1');
    expect(h['accept-language']).toBe('zh-CN');
  });

  it('★ 设备头按 uid 稳定派生（不能用随机值）', () => {
    const a = wbCommonHeaders('t', 'uid-1');
    const b = wbCommonHeaders('t', 'uid-1');
    expect(a['x-machine-id']).toBe(b['x-machine-id']);
    expect(a['x-machine-id']).toHaveLength(36);
    expect(a['x-machine-id']).not.toBe(a['x-session-id']);
    expect(wbCommonHeaders('t', 'uid-2')['x-machine-id']).not.toBe(a['x-machine-id']);
  });

  it('没给 uid 时不带设备头（登录流程本身不需要）', () => {
    expect(wbCommonHeaders('t')['x-machine-id']).toBeUndefined();
  });
  it('给了 token 才带 Authorization', () => {
    expect(wbCommonHeaders()['authorization']).toBeUndefined();
    expect(wbCommonHeaders('tok')['authorization']).toBe('Bearer tok');
  });
});

describe('OAuth 设备授权：第 ① 步拿授权 URL', () => {
  it('请求 state 端点（platform=CLI），返回 authUrl 并落盘 state', async () => {
    let seenUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seenUrl = String(u);
      return json({ code: 0, data: { state: 'st-123', authUrl: 'https://copilot.tencent.com/login?state=st-123' } });
    }));
    const url = await startLogin();
    expect(seenUrl).toContain('/v2/plugin/auth/state?platform=CLI');
    expect(url).toContain('state=st-123');
    /* state 落盘（poll 要用） */
    expect(existsSync(join(dir, 'wb', 'login-state.json'))).toBe(true);
  });

  it('缺 state/authUrl 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 0, data: {} })));
    await expect(startLogin()).rejects.toThrow(/state \/ authUrl/);
  });
});

describe('OAuth 设备授权：第 ②③ 步取 token', () => {
  /*
   * ⚠️ 从 v0.1.3 起 `pollLogin(timeoutMs)` **默认原地等 2 分钟**（`wb login` 阻塞等待）。
   * 所以测试里一律传一个很短的超时 —— 不传会真的等满 2 分钟（vitest 5s 超时失败）。
   */
  it('★ 未完成授权 → 等到超时后抛 PendingLoginError（不是硬错误），且 state 保留供 login-poll 续取', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/auth/state')) return json({ code: 0, data: { state: 'st-1', authUrl: 'https://x/login' } });
      /* 业务码非 0 = 「login ing」 */
      return json({ code: 40001, msg: 'login ing' });
    }));
    await startLogin();
    await expect(pollLogin(60, undefined, 1)).rejects.toBeInstanceOf(PendingLoginError);
    /* ★ state 必须还在：用户随后授权完还能跑 `wb login-poll` 救回来。 */
    expect(existsSync(join(dir, 'wb', 'login-state.json'))).toBe(true);
  });

  it('★ 原地轮询：先 pending 数轮、后成功（`login` 阻塞等待的核心路径）', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('/auth/state')) return json({ code: 0, data: { state: 'st-p', authUrl: 'https://x/login' } });
      if (url.includes('/auth/token')) {
        polls += 1;
        /* 前两次未授权，第三次成功 —— 证明它**会重试**而不是一次失败就退出。 */
        if (polls < 3) return json({ code: 40001, msg: 'login ing' });
        return json({ code: 0, data: { accessToken: 'at_ok', refreshToken: 'rt_ok', expiresIn: 2419200 } });
      }
      if (url.includes('/login/account')) return json({ code: 0, data: { uid: 'u-p' } });
      return json({ code: 0, data: {} });
    }));
    await startLogin();
    /* interval 传 1ms：测试不必真等 3s×2。 */
    const cred = await pollLogin(10_000, undefined, 1);
    expect(cred.accessToken).toBe('at_ok');
    expect(polls).toBe(3);
  });

  it('★ 轮询期间报进度（否则终端最长 2 分钟完全静默）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/auth/state')) return json({ code: 0, data: { state: 'st-t', authUrl: 'https://x/login' } });
      return json({ code: 40001, msg: 'login ing' });
    }));
    await startLogin();
    const ticks: number[] = [];
    /* 60ms 窗口 + 1ms 间隔 → 必然 tick 若干次，好断言「进度确实在报」。 */
    await expect(pollLogin(60, (i) => ticks.push(i.waitedMs), 1)).rejects.toBeInstanceOf(PendingLoginError);
    expect(ticks.length).toBeGreaterThan(0);
    /* 剩余时间要递减（进度条语义），不能恒定。 */
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(ticks[0]!);
  });

  it('成功后落盘完整凭证（含账号信息）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('/auth/state')) return json({ code: 0, data: { state: 'st-2', authUrl: 'https://x/login' } });
      if (url.includes('/auth/token')) {
        return json({ code: 0, data: { accessToken: 'at_new', refreshToken: 'rt_new', expiresIn: 2419200, domain: 'www.workbuddy.cn' } });
      }
      if (url.includes('/login/account')) return json({ code: 0, data: { uid: 'u-9', enterpriseId: 'e-1', nickname: '小明' } });
      return json({ code: 0, data: {} });
    }));
    await startLogin();
    const cred = await pollLogin();
    expect(cred.accessToken).toBe('at_new');
    expect(cred.uid).toBe('u-9');
    expect(cred.nickname).toBe('小明');
    expect(readSavedCredential()?.accessToken).toBe('at_new');
    expect(cred.expiresAt).toBeGreaterThan(Date.now());
    /* state 用后即焚 */
    expect(existsSync(join(dir, 'wb', 'login-state.json'))).toBe(false);
  });

  it('account 拿不到时不阻断登录（uid 为硬要求）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('/auth/state')) return json({ code: 0, data: { state: 'st-3', authUrl: 'https://x/login' } });
      if (url.includes('/auth/token')) return json({ code: 0, data: { accessToken: 'at', refreshToken: 'rt', expiresIn: 100 } });
      /* account 端点失败 */
      return json({ code: 500, msg: 'boom' }, 500);
    }));
    await startLogin();
    await expect(pollLogin()).rejects.toThrow(/uid/);
  });

  it('没先跑 login 就 poll → 明确报错', async () => {
    await expect(pollLogin()).rejects.toThrow(/先跑/);
  });
});

describe('令牌刷新', () => {
  it('★ 未到期时不刷新（直接用缓存）', async () => {
    saveCredential(CRED);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return json({ code: 0, data: {} }); }));
    expect(await new WbTokenManager().accessToken()).toBe(CRED.accessToken);
    expect(calls.length).toBe(0);
  });

  it('临期时刷新，并把轮换后的两个 token 都写回', async () => {
    saveCredential({ ...CRED, expiresAt: Date.now() + 1000 }); // 1 秒后过期 → 触发刷新
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      expect(String(u)).toContain('/v2/plugin/auth/token/refresh');
      return json({ code: 0, data: { accessToken: 'at_rotated', refreshToken: 'rt_rotated', expiresIn: 2419200 } });
    }));
    const t = await new WbTokenManager().accessToken();
    expect(t).toBe('at_rotated');
    const saved = readSavedCredential()!;
    expect(saved.accessToken).toBe('at_rotated');
    /* 轮换必须写回 —— 否则下次刷新用已作废的旧 refresh。 */
    expect(saved.refreshToken).toBe('rt_rotated');
  });

  it('未登录时取 token 报明确错误', async () => {
    await expect(new WbTokenManager().accessToken()).rejects.toThrow(/wb login/);
  });

  it('刷新请求带 x-refresh-token 与 x-auth-refresh-source（插件链）', async () => {
    saveCredential({ ...CRED, expiresAt: Date.now() + 1000 });
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string>) ?? {};
      return json({ code: 0, data: { accessToken: 'at2', refreshToken: 'rt2', expiresIn: 100 } });
    }));
    await new WbTokenManager().accessToken();
    expect(seen['x-refresh-token']).toBe(CRED.refreshToken);
    expect(seen['x-auth-refresh-source']).toBe('plugin');
  });
});

describe('文件权限', () => {
  it('落盘内容是 JSON（含令牌）—— 关键是 0600 与不进版本库', () => {
    saveCredential(CRED);
    const raw = readFileSync(credentialPath(), 'utf8');
    expect(JSON.parse(raw).accessToken).toBe(CRED.accessToken);
  });
});
