/**
 * WorkBuddy 凭证：**官方 OAuth 设备授权**（`wb login`）。
 *
 * ## 为什么走 OAuth，而不是读本机登录态
 * WorkBuddy 桌面端的本机登录态（`%LOCALAPPDATA%\CodeBuddyExtension\...\*.info`）自某版本起
 * 做了**字段级加密**（AES-256-GCM + 机器绑定密钥，密钥只在客户端运行时存在）。
 * 早期社区反代项目（workbuddy2openai 等）面对的是明文，现在这条路已失效 ——
 * 绕过它意味着对抗厂商主动设置的安全控制。
 *
 * 而官方给插件/CLI 留了**正规登录通道**，走它就没有上述问题，且流程简单得多：
 *
 *   POST /v2/plugin/auth/state?platform=CLI          → { state, authUrl }
 *   （浏览器打开 authUrl 完成登录）
 *   GET  /v2/plugin/auth/token?state=<state>         → { accessToken, refreshToken, expiresIn, domain }
 *   GET  /v2/plugin/login/account?state=<state>      → { uid, enterpriseId, nickname }
 *
 * 无 PKCE（state 由服务端签发）。本模块实现这个流程，并维护 token 生命周期。
 *
 * ## 令牌生命周期
 *   · access 寿命由 `expiresIn` 给出；提前 2 天自动刷新
 *   · refresh 走 `POST /v2/plugin/auth/token/refresh`（插件刷新链），两 token 一起轮换 → 必须写回
 *   · 实测不互踢：刷新后旧 access 仍有效
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandDir } from 'waygate-core';
import { CredentialError, UpstreamError } from './errors.js';
/** 提前刷新余量：2 天。 */
export const WB_REFRESH_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
/**
 * `login` 原地等待授权的时长（用户口径 2 分钟）；超时后保留 state，
 * 提示用户改用 `wb login-poll` 续取。
 */
