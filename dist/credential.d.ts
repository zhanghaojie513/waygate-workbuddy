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
/** 提前刷新余量：2 天。 */
export declare const WB_REFRESH_AHEAD_MS: number;
/** CN 域（国际版 base 为 https://www.workbuddy.ai，Origin 同域）。 */
export declare const WB_BASE_URL = "https://copilot.tencent.com";
export declare const WB_ORIGIN = "https://www.codebuddy.cn";
/** 登录/刷新用的客户端标识（与官方 CLI 插件同形）。 */
export declare const WB_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** 凭证落盘位置（`~/.waygate/wb/credential.json`）。 */
export declare function credentialPath(): string;
/** 官方 OAuth 设备授权拿到的凭证。 */
export interface WbCredential {
    accessToken: string;
    refreshToken: string;
    uid: string;
    enterpriseId?: string;
    nickname?: string;
    domain?: string;
    /** access 过期时刻（epoch ms）。 */
    expiresAt?: number;
}
export declare function readSavedCredential(): WbCredential | null;
/** 落盘（0600）。token 轮换后也调用本函数写回。 */
export declare function saveCredential(cred: WbCredential): string;
/**
 * 登录态域通用出站头（OAuth 流程与活动接口共用）。
 *
 * ⚠️ 这些头不是可有可无的装饰 —— `x-codebuddy-request` 是**风控闸门头**
 * （实测：缺它时签到/领取类端点被拒），`x-machine-id`/`x-session-id` 是设备标识
 * （官方客户端有，缺失可能被当作异常来源）。三者缺一不可。
 */
export declare function wbCommonHeaders(token?: string, uid?: string): Record<string, string>;
/** 按 uid 派生稳定设备标识（OAuth 登录态没有真实机器 ID，用确定性派生代替随机）。 */
export declare function deriveStableId(uid: string, purpose: 'machine' | 'session'): string;
/** 登录尚未完成（poll 时的正常待机状态，不是错误）。 */
export declare class PendingLoginError extends Error {
    readonly name = "PendingLoginError";
    constructor(message: string);
}
/** 第 ① 步：拿授权 URL（用户在浏览器打开完成登录）。 */
export declare function startLogin(baseUrl?: string): Promise<string>;
/** 第 ②③ 步：轮询取 token + 账号信息。未完成时抛 `PendingLoginError`。 */
export declare function pollLogin(baseUrl?: string): Promise<WbCredential>;
/**
 * token 管理器：缓存 access token，临期自动刷新（并发去重），轮换时写回。
 */
export declare class WbTokenManager {
    private readonly baseUrl;
    private readonly onLog;
    private cached;
    private inFlight;
    constructor(baseUrl?: string, onLog?: (line: string) => void);
    accessToken(): Promise<string>;
    /** 立即刷新（不看余量）。doctor 体检用。 */
    forceRefresh(): Promise<string>;
    private refresh;
}
/** 供 doctor / 启动输出展示的摘要（**绝不回显令牌**）。 */
export declare function credentialSummary(): string;
