#!/usr/bin/env node
/**
 * 把 yoka-dsh-billing 推到 GitHub，并向 awesome-dsh-plugin 提收录 PR —— 全自动。
 *
 * 凭据：从文件读 GitHub token（默认 C:\Users\walex lin\.dsh\github-token.txt）。
 *   · 绝不打印 token；
 *   · 先 GET /user 校验身份，不是 niliemi 就停；
 *   · 推送用 git -c http.extraheader 传 Basic，token 不进 remote URL、不落盘。
 *
 * 用法：
 *   node tools/submit-remote.mjs check    # 只体检：token、身份、仓库是否存在、够不够 1 天
 *   node tools/submit-remote.mjs repo     # 建公开仓库 dsh-billing + 打 topic dsh-plugin
 *   node tools/submit-remote.mjs push     # 推 main（直连优先，失败自动重试；本地代理开着就兜底走它）
 *   node tools/submit-remote.mjs pr       # fork 精选列表 → 加条目 → 开 PR（仓库不满 1 天会拒绝）
 *   node tools/submit-remote.mjs all      # repo + push（满 1 天则连 pr 一起）
 *   加 --force 可跳过「仓库满 1 天」检查（不推荐：CI 会失败）
 *
 * 网络：github.com:443 在本机时通时不通，所以 git 走网的每一步都「直连优先 × N 次」，
 *   全失败后再看本地代理端口是否开着（HTTPS_PROXY / http://127.0.0.1:7877 等）。
 *   重试次数用环境变量 GIT_NET_RETRIES 改（默认 3）。api.github.com 不受此影响。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "niliemi";
const REPO = "dsh-billing";
const UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
const ENTRY_PATH = "data/plugins/niliemi__dsh-billing.yml";
const BRANCH = "add-niliemi-dsh-billing";
const PR_TITLE = "Add niliemi/dsh-billing (usage)";
const TOKEN_FILE = process.env.GITHUB_TOKEN_FILE ?? join(process.env.USERPROFILE ?? "", ".dsh", "github-token.txt");
const DAY_MS = 24 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const step = (args.find((a) => !a.startsWith("--")) ?? "check").toLowerCase();
const force = args.includes("--force");
const log = (...a) => console.log(...a);
const die = (m) => { console.error("✖ " + m); process.exit(1); };

// ---------- token ----------
function readToken() {
  if (!existsSync(TOKEN_FILE)) die(`找不到 token 文件：${TOKEN_FILE}\n  请把 GitHub token 存成这个路径的纯文本文件（只放 token 一行）。`);
  const t = readFileSync(TOKEN_FILE, "utf8").trim();
  if (!t) die(`token 文件是空的：${TOKEN_FILE}`);
  if (/\s/.test(t)) die(`token 文件里除了 token 还有别的字符（${t.split(/\s+/).length} 段）——请只放一行 token。`);
  return t;
}

let TOKEN = null;
async function api(method, path, body) {
  const r = await fetch(path.startsWith("http") ? path : "https://api.github.com" + path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "yoka-dsh-billing-submit",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, ok: r.ok, json };
}

function git(...argv) {
  return execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitTry(argv) {
  try {
    return { ok: true, out: execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, err: String(e.stderr ?? e.message).trim().split("\n")[0] };
  }
}

const NET_RETRIES = Math.max(1, Number(process.env.GIT_NET_RETRIES ?? 3) || 3);

/** 这台机器上的代理候选：环境变量优先，再看那个常见的本地端口。 */
function proxyCandidates() {
  const list = [];
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const v = process.env[k];
    if (v && !/^direct:\/\//i.test(v)) list.push(v);
  }
  list.push("http://127.0.0.1:7877");
  return [...new Set(list)];
}

