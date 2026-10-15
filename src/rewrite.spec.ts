/**
 * 出站改写单测 —— 上游那几条隐形硬约束的守卫。
 * 每一条都对应一个实测 400：违反就整条请求挂掉（且错误码不解释原因）。
 */

import { describe, expect, it } from 'vitest';
import type { ChatRequestBody } from 'waygate-core';
import { MIN_MAX_TOKENS, NEUTRAL_SYSTEM_PROMPT, rewriteRequestBody } from './rewrite.js';

function body(over: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], ...over } as ChatRequestBody;
}

/** 自定义 role（developer/knowledge…）**正是被测对象**，故这里放宽类型。 */
function msg(role: string, content: string, extra: Record<string, unknown> = {}) {
  return { role, content, ...extra } as never;
}

describe('① developer → system（上游只拒精确小写 developer）', () => {
  it('任意位置的 developer 就地改成 system（保序保内容）', () => {
    const r = rewriteRequestBody(
      body({
        messages: [
          msg('developer', 'be nice'),
          { role: 'user', content: 'hi' },
        ],
      }),
    );
    expect(r.body.messages[0]?.role).toBe('system');
    expect(r.body.messages[0]?.content).toBe('be nice');
    expect(r.notes).toContain('developer_role_normalized');
  });

  it('大小写不敏感（Developer 也收口）', () => {
    const r = rewriteRequestBody(body({ messages: [msg('Developer', 'x')] }));
    expect(r.body.messages[0]?.role).toBe('system');
  });
});

describe('①b 白名单外 role 降级为 user（保内容）', () => {
  it('自定义 role 降级，note 记录原始名', () => {
    const r = rewriteRequestBody(
      body({
        messages: [
          { role: 'system', content: 's' },
          msg('knowledge', 'ctx'),
        ],
      }),
    );
    expect(r.body.messages[1]?.role).toBe('user');
    expect(r.body.messages[1]?.content).toBe('ctx');
    expect(r.notes.some((n) => n.startsWith('role_normalized_knowledge'))).toBe(true);
  });

  it('tool 在白名单内，不动', () => {
    const r = rewriteRequestBody(
      body({
        messages: [
          { role: 'system', content: 's' },
          msg('tool', 'r', { tool_call_id: 't1' }),
        ],
      }),
    );
    expect(r.body.messages[1]?.role).toBe('tool');
  });
});

describe('② system 补全', () => {
  it('首条非 system 时头部插入中性提示', () => {
    const r = rewriteRequestBody(body());
    expect(r.body.messages[0]?.role).toBe('system');
    expect(r.body.messages[0]?.content).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(r.notes).toContain('system_injected');
  });

  it('已有 system 头时不多插', () => {
    const r = rewriteRequestBody(body({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] }));
    expect(r.body.messages.length).toBe(2);
    expect(r.notes).not.toContain('system_injected');
  });
});

describe('③ stream 强制为 true（上游 11101）', () => {
  it('stream:false 被改为 true', () => {
    const r = rewriteRequestBody(body({ stream: false }));
    expect(r.body.stream).toBe(true);
  });
});

describe('④ max_tokens 下限（上游 11133）', () => {
  it('小于 16 时提升到 16', () => {
    const r = rewriteRequestBody(body({ max_tokens: 5 }));
    expect(r.body.max_tokens).toBe(MIN_MAX_TOKENS);
    expect(r.notes).toContain('max_tokens_raised_5_to_16');
  });

  it('未提供时不主动补（不改变用户语义）', () => {
    const r = rewriteRequestBody(body());
    expect('max_tokens' in r.body).toBe(false);
  });

  it('大于等于下限时不动', () => {
    const r = rewriteRequestBody(body({ max_tokens: 100 }));
    expect(r.body.max_tokens).toBe(100);
  });
});

describe('⑤ stream_options 删除', () => {
  it('删除该字段并记 note', () => {
    const r = rewriteRequestBody(body({ stream_options: { include_usage: true } }));
    expect('stream_options' in r.body).toBe(false);
    expect(r.notes).toContain('stream_options_stripped');
  });
});

describe('⑥ system 模板行改写（上游 n-gram 指纹）', () => {
  it('template 档：改写 Claude Code 血统的模板行', () => {
    const r = rewriteRequestBody(
      body({
        messages: [
          {
            role: 'system',
            content: 'Current branch: main\nGit user: someone\nYou are Claude Code',
          },
          { role: 'user', content: 'hi' },
        ],
      }),
      { promptRewrite: 'template' },
    );
    const sys = r.body.messages[0]?.content as string;
    expect(sys).toContain('Active branch:');
    expect(sys).toContain('Git author:');
    expect(sys).toContain('You are an interactive coding agent');
    expect(sys).not.toContain('You are Claude Code');
    expect(r.notes.some((n) => n.startsWith('template_rewritten_'))).toBe(true);
  });

  it('neutral 档：整段换成中性提示', () => {
    const r = rewriteRequestBody(
      body({ messages: [{ role: 'system', content: 'Current branch: main' }, { role: 'user', content: 'hi' }] }),
      { promptRewrite: 'neutral' },
    );
    expect(r.body.messages[0]?.content).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(r.notes.some((n) => n.startsWith('sysprompt_neutralized_'))).toBe(true);
  });

  it('off 档：原样不动', () => {
    const original = 'Current branch: main';
    const r = rewriteRequestBody(body({ messages: [{ role: 'system', content: original }, { role: 'user', content: 'hi' }] }), {
      promptRewrite: 'off',
    });
    expect(r.body.messages[0]?.content).toBe(original);
  });

  it('content 为 parts 数组时只改 text 字段，结构不动', () => {
    const r = rewriteRequestBody(
      body({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Current branch: main' }] },
          { role: 'user', content: 'hi' },
        ],
      }),
      { promptRewrite: 'template' },
    );
    const parts = r.body.messages[0]?.content as Array<{ type: string; text: string }>;
    expect(parts[0]?.type).toBe('text');
    /* 规则只替换前缀标签，值（main）保留 —— 破坏 n-gram 已足够，不必改内容。 */
    expect(parts[0]?.text).toBe('Active branch: main');
  });
});

describe('纯函数（不改传入对象）', () => {
  it('原 body 与 messages 都不被改动', () => {
    const input = body({ messages: [msg('developer', 'x')] });
    const snapshot = JSON.stringify(input);
    rewriteRequestBody(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
