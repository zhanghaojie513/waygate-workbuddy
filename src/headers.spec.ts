/**
 * 出站指纹单测 —— 本项目**最不能出错**的一块：
 *   · 指纹是否与官方桌面端实测值一致（少一个头就归因失败 / 被风控）
 *   · 本机密钥是否**绝不外泄**（allowlist 的核心不变量）
 */

import { describe, expect, it } from 'vitest';
import {
  NEVER_FORWARD,
  buildUpstreamHeaders,
  expandWorkBuddyUA,
  injectWorkBuddyFingerprint,
  parseWorkBuddyVersion,
} from './headers.js';

describe('UA 展开', () => {
  it('把 WorkBuddy/<ver> 展开为官方三段式', () => {
    expect(expandWorkBuddyUA('WorkBuddy/5.8.0')).toBe('WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1');
  });

  it('已含 CLI 段的自定义 UA 原样返回（用户显式配置优先）', () => {
    const custom = 'WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/1.2.3';
    expect(expandWorkBuddyUA(custom)).toBe(custom);
  });

  it('非 WorkBuddy 形态的 UA 原样返回', () => {
    expect(expandWorkBuddyUA('curl/8.0')).toBe('curl/8.0');
  });

  it('版本解析：取不出时回落内置默认', () => {
    expect(parseWorkBuddyVersion('WorkBuddy/5.8.0')).toBe('5.8.0');
    expect(parseWorkBuddyVersion('WorkBuddy AI/6.1.2')).toBe('6.1.2');
    expect(parseWorkBuddyVersion('whatever')).toBe('5.8.0');
  });
});

describe('★ 指纹注入（与官方实测值逐项对齐）', () => {
  it('注入官方头族，值必须与实测一致', () => {
    const h: Record<string, string> = {};
    injectWorkBuddyFingerprint(h, '5.8.0');
    /* 这些值是逆向官方 app.asar + 本机 product-config 实测得到的，不是猜的。 */
    expect(h['x-agent-purpose']).toBe('conversation');
    expect(h['x-agent-intent']).toBe('craft');
    expect(h['x-ide-name']).toBe('WorkBuddy');
    expect(h['x-ide-type']).toBe('WorkBuddy');
    expect(h['x-ide-version']).toBe('5.8.0');
    expect(h['x-product']).toBe('SaaS'); // ★ deploymentType，不是 WorkBuddy
    expect(h['x-private-data']).toBe('true');
    expect(h['x-codebuddy-request']).toBe('1');
    expect(h['origin']).toBe('https://www.codebuddy.cn');
    expect(h['referer']).toBe('https://www.codebuddy.cn/');
    expect(h['x-requested-with']).toBe('XMLHttpRequest');
    expect(h['accept-language']).toBe('zh-CN');
  });

  it('已有 accept-language 时不覆盖（入站优先）', () => {
    const h: Record<string, string> = { 'accept-language': 'en-US' };
    injectWorkBuddyFingerprint(h, '5.8.0');
    expect(h['accept-language']).toBe('en-US');
  });
});

describe('★ 出站头构造：安全不变量', () => {
  const fakeKey = 'ck_1234567890abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  it('强制注入上游密钥，且覆盖入站残留', () => {
    const { headers } = buildUpstreamHeaders(
      { authorization: 'Bearer sk-inbound-should-be-dropped' },
      fakeKey,
      true,
      'WorkBuddy/5.8.0',
    );
    expect(headers['authorization']).toBe(`Bearer ${fakeKey}`);
  });

  it('★ 敏感头永不出站（allowlist 的核心不变量）', () => {
    const { headers, leaked } = buildUpstreamHeaders(
      {
        cookie: 'session=secret',
        'x-api-key': 'secret-api-key',
        'set-cookie': 'a=b',
        'proxy-authorization': 'Basic x',
        'x-inbound-key': 'sk-wb-inbound-secret',
        /* 以下这些是允许透传的 */
        'content-type': 'application/json',
        accept: 'application/json',
      },
      fakeKey,
      true,
      'WorkBuddy/5.8.0',
    );
    for (const h of NEVER_FORWARD) {
      if (h === 'authorization') continue; // 这里是上游密钥，允许
      expect(headers[h]).toBeUndefined();
    }
    expect(leaked).toEqual([]);
    /* 允许透传的三个确实带上了 */
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('application/json');
  });

  it('allowlist 外的一律不带（不是 blocklist）', () => {
    const { headers } = buildUpstreamHeaders(
      { 'x-custom-tracking': 'value', 'x-forwarded-for': '1.2.3.4' },
      fakeKey,
      true,
      'WorkBuddy/5.8.0',
    );
    expect(headers['x-custom-tracking']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
  });

  it('spoof=false 时不注入指纹，但补默认 UA', () => {
    const { headers } = buildUpstreamHeaders({}, fakeKey, false, '');
    expect(headers['x-product']).toBeUndefined();
    expect(headers['user-agent']).toBe('WorkBuddy/5.8.0');
  });

  it('spoof=true 时 UA 是指纹基准展开后的三段式', () => {
    const { headers } = buildUpstreamHeaders({}, fakeKey, true, 'WorkBuddy/5.8.0');
    expect(headers['user-agent']).toBe('WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1');
    expect(headers['x-ide-version']).toBe('5.8.0');
  });
});
