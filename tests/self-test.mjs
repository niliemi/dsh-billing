/**
 * 宿主半边自测：折叠 / 计价 / 全局上限=余额 / 单会话上限 / 守卫 / 路由 / 持久化。
 * 用法：node tests/self-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { apply } from "../lib/index.js";

let failed = 0;
let passed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

function near(label, actual, expected, epsilon = 1e-9) {
  if (typeof actual === "number" && Math.abs(actual - expected) <= epsilon) {
    passed += 1;
    console.log(`  ok   ${label} (${actual})`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}: expected ≈${expected}, actual ${actual}`);
  }
}

/* --------------------------------- 夹具 --------------------------------- */

function makeCtx(account) {
  const routes = new Map();
  const listeners = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    webServer: { register: (route) => (routes.set(route.path, route.handler), () => routes.delete(route.path)) },
    get: (name) => (name === "deepseekAccount" ? account : undefined),
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() });
      return () => {};
    },
    routes,
    listeners,
    effects,
    logs,
  };
  return ctx;
}

/** 假的 DeepSeek 账户服务：`value` 是充值钱包，`bonus` 是赠金钱包。 */
function makeAccount({ value = [], bonus = [], status = "credential-stored", topUpUrl = "https://platform.deepseek.com/top_up" } = {}) {
  return {
    async getBalance() {
      return { status: "ready", value, bonusWallets: bonus };
    },
    async getState() {
      return { status, links: { topUpUrl, usageUrl: "https://platform.deepseek.com/usage" }, attempt: null };
    },
  };
}

const cny = (amount) => ({ currency: "CNY", balance: String(amount) });
const usd = (amount) => ({ currency: "USD", balance: String(amount) });

function makeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
}

async function call(ctx, path, { method = "GET", body, headers = {}, socket } = {}) {
  const handler = ctx.routes.get(path.split("?")[0]);
  if (!handler) throw new Error(`未注册路由 ${path}`);
  const base = {
    method,
    url: path,
    headers: { "sec-fetch-site": "same-origin", ...headers },
    socket: socket ?? { remoteAddress: "127.0.0.1" },
  };
  const req =
    body === undefined
      ? base
      : Object.assign(Readable.from([Buffer.from(JSON.stringify(body), "utf8")]), base, {
          headers: { ...base.headers, "content-type": "application/json" },
        });
  const res = makeRes();
  await handler(req, res);
  return res;
}

/** 读状态并强制刷新余额，避免 TTL 缓存让用例不确定。 */
async function stateOf(ctx, sessionId = "") {
  const suffix = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
  return (await call(ctx, `/plugin-billing/state?refresh=1${suffix}`)).body;
}

async function post(ctx, path, body) {
  return (await call(ctx, path, { method: "POST", body })).body;
}

function fakeSession(id, events) {
  return {
    id,
    get seq() {
      return events.length;
    },
    eventAt(index) {
      return events[index];
    },
    events,
  };
}

const header = (provider, model) => ({ type: "request/header", data: { header: { config: { provider, model } } } });
const usage = (turn, step, u) => ({ type: "assistant/message", data: { turn, step, usage: u } });
const payloadOf = (id) => ({ agent: { session: { id } } });

async function preStep(ctx, payload = {}) {
  const handlers = ctx.listeners.get("agent/pre-step") ?? [];
  let decision = { kind: "enter", messages: [] };
  for (const handler of handlers) {
    const inner = decision;
    decision = await handler(payload, async () => inner);
  }
  return decision;
}

function emit(ctx, session) {
  for (const handler of ctx.listeners.get("session/event") ?? []) handler(session);
}

/* --------------------------------- 用例 --------------------------------- */

const dir = mkdtempSync(join(tmpdir(), "yoka-billing-"));
const storeFile = join(dir, "ledger.json");

