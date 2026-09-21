#!/usr/bin/env node
'use strict';
/**
 * 用 GitHub REST API 做一次凭据体检：验证 token、报告身份与权限范围。
 *
 * 为什么单独写一个脚本而不是命令行里现拼：
 *  1. 本机 PowerShell 的 Invoke-RestMethod 走 schannel，直连 GitHub 会报
 *     SEC_E_NO_CREDENTIALS（见 AGENTS.md）。Node 自带 fetch 不受影响。
 *  2. Token 只从**环境变量**读，绝不写进任何文件、绝不打印出来 ——
 *     脚本本身可以安全地留在仓库里。
 *
 * 用法：
 *   $env:GH_TOKEN_PAT="github_pat_..."; node tools/gh-check.js
 */

const TOKEN = process.env.GH_TOKEN_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', B: '', x: '' };

if (!TOKEN) {
  console.error(`${C.r}没有拿到 token。${C.x}`);
  console.error(`${C.d}用法：$env:GH_TOKEN_PAT="github_pat_..."; node tools/gh-check.js${C.x}`);
  process.exit(2);
}

/** 打码，任何地方都不许出现完整 token */
const masked = `${TOKEN.slice(0, 11)}…${TOKEN.slice(-4)}（共 ${TOKEN.length} 字符）`;

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'video-vault-setup',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, headers: res.headers, body };
}

(async () => {
  console.log(`\n${C.B}GitHub 凭据体检${C.x}`);
  console.log(`  token: ${C.d}${masked}${C.x}\n`);

  // ---- 1. 身份
  const me = await api('/user');
  if (!me.ok) {
    console.log(`  ${C.r}✘ token 无效或已过期${C.x}  HTTP ${me.status}`);
    console.log(`    ${C.d}${typeof me.body === 'object' ? me.body.message : me.body}${C.x}`);
    process.exitCode = 1;
    return;
  }

  const login = me.body.login;
  console.log(`  ${C.g}✔ 身份有效${C.x}`);
  console.log(`    login      ${C.B}${login}${C.x}`);
  console.log(`    名字       ${me.body.name || '（未设置）'}`);
  console.log(`    主页       ${me.body.html_url}`);
  console.log(`    仓库数     ${me.body.public_repos} 公开 / ${me.body.total_private_repos ?? '?'} 私有`);

  // ---- 2. noreply 邮箱（提交身份要用，避免公开真实邮箱）
  const uid = me.body.id;
  console.log(`\n  ${C.B}noreply 邮箱候选${C.x}`);
  const candidates = [
    `${uid}+${login}@users.noreply.github.com`,
    `${login}@users.noreply.github.com`,
  ];
  for (const c of candidates) console.log(`    ${C.d}${c}${C.x}`);
  console.log(`    ${C.d}（GitHub 设置里开 "Keep my email addresses private" 后，
    上面第一个是官方推荐格式，提交记录会正确关联到你的账号）${C.x}`);

  // ---- 3. token 权限范围
  console.log(`\n  ${C.B}token 权限${C.x}`);
  const scopes = me.headers.get('x-oauth-scopes');
  const isFineGrained = !scopes;
  if (isFineGrained) {
    console.log(`    ${C.d}类型：fine-grained PAT（细粒度）${C.x}`);
    // 细粒度 token 的权限不会在响应头里列出，只能实测
    const probe = await api('/user/repos?per_page=1&affiliation=owner');
    console.log(`    读自己的仓库  ${probe.ok ? `${C.g}✔ 可以${C.x}` : `${C.r}✘ 不行（HTTP ${probe.status}）${C.x}`}`);
    // 创建仓库需要 administration:write —— 只能实际试，试之前先看是否已经有同名仓库
    const existing = await api(`/repos/${login}/video-vault`);
    if (existing.ok) {
      console.log(`    目标仓库      ${C.y}已存在${C.x}  ${existing.body.html_url}`);
    } else if (existing.status === 404) {
      console.log(`    目标仓库      ${C.g}video-vault 还没建，稍后创建${C.x}`);
    } else {
      console.log(`    目标仓库      ${C.y}查询返回 HTTP ${existing.status}${C.x}`);
    }
  } else {
    console.log(`    类型：classic PAT，scopes = ${C.B}${scopes || '(无)'}${C.x}`);
    const need = ['repo'];
    for (const s of need) {
      const has = (scopes || '').split(/,\s*/).includes(s);
      console.log(`    ${has ? `${C.g}✔` : `${C.r}✘`}${C.x} ${s}${has ? '' : '  ← 建仓库/推送需要它'}`);
    }
  }

  console.log(`\n${C.d}把上面的 login 和 noreply 邮箱记下来，提交身份要用。${C.x}`);
  console.log(`${C.y}提醒：这个 token 已经出现在会话记录里，用完请去 GitHub 设置里吊销。${C.x}\n`);
})();
