/**
 * WorkBuddy 适配器：把「官方桌面端登录态」变成「本地 OpenAI/Anthropic 兼容反代」。
 *
 * ## 与 waygate-mmcode / waygate-qoder 的关系
 * 同一个 core 骨架、同样的「读本机客户端登录态」模型。差异：
 *   · 上游本身就是 **OpenAI 兼容**（`POST /v2/chat/completions`）—— **无需协议翻译**，
 *     出的 SSE 直接透传（没有 `protocol/` 目录）。
 *   · 真正的难点是**指纹与改写**：上游按官方客户端头族做归因与风控，
 *     且对 body 有几条隐形硬约束（见 `rewrite.ts`）。
 *
 * ## 凭证：一份登录态覆盖全部能力（实测）
 * 桌面端 OAuth accessToken 可打通聊天 / 模型清单 / 签到 / 代领 —— 不需要 `ck_` 密钥。
 */
import {} from 'waygate-core';
import { UpstreamError } from './errors.js';
import { buildUpstreamHeaders } from './headers.js';
import { rewriteRequestBody } from './rewrite.js';
import { LOGIN_WAIT_MS, PendingLoginError, WbTokenManager, credentialPath, credentialSummary, pollLogin, readSavedCredential, startLogin, wbCommonHeaders, } from './credential.js';
import { WbActivity, renderRunAll, renderSigninPanel } from './activity.js';
/**
 * 轮询进度行 —— 用 `\r` 覆盖同一行，不刷屏。
 *
 * 没有它，用户面对的是最长 2 分钟的**完全静默**，分不清"在等"还是"卡死了"。
 */