try {
  /* 1. 折叠与计价 --------------------------------------------------------- */
  console.log("\n[1] 折叠与官方价目表计价");
  const ctx = makeCtx(makeAccount({ value: [cny(1000)], bonus: [usd(1)] }));
  apply(ctx, { storeFile });
  const session = fakeSession("s1", []);
  emit(ctx, session);
  session.events.push(header("deepseek", "deepseek-v4-pro"));
  session.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 4000000, cacheWriteTokens: 0 }));
  emit(ctx, session);
  let state = await stateOf(ctx);
  // 1e6*1.32 + 1e5*3.96 + 4e6*0.044 = 1.32 + 0.396 + 0.176 = 1.892 USD
  near("usedUSD = 1.32+0.396+0.176", state.usedUSD, 1.892);
  near("usedCNY = USD × 7.2", state.usedCNY, 1.892 * 7.2);
  check("四类 token 累计", state.tokens, [1000000, 100000, 4000000, 0]);
  check("模型键", state.breakdown[0]?.key, "deepseek/deepseek-v4-pro");
  check("价格来源", state.breakdown[0]?.source, "official");
  check("官方单价", state.breakdown[0]?.price, [1.32, 3.96, 0.044, 0]);
  check("当前路由", state.current?.key, "deepseek/deepseek-v4-pro");
  check("未阻断", state.blocked, false);

  /* 2. 同一 (turn,step) 重采样是替换而非累加 ------------------------------ */
  console.log("\n[2] 同一 (turn,step) 的重采样必须替换");
  session.events.push(usage(1, 1, { inputTokens: 2000000, outputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx, session);
  state = await stateOf(ctx);
  near("替换后 USD", state.usedUSD, 2 * 1.32 + 0.396); // 3.036
  check("替换后 token", state.tokens, [2000000, 100000, 0, 0]);

  /* 3. 新 step 累加 ------------------------------------------------------- */
  console.log("\n[3] 新 step 累加");
  session.events.push(usage(2, 1, { inputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx, session);
  state = await stateOf(ctx);
  near("累加后 USD", state.usedUSD, 3.036 + 3.96);
  check("token 总数", state.tokens, [2000000, 1100000, 0, 0]);

  /* 4. llm/retry-started 清槽 ------------------------------------------- */
  console.log("\n[4] llm/retry-started 后重采样仍为替换");
  session.events.push({ type: "llm/retry-started", data: { turn: 2, step: 1 } });
  session.events.push(usage(2, 1, { inputTokens: 0, outputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx, session);
  state = await stateOf(ctx);
  near("重试后 USD", state.usedUSD, 3.036 + 2 * 3.96);

  /* 5. 汇率/单价改动立即重算历史 ---------------------------------------- */
  console.log("\n[5] 改规则立即重算全部历史");
  const before = state.usedCNY;
  state = await post(ctx, "/plugin-billing/config", { rate: 10 });
  near("汇率 10 → CNY = USD × 10", state.usedCNY, state.usedUSD * 10);
  check("USD 不随汇率变", state.usedUSD, 3.036 + 2 * 3.96);
  state = await post(ctx, "/plugin-billing/config", { price: { key: "deepseek/deepseek-v4-pro", value: [0, 0, 0, 0] } });
  near("单价全 0 → 费用为 0", state.usedCNY, 0);
  check("覆盖来源", state.breakdown[0]?.source, "override");
  state = await post(ctx, "/plugin-billing/config", { price: { key: "deepseek/deepseek-v4-pro", reset: true }, rate: 7.2 });
  near("恢复官方价", state.usedUSD, 3.036 + 2 * 3.96);
  check("恢复后来源", state.breakdown[0]?.source, "official");
  check("历史按旧汇率折算过", before > 0, true);
  const usdAfterRules = state.usedUSD;

  /* 6. 全局上限由主人自设；留空 = 不设，超过余额夹到余额 ----------------- */
  console.log("\n[6] 全局上限（自设 + 余额夹取）");
  state = await stateOf(ctx);
  check("默认不设上限", [state.ceiling, state.ceilingSource, state.ceilingAvailable], [0, "unset", false]);
  check("不设上限 → 不阻断", state.blocked, false);
  near("余额仍可读（充值 1000 + 赠金 1 USD×7.2）", state.balance.cny, 1007.2);
  check("钱包两行（充值在前）", (state.balance.wallets ?? []).map((w) => w.bonus), [false, true]);
  near("赠金折算成 CNY", state.balance.bonusCNY, 7.2);
  check("已登录", state.balance.signedIn, true);
  check("充值入口存在", typeof state.balance.topUpUrl, "string");

  state = await post(ctx, "/plugin-billing/config", { limit: 500 });
  near("自设 500 → 上限就是 500", state.ceiling, 500);
  check("来源是自设（未夹取）", [state.ceilingSource, state.ceilingClamped], ["limit", false]);
  near("余额只当边界", state.balanceCap, 1007.2);
  near("占用百分比", state.percent, (state.usedCNY / 500) * 100, 1e-6);

  state = await post(ctx, "/plugin-billing/config", { limit: 5000 });
  near("自设 5000 → 夹到余额", state.ceiling, 1007.2);
  check("来源是夹取", [state.ceilingSource, state.ceilingClamped], ["limit-clamped", true]);
  check("夹取时响应带 limitClamped", state.limitClamped, true);
  near("原值仍保留在账本里", state.limit, 5000);

  state = await post(ctx, "/plugin-billing/config", { limit: 0 });
  check("清零 → 回到不设上限", [state.ceiling, state.ceilingSource], [0, "unset"]);

  const emptyCtx = makeCtx(makeAccount({ value: [] }));
  apply(emptyCtx, { storeFile: join(dir, "empty.json") });
  const emptyState = await stateOf(emptyCtx);
  check("余额为 0 → 上限仍未设", [emptyState.ceiling, emptyState.ceilingSource], [0, "unset"]);
  check("余额为 0 → 不阻断", emptyState.blocked, false);
  const emptySet = await post(emptyCtx, "/plugin-billing/config", { limit: 50 });
  near("余额为 0 时不夹取：自设 50 生效", emptySet.ceiling, 50);

  const noAccountCtx = makeCtx(undefined);
  apply(noAccountCtx, { storeFile: join(dir, "noaccount.json") });
  const noAccount = await stateOf(noAccountCtx);
  check("账户服务缺失 → 上限未设", [noAccount.ceiling, noAccount.ceilingSource], [0, "unset"]);
  check("账户服务缺失 → 有可读错误", noAccount.balance.error.length > 0, true);
  const noAccountSet = await post(noAccountCtx, "/plugin-billing/config", { limit: 7 });
  check("账户服务缺失 → 自设上限照旧生效", [noAccountSet.ceiling, noAccountSet.ceilingSource], [7, "limit"]);

  /* 7. 守卫：超过自设上限 → reject，放行语义 ----------------------------- */
  console.log("\n[7] agent/pre-step 守卫（全局）");
  const ctx7 = makeCtx(makeAccount({ value: [cny(9.5)] }));
  apply(ctx7, { storeFile: join(dir, "guard.json") });
  await post(ctx7, "/plugin-billing/config", { limit: 5 }); // 自设 5 < 用量 9.504
  const s7 = fakeSession("s7", []);
  emit(ctx7, s7);
  s7.events.push(header("deepseek", "deepseek-v4-pro"));
  s7.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx7, s7); // 1.32 USD = 9.504 CNY ≥ 自设上限 5
  const hit7 = await stateOf(ctx7);
  near("用量 9.504", hit7.usedCNY, 9.504);
  check("超过自设上限 → blocked", [hit7.blocked, hit7.blockScope], [true, "global"]);
  check("entry 决策被拒绝", (await preStep(ctx7, payloadOf("s7"))).kind, "reject");
  const blockedState = await stateOf(ctx7);
  check("阻断时间戳已记录", blockedState.lastBlockAt > 0, true);
  check("阻断范围记的是全局", blockedState.lastBlock?.scope, "global");
  check("重复调用仍拒绝", (await preStep(ctx7, payloadOf("s7"))).kind, "reject");

  let st = await post(ctx7, "/plugin-billing/override", { mode: "once" });
  check("放行一次后 blocked=false", st.blocked, false);
  check("第一次放行通过", (await preStep(ctx7, payloadOf("s7"))).kind, "enter");
  check("第二次又拒绝", (await preStep(ctx7, payloadOf("s7"))).kind, "reject");

  st = await post(ctx7, "/plugin-billing/override", { mode: "session", sessionId: "s7" });
  check("单会话放行不越过全局上限", (await preStep(ctx7, payloadOf("s7"))).kind, "reject");

  st = await post(ctx7, "/plugin-billing/override", { mode: "session" });
  check("整会话放行（旧语义）", st.overrideSession, true);
  check("整会话放行生效", (await preStep(ctx7, payloadOf("s7"))).kind, "enter");

  await post(ctx7, "/plugin-billing/override", { mode: "reset" });
  await post(ctx7, "/plugin-billing/config", { guard: false });
  check("守卫关闭 → 不阻断", (await preStep(ctx7, payloadOf("s7"))).kind, "enter");
  await post(ctx7, "/plugin-billing/config", { guard: true });

  check(
    "链上他人拒绝时本插件不改变决策",
    (
      await (async () => {
        const handlers = ctx.listeners.get("agent/pre-step") ?? [];
        let decision = { kind: "reject", reason: "别的插件" };
        for (const handler of handlers) {
          const inner = decision;
          decision = await handler({}, async () => inner);
        }
        return decision;
      })()
    ).reason,
    "别的插件",
  );

  /* 8. 账本只存 token，不存金额 ----------------------------------------- */
  console.log("\n[8] 持久化：只存 token");
  const raw = JSON.parse(readFileSync(storeFile, "utf8"));
  const text = JSON.stringify(raw);
  check("账本无 CNY 字段", /"cny"|"usedCNY"/i.test(text), false);
  check("账本记录了模型键", raw.sessions.s1.steps["1:1"].m, "deepseek/deepseek-v4-pro");
  check("账本记录了 4 类 token", raw.sessions.s1.steps["1:1"].t, [2000000, 100000, 0, 0]);
  check("账本版本 3", raw.version, 3);
  check("账本带单会话字段", Array.isArray(Object.keys(raw.sessionLimits)), true);

  /* 9. 重启后按新汇率现算 ----------------------------------------------- */
  console.log("\n[9] 重启后按当前规则重算");
  const ctx2 = makeCtx(makeAccount({ value: [cny(1000)] }));
  apply(ctx2, { storeFile, rate: 3 });
  const fresh = await stateOf(ctx2);
  near("重启后沿用 7.2 汇率（账本优先）", fresh.rate, 7.2);
  near("重启后重算出的 CNY", fresh.usedCNY, fresh.usedUSD * 7.2);
  near("重启后 USD 与内存态一致", fresh.usedUSD, usdAfterRules, 1e-9);

  /* 10. 未知模型 → 估算价 ----------------------------------------------- */
  console.log("\n[10] 未识别路由用估算价");
  const ctx3 = makeCtx(makeAccount({ value: [cny(1000)] }));
  apply(ctx3, { storeFile: join(dir, "l3.json") });
  const s3 = fakeSession("s3", []);
  emit(ctx3, s3);
  s3.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx3, s3);
  const st3 = await stateOf(ctx3);
  check("未识别键", st3.breakdown[0]?.key, "(未识别路由)");
  check("估算来源", st3.breakdown[0]?.source, "fallback");
  near("估算价 1 USD/1M 输入", st3.usedUSD, 1);

  /* 11. 路由守卫与定价接口 ---------------------------------------------- */
  console.log("\n[11] HTTP 路由守卫");
  const untrusted = await call(ctx, "/plugin-billing/state", {
    headers: { "sec-fetch-site": "cross-site" },
    socket: { remoteAddress: "10.1.2.3" },
  });
  check("不可信请求 403", untrusted.status, 403);
  const cookieTrusted = await call(ctx, "/plugin-billing/state", {
    headers: { "sec-fetch-site": "cross-site", cookie: "dsh-auth-token=abc" },
    socket: { remoteAddress: "10.1.2.3" },
  });
  check("带 dsh-auth- cookie 放行", cookieTrusted.status, 200);
  const loopback = await call(ctx, "/plugin-billing/state", {
    headers: { "sec-fetch-site": "cross-site" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  check("本机回环放行", loopback.status, 200);
  check("错误方法 405", (await call(ctx, "/plugin-billing/state", { method: "POST", body: {} })).status, 405);
  const pricing = (await call(ctx, "/plugin-billing/pricing?q=deepseek-v4-pro")).body;
  check("定价接口命中", pricing.rows?.[0]?.key, "deepseek/deepseek-v4-pro");
  check("价目表总数 > 500", pricing.count > 500, true);
  const diag = (await call(ctx, "/plugin-billing/diag")).body;
  check("diag 暴露余额", [diag.balance.available, diag.balance.cny], [true, 1007.2]);
  check("diag 暴露单会话上限表", diag.sessionLimits && typeof diag.sessionLimits === "object", true);

  /* 12. 重置计费起点（默认软重置：前移基线，累计保留） ------------------- */
  console.log("\n[12] 重置计费起点（默认软重置）");
  const before12 = (await call(ctx, "/plugin-billing/state")).body;
  check("重置前有累计", before12.totalCNY > 0, true);
  near("重置前本次 = 累计", before12.usedCNY, before12.totalCNY);
  const zeroed = await post(ctx, "/plugin-billing/reset", {});
  near("重置后本次 CNY = 0", zeroed.usedCNY, 0);
  near("重置后累计不变", zeroed.totalCNY, before12.totalCNY);
  near("前移额 = 重置前的本次", zeroed.baselineCNY, before12.usedCNY);
  check("重置后不再阻断", zeroed.blocked, false);
  check("重置后本次明细为 0、累计明细仍在", zeroed.breakdown.length > 0 && zeroed.breakdown.every((row) => row.cny === 0 && row.totalCNY > 0), true);
  check("重置时间已记录", zeroed.resetAt > 0, true);
  check("重置后 token 记录没被抹掉", zeroed.totalTokens.some((v) => v > 0), true);

  const wiped = await post(ctx, "/plugin-billing/reset", { hard: true });
  near("硬重置清掉累计", wiped.totalCNY, 0);
  check("硬重置后无明细", wiped.breakdown.length, 0);

  /* 13. effect 清理 ------------------------------------------------------- */
  console.log("\n[13] effect 清理器");
  check("注册了 1 个 effect", ctx.effects.length, 1);
  ctx.effects[0].dispose();
  check("清理后路由已注销", ctx.routes.size, 0);

  /* 14. 单会话上限（默认值 + 每会话覆盖 + 放行） ------------------------- */
  console.log("\n[14] 单会话上限");
  const ctx14 = makeCtx(makeAccount({ value: [cny(1000)] }));
  apply(ctx14, { storeFile: join(dir, "session.json") });
  const s14 = fakeSession("s14", []);
  emit(ctx14, s14);
  s14.events.push(header("deepseek", "deepseek-v4-pro"));
  s14.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx14, s14); // 9.504 CNY

  let st14 = await stateOf(ctx14, "s14");
  near("本会话费用", st14.session.usedCNY, 9.504);
  check("会话上限未设", [st14.session.ceiling, st14.session.ceilingSource], [0, "none"]);
  check("会话未越线", [st14.session.blocked, st14.blockScope], [false, null]);

  await post(ctx14, "/plugin-billing/config", { sessionLimit: 20 });
  st14 = await stateOf(ctx14, "s14");
  check("旧的共用默认字段已失效", [st14.session.ceiling, st14.session.ceilingSource], [0, "none"]);
  check("旧的共用默认不再阻断", (await preStep(ctx14, payloadOf("s14"))).kind, "enter");

  await post(ctx14, "/plugin-billing/config", { sessionId: "s14", sessionLimitFor: 5 });
  st14 = await stateOf(ctx14, "s14");
  check("会话单独设上限", [st14.session.ceiling, st14.session.ceilingSource], [5, "own"]);
  check("会话越线 → blocked(session)", [st14.blocked, st14.blockScope], [true, "session"]);
  check("会话越线被拒绝", (await preStep(ctx14, payloadOf("s14"))).kind, "reject");
  check("其它会话不受影响", (await preStep(ctx14, payloadOf("s99"))).kind, "enter");
  const blockRow = (st14.sessions ?? []).find((row) => row.id === "s14");
  check("会话列表带上限与百分比", [blockRow.ceiling, blockRow.percent >= 100], [5, true]);

  await post(ctx14, "/plugin-billing/override", { mode: "session", sessionId: "s14" });
  check("本会话放行 → 通过", (await preStep(ctx14, payloadOf("s14"))).kind, "enter");
  check("放行状态出现在 state", (await stateOf(ctx14, "s14")).session.allowed, true);

  await post(ctx14, "/plugin-billing/config", { sessionId: "s14", sessionLimitFor: 0 });
  st14 = await stateOf(ctx14, "s14");
  check("清除该会话上限 → 该会话不设上限", [st14.session.ceiling, st14.session.ceilingSource], [0, "none"]);
  check("清除后不再阻断", (await preStep(ctx14, payloadOf("s14"))).kind, "enter");
  check("清覆盖同时清掉放行", st14.session.allowed, false);

  await post(ctx14, "/plugin-billing/config", { sessionId: "s14", sessionLimitFor: 3 });
  await post(ctx14, "/plugin-billing/config", { sessionId: "s99", sessionLimitFor: 4 });
  check("两个会话各存各的上限", (await stateOf(ctx14, "s14")).session.ceiling, 3);
  check("另一会话的上限只作用于它自己", (await stateOf(ctx14, "s99")).session.ceiling, 4);

  /* 15. 余额取不到 → 不阻断（哪怕用量很大） ------------------------------ */
  console.log("\n[15] 余额不可用时绝不阻断");
  const ctx15 = makeCtx(undefined);
  apply(ctx15, { storeFile: join(dir, "unavail.json") });
  const s15 = fakeSession("s15", []);
  emit(ctx15, s15);
  s15.events.push(header("deepseek", "deepseek-v4-pro"));
  s15.events.push(usage(1, 1, { inputTokens: 100000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx15, s15);
  const st15 = await stateOf(ctx15);
  check("余额不可用 → 上限 0", [st15.ceiling, st15.ceilingAvailable], [0, false]);
  check("余额不可用 → 不阻断", [st15.blocked, (await preStep(ctx15, payloadOf("s15"))).kind], [false, "enter"]);

  /* 16. 0.1 的旧账本（version 1）能被读进来，且用量不丢 ------------------- */
  console.log("\n[16] 旧账本（version 1）迁移");
  const legacyFile = join(dir, "legacy.json");
  writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      rate: 7.2,
      symbol: "¥",
      topUp: 500,
      limit: 300,
      sessionLimit: 50,
      guard: true,
      sessions: {
        "s-legacy": {
          lastSeq: 42,
          steps: {
            "1:1": { t: [1000000, 0, 0, 0], m: "deepseek/deepseek-v4-pro" },
            "1:2": { t: [0, 1000000, 0, 0], m: "deepseek/deepseek-v4-pro" },
          },
        },
      },
    }),
  );
  const ctx16 = makeCtx(makeAccount({ value: [cny(1000)], bonus: [] }));
  apply(ctx16, { storeFile: legacyFile });
  const st16 = await stateOf(ctx16, "s-legacy");
  near("旧账本用量保留", st16.usedUSD, 1.32 + 3.96);
  near("旧账本没有基线 → 本次 = 累计", st16.usedCNY, st16.totalCNY);
  check("旧账本会话仍在", st16.session?.id, "s-legacy");
  check(
    "0.2.1 的共用默认上限已落到该会话自己身上",
    [st16.session?.ceiling, st16.session?.ceilingSource],
    [50, "own"],
  );
  check("旧字段 topUp 保留（废弃不再当上限），limit 当作自设全局上限", [st16.topUp, st16.limit, st16.ceilingSource, st16.ceiling], [500, 300, "limit", 300]);
  check("旧账本的上限不高，未阻断", st16.blocked, false);
  const migrated = JSON.parse(readFileSync(legacyFile, "utf8"));
  check("落盘后升级为 version 3", migrated.version, 3);
  check("升级后旧字段仍在文件里", [migrated.topUp, migrated.limit], [500, 300]);
  check(
    "升级后共用默认字段消失、改成该会话自己的上限",
    [migrated.sessionLimit, migrated.sessionLimits["s-legacy"], migrated.sessionAllow],
    [undefined, 50, {}],
  );
  check("旧账本会话的 token 未丢", migrated.sessions["s-legacy"].steps["1:2"].t, [0, 1000000, 0, 0]);
  check("迁移后磁盘上有基线字段（空）", [migrated.globalBaseline, migrated.sessions["s-legacy"].baselineByModel], [{}, {}]);

  /* 16b. 0.2.4 形状的账本：全局重置把基线写进了每个会话，迁移要分开且不改变显示值 --- */
  const v2File = join(dir, "legacy-024.json");
  const t024 = 1790777826908;
  writeFileSync(
    v2File,
    JSON.stringify({
      version: 2,
      rate: 7.2,
      symbol: "¥",
      limit: 0,
      guard: true,
      resetAt: t024,
      archiveBaseline: {},
      sessions: {
        "s-a": {
          lastSeq: 1,
          resetAt: t024,
          steps: { "1:1": { t: [1000000, 0, 0, 0], m: "deepseek/deepseek-v4-pro" } },
          baselineByModel: { "deepseek/deepseek-v4-pro": [1000000, 0, 0, 0] },
        },
        "s-b": {
          lastSeq: 1,
          resetAt: 0,
          steps: { "1:1": { t: [500000, 0, 0, 0], m: "deepseek/deepseek-v4-pro" } },
        },
      },
    }),
  );
  const ctx16b = makeCtx(makeAccount({ value: [cny(1000)] }));
  apply(ctx16b, { storeFile: v2File });
  const st16b = await stateOf(ctx16b, "s-a");
  near("0.2.4 → 3：全局本次保持不变", st16b.usedCNY, 4.752);
  near("0.2.4 → 3：全局累计不变", st16b.totalCNY, 14.256);
  near("被全局重置误伤的单会话恢复自己的周期", st16b.session.usedCNY, 9.504);
  const migrated2 = JSON.parse(readFileSync(v2File, "utf8"));
  check("0.2.4 的旧基线并进全局基线", migrated2.globalBaseline["deepseek/deepseek-v4-pro"], [1000000, 0, 0, 0]);
  check("全局重置留下的会话基线被清掉", [migrated2.sessions["s-a"].baselineByModel, migrated2.sessions["s-a"].resetAt], [{}, 0]);

  /* 17. 重置计费起点：单会话 / 全局 / 累计保留 / 上限比的是本次 ----------- */
  console.log("\n[17] 重置计费起点（单会话与全局）");
  const ctx17 = makeCtx(makeAccount({ value: [cny(1000)] }));
  apply(ctx17, { storeFile: join(dir, "reset.json") });
  const s17a = fakeSession("sA", []);
  emit(ctx17, s17a);
  s17a.events.push(header("deepseek", "deepseek-v4-pro"));
  s17a.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx17, s17a); // sA: 9.504
  const s17b = fakeSession("sB", []);
  emit(ctx17, s17b);
  s17b.events.push(header("deepseek", "deepseek-v4-pro"));
  s17b.events.push(usage(1, 1, { inputTokens: 500000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx17, s17b); // sB: 4.752
  let st17 = await stateOf(ctx17, "sA");
  near("重置前全局本次", st17.usedCNY, 14.256);
  near("重置前全局累计", st17.totalCNY, 14.256);
  near("重置前会话本次", st17.session.usedCNY, 9.504);
  near("重置前会话累计", st17.session.totalCNY, 9.504);

  const capped17 = await post(ctx17, "/plugin-billing/config", { limit: 10 });
  check("越线先阻断", [capped17.blocked, capped17.blockScope], [true, "global"]);
  check("越线时确实拒绝", (await preStep(ctx17, payloadOf("sA"))).kind, "reject");

  const afterA = await post(ctx17, "/plugin-billing/reset", { scope: "session", sessionId: "sA" });
  near("单会话重置只清该会话的本次", afterA.session.usedCNY, 0);
  near("单会话重置不动全局本次", afterA.usedCNY, 14.256);
  near("单会话重置不动累计", afterA.totalCNY, 14.256);
  near("单会话重置不动会话累计", afterA.session.totalCNY, 9.504);
  check("单会话重置不让全局上限放行", [afterA.blocked, afterA.blockScope], [true, "global"]);
  check("全局仍越线 → 仍拒绝", (await preStep(ctx17, payloadOf("sA"))).kind, "reject");
  near("另一个会话没被牵连", (await stateOf(ctx17, "sB")).session.usedCNY, 4.752);
  check("单会话重置不刷新全局周期起点", afterA.resetAt, 0);

  const afterAll = await post(ctx17, "/plugin-billing/reset", {});
  near("全局重置后本次 = 0", afterAll.usedCNY, 0);
  near("全局重置后累计不变", afterAll.totalCNY, 14.256);
  check("全局重置后不再阻断（不必调高上限）", afterAll.blocked, false);
  check("全局重置才刷新全局周期起点", afterAll.resetAt > 0, true);
  check("全局重置后守卫放行", (await preStep(ctx17, payloadOf("sA"))).kind, "enter");
  const rows17 = Object.fromEntries(afterAll.sessions.map((row) => [row.id, row]));
  near("全局重置不碰会话 sB 的本次（独立）", rows17.sB.cny, 4.752);
  near("全局重置不碰会话 sA 的本次（它自己重置过）", rows17.sA.cny, 0);
  near("会话 sA 的累计保留", rows17.sA.totalCNY, 9.504);
  near("会话 sB 的累计保留", rows17.sB.totalCNY, 4.752);

  s17a.events.push(header("deepseek", "deepseek-v4-pro"));
  s17a.events.push(usage(2, 1, { inputTokens: 100000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx17, s17a); // +0.9504
  const st17c = await stateOf(ctx17, "sA");
  near("重置后新用量只进本次", st17c.session.usedCNY, 0.9504);
  near("会话累计含前移部分", st17c.session.totalCNY, 10.4544);
  near("全局本次 = 新用量", st17c.usedCNY, 0.9504);
  near("全局累计 = 全部历史", st17c.totalCNY, 15.2064);
  check("远未到上限 → 放行", (await preStep(ctx17, payloadOf("sA"))).kind, "enter");
  const disk17 = JSON.parse(readFileSync(join(dir, "reset.json"), "utf8"));
  check(
    "全局基线与单会话基线各存各的",
    [
      disk17.globalBaseline["deepseek/deepseek-v4-pro"],
      disk17.sessions.sA.baselineByModel["deepseek/deepseek-v4-pro"],
      disk17.sessions.sB.baselineByModel,
    ],
    [[1500000, 0, 0, 0], [1000000, 0, 0, 0], {}],
  );
  check("账本仍只存 token（没有金额字段）", ["usedCNY", "totalCNY", "cny"].every((key) => !(key in disk17)), true);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} —— ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