function tcpOpen(proxyUrl, timeoutMs = 500) {
  return new Promise((resolvePromise) => {
    let url;
    try {
      url = new URL(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`);
    } catch {
      resolvePromise(false);
      return;
    }
    const sock = connect({ host: url.hostname, port: Number(url.port || 80) });
    const done = (open) => { sock.destroy(); resolvePromise(open); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * 走网络的 git 命令：先直连（显式把 URL 专用代理置空）× NET_RETRIES 次，再依次试「端口真的开着」的代理。
 * 返回 stdout；全部失败则抛带 stderr 摘要的错误。
 */
async function gitNet(argv, { label = argv[0], quiet = false } = {}) {
  const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  const auth = ["-c", `http.extraheader=AUTHORIZATION: basic ${b64}`];
  const plans = [];
  for (let i = 1; i <= NET_RETRIES; i += 1) {
    plans.push({ label: `直连${i > 1 ? `（第 ${i} 次）` : ""}`, cfg: ["-c", "http.https://github.com.proxy="] });
  }
  for (const proxy of proxyCandidates()) {
    if (await tcpOpen(proxy)) plans.push({ label: `经代理 ${proxy}`, cfg: ["-c", `http.https://github.com.proxy=${proxy}`] });
  }
  const failed = [];
  for (const plan of plans) {
    const r = gitTry([...plan.cfg, ...auth, ...argv]);
    if (r.ok) {
      if (failed.length && !quiet) log(`（${label}：${plan.label} 成功，前面失败 ${failed.length} 次）`);
      return r.out;
    }
    failed.push(`${plan.label}: ${r.err}`);
    if (!quiet) log(`  ${label} · ${plan.label} 失败：${r.err}`);
  }
  const err = new Error(`${label} 失败 ${failed.length} 次`);
  err.stderr = failed.join(" ｜ ");
  throw err;
}

// ---------- steps ----------
async function preflight() {
  TOKEN = readToken();
  log(`token 文件：${TOKEN_FILE}（长度 ${TOKEN.length}，内容不显示）`);
  const me = await api("GET", "/user");
  if (!me.ok) die(`token 无效或权限不足：GET /user → ${me.status}`);
  log(`身份：${me.json.login}（${me.json.html_url}）`);
  if (me.json.login.toLowerCase() !== OWNER) die(`token 属于 ${me.json.login}，而本仓库写的是 ${OWNER}——请换 token 或改脚本里的 OWNER。`);
  return me.json;
}

async function check() {
  await preflight();
  const r = await api("GET", `/repos/${OWNER}/${REPO}`);
  if (r.status === 404) { log(`仓库 ${OWNER}/${REPO}：不存在（可建）`); return { repo: null }; }
  if (!r.ok) die(`查仓库失败：${r.status}`);
  const created = new Date(r.json.created_at);
  const ageH = (Date.now() - created.getTime()) / 3.6e6;
  log(`仓库 ${OWNER}/${REPO}：已存在，创建于 ${created.toISOString()}，年龄 ${ageH.toFixed(1)} 小时`);
  log(`  topics: ${(r.json.topics ?? []).join(", ") || "(无)"}  默认分支: ${r.json.default_branch}`);
  log(`  CI 的「满 1 天」检查：${ageH >= 24 ? "✅ 已满足，可以提 PR" : `⏳ 还差 ${(24 - ageH).toFixed(1)} 小时`}`);
  return { repo: r.json, ageH };
}

async function repo() {
  await preflight();
  const cur = await api("GET", `/repos/${OWNER}/${REPO}`);
  if (cur.status === 404) {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const c = await api("POST", "/user/repos", { name: REPO, description: pkg.description, private: false, has_issues: true, has_wiki: false, auto_init: false });
    if (!c.ok && c.status !== 422) die(`建仓库失败：${c.status} ${JSON.stringify(c.json)}`);
    log(c.status === 422 ? `仓库已存在（422）` : `已建公开仓库 ${OWNER}/${REPO}`);
  } else {
    log(`仓库已存在：${OWNER}/${REPO}`);
  }
  const t = await api("PUT", `/repos/${OWNER}/${REPO}/topics`, { names: ["dsh-plugin", "dsh", "billing", "usage", "cost", "tokens", "deepseek-harness"] });
  log(t.ok ? `topics 已设为：dsh-plugin, dsh, billing, usage, cost, tokens, deepseek-harness` : `⚠ 设 topics 失败：${t.status} ${JSON.stringify(t.json)}`);
}

async function push() {
  await preflight();
  const url = `https://github.com/${OWNER}/${REPO}.git`;
  try {
    const head = await gitNet(["ls-remote", url, "HEAD"], { label: "ls-remote", quiet: true });
    log(`远端可写：${head ? head.split(/\s+/)[0] : "(空仓库)"}`);
  } catch (e) {
    log(`远端 ls-remote 没连上（空仓库 / 还没建 / 网络抖动）：${String(e.stderr ?? e.message).split(" ｜ ")[0]}`);
  }
  const dirty = git("status", "--porcelain");
  if (dirty) die(`工作区不干净，先提交：\n${dirty}`);
  try {
    const out = await gitNet(["push", url, "main:main"], { label: "push" });
    log(out || "（无输出）");
  } catch (e) {
    die(`push 失败（直连与代理都试过了）：${String(e.stderr ?? e.message)}`);
  }
  const sha = git("rev-parse", "HEAD");
  log(`✅ 已推送 ${sha.slice(0, 7)} → https://github.com/${OWNER}/${REPO}`);
}

async function pr() {
  await preflight();
  const info = await check();
  if (!info.repo) die(`仓库还不存在，先跑 repo + push。`);
  if (info.ageH < 24 && !force) {
    die(`仓库年龄 ${info.ageH.toFixed(1)} 小时 < 24：精选列表 CI 会直接失败。\n  等满 24 小时后再跑；确有把握可用 --force。`);
  }
  // fork
  let fork = await api("GET", `/repos/${OWNER}/${UPSTREAM.split("/")[1]}`);
  if (fork.status === 404) {
    const f = await api("POST", `/repos/${UPSTREAM}/forks`, { default_branch_only: true });
    if (!f.ok && f.status !== 202) die(`fork 失败：${f.status} ${JSON.stringify(f.json)}`);
    log(`已发起 fork → ${OWNER}/${UPSTREAM.split("/")[1]}，等待就绪…`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      fork = await api("GET", `/repos/${OWNER}/${UPSTREAM.split("/")[1]}`);
      if (fork.ok) break;
    }
    if (!fork.ok) die(`fork 一直没就绪（最后一次 ${fork.status}）`);
  }
  log(`fork 就绪：${fork.json.full_name}（默认分支 ${fork.json.default_branch}）`);
  const forkName = fork.json.full_name;

  // 分支
  const base = fork.json.default_branch;
  const ref = await api("GET", `/repos/${forkName}/git/ref/heads/${base}`);
  if (!ref.ok) die(`取分支失败：${ref.status}`);
  const baseSha = ref.json.object.sha;
  const mk = await api("POST", `/repos/${forkName}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: baseSha });
  if (!mk.ok && mk.status !== 422) die(`建分支失败：${mk.status} ${JSON.stringify(mk.json)}`);
  log(`分支 ${BRANCH} 就绪（基于 ${base}@${baseSha.slice(0, 7)}）`);

  // 条目文件（以本仓库的 submission/data-plugins-entry.yml 为唯一来源）
  const content = readFileSync(join(ROOT, "submission", "data-plugins-entry.yml"), "utf8");
  const existing = await api("GET", `/repos/${forkName}/contents/${ENTRY_PATH}?ref=${BRANCH}`);
  const body = {
    message: `Add ${OWNER}/${REPO} (usage)`,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: BRANCH,
    ...(existing.ok ? { sha: existing.json.sha } : {}),
  };
  const put = await api("PUT", `/repos/${forkName}/contents/${ENTRY_PATH}`, body);
  if (!put.ok) die(`写条目失败：${put.status} ${JSON.stringify(put.json)}`);
  log(`已写入 ${ENTRY_PATH}`);

  // PR
  const prBody = readFileSync(join(ROOT, "submission", "PR-body.md"), "utf8");
  const p = await api("POST", `/repos/${UPSTREAM}/pulls`, { title: PR_TITLE, head: `${OWNER}:${BRANCH}`, base, body: prBody });
  if (!p.ok) {
    if (p.status === 422) die(`开 PR 失败（422）：可能已存在同分支 PR，去看 https://github.com/${UPSTREAM}/pulls?q=${OWNER}\n${JSON.stringify(p.json)}`);
    die(`开 PR 失败：${p.status} ${JSON.stringify(p.json)}`);
  }
  log(`✅ PR 已开：#${p.json.number} ${p.json.html_url}`);
}

const steps = { check, repo, push, pr };
if (step === "all") {
  await repo();
  await push();
  const info = await check();
  if (info.repo && info.ageH >= 24) await pr();
  else log(`\n下一步：等仓库满 24 小时后跑  node tools/submit-remote.mjs pr`);
} else if (steps[step]) {
  await steps[step]();
} else {
  die(`未知步骤 "${step}"，可用：check | repo | push | pr | all`);
}
