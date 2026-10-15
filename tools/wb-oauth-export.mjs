/**
 * WorkBuddy OAuth 凭证导出（v1.4.0 第 0 步，一次性导入工具）。
 *
 * 从 WorkBuddy 桌面端的 auth 文件（明文 JSON + $wbEncrypted AES-GCM 信封）解出
 * accessToken / refreshToken，输出 waygate-workbuddy 可导入的明文 JSON（`wb import-oauth`）。
 *
 * 解密方式：借 workbuddy.exe 当 runtime（ELECTRON_RUN_AS_NODE=1）跑一小段 JS，
 * 通过 WorkBuddy 定制 native binding（electron_browser_workbuddy_storage.loggerGet）
 * 拿 atRestSecretKey 派生 AES key。协议与 88lin/workbuddy-auto-signin 的
 * AUTH_HELPER_JS 逐字同源（其注释即逆向证据）。
 *
 * 用法：node tools/wb-oauth-export.mjs [--out wb-oauth.json]
 *   环境变量 WORKBUDDY_EXE 可覆盖 exe 路径。
 * ⚠️ 输出文件等同账号登录态：不进 git、导入后立即删除本地副本。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ---------- 88lin 协议照抄（helper 在 workbuddy.exe 的 node 模式里跑） ----------
   String.raw：源码里的 \0 \/ 等转义序列必须原样传给 -e，不能被本文件解析。 */
const HELPER_JS = String.raw`
'use strict';
const crypto = require('crypto');
const inputLimit = 65536;
const failure = reason => { throw {reason}; };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function base64(value, length) {
  if (typeof value !== 'string' || value.length > inputLimit) failure('INVALID_FORMAT');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length))
    failure('INVALID_FORMAT');
  return bytes;
}
function utf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) failure('INVALID_FORMAT');
  return text;
}
function decode(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== '$wbEncrypted,envelope' || value.$wbEncrypted !== 1)
    failure('UNSUPPORTED_ENVELOPE');
  let envelope;
  try { envelope = JSON.parse(utf8(base64(value.envelope))); }
  catch (e) { failure(e.reason || 'INVALID_FORMAT'); }
  if (!object(envelope) || !Number.isInteger(envelope.suite)) failure('INVALID_FORMAT');
  if (envelope.suite !== 1) failure('UNSUPPORTED_ENVELOPE');
  if (Object.keys(envelope).sort().join(',') !== 'authTag,ciphertext,keyId,nonce,suite' ||
      typeof envelope.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.keyId)) failure('INVALID_FORMAT');
  return {keyId: envelope.keyId, nonce: base64(envelope.nonce, 12),
    tag: base64(envelope.authTag, 16), ciphertext: base64(envelope.ciphertext)};
}
function nativeStorage() {
  try {
    const storage = process._linkedBinding('electron_browser_workbuddy_storage');
    if (typeof storage.loggerGet !== 'function') failure('RUNTIME_UNAVAILABLE');
    return storage;
  } catch (_) { failure('RUNTIME_UNAVAILABLE'); }
}
function decrypt(envelope) {
  let key;
  let plaintext;
  try {
    if (!object(payload) || payload.version !== 1) failure('RUNTIME_UNAVAILABLE');
    let secret;
    try { secret = base64(payload.atRestSecretKey, 32); }
    catch (_) { failure('RUNTIME_UNAVAILABLE'); }
    const empty = secret.every(b => b === 0);
    secret.fill(0);
    if (empty) failure('RUNTIME_UNAVAILABLE');
    key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    payload = null;
    if (crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) !== envelope.keyId)
      failure('KEY_MISMATCH');
    const lp = s => {
      const bytes = Buffer.from(s, 'utf8');
      const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const aad = Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
      lp('WBEV1'), lp('sym-v1'), Buffer.from([0, 0, 0, 1]), lp(envelope.keyId), Buffer.from([2, 0, 0])]);
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.nonce, {authTagLength: 16});
      cipher.setAAD(aad); cipher.setAuthTag(envelope.tag);
      plaintext = Buffer.concat([cipher.update(envelope.ciphertext), cipher.final()]);
    } catch (_) { failure('DECRYPT_FAILED'); }
    const token = utf8(plaintext);
    if (!token.length || token.length > 32768 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token))
      failure('INVALID_FORMAT');
    return token;
  } finally {
    if (key) key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}
let payload = null;
let chunks = [], size = 0;
function reply(value) {
  process.stdout.write(JSON.stringify({version: 1, ...value}), () => process.exit(value.ok ? 0 : 1));
}
process.stdin.on('data', chunk => {
  size += chunk.length;
  if (size > inputLimit) reply({ok: false, reason: 'INVALID_FORMAT'});
  else chunks.push(chunk);
});
process.stdin.on('error', () => reply({ok: false, reason: 'HELPER_PROTOCOL'}));
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(utf8(Buffer.concat(chunks))); chunks = [];
    if (!object(request) || request.version !== 1) failure('HELPER_PROTOCOL');
    if (request.operation === 'probe') {
      nativeStorage();
      if (!crypto.getCiphers().includes('aes-256-gcm')) failure('RUNTIME_UNAVAILABLE');
      reply({ok: true, electron: process.versions.electron || 'unknown'});
    } else if (request.operation === 'decrypt') {
      payload = JSON.parse(nativeStorage().loggerGet());
      reply({ok: true, token: decrypt(decode(request.value))});
    } else failure('HELPER_PROTOCOL');
  } catch (e) {
    const reasons = ['INVALID_FORMAT','UNSUPPORTED_ENVELOPE','RUNTIME_UNAVAILABLE',
      'KEY_MISMATCH','DECRYPT_FAILED','HELPER_PROTOCOL'];
    reply({ok: false, reason: reasons.includes(e.reason) ? e.reason : 'HELPER_PROTOCOL'});
  }
});
`;