export const LOGIN_WAIT_MS = 120_000;
/** 轮询间隔（WorkBuddy 的 state 端点未给建议间隔，取 3s —— 与 MiniMax 设备授权同节奏）。 */
const LOGIN_POLL_INTERVAL_MS = 3000;
/** CN 域（国际版 base 为 https://www.workbuddy.ai，Origin 同域）。 */
export const WB_BASE_URL = 'https://copilot.tencent.com';
export const WB_ORIGIN = 'https://www.codebuddy.cn';
/** 登录/刷新用的客户端标识（与官方 CLI 插件同形）。 */
export const WB_CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const REQUEST_TIMEOUT_MS = 30_000;
/** 凭证落盘位置（`~/.waygate/wb/credential.json`）。 */
export function credentialPath() {
    return join(commandDir('wb'), 'credential.json');
}
export function readSavedCredential() {
    const p = credentialPath();
    if (!existsSync(p))
        return null;
    try {
        const c = JSON.parse(readFileSync(p, 'utf8'));
        return c.accessToken && c.refreshToken && c.uid ? c : null;
    }
    catch {
        return null;
    }
}
/** 落盘（0600）。token 轮换后也调用本函数写回。 */
export function saveCredential(cred) {
    if (!cred.accessToken || !cred.refreshToken || !cred.uid) {
        throw new CredentialError('凭证需要 accessToken / refreshToken / uid 三个字段');
    }
    const p = credentialPath();
    writeFileSync(p, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
    try {
        chmodSync(p, 0o600);
    }
    catch {
        /* Windows 语义有限 */
    }
    return p;
}
/**
 * 登录态域通用出站头（OAuth 流程与活动接口共用）。
 *
 * ⚠️ 这些头不是可有可无的装饰 —— `x-codebuddy-request` 是**风控闸门头**
 * （实测：缺它时签到/领取类端点被拒），`x-machine-id`/`x-session-id` 是设备标识
 * （官方客户端有，缺失可能被当作异常来源）。三者缺一不可。
 */
export function wbCommonHeaders(token, uid) {
    return {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
        origin: WB_ORIGIN,
        referer: `${WB_ORIGIN}/`,
        'user-agent': WB_CLIENT_UA,
        'x-codebuddy-request': '1',
        'accept-language': 'zh-CN',
        /* 设备头：官方客户端用真实机器标识；我们没有，按 uid 做**确定性派生**
           （不能用随机值——每次请求换一个机器 ID 像「同账号在多台设备间跳」，反而触发风控）。 */
        ...(uid
            ? {
                'x-machine-id': deriveStableId(uid, 'machine'),
                'x-session-id': deriveStableId(uid, 'session'),
            }
            : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
}
/** 按 uid 派生稳定设备标识（OAuth 登录态没有真实机器 ID，用确定性派生代替随机）。 */
export function deriveStableId(uid, purpose) {
    return createHash('sha256').update(`wb:${purpose}:${uid}`).digest('hex').slice(0, 36);
}
async function postJson(url, body, token) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: wbCommonHeaders(token),
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }
    catch (err) {
        throw new UpstreamError(`上游不可达（${url}）：${err.message}`);
    }
    const text = await res.text().catch(() => '');
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    }
    catch {
        throw new UpstreamError(`${url} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
        throw new UpstreamError(`${url} 失败（HTTP ${res.status}）：${String(parsed.msg ?? text).slice(0, 200)}`);
    }
    if (typeof parsed.code === 'number' && parsed.code !== 0) {
        throw new UpstreamError(`${url} 失败（业务码 ${parsed.code}）：${String(parsed.msg ?? '')}`);
    }
    return (parsed.data ?? {});
}
async function getJson(url, token) {
    let res;
    try {
        res = await fetch(url, { headers: wbCommonHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    catch (err) {
        throw new UpstreamError(`上游不可达（${url}）：${err.message}`);
    }
    const text = await res.text().catch(() => '');
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    }
    catch {
        throw new UpstreamError(`${url} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
        const detail = String(parsed.msg ?? '').trim();
        throw new UpstreamError(`${url} 失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
    }
    if (typeof parsed.code === 'number' && parsed.code !== 0) {
        /* 「登录未完成」是 pending 的正常表达，调用方需要区分它。 */
        throw new PendingLoginError(`${url} 业务码 ${parsed.code}：${String(parsed.msg ?? '')}`);
    }
    return (parsed.data ?? {});
}
/** 登录尚未完成（poll 时的正常待机状态，不是错误）。 */
export class PendingLoginError extends Error {
    name = 'PendingLoginError';
    constructor(message) {
        super(message);
    }
}
/* ─────────────────────── OAuth 设备授权流程 ─────────────────────── */
/** 第 ① 步：拿授权 URL（用户在浏览器打开完成登录）。 */
export async function startLogin(baseUrl = WB_BASE_URL) {
    const data = await postJson(`${baseUrl}/v2/plugin/auth/state?platform=CLI`, {});
    if (typeof data.state !== 'string' || !data.state || typeof data.authUrl !== 'string' || !data.authUrl) {
        throw new UpstreamError('登录接口未返回 state / authUrl');
    }
    /* state 是后续取 token 的凭据，落盘 0600（登录完成后删除）。 */
    const p = join(commandDir('wb'), 'login-state.json');
    writeFileSync(p, JSON.stringify({ state: data.state, baseUrl }, null, 2) + '\n', { mode: 0o600 });
    return data.authUrl;
}
/**
 * 第 ②③ 步：取 token + 账号信息（授权完成后调用）。
 *
 * **原地轮询**：WorkBuddy 未完成授权时返回**业务码非 0**（不是 HTTP 错误），
 * `getJson` 把它包成 `PendingLoginError` —— 这里捕获它并继续等，直到：
 *   · 拿到 token（返回凭证）；或
 *   · 等满 `timeoutMs`（抛 `PendingLoginError`，**state 保留**，用户可跑 `login-poll` 续取）；或
 *   · 遇到真错误（state 损坏 / 非 pending 的失败）→ 直接抛。
 *
 * `onTick` 每轮失败调一次：让终端能显示「等待中…」，否则用户面对的是最长 2 分钟的
 * **完全静默**，分不清是在等、还是已经卡死。
 * `intervalMs` 仅测试需要（默认 3s）；生产走默认值。
 */
export async function pollLogin(timeoutMs = LOGIN_WAIT_MS, onTick, intervalMs = LOGIN_POLL_INTERVAL_MS) {
    const statePath = join(commandDir('wb'), 'login-state.json');
    if (!existsSync(statePath)) {
        throw new CredentialError('没有待完成的登录 —— 先跑 `wb login`');
    }
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    const state = typeof saved.state === 'string' ? saved.state : '';
    if (!state)
        throw new CredentialError('登录 state 文件损坏 —— 重新跑 `wb login`');
    const base = typeof saved.baseUrl === 'string' && saved.baseUrl ? saved.baseUrl : WB_BASE_URL;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    for (;;) {
        try {
            return await fetchCredential(base, state, statePath);
        }
        catch (err) {
            /* 「登录未完成」是正常待机态，不是失败 —— 继续等。 */
            if (!(err instanceof PendingLoginError))
                throw err;
            if (Date.now() >= deadline)
                throw err;
            onTick?.({ waitedMs: Date.now() - startedAt, remainingMs: Math.max(0, deadline - Date.now()) });
            await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
        }
    }
}
/** 打一次 token + account 端点并落盘（`PendingLoginError` 由调用方判为待机态）。 */
async function fetchCredential(base, state, statePath) {
    const tok = await getJson(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`);
    if (typeof tok.accessToken !== 'string' || !tok.accessToken) {
        throw new CredentialError('token 端点未返回 accessToken');
    }
    /* 账号信息是锦上添花：拿不到也不该让整次登录失败（uid 可从别处补）。 */
    let uid = '';
    let enterpriseId;
    let nickname;
    try {
        const acct = await getJson(`${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, tok.accessToken);
        uid = typeof acct.uid === 'string' ? acct.uid : '';
        enterpriseId = typeof acct.enterpriseId === 'string' ? acct.enterpriseId : undefined;
        nickname = typeof acct.nickname === 'string' ? acct.nickname : undefined;
    }
    catch {
        /* 忽略：下面若 uid 仍空则报错 */
    }
    if (!uid)
        throw new CredentialError('未能取到账号 uid —— 请重试登录');
    const cred = {
        accessToken: tok.accessToken,
        refreshToken: typeof tok.refreshToken === 'string' ? tok.refreshToken : '',
        uid,
        enterpriseId,
        nickname,
        domain: typeof tok.domain === 'string' ? tok.domain : undefined,
        expiresAt: typeof tok.expiresIn === 'number' && tok.expiresIn > 0 ? Date.now() + tok.expiresIn * 1000 : undefined,
    };
    saveCredential(cred);
    try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(statePath);
    }
    catch {
        /* state 清理失败不影响登录结果 */
    }
    return cred;
}
/* ─────────────────────── token 生命周期 ─────────────────────── */
/**
 * token 管理器：缓存 access token，临期自动刷新（并发去重），轮换时写回。
 */
export class WbTokenManager {
    baseUrl;
    onLog;
    cached = null;
    inFlight = null;
    constructor(baseUrl = WB_BASE_URL, onLog = () => { }) {
        this.baseUrl = baseUrl;
        this.onLog = onLog;
    }
    async accessToken() {
        const cred = this.cached ?? readSavedCredential();
        if (!cred) {
            throw new CredentialError('未登录 —— 先跑 `wb login`（浏览器授权一次）');
        }
        this.cached = cred;
        if (cred.expiresAt && Date.now() + WB_REFRESH_AHEAD_MS < cred.expiresAt)
            return cred.accessToken;
        if (this.inFlight)
            return this.inFlight;
        const job = this.refresh(cred).finally(() => {
            this.inFlight = null;
        });
        this.inFlight = job;
        return job;
    }
    /** 立即刷新（不看余量）。doctor 体检用。 */
    async forceRefresh() {
        const cred = this.cached ?? readSavedCredential();
        if (!cred)
            throw new CredentialError('未登录。');
        return this.refresh(cred);
    }
    async refresh(cred) {
        const headers = wbCommonHeaders();
        delete headers['content-type'];
        headers['x-refresh-token'] = cred.refreshToken;
        headers['x-auth-refresh-source'] = 'plugin';
        let res;
        try {
            res = await fetch(`${this.baseUrl}/v2/plugin/auth/token/refresh`, {
                method: 'POST',
                headers,
                body: '{}',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        }
        catch (err) {
            throw new UpstreamError(`刷新登录态失败（上游不可达）：${err.message}`);
        }
        const text = await res.text().catch(() => '');
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch {
            throw new UpstreamError(`刷新登录态返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
        }
        if (!res.ok) {
            throw new CredentialError(`刷新登录态被拒（HTTP ${res.status}）：${String(parsed.msg ?? text).slice(0, 200)}`);
        }
        if (typeof parsed.code === 'number' && parsed.code !== 0) {
            throw new CredentialError(`刷新登录态失败（业务码 ${parsed.code}）：${String(parsed.msg ?? '')}`);
        }
        const data = (parsed.data ?? {});
        if (typeof data.accessToken !== 'string' || !data.accessToken) {
            throw new CredentialError('刷新登录态的响应缺少 accessToken');
        }
        const next = {
            ...cred,
            accessToken: data.accessToken,
            /* 两 token 一起轮换（实测）：新 refresh 必须覆盖，否则下次刷新用已作废的旧值。 */
            refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : cred.refreshToken,
            domain: typeof data.domain === 'string' && data.domain ? data.domain : cred.domain,
            expiresAt: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : undefined,
        };
        this.cached = next;
        saveCredential(next);
        this.onLog(`登录态已刷新（有效至 ${next.expiresAt ? new Date(next.expiresAt).toISOString() : '未知'}）`);
        return next.accessToken;
    }
}
/** 供 doctor / 启动输出展示的摘要（**绝不回显令牌**）。 */
export function credentialSummary() {
    const cred = readSavedCredential();
    if (!cred)
        return '未登录';
    const left = cred.expiresAt ? Math.round((cred.expiresAt - Date.now()) / 3600_000) : null;
    const who = cred.nickname ? `${cred.nickname}` : `uid ${cred.uid.slice(0, 8)}…`;
    return left !== null ? `已登录：${who}（登录态约剩 ${left} 小时）` : `已登录：${who}（到期未知）`;
}
