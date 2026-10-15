/**
 * 出站请求头构造（本项目最核心的一块）。
 *
 * ## 为什么需要「指纹」
 * WorkBuddy 上游网关按**客户端指纹**做归因与风控：不带官方头族时，用量不会归到
 * WorkBuddy 使用端，且部分端点直接拒绝。本模块按**官方桌面端实测值**重建头族
 * （逆向自官方 app.asar 的 `buildVlmGatewayHeaders` + 本机 product-config 缓存）。
 *
 * ## 安全：用 allowlist 而不是 blocklist
 * 本机入站密钥（`sk-wb-…`）**绝不能出现在出站请求里**。因此只拷贝明确安全的头，
 * 而不是「拷贝全部再删掉 Authorization」—— allowlist 的失效模式是「少带一个头」，
 * blocklist 的失效模式是「密钥泄漏到上游」，两者代价不对称。
 */
/** 允许透传给上游的头（小写）。 */
const FORWARD_ALLOWLIST = new Set([
    'content-type',
    'accept',
    'accept-language',
    'user-agent', // 会被指纹覆盖；不在 allowlist 时根本无法伪装
]);
/**
 * 官方 WorkBuddy 桌面端指纹常量（实测 2026-10）。
 *
 * 与社区常见实现（workbuddy2api 早期版本抄来的）的差异，这三点正是「像不像官方」的关键：
 *   · `X-Product` = **deploymentType**（实测 `SaaS`）—— 社区常硬编码 `WorkBuddy`（错）
 *   · `X-Agent-Intent: craft`、`X-Private-Data: true` —— 官方必带，社区实现常缺
 *   · 版本取 `app.getVersion()`（实测 5.8.0），随客户端升版更新
 */
export const WORKBUDDY_CLI_VERSION = '2.137.1';
export const WORKBUDDY_ORIGIN = 'https://www.codebuddy.cn';
export const WORKBUDDY_FALLBACK_VERSION = '5.8.0';
/** 从配置 UA（`WorkBuddy/<ver>` 形态）解析客户端版本段；解析不出回落内置默认。 */
export function parseWorkBuddyVersion(ua) {
    const m = /WorkBuddy(?:\s+AI)?\/([\d.]+)/i.exec(ua);
    return m?.[1] ?? WORKBUDDY_FALLBACK_VERSION;
}
/**
 * 展开为官方桌面端 UA 三段式：`WorkBuddy/<ver> WorkBuddy/<ver> CLI/<cliVer>`
 * （官方 RestOperations 层形状）。已含 CLI 段或非 WorkBuddy 形态的自定义 UA 原样返回
 * —— 用户显式配置的完整 UA 优先，不做二次加工。
 */
export function expandWorkBuddyUA(ua) {
    if (ua.includes('CLI/') || !/^WorkBuddy\b/i.test(ua))
        return ua;
    const ver = parseWorkBuddyVersion(ua);
    return `WorkBuddy/${ver} WorkBuddy/${ver} CLI/${WORKBUDDY_CLI_VERSION}`;
}
/**
 * 注入用量归因头族（+ 官方客户端公共头）。
 *
 * 这是「使用端」在官方后台显示为 WorkBuddy 的关键：X-Product / X-IDE-* / X-Agent-Purpose
 * 缺失时上游归因为空，账单里只看到网关特征。
 */
export function injectWorkBuddyFingerprint(headers, version) {
    // 用量归因：对齐官方桌面端（X-IDE-Name/Type + 会话用途/意图声明）
    headers['x-agent-purpose'] = 'conversation';
    headers['x-agent-intent'] = 'craft'; // 官方恒定值
    headers['x-ide-name'] = 'WorkBuddy';
    headers['x-ide-type'] = 'WorkBuddy';
    headers['x-ide-version'] = version;
    // 官方取 deploymentType（本机 product-config 实测 = SaaS）
    headers['x-product'] = 'SaaS';
    headers['x-private-data'] = 'true'; // 官方恒定值
    // 官方客户端风控闸门头：所有 API 请求必带
    headers['x-codebuddy-request'] = '1';
    // Web 端公共头（官方客户端同款）
    headers['origin'] = WORKBUDDY_ORIGIN;
    headers['referer'] = `${WORKBUDDY_ORIGIN}/`;
    headers['x-requested-with'] = 'XMLHttpRequest';
    // 语言标识：入站有则透传（allowlist 已收），否则补 CN 默认
    if (!headers['accept-language'])
        headers['accept-language'] = 'zh-CN';
}
/** 明确列出、用于测试断言的敏感头：这些头永远不许出站。 */
export const NEVER_FORWARD = [
    'authorization',
    'x-api-key',
    'api-key',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-inbound-key',
];
const NEVER_FORWARD_SET = new Set(NEVER_FORWARD);
/**
 * 构造出站头。
 * @param incoming 客户端原始头
 * @param upstreamKey 上游 `ck_` 凭证
 * @param spoof 是否注入官方指纹（false 时保留入站 UA，缺失则用默认）
 * @param spoofUAValue 指纹 UA 基准值（如 `WorkBuddy/5.8.0`）
 */
export function buildUpstreamHeaders(incoming, upstreamKey, spoof, spoofUAValue) {
    const headers = {};
    for (const [rawKey, rawValue] of Object.entries(incoming)) {
        const key = rawKey.toLowerCase();
        if (!FORWARD_ALLOWLIST.has(key))
            continue;
        if (NEVER_FORWARD_SET.has(key))
            continue; // 双保险，allowlist 已挡住
        if (rawValue === undefined)
            continue;
        headers[key] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
    }
    // ★ 强制注入上游凭证 —— 覆盖任何残留，且本机密钥从不进入这个函数
    headers['authorization'] = `Bearer ${upstreamKey}`;
    headers['content-type'] = 'application/json';
    if (spoof) {
        const ua = spoofUAValue || `WorkBuddy/${WORKBUDDY_FALLBACK_VERSION}`;
        headers['user-agent'] = expandWorkBuddyUA(ua);
        injectWorkBuddyFingerprint(headers, parseWorkBuddyVersion(ua));
    }
    else if (!headers['user-agent']) {
        headers['user-agent'] = `WorkBuddy/${WORKBUDDY_FALLBACK_VERSION}`;
    }
    const leaked = Object.keys(headers).filter((k) => NEVER_FORWARD_SET.has(k) && k !== 'authorization');
    return { headers, leaked };
}
