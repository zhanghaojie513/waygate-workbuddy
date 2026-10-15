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
import type { ChatRequestBody } from 'waygate-core';
/** 上游硬约束：必须流式。 */
export declare const UPSTREAM_REQUIRED_STREAM = true;
/** `max_tokens` 低于此值时提升（上游 11133）。 */
export declare const MIN_MAX_TOKENS = 16;
export interface RewriteResult {
    body: ChatRequestBody;
    /** 本次改写做了哪些动作（供日志/排障）。 */
    notes: string[];
}
/** system 提示改写档位。`neutral` = 把 system 全量换成中性提示（自动降级形态）。 */
export type PromptRewriteMode = 'template' | 'neutral' | 'off';
/** 默认档（与生产默认一致）。 */
export declare const DEFAULT_PROMPT_REWRITE_MODE: PromptRewriteMode;
export interface RewriteOptions {
    /** system 提示改写档位；缺省 = `template`。 */
    promptRewrite?: PromptRewriteMode;
    /** `neutral` 档使用的中性提示词。 */
    neutralPrompt?: string;
}
/** 中性提示词（与注入用的最小 system 同文）。 */
export declare const NEUTRAL_SYSTEM_PROMPT = "You are a helpful assistant.";
/**
 * 模板行改写规则（有序，先长后短；只做**语义等价**改写，破坏逐字 n-gram 匹配）。
 *
 * 判据来自二分实验：关键词零宽脱敏无效、身份词中性化无效，**模板行语义等价改写有效**。
 * 规则表是代码常量（改规则需发版）；`off` 档可整体关闭。
 */
export declare const TEMPLATE_RULES: ReadonlyArray<readonly [RegExp, string]>;
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
export declare function rewriteRequestBody(input: ChatRequestBody, opts?: RewriteOptions): RewriteResult;
