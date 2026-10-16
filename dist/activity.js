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
import { randomUUID } from 'node:crypto';
import { describeFetchError, fetchWithRetry } from 'waygate-core';
import { UpstreamError } from './errors.js';
import { wbCommonHeaders } from './credential.js';
const REQUEST_TIMEOUT_MS = 20_000;
/** 端点路径（实测）。 */
export const WB_SIGNIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
export const WB_SIGNIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin';
export const WB_GROWTH_TASKS_PATH = '/v2/activity/growth/tasks';
export const WB_GROWTH_TASKS_ACCEPT_PATH = '/v2/activity/growth/tasks/accept';
export const WB_GROWTH_STREAK_PATH = '/v2/activity/growth/streak';
export const WB_GROWTH_REDEEM_PATH = '/v2/activity/growth/redeem';
function num(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
        return Number(v);
    return null;
}
function str(v) {
    return typeof v === 'string' && v ? v : null;
}
/**
 * 活动客户端。
 *
 * `call()` 统一处理信封 `{code,msg,data}`：`code` 非 0 抛错；非 2xx 也读 body 拿上游 `msg`
 * —— 上游的失败原因（如「task not completed」）比 HTTP 状态码有用得多。
 */
export class WbActivity {
    baseUrl;
    getCred;
    getToken;
    constructor(baseUrl, getCred, getToken) {
        this.baseUrl = baseUrl;
        this.getCred = getCred;
        this.getToken = getToken;
    }
    async call(path, init = {}) {
        const cred = this.getCred();
        if (!cred)
            throw new UpstreamError('未导入 WorkBuddy 登录态 —— 先跑 `wb login`。');
        const token = await this.getToken();
        const method = init.method ?? 'POST';
        /* ★ 走 fetchWithRetry：上游有间歇性连接超时，原来"打一次就完"会让用户偶发看到
           `fetch failed`。只重试连接层失败（4xx 不重试，见 core retry.ts 注释）。
           签到/领取上游自带幂等（重复领返回已领状态），故对 POST 重试也是安全的。 */
        let res;
        try {
            res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method,
                headers: { ...wbCommonHeaders(token, cred.uid), 'x-user-id': cred.uid },
                ...(method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
            }, { timeoutMs: REQUEST_TIMEOUT_MS });
        }
        catch (err) {
            /* 把 "fetch failed" 变成可行动的文案（带 cause 码）。 */
            throw new UpstreamError(`连不上 WorkBuddy 上游（${describeFetchError(err)}）—— 网络抖动，请重试`);
        }
        const text = await res.text().catch(() => '');
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch {
            throw new UpstreamError(`${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
        }
        if (!res.ok) {
            const detail = String(parsed.msg ?? '').trim();
            throw new UpstreamError(`${path} 失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
        }
        if (typeof parsed.code === 'number' && parsed.code !== 0) {
            throw new UpstreamError(`${path} 失败（业务码 ${parsed.code}）：${String(parsed.msg ?? '')}`);
        }
        return (parsed.data ?? {});
    }
    /** 查签到状态（只读）。 */
    async panel() {
        const d = await this.call(WB_SIGNIN_STATUS_PATH, { body: {} });
        return {
            active: d.active === true,
            todayCheckedIn: d.today_checked_in === true,
            streak: num(d.streak_days),
            todayCredit: num(d.today_credit) ?? num(d.daily_credit),
            totalCredits: num(d.total_credits),
            activityName: str(d.activity_name),
        };
    }
    /**
     * 签到代领：先查状态，再决定领不领（上游幂等，但白打一次没意义）。
     * 已签 → `already`（不发 claim）；活动未开 → `unavailable`。
     */
    async claimSignin() {
        let status;
        try {
            status = await this.panel();
        }
        catch (err) {
            return { outcome: 'error', points: null, streak: null, message: err.message };
        }
        if (!status.active) {
            return { outcome: 'unavailable', points: null, streak: status.streak, message: '签到活动未开启。' };
        }
        if (status.todayCheckedIn) {
            return { outcome: 'already', points: null, streak: status.streak, message: '今天已经签过了。' };
        }
        try {
            const d = await this.call(WB_SIGNIN_CLAIM_PATH, { body: {} });
            const points = num(d.credit) ?? num(d.daily_credit) ?? num(d.today_credit);
            const streak = num(d.streak_days) ?? num(d.status?.streak_days);
            return {
                outcome: 'claimed',
                points,
                streak,
                message: points !== null ? `签到成功 +${points} 积分。` : '签到成功（上游未回报积分）。',
            };
        }
        catch (err) {
            return { outcome: 'error', points: null, streak: null, message: err.message };
        }
    }
    /** 任务列表（只读）。 */
    async panelTasks() {
        const d = await this.call(WB_GROWTH_TASKS_PATH, { method: 'GET' });
        return Array.isArray(d.tasks) ? d.tasks : [];
    }
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
    async runTasks() {
        let tasks;
        try {
            tasks = await this.panelTasks();
        }
        catch (err) {
            return [{ code: '-', title: null, outcome: 'error', reason: err.message }];
        }
        const titles = new Map();
        const acceptable = tasks.filter((t) => typeof t.task_code === 'string' && t.locked !== true);
        for (const t of acceptable)
            titles.set(String(t.task_code), str(t.title));
        /* 先批量接单（复数数组一次打包）；整体失败也继续逐个 claim —— 有些任务此前已接过。 */
        if (acceptable.length > 0) {
            try {
                await this.call(WB_GROWTH_TASKS_ACCEPT_PATH, { body: { task_codes: acceptable.map((t) => t.task_code) } });
            }
            catch {
                /* 忽略：下面逐个 claim 仍可能成功 */
            }
        }
        const out = [];
        for (const t of acceptable) {
            const code = String(t.task_code);
            try {
                const d = await this.call(`/v2/activity/growth/tasks/${encodeURIComponent(code)}/claim`, { body: {} });
                if (d.already_claimed === true) {
                    out.push({ code, title: titles.get(code) ?? null, outcome: 'already', reason: '此前已领过' });
                    continue;
                }
                const credit = num(d.credit) ?? num(d.credit_granted);
                const energy = num(d.energy);
                const rewards = [
                    credit !== null && credit > 0 ? `+${credit} 积分` : null,
                    energy !== null && energy > 0 ? `+${energy} 能量` : null,
                ].filter(Boolean).join(' ');
                out.push({ code, title: titles.get(code) ?? null, outcome: 'claimed', reason: rewards || '已领取' });
            }
            catch (err) {
                const msg = err.message;
                /* 任务未完成是可预期的业务结果（需在官方端真实使用后才能领），不是系统错误。 */
                const notDone = /not completed|prerequisite|未完成|未达到/i.test(msg);
                out.push({
                    code,
                    title: titles.get(code) ?? null,
                    outcome: notDone ? 'skipped' : 'error',
                    reason: notDone ? '任务未完成（需在官方端真实使用后才能领）' : msg,
                });
            }
        }
        return out;
    }
    /** 连登兑换：只对 `available` 的档发（7d/14d/28d）。 */
    async redeemStreak() {
        let data;
        try {
            data = await this.call(WB_GROWTH_STREAK_PATH, { method: 'GET' });
        }
        catch (err) {
            return [{ tier: '-', ok: false, detail: err.message }];
        }
        const status = (data.redemption_status ?? {});
        const out = [];
        for (const tier of ['7d', '14d', '28d']) {
            const st = status[`tier_${tier}_status`];
            if (st !== 'available') {
                out.push({ tier, ok: false, detail: String(st ?? 'unknown') });
                continue;
            }
            try {
                await this.call(WB_GROWTH_REDEEM_PATH, { body: { tier, client_token: randomUUID() } });
                out.push({ tier, ok: true, detail: '已兑换' });
            }
            catch (err) {
                out.push({ tier, ok: false, detail: err.message });
            }
        }
        return out;
    }
    /** 一轮全跑：签到 → 任务 → 连登兑换（单段失败不影响其余）。 */
    async runAll() {
        const signin = await this.claimSignin();
        const tasks = await this.runTasks();
        const redeem = await this.redeemStreak();
        const claimed = tasks.filter((t) => t.outcome === 'claimed').length;
        const skipped = tasks.filter((t) => t.outcome === 'skipped').length;
        return {
            signin,
            tasks,
            redeem,
            message: `${signin.message}` +
                (tasks.length > 0 ? ` 任务：${claimed} 领到 / ${skipped} 未完成 / 共 ${tasks.length} 项。` : ' 无任务。') +
                (redeem.some((r) => r.ok) ? ` 连登兑换：${redeem.filter((r) => r.ok).map((r) => r.tier).join('、')}。` : ''),
        };
    }
}
/** 面板渲染（人读）。 */
export function renderSigninPanel(p) {
    const lines = [`WorkBuddy 签到状态${p.activityName ? `（${p.activityName}）` : ''}`];
    lines.push('');
    lines.push(`今日已签   ${p.todayCheckedIn ? '是' : '否'}`);
    if (p.streak !== null)
        lines.push(`连续天数   ${p.streak} 天`);
    if (p.todayCredit !== null)
        lines.push(`今日可得   ${p.todayCredit} 积分`);
    if (p.totalCredits !== null)
        lines.push(`累计积分   ${p.totalCredits}`);
    return lines.join('\n');
}
/** 领取结果渲染（人读）。 */
export function renderClaim(r) {
    const icon = r.outcome === 'claimed' ? '✓' : r.outcome === 'error' ? '✗' : '·';
    return `${icon} ${r.message}`;
}
/** 一轮全跑的渲染。 */
export function renderRunAll(r) {
    const lines = [renderClaim(r.signin)];
    if (r.tasks.length > 0) {
        lines.push('');
        lines.push('成长任务：');
        for (const t of r.tasks) {
            const mark = t.outcome === 'claimed' ? '✓' : t.outcome === 'skipped' ? '·' : t.outcome === 'error' ? '✗' : '→';
            lines.push(`  ${mark} ${t.title ?? t.code}　${t.outcome}${t.reason ? `（${t.reason}）` : ''}`);
        }
    }
    if (r.redeem.length > 0) {
        lines.push('');
        lines.push('连登兑换：');
        for (const x of r.redeem)
            lines.push(`  ${x.ok ? '✓' : '·'} ${x.tier}　${x.detail}`);
    }
    lines.push('');
    lines.push('注：任务多为「体验 XX」型 —— 前置条件不满足时如实跳过，不伪造行为去凑。');
    return lines.join('\n');
}