function tickTo(out) {
    return ({ waitedMs, remainingMs }) => {
        const w = Math.round(waitedMs / 1000);
        const r = Math.round(remainingMs / 1000);
        out.write(`\r  ⏳ 等待登录完成… ${w}s（最多再等 ${r}s，按 Ctrl+C 可中断）   `);
    };
}
export const DEFAULT_WB_BASE_URL = 'https://copilot.tencent.com';
export const DEFAULT_WB_CHAT_PATH = '/v2/chat/completions';
/** 模型清单端点（实测 `data.models[]`）。 */
export const WB_MODELS_PATH = '/v2/enterprises/personal/models';
export function createWorkBuddyAdapter(opts = {}) {
    const baseUrl = (opts.baseUrl ?? DEFAULT_WB_BASE_URL).replace(/\/+$/, '');
    const chatPath = opts.chatPath ?? DEFAULT_WB_CHAT_PATH;
    const spoof = opts.spoof ?? true;
    /* 改写档位：opts 优先，其次环境变量 WB_PROMPT_REWRITE（core 的 CLI 不接受自定义 flag）。 */
    const promptRewrite = opts.promptRewrite ?? process.env.WB_PROMPT_REWRITE ?? undefined;
    const userAgent = opts.userAgent ?? 'WorkBuddy/5.8.0';
    const log = (line) => process.stdout.write(`[wb] ${line}\n`);
    const tokens = new WbTokenManager(baseUrl, log);
    const activity = new WbActivity(baseUrl, () => readSavedCredential(), () => tokens.accessToken());
    /** 用当前登录态出站（自动刷新令牌）。 */
    async function authedHeaders(extra = {}) {
        const cred = readSavedCredential();
        if (!cred) {
            throw new UpstreamError('未导入 WorkBuddy 登录态 —— 先跑 `wb login`（见 README）。');
        }
        const token = await tokens.accessToken();
        /* 指纹头（headers.ts）+ 登录态域公共头（credential.ts）：两者共同构成官方客户端形态。 */
        const { headers, leaked } = buildUpstreamHeaders({}, token, spoof, userAgent);
        if (leaked.length > 0) {
            throw new UpstreamError(`内部错误：出站头残留敏感头 ${leaked.join(', ')}`);
        }
        const common = wbCommonHeaders(token);
        delete common['content-type'];
        delete common['x-requested-with'];
        headers['x-user-id'] = cred.uid;
        if (cred.enterpriseId)
            headers['x-enterprise-id'] = cred.enterpriseId;
        if (cred.domain)
            headers['x-domain'] = cred.domain;
        return { ...headers, ...common, ...extra };
    }
    return {
        command: 'wb',
        displayName: 'WorkBuddy',
        defaultPort: 8786,
        upstreamLabel: `${baseUrl}  (OpenAI 兼容 · 官方桌面端指纹)`,
        /* 帮助文本里 login 那一行的说明（本工具是 OAuth，不是读客户端登录态）。 */
        loginHint: '登录（官方 OAuth 设备授权；按提示在浏览器完成授权）',
        extraCommands: [
            {
                name: 'login-poll',
                summary: `完成登录：轮询取 token（浏览器授权后执行；\`login\` 等待超时也用它）`,
                usage: 'login-poll',
                async run() {
                    try {
                        const cred = await pollLogin(LOGIN_WAIT_MS, tickTo(process.stdout));
                        return '登录成功 → ' + credentialPath() + '\n' + credentialSummary() + '\n（授权账号 ' + cred.uid.slice(0, 8) + '…）';
                    }
                    catch (err) {
                        if (err instanceof PendingLoginError) {
                            return '⏳ 还没看到你的登录完成 —— 请先在浏览器里打开链接完成登录，然后重跑：wb login-poll';
                        }
                        throw err;
                    }
                },
            },
            {
                name: 'checkin',
                summary: '签到代领 + 跑成长任务（用本工具维护的登录态）',
                usage: 'checkin',
                async run({ json }) {
                    const r = await activity.runAll();
                    return json ? JSON.stringify(r, null, 2) : renderRunAll(r);
                },
            },
            {
                name: 'status',
                summary: '只查签到状态（不领取）',
                usage: 'status',
                async run({ json }) {
                    const p = await activity.panel();
                    return json ? JSON.stringify(p, null, 2) : renderSigninPanel(p);
                },
            },
        ],
        async credentialStatus() {
            const cred = readSavedCredential();
            if (!cred) {
                return {
                    ok: false,
                    detail: '未登录 —— 跑 `wb login`（浏览器授权一次，走官方 OAuth 通道，无需读客户端文件）。',
                };
            }
            return { ok: true, detail: credentialSummary(), source: credentialPath() };
        },
        /**
         * 「登录」= 官方 OAuth 设备授权：打印授权 URL 后**原地等 2 分钟**（用户口径）。
         *
         * 用户在浏览器点完登录，终端**自动继续**，无需手动回来再跑一次 `login-poll`。
         * 超时 → 抛 `PendingLoginError`，**state 保留**，提示改用 `wb login-poll` 续取。
         * 走官方给插件/CLI 的正规通道 —— **不读本机登录态、不解密**。
         */
        async login() {
            const out = process.stdout;
            const authUrl = await startLogin();
            out.write('请在浏览器打开下面的链接完成登录（用你的 WorkBuddy 账号）：\n\n' +
                '  ' + authUrl + '\n\n' +
                `完成后本终端会**自动继续**（最多等 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒）。\n\n` +
                '（登录态只保存在本机 ' + credentialPath() + '，权限 0600。）\n');
            try {
                const cred = await pollLogin(LOGIN_WAIT_MS, tickTo(out));
                void cred;
                out.write('\n✓ 登录成功 → ' + credentialPath() + '\n' + credentialSummary() + '\n');
            }
            catch (err) {
                if (err instanceof PendingLoginError) {
                    out.write(`\n⏳ 等了 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒还没看到登录完成。\n` +
                        '   完成浏览器登录后，回来执行：wb login-poll\n');
                    throw err;
                }
                throw err;
            }
        },
        /** 模型清单：真拉上游；失败回落内置（并如实标注）。 */
        async listModels() {
            const cred = readSavedCredential();
            if (!cred)
                return [];
            try {
                const headers = await authedHeaders({ accept: 'application/json' });
                const res = await fetch(`${baseUrl}${WB_MODELS_PATH}`, { headers, signal: AbortSignal.timeout(15_000) });
                if (!res.ok)
                    return [];
                const body = (await res.json());
                /* 实测形状（2026-10）：data.models[] —— 每项 { id, name, tags:['craft','badge:限时免费:#FF0000'] }。 */
                const data = (body.data ?? {});
                const rows = Array.isArray(data.models) ? data.models : [];
                const models = [];
                for (const r of rows) {
                    if (!r || typeof r !== 'object')
                        continue;
                    const o = r;
                    if (typeof o.id !== 'string' || !o.id)
                        continue;
                    const tags = Array.isArray(o.tags) ? o.tags.filter((t) => typeof t === 'string') : [];
                    /* badge:<文字>:<颜色> 是上游的计价徽标；取文字部分作 tag。 */
                    const badge = tags.map((t) => /^badge:([^:]+):/.exec(t)?.[1]).find((x) => !!x) ?? null;
                    models.push({
                        id: o.id,
                        displayName: typeof o.name === 'string' && o.name ? o.name : o.id,
                        tag: badge ?? null,
                    });
                }
                return models;
            }
            catch {
                return [];
            }
        },
        async doctorChecks() {
            const checks = [];
            const cred = readSavedCredential();
            if (!cred) {
                checks.push({ name: '登录态', ok: false, detail: '未导入（跑 wb login）' });
                return checks;
            }
            checks.push({ name: '登录态', ok: true, detail: credentialSummary() });
            /* 上游连通 + 令牌有效性：清单端点是登录态域里最轻的鉴权接口。 */
            try {
                const headers = await authedHeaders({ accept: 'application/json' });
                const res = await fetch(`${baseUrl}${WB_MODELS_PATH}`, { headers, signal: AbortSignal.timeout(10_000) });
                checks.push({
                    name: '上游连通',
                    ok: res.ok,
                    detail: res.ok ? `${baseUrl} 可达且登录态有效` : `HTTP ${res.status}`,
                });
            }
            catch (err) {
                checks.push({ name: '上游连通', ok: false, detail: err.message });
            }
            /* 令牌刷新链（顺带把轮换写回）。 */
            try {
                const t = await tokens.forceRefresh();
                checks.push({ name: '令牌刷新', ok: true, detail: `可刷新（${t.slice(0, 6)}…）` });
            }
            catch (err) {
                checks.push({ name: '令牌刷新', ok: false, detail: err.message });
            }
            return checks;
        },
        async chat(body, signal) {
            const headers = await authedHeaders({ accept: 'text/event-stream' });
            /* 上游硬约束在转发前就地满足（stream 恒 true / max_tokens 下限 / role 规范化 / 模板改写）。 */
            const { body: rewritten } = rewriteRequestBody(body, { promptRewrite });
            const res = await fetch(`${baseUrl}${chatPath}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(rewritten),
                signal,
            });
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                throw new UpstreamError(res.status === 401 || res.status === 403
                    ? `上游鉴权失败（HTTP ${res.status}）—— 登录态可能已失效：在客户端重新登录后重跑导出与导入。${text ? ` 上游说：${text.slice(0, 200)}` : ''}`
                    : `上游 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
            }
            /* 上游本身是 OpenAI SSE —— **直接透传**，无需协议翻译。 */
            return { stream: res.body, status: 200 };
        },
    };
}
