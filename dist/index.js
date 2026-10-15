#!/usr/bin/env node
/**
 * waygate-workbuddy —— WorkBuddy 本地反代（命令 `wb`）。
 *
 * 读取本机保存的官方 API 密钥（`ck_`），在本机提供 OpenAI/Anthropic 兼容的聊天端点；
 * 按官方桌面端指纹出站（用量归因到 WorkBuddy 使用端），并越过上游的几条隐形硬约束。
 *
 * 可选导入 OAuth 凭证以启用**签到代领 / 成长任务**（上游规定该域不接受 API 密钥）。
 * 详见 README。
 */
import { createRequire } from 'node:module';
import { runCli } from 'waygate-core';
import { createWorkBuddyAdapter } from './adapter.js';
/* 版本从 package.json 读 —— 硬编码会与 npm 发布版本漂移。 */
const VERSION = createRequire(import.meta.url)('../package.json').version;
const code = await runCli(createWorkBuddyAdapter(), { version: VERSION });
process.exit(code);
