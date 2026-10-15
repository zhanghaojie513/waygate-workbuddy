/**
 * WorkBuddy 签到与成长任务。
 *
 * ## 一个意外的好消息（实测 2026-10）
 * 既然桌面端登录态能打通聊天与清单，**签到与代领也能用它** —— 一个凭证覆盖全部能力，
 * 不再需要 `ck_` 与 OAuth 两套。本模块就是这套统一凭证上的活动能力。
 *
 * ## 实测端点
 *   查状态/领取  `POST /v2/billing/meter/checkin-activity-status` / `POST /v2/billing/meter/daily-checkin`
 *   成长任务     `GET  /v2/activity/growth/tasks` → `POST .../tasks/accept` → `POST .../tasks/{code}/claim`
 *   连登兑换     `GET  /v2/activity/growth/streak` → `POST /v2/activity/growth/redeem`
 *
 * ## 诚实边界
 * 任务多为「体验 XX」型，前置条件不满足时如实记 `skipped` —— **绝不伪造行为去凑任务**。
 * 补登卡 / 抽奖 / 旅行属资源消耗型，**不自动化**。
 */
import type { WbCredential } from './credential.js';
/** 端点路径（实测）。 */
export declare const WB_SIGNIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
export declare const WB_SIGNIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
export declare const WB_GROWTH_TASKS_PATH = "/v2/activity/growth/tasks";
export declare const WB_GROWTH_TASKS_ACCEPT_PATH = "/v2/activity/growth/tasks/accept";
export declare const WB_GROWTH_STREAK_PATH = "/v2/activity/growth/streak";
export declare const WB_GROWTH_REDEEM_PATH = "/v2/activity/growth/redeem";
export interface SigninPanel {
    active: boolean;
    todayCheckedIn: boolean;
    streak: number | null;
    todayCredit: number | null;
    totalCredits: number | null;
    activityName: string | null;
}
export interface ClaimResult {
    /** 'claimed' 本次真领到 | 'already' 今天已领 | 'unavailable' 活动未开 | 'error' */
    outcome: 'claimed' | 'already' | 'unavailable' | 'error';
    points: number | null;
    streak: number | null;
    message: string;
}
export interface GrowthTaskOutcome {
    code: string;
    title: string | null;
    outcome: 'claimed' | 'already' | 'accepted' | 'skipped' | 'error';
    reason?: string;
}
export interface RedeemOutcome {
    tier: string;
    ok: boolean;
    detail: string;
}
export interface GrowthRunReport {
    signin: ClaimResult;
    tasks: GrowthTaskOutcome[];
    redeem: RedeemOutcome[];
    message: string;
}
/**
 * 活动客户端。
 *
 * `call()` 统一处理信封 `{code,msg,data}`：`code` 非 0 抛错；非 2xx 也读 body 拿上游 `msg`
 * —— 上游的失败原因（如「task not completed」）比 HTTP 状态码有用得多。
 */
export declare class WbActivity {
    private readonly baseUrl;
    private readonly getCred;
    private readonly getToken;
    constructor(baseUrl: string, getCred: () => WbCredential | null, getToken: () => Promise<string>);
    private call;
    /** 查签到状态（只读）。 */
    panel(): Promise<SigninPanel>;
    /**
     * 签到代领：先查状态，再决定领不领（上游幂等，但白打一次没意义）。
     * 已签 → `already`（不发 claim）；活动未开 → `unavailable`。
     */
    claimSignin(): Promise<ClaimResult>;
    /** 任务列表（只读）。 */
    panelTasks(): Promise<Array<Record<string, unknown>>>;
    /**
    /**
     * 跑一轮任务：**对全部未锁定任务先 accept、再逐个 claim**，由上游语义分流结果。
     *
     * ⚠️ 为什么不「先筛出可领的再 claim」：实测（2026-10）任务响应里**没有**
     * `claim_status` / `status` 这类「可领」字段 —— 只有 `accept_status`
     * （取值 `accepted` / `claimed` / `in_progress`）与 `progress{current,target}`。
     * 靠臆想的字段筛会**一个都筛不出来**（这正是上一版的 bug）。
     * 正确做法：对每个任务都试 claim，让上游回答：
     *   · 已领过 → 200 + `already_claimed:true`   → `already`
     *   · 未完成 → 400 + `task not completed`     → `skipped`（等真实使用后再领）
     *   · 成功   → 200 + `credit` / `energy`      → `claimed`
     */
    runTasks(): Promise<GrowthTaskOutcome[]>;
    /** 连登兑换：只对 `available` 的档发（7d/14d/28d）。 */
    redeemStreak(): Promise<RedeemOutcome[]>;
    /** 一轮全跑：签到 → 任务 → 连登兑换（单段失败不影响其余）。 */
    runAll(): Promise<GrowthRunReport>;
}
/** 面板渲染（人读）。 */
export declare function renderSigninPanel(p: SigninPanel): string;
/** 领取结果渲染（人读）。 */
export declare function renderClaim(r: ClaimResult): string;
/** 一轮全跑的渲染。 */
export declare function renderRunAll(r: GrowthRunReport): string;
