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
import { WORKBUDDY_CLI_VERSION, expandWorkBuddyUA } from './headers.js';
/** 提前刷新余量：2 天（access 寿命实测约 28 天）。 */
export declare const WB_REFRESH_AHEAD_MS: number;
/** 本工具保存的凭证位置。 */
export declare function credentialPath(): string;
/** 客户端原始登录态文件（加密信封，仅供参考/提示用）。 */
export declare function clientAuthFile(): string;
/** 桌面端登录态（导出工具产出的明文形态）。 */
export interface WbCredential {
    accessToken: string;
    refreshToken: string;
    uid: string;
    uin?: string;
    domain?: string;
    /** access 过期时刻（epoch ms）。 */
    expiresAt?: number;
}
/** 取本工具已保存的凭证明文（无则 null）。 */
export declare function readSavedCredential(): WbCredential | null;
/** 落盘（0600）。refresh token 轮换后也要调用本函数写回。 */
export declare function saveCredential(cred: WbCredential): string;
/** 从导出工具的输出导入（`wb login <文件>` 或 `wb import-credential <文件>`）。 */
export declare function importCredentialFrom(payload: Record<string, unknown>): WbCredential;
/**
 * 按 uid 派生**稳定**设备头。
 *
 * 官方客户端用真实机器标识；本工具没有，但不能用随机值 —— 每次请求换一个机器 ID
 * 会像「同一账号在多台设备上来回跳」，反而触发风控。故按 uid 做确定性派生。
 */
export declare function deriveStableId(uid: string, purpose: 'machine' | 'session'): string;
/** 出站请求头（登录态域）：官方桌面端公共头 + 稳定设备头 + Bearer。 */
export declare function wbHeaders(cred: WbCredential, token?: string): Record<string, string>;
/**
 * token 管理器：缓存 access token，临期自动刷新（并发去重），轮换时写回。
 */
export declare class WbTokenManager {
    private readonly baseUrl;
    private readonly onLog;
    private cached;
    private inFlight;
    constructor(baseUrl: string, onLog?: (line: string) => void);
    /** 取可用 access token（必要时刷新并写回）。 */
    accessToken(): Promise<string>;
    /** 立即刷新（不看余量）。doctor 体检用。 */
    forceRefresh(): Promise<string>;
    private refresh;
}
/** 供 doctor / 启动输出展示的凭证摘要（**绝不回显令牌**）。 */
export declare function credentialSummary(): string;
export { WORKBUDDY_CLI_VERSION, expandWorkBuddyUA };
