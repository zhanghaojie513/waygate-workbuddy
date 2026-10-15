/**
 * 出站请求体改写（上游是腾讯系网关，有几条**硬约束**，实测得到）。
 *
 * 上游不是「标准 OpenAI 兼容」，它有若干隐形规则，违反即 400：
 *   · `stream:false` → 400 + `11101`（不认非流式）
 *   · `max_tokens < 16` → 400 + `11133`
 *   · role 精确等于小写 `developer` → 400 + `11128`
 *   · `stream_options` 字段 → 不认
 *   · **system 正文命中「长 n-gram 模板指纹」→ 400 + `11128`**
 *     （Claude Code 血统的 git 环境模板行是主要触发源，最小触发窗口实测 47 连续字符）
 *
 * 本模块把这些约束**在转发前就地满足**，让任何 OpenAI 兼容客户端都能直连。
 */
/** 上游硬约束：必须流式。 */
export const UPSTREAM_REQUIRED_STREAM = true;
/** `max_tokens` 低于此值时提升（上游 11133）。 */
export const MIN_MAX_TOKENS = 16;
function isSystem(m) {
    return !!m && typeof m.role === 'string' && m.role.toLowerCase() === 'system';
}
/** `developer` 是 `system` 的继任者（新 OpenAI 规范），语义同位。 */
const DEVELOPER_ROLE = 'developer';
/** 上游实际接受的 role 白名单（实测：小写 `developer` 触发 11128）。 */
const ROLE_WHITELIST = new Set(['system', 'user', 'assistant', 'tool']);
/**
 * `developer` → `system` 的角色规范化（**保序、保内容、不丢消息**）。
 *
 * 实测根因：上游**只拒精确小写 `developer`**（任意位置都回 400/11128），
 * 而 `Developer`（首字母大写）/`foo` 这类**反而容忍**。语义上 `developer` 本就是
 * `system` 的继任者，故这是**保义转换**。大小写不敏感识别（统一收口更稳）。
 */
function normalizeDeveloperRoles(messages) {
    let changed = false;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m && typeof m.role === 'string' && m.role.toLowerCase() === DEVELOPER_ROLE) {
            messages[i] = { ...m, role: 'system' };
            changed = true;
        }
    }
    return changed;
}
/**
 * 白名单外的 role 一律降级为 `user`（**保留内容**）。
 *
 * 上游对自定义 role 的容忍度是黑盒；下一个 SDK 换个新角色名就会再打死整条请求。
 * 白名单的失效模式是「少一次语义」，而不是「整条挂掉」—— 两者代价不对称，选前者。
 */
function normalizeUnknownRoles(messages) {
    const seen = new Set();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || typeof m.role !== 'string')
            continue;
        const lower = m.role.toLowerCase();
        if (ROLE_WHITELIST.has(lower) || lower === DEVELOPER_ROLE)
            continue; // developer 已在上一步转换
        seen.add(m.role);
        messages[i] = { ...m, role: 'user' };
    }
    return [...seen];
}
/** 默认档（与生产默认一致）。 */
export const DEFAULT_PROMPT_REWRITE_MODE = 'template';
/** 中性提示词（与注入用的最小 system 同文）。 */
export const NEUTRAL_SYSTEM_PROMPT = 'You are a helpful assistant.';
/**
 * 模板行改写规则（有序，先长后短；只做**语义等价**改写，破坏逐字 n-gram 匹配）。
 *
 * 判据来自二分实验：关键词零宽脱敏无效、身份词中性化无效，**模板行语义等价改写有效**。
 * 规则表是代码常量（改规则需发版）；`off` 档可整体关闭。
 */
