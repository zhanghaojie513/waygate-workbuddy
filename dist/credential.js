/**
 * WorkBuddy 桌面端登录态（OAuth）—— 本项目唯一的凭证来源。
 *
 * ## 为什么用桌面端登录态，而不是 API 密钥（`ck_`）
 * 实测（2026-10）：**桌面端 OAuth accessToken 能直接用于聊天、模型清单、签到状态**，
 * 三条链路全部 HTTP 200 —— 既然登录态够用，就不必让用户去后台自签一个 `ck_` 密钥再粘过来。
 * 这与同家族的 waygate-qoder / waygate-mmcode 也一致：**都读本机客户端登录态**。
 *
 * ## 登录态从哪来（两种，按优先级）
 *   ① 本工具自己保存的 `~/.waygate/wb/oauth.json`（首次用 `wb login` 从客户端导入）
 *   ② 客户端原始文件：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
 *
 * 客户端文件里 `accessToken` / `refreshToken` 是**加密信封**（AES-256-GCM，密钥绑定机器）——
 * 解密需要借客户端运行时（见 `tools/wb-oauth-export.mjs`），故 `wb login` 会在需要时
 * 提示用户先跑导出工具；导出后的明文 JSON 本工具可长期维护（自动刷新 + 轮换写回）。
 *
 * ## 令牌生命周期
 *   · access 实测约 **28 天**；提前 2 天自动刷新
 *   · refresh 时**两个 token 一起轮换**，必须写回（否则下次刷新用已作废的旧值）
 *   · 实测**不互踢**：刷新后旧 access 复打仍 200（官方插件刷新链，多会话共存）
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandDir } from 'waygate-core';
import { CredentialError, UpstreamError } from './errors.js';
import { WORKBUDDY_ORIGIN, WORKBUDDY_CLI_VERSION, expandWorkBuddyUA } from './headers.js';
/** 提前刷新余量：2 天（access 寿命实测约 28 天）。 */
export const WB_REFRESH_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
const UA = expandWorkBuddyUA('WorkBuddy/5.8.0');
/** 本工具保存的凭证位置。 */
export function credentialPath() {
    return join(commandDir('wb'), 'credential.json');
}
/** 客户端原始登录态文件（加密信封，仅供参考/提示用）。 */
export function clientAuthFile() {
    const override = (process.env.WB_CLIENT_AUTH_FILE ?? '').trim();
    if (override)
        return override;
    const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), 'AppData', 'Local');
    return join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
}
/** 取本工具已保存的凭证明文（无则 null）。 */
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
/** 落盘（0600）。refresh token 轮换后也要调用本函数写回。 */
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
/** 从导出工具的输出导入（`wb login <文件>` 或 `wb import-credential <文件>`）。 */
export function importCredentialFrom(payload) {
    const cred = {
        accessToken: String(payload.accessToken ?? ''),
        refreshToken: String(payload.refreshToken ?? ''),
        uid: String(payload.uid ?? ''),
        uin: payload.uin ? String(payload.uin) : undefined,
        domain: payload.domain ? String(payload.domain) : undefined,
        expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : undefined,
    };
    saveCredential(cred);
    return cred;
}
/**
 * 按 uid 派生**稳定**设备头。
 *
 * 官方客户端用真实机器标识；本工具没有，但不能用随机值 —— 每次请求换一个机器 ID
 * 会像「同一账号在多台设备上来回跳」，反而触发风控。故按 uid 做确定性派生。
 */
export function deriveStableId(uid, purpose) {
    return createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36);
}
/** 出站请求头（登录态域）：官方桌面端公共头 + 稳定设备头 + Bearer。 */
export function wbHeaders(cred, token) {
    return {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        origin: WORKBUDDY_ORIGIN,
        referer: `${WORKBUDDY_ORIGIN}/`,
        'user-agent': UA,
        'x-codebuddy-request': '1',
        'accept-language': 'zh-CN',
        'x-machine-id': deriveStableId(cred.uid, 'machine'),
        'x-session-id': deriveStableId(cred.uid, 'session'),
        /* 领取族需要，值不校验但必须非空。 */
        'x-user-id': cred.uid,
        authorization: `Bearer ${token ?? cred.accessToken}`,
    };
}
/**
 * token 管理器：缓存 access token，临期自动刷新（并发去重），轮换时写回。
 */
export class WbTokenManager {
    baseUrl;
    onLog;
    cached = null;
    inFlight = null;
    constructor(baseUrl, onLog = () => { }) {
        this.baseUrl = baseUrl;
        this.onLog = onLog;
    }
    /** 取可用 access token（必要时刷新并写回）。 */
    async accessToken() {
        const cred = this.cached ?? readSavedCredential();
        if (!cred) {
            throw new CredentialError('未导入 WorkBuddy 登录态 —— 先跑 `wb login`（用 tools/wb-oauth-export.mjs 从客户端导出后导入）');
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
            throw new CredentialError('未导入 WorkBuddy 登录态。');
        return this.refresh(cred);
    }
    async refresh(cred) {
        const headers = wbHeaders(cred);
        delete headers['authorization'];
        delete headers['x-user-id'];
        headers['x-refresh-token'] = cred.refreshToken;
        headers['x-auth-refresh-source'] = 'plugin';
        let res;
        try {
            res = await fetch(`${this.baseUrl}/v2/plugin/auth/token/refresh`, {
                method: 'POST',
                headers,
                body: '{}',
                signal: AbortSignal.timeout(20_000),
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
/** 供 doctor / 启动输出展示的凭证摘要（**绝不回显令牌**）。 */
export function credentialSummary() {
    const cred = readSavedCredential();
    if (!cred)
        return '未导入';
    const left = cred.expiresAt ? Math.round((cred.expiresAt - Date.now()) / 3600_000) : null;
    const uid = cred.uid.slice(0, 8);
    return left !== null ? `已登录（uid ${uid}…，登录态约剩 ${left} 小时）` : `已登录（uid ${uid}…，到期未知）`;
}
export { WORKBUDDY_CLI_VERSION, expandWorkBuddyUA };
