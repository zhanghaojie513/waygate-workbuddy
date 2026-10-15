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
/**
 * 官方 WorkBuddy 桌面端指纹常量（实测 2026-10）。
 *
 * 与社区常见实现（workbuddy2api 早期版本抄来的）的差异，这三点正是「像不像官方」的关键：
 *   · `X-Product` = **deploymentType**（实测 `SaaS`）—— 社区常硬编码 `WorkBuddy`（错）
 *   · `X-Agent-Intent: craft`、`X-Private-Data: true` —— 官方必带，社区实现常缺
 *   · 版本取 `app.getVersion()`（实测 5.8.0），随客户端升版更新
 */
export declare const WORKBUDDY_CLI_VERSION = "2.137.1";
export declare const WORKBUDDY_ORIGIN = "https://www.codebuddy.cn";
export declare const WORKBUDDY_FALLBACK_VERSION = "5.8.0";
/** 从配置 UA（`WorkBuddy/<ver>` 形态）解析客户端版本段；解析不出回落内置默认。 */
export declare function parseWorkBuddyVersion(ua: string): string;
/**
 * 展开为官方桌面端 UA 三段式：`WorkBuddy/<ver> WorkBuddy/<ver> CLI/<cliVer>`
 * （官方 RestOperations 层形状）。已含 CLI 段或非 WorkBuddy 形态的自定义 UA 原样返回
 * —— 用户显式配置的完整 UA 优先，不做二次加工。
 */
export declare function expandWorkBuddyUA(ua: string): string;
/**
 * 注入用量归因头族（+ 官方客户端公共头）。
 *
 * 这是「使用端」在官方后台显示为 WorkBuddy 的关键：X-Product / X-IDE-* / X-Agent-Purpose
 * 缺失时上游归因为空，账单里只看到网关特征。
 */
export declare function injectWorkBuddyFingerprint(headers: Record<string, string>, version: string): void;
/** 明确列出、用于测试断言的敏感头：这些头永远不许出站。 */
export declare const NEVER_FORWARD: readonly ["authorization", "x-api-key", "api-key", "cookie", "set-cookie", "proxy-authorization", "x-inbound-key"];
export interface HeaderBuildResult {
    headers: Record<string, string>;
    /** 出站头里是否残留敏感头（必须恒为 false，测试会断言）。 */
    leaked: string[];
}
/**
 * 构造出站头。
 * @param incoming 客户端原始头
 * @param upstreamKey 上游 `ck_` 凭证
 * @param spoof 是否注入官方指纹（false 时保留入站 UA，缺失则用默认）
 * @param spoofUAValue 指纹 UA 基准值（如 `WorkBuddy/5.8.0`）
 */
export declare function buildUpstreamHeaders(incoming: Record<string, string | string[] | undefined>, upstreamKey: string, spoof: boolean, spoofUAValue: string): HeaderBuildResult;