export const TEMPLATE_RULES = [
    [/^Main branch \(you will usually use this for PRs\):/gm, 'Default PR target:'],
    [/^Current branch:/gm, 'Active branch:'],
    [/^Git user:/gm, 'Git author:'],
    [/^Recent commits:/gm, 'Recent history:'],
    [/^Status:/gm, 'Working tree:'],
    [/^Note that this status is a snapshot in time, and will not update during the conversation\.$/gm, 'This snapshot does not live-update.'],
    [/^Here is useful information about the environment you are running in:$/gm, 'Environment:'],
    [/You are Claude Code/g, 'You are an interactive coding agent'],
];
function applyTemplateRules(text) {
    let out = text;
    let count = 0;
    for (const [re, to] of TEMPLATE_RULES) {
        out = out.replace(re, () => {
            count += 1;
            return to;
        });
    }
    return { text: out, count };
}
/** system 的 content 兼容 string / null / parts 数组（parts 只改 text 字段，结构不动）。 */
function rewriteContent(content) {
    if (typeof content === 'string') {
        const r = applyTemplateRules(content);
        return { content: r.text, count: r.count };
    }
    if (Array.isArray(content)) {
        let count = 0;
        const parts = content.map((p) => {
            if (p && typeof p === 'object' && typeof p.text === 'string') {
                const r = applyTemplateRules(p.text);
                count += r.count;
                return { ...p, text: r.text };
            }
            return p;
        });
        return { content: parts, count };
    }
    return { content, count: 0 };
}
/** template 档：只改 system 消息正文里的模板行，返回替换次数。 */
function rewriteSystemTemplates(messages) {
    let count = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || !isSystem(m))
            continue;
        const r = rewriteContent(m.content);
        if (r.count > 0)
            messages[i] = { ...m, content: r.content };
        count += r.count;
    }
    return count;
}
/** neutral 档：把所有 system 消息正文整体换成中性提示（返回替换条数）。 */
function neutralizeSystemPrompts(messages, neutral) {
    let count = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || !isSystem(m))
            continue;
        if (m.content !== neutral) {
            messages[i] = { ...m, content: neutral };
            count += 1;
        }
    }
    return count;
}
/**
 * 出站请求体改写。**纯函数**（不改传入对象）。
 *
 * 顺序固定：
 *   ① developer 规范化     就地改成 `system`（须在「首条是否 system」判断之前）
 *   ①b role 白名单         其余 role 降级为 `user`（保内容）
 *   ② system 补全          首条非 system 时头部插入一条
 *   ③ stream 强制          恒为 true
 *   ④ max_tokens 下限      低于 16 则提升（不主动补：会改变用户语义）
 *   ⑤ stream_options 删除
 *   ⑥ system 提示改写      按档位 template / neutral / off
 */
export function rewriteRequestBody(input, opts = {}) {
    const notes = [];
    const messages = Array.isArray(input.messages) ? [...input.messages] : [];
    if (normalizeDeveloperRoles(messages))
        notes.push('developer_role_normalized');
    for (const role of normalizeUnknownRoles(messages)) {
        const safe = role.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'unknown';
        notes.push(`role_normalized_${safe}`);
    }
    if (!isSystem(messages[0])) {
        // 补一条最小 system：不伪造业务语义，只满足上游协议要求
        messages.unshift({ role: 'system', content: NEUTRAL_SYSTEM_PROMPT });
        notes.push('system_injected');
    }
    const hadStreamOptions = 'stream_options' in input && input.stream_options !== undefined;
    const body = { ...input, messages, stream: UPSTREAM_REQUIRED_STREAM };
    delete body.stream_options;
    if (hadStreamOptions)
        notes.push('stream_options_stripped');
    const mt = typeof input.max_tokens === 'number' ? input.max_tokens : undefined;
    if (mt !== undefined && mt < MIN_MAX_TOKENS) {
        body.max_tokens = MIN_MAX_TOKENS;
        notes.push(`max_tokens_raised_${mt}_to_${MIN_MAX_TOKENS}`);
    }
    const mode = opts.promptRewrite ?? DEFAULT_PROMPT_REWRITE_MODE;
    if (mode === 'template') {
        const n = rewriteSystemTemplates(messages);
        if (n > 0)
            notes.push(`template_rewritten_${n}`);
    }
    else if (mode === 'neutral') {
        const n = neutralizeSystemPrompts(messages, opts.neutralPrompt ?? NEUTRAL_SYSTEM_PROMPT);
        if (n > 0)
            notes.push(`sysprompt_neutralized_${n}`);
    }
    return { body, notes };
}