/* ---------------- 88lin 协议照抄（JS 里 decrypt 读模块级 payload，上面已对齐） ---------------- */

function findExe() {
  if (process.env.WORKBUDDY_EXE && existsSync(process.env.WORKBUDDY_EXE)) return process.env.WORKBUDDY_EXE;
  const home = homedir();
  const candidates = [
    'C:\\tools\\WorkBuddy\\WorkBuddy.exe',
    join(home, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    'C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('找不到 WorkBuddy.exe（可用 WORKBUDDY_EXE 环境变量指定）');
}

function runHelper(exe, request) {
  return new Promise((resolve, reject) => {
    /* 环境清洗：去掉 NODE_/ELECTRON_/WORKBUDDY_ 前缀再注入 node 模式开关（88lin 同款） */
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(NODE_|ELECTRON_|WORKBUDDY_)/i.test(k)) continue;
      env[k] = v;
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    const proc = spawn(exe, ['-e', HELPER_JS], { env, shell: false, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('helper 超时（30s）'));
    }, 30_000);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const resp = JSON.parse(out.trim().split('\n').pop());
        if (resp.ok) resolve(resp);
        else reject(new Error(`helper 拒绝：${resp.reason}`));
      } catch {
        reject(new Error(`helper 输出不可解析${err ? `（stderr: ${err.slice(0, 200)}）` : ''}`));
      }
    });
    proc.stdin.write(JSON.stringify({ version: 1, ...request }));
    proc.stdin.end();
  });
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : 'wb-oauth.json';
  const authPath = join(
    homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info',
  );
  const raw = JSON.parse(readFileSync(authPath, 'utf8'));
  const exe = findExe();
  console.log(`runtime: ${exe}`);

  /* probe 先行：确认 native binding 可用 */
  const probe = await runHelper(exe, { operation: 'probe' });
  console.log(`probe ok（electron ${probe.electron}）`);

  /* 解密两个信封字段 */
  const at = await runHelper(exe, { operation: 'decrypt', value: raw.auth.accessToken });
  const rt = await runHelper(exe, { operation: 'decrypt', value: raw.auth.refreshToken });
  console.log(`accessToken: ${at.token.slice(0, 10)}…(${at.token.length})`);
  console.log(`refreshToken: ${rt.token.slice(0, 10)}…(${rt.token.length})`);

  const now = Date.now();
  const payload = {
    accessToken: at.token,
    refreshToken: rt.token,
    uid: raw.account.uid,
    uin: raw.account.uin,
    domain: raw.auth.domain,
    /* 桌面端文件只给相对有效期；按导出时刻折算 epoch，导入后由本工具刷新维护 */
    expiresAt: now + (raw.auth.expiresIn ?? 0) * 1000,
    refreshExpiresAt: now + (raw.auth.refreshExpiresIn ?? 0) * 1000,
    exportedAt: now,
  };
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\n已写出 ${outFile}（含账号登录态，导入后删除本地副本）`);
  console.log(`domain=${payload.domain} uid=${payload.uid} access 有效至 ${new Date(payload.expiresAt).toISOString()}`);
}

main().catch((e) => {
  console.error(`导出失败：${e.message}`);
  process.exit(1);
});
