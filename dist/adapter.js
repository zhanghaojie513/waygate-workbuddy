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
import { existsSync, readFileSync } from 'node:fs';
import {} from 'waygate-core';
import { UpstreamError } from './errors.js';
import { buildUpstreamHeaders } from './headers.js';
import { rewriteRequestBody } from './rewrite.js';
import { WbTokenManager, clientAuthFile, credentialPath, credentialSummary, importCredentialFrom, readSavedCredential, wbHeaders, } from './credential.js';
import { WbActivity, renderRunAll, renderSigninPanel } from './activity.js';
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
        /* 复用 headers.ts 的指纹构造，再把 Bearer 换成登录态令牌。 */
        const { headers, leaked } = buildUpstreamHeaders({}, cred.accessToken, spoof, userAgent);
        if (leaked.length > 0) {
            throw new UpstreamError(`内部错误：出站头残留敏感头 ${leaked.join(', ')}`);
        }
        headers['authorization'] = `Bearer ${token}`;
        /* 登录态域还要求稳定设备头与 x-user-id（领取族必需）。 */
        const credHeaders = wbHeaders(cred, token);
        headers['x-machine-id'] = credHeaders['x-machine-id'];
        headers['x-session-id'] = credHeaders['x-session-id'];
        headers['x-user-id'] = credHeaders['x-user-id'];
        return { ...headers, ...extra };
    }
    /** 导入登录态（import 与其别名共用）。 */
    async function importRun({ args }) {
        const file = args[0];
        if (!file)
            throw new Error('用法：wb import <导出文件.json>（用 tools/wb-oauth-export.mjs 生成）');
        const payload = JSON.parse(readFileSync(file, 'utf8'));
        importCredentialFrom(payload);
        return `已导入登录态 → ${credentialPath()}\n${credentialSummary()}`;
    }
    return {
        command: 'wb',
        displayName: 'WorkBuddy',
        defaultPort: 8786,
        upstreamLabel: `${baseUrl}  (OpenAI 兼容 · 官方桌面端指纹)`,
        extraCommands: [
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
            {
                name: 'import',
                summary: '导入客户端登录态（wb-oauth-export.mjs 的输出）',
                usage: 'import <文件>',
                run: importRun,
            },
        ],
        async credentialStatus() {
            const cred = readSavedCredential();
            if (!cred) {
                return {
                    ok: false,
                    detail: '未导入 WorkBuddy 登录态。用 tools/wb-oauth-export.mjs 从客户端导出，再跑 `wb login`。' +
                        (existsSync(clientAuthFile()) ? '' : `（也未找到客户端登录态文件：${clientAuthFile()}）`),
                };
            }
            return { ok: true, detail: credentialSummary(), source: credentialPath() };
        },
        /**
         * 「登录」= 导入客户端登录态。
         *
         * 与 mmcode/qoder 的差别：WorkBuddy 的客户端登录态是**加密信封**（AES-GCM，密钥绑定机器），
         * 解密必须借客户端运行时 —— 本工具不重复实现那段解密，改为引导用户跑 `tools/wb-oauth-export.mjs`。
         * 该脚本产出明文 JSON，导入后由本工具长期维护（自动刷新 + 轮换写回）。
         */
        async login() {
            const fromEnv = (process.env.WB_CREDENTIAL_FILE ?? '').trim();
            if (fromEnv) {
                const payload = JSON.parse(readFileSync(fromEnv, 'utf8'));
                importCredentialFrom(payload);
                process.stdout.write(`已从 ${fromEnv} 导入登录态 → ${credentialPath()}\n${credentialSummary()}\n`);
                return;
            }
            process.stdout.write('WorkBuddy 的客户端登录态是加密的，需要先导出为明文：\n' +
                '\n' +
                '  1) 确保 WorkBuddy 桌面端已登录\n' +
                '  2) 跑：node tools/wb-oauth-export.mjs        （借客户端运行时解密）\n' +
                '  3) 导入：wb import wb-oauth.json  （或 WB_CREDENTIAL_FILE=<文件> wb login）\n' +
                '\n' +
                '导出文件等同账号登录态 —— 不提交版本库、导入后请删除本地副本。\n');
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
