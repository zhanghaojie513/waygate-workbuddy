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
import { type Adapter } from 'waygate-core';
import { type PromptRewriteMode } from './rewrite.js';
import { type WbCredential } from './credential.js';
export declare const DEFAULT_WB_BASE_URL = "https://copilot.tencent.com";
export declare const DEFAULT_WB_CHAT_PATH = "/v2/chat/completions";
/** 模型清单端点（实测 `data.models[]`）。 */
export declare const WB_MODELS_PATH = "/v2/enterprises/personal/models";
export interface WbAdapterOptions {
    baseUrl?: string;
    chatPath?: string;
    /** system 提示改写档位（默认 template）。 */
    promptRewrite?: PromptRewriteMode;
    /** 是否注入官方指纹（默认 true）。 */
    spoof?: boolean;
    /** 指纹 UA 基准值。 */
    userAgent?: string;
}
export declare function createWorkBuddyAdapter(opts?: WbAdapterOptions): Adapter;
export type { WbCredential };
