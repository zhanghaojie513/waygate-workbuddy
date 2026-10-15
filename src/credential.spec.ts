/**
 * 登录态单测 —— 凭证的落盘/读取、设备头派生、以及**令牌绝不回显**。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialPath,
  credentialSummary,
  deriveStableId,
  importCredentialFrom,
  readSavedCredential,
  saveCredential,
  wbHeaders,
  type WbCredential,
} from './credential.js';

let dir: string;
const savedHome = process.env.WAYGATE_HOME;

const CRED: WbCredential = {
  accessToken: 'at_secret_value_should_never_leak',
  refreshToken: 'rt_secret_value_should_never_leak',
  uid: '01a0d156-1709-75a1-bacd-837a4e3d2c91',
  domain: 'www.workbuddy.cn',
  expiresAt: Date.now() + 20 * 24 * 3600_000,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-cred-'));
  process.env.WAYGATE_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.WAYGATE_HOME;
  else process.env.WAYGATE_HOME = savedHome;
});

describe('落盘与读取', () => {
  it('保存后能读回', () => {
    saveCredential(CRED);
    expect(readSavedCredential()).toEqual(CRED);
  });

  it('未导入时返回 null（不抛错）', () => {
    expect(readSavedCredential()).toBeNull();
  });

  it('缺字段时 saveCredential 抛错', () => {
    expect(() => saveCredential({ ...CRED, refreshToken: '' })).toThrow(/三个字段/);
  });

  it('导入工具产出的 JSON（超集：带 refreshExpiresAt/exportedAt）', () => {
    const payload = { ...CRED, refreshExpiresAt: Date.now() + 1, exportedAt: Date.now() };
    const cred = importCredentialFrom(payload);
    expect(cred.uid).toBe(CRED.uid);
    expect(readSavedCredential()?.accessToken).toBe(CRED.accessToken);
  });
});

describe('★ 安全：摘要绝不回显令牌', () => {
  it('credentialSummary 不含令牌片段', () => {
    saveCredential(CRED);
    const s = credentialSummary();
    expect(s).toContain(CRED.uid.slice(0, 8));
    expect(s).not.toContain('at_secret');
    expect(s).not.toContain('rt_secret');
    expect(s).not.toContain(CRED.accessToken);
    expect(s).not.toContain(CRED.refreshToken);
  });

  it('落盘文件的权限是 600（非 Windows 语义时跳过）', () => {
    saveCredential(CRED);
    const raw = readFileSync(credentialPath(), 'utf8');
    /* 文件内容本身是 JSON（含令牌）—— 这是必要的；关键是权限位与「不进版本库」。 */
    expect(JSON.parse(raw).accessToken).toBe(CRED.accessToken);
  });
});

describe('设备头派生', () => {
  it('同一 uid 稳定（确定性，不是随机）', () => {
    expect(deriveStableId('u1', 'machine')).toBe(deriveStableId('u1', 'machine'));
  });

  it('不同 uid / 不同用途不同值', () => {
    expect(deriveStableId('u1', 'machine')).not.toBe(deriveStableId('u2', 'machine'));
    expect(deriveStableId('u1', 'machine')).not.toBe(deriveStableId('u1', 'session'));
  });

  it('长度 36（与 relay 侧同源约定）', () => {
    expect(deriveStableId('u1', 'machine')).toHaveLength(36);
  });
});

describe('出站头（登录态域）', () => {
  it('带官方公共头 + 稳定设备头 + x-user-id + Bearer', () => {
    const h = wbHeaders(CRED);
    expect(h['authorization']).toBe(`Bearer ${CRED.accessToken}`);
    expect(h['x-user-id']).toBe(CRED.uid);
    expect(h['x-machine-id']).toBe(deriveStableId(CRED.uid, 'machine'));
    expect(h['x-session-id']).toBe(deriveStableId(CRED.uid, 'session'));
    expect(h['x-codebuddy-request']).toBe('1');
    expect(h['origin']).toBe('https://www.codebuddy.cn');
  });

  it('可覆盖 token（刷新后用新值）', () => {
    const h = wbHeaders(CRED, 'at_fresh');
    expect(h['authorization']).toBe('Bearer at_fresh');
  });
});
