/**
 * 宿主半边自测：折叠 / 计价 / 上限 / 守卫 / 路由 / 持久化。
 * 用法：node tools/self-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function makeCtx() {
  const routes = new Map();
  const listeners = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    webServer: { register: (route) => (routes.set(route.path, route.handler), () => routes.delete(route.path)) },
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
  const ctx = makeCtx();
  apply(ctx, { storeFile });
  const session = fakeSession("s1", []);
  emit(ctx, session);
  session.events.push(header("deepseek", "deepseek-v4-pro"));
  session.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 4000000, cacheWriteTokens: 0 }));
  emit(ctx, session);
  let state = (await call(ctx, "/plugin-billing/state")).body;
  // 1e6*1.32 + 1e5*3.96 + 4e6*0.044 = 1.32 + 0.396 + 0.176 = 1.892 USD
  near("usedUSD = 1.32+0.396+0.176", state.usedUSD, 1.892);
  near("usedCNY = USD × 7.2", state.usedCNY, 1.892 * 7.2);
  check("四类 token 累计", state.tokens, [1000000, 100000, 4000000, 0]);
  check("模型键", state.breakdown[0]?.key, "deepseek/deepseek-v4-pro");
  check("价格来源", state.breakdown[0]?.source, "official");
  check("官方单价", state.breakdown[0]?.price, [1.32, 3.96, 0.044, 0]);
  check("当前路由", state.current?.key, "deepseek/deepseek-v4-pro");
  check("上限未设", state.ceiling, 0);
  check("未阻断", state.blocked, false);

  /* 2. 同一 (turn,step) 重采样是替换而非累加 ------------------------------ */
  console.log("\n[2] 同一 (turn,step) 的重采样必须替换");
  session.events.push(usage(1, 1, { inputTokens: 2000000, outputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx, session);
  state = (await call(ctx, "/plugin-billing/state")).body;
  near("替换后 USD", state.usedUSD, 2 * 1.32 + 0.396); // 3.036
  check("替换后 token", state.tokens, [2000000, 100000, 0, 0]);

  /* 3. 新 step 累加 ------------------------------------------------------- */
  console.log("\n[3] 新 step 累加");
  session.events.push(usage(2, 1, { inputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx, session);
  state = (await call(ctx, "/plugin-billing/state")).body;
  near("累加后 USD", state.usedUSD, 3.036 + 3.96);
  check("token 总数", state.tokens, [2000000, 1100000, 0, 0]);

  /* 4. llm/retry-started 清槽 ------------------------------------------- */
  console.log("\n[4] llm/retry-started 后重采样仍为替换");
  session.events.push({ type: "llm/retry-started", data: { turn: 2, step: 1 } });
  session.events.push(usage(2, 1, { inputTokens: 0, outputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx, session);
  state = (await call(ctx, "/plugin-billing/state")).body;
  near("重试后 USD", state.usedUSD, 3.036 + 2 * 3.96);

  /* 5. 汇率/单价改动立即重算历史 ---------------------------------------- */
  console.log("\n[5] 改规则立即重算全部历史");
  const before = state.usedCNY;
  state = (await call(ctx, "/plugin-billing/config", { method: "POST", body: { rate: 10 } })).body;
  near("汇率 10 → CNY = USD × 10", state.usedCNY, state.usedUSD * 10);
  check("USD 不随汇率变", state.usedUSD, 3.036 + 2 * 3.96);
  state = (await call(ctx, "/plugin-billing/config", {
    method: "POST",
    body: { price: { key: "deepseek/deepseek-v4-pro", value: [0, 0, 0, 0] } },
  })).body;
  near("单价全 0 → 费用为 0", state.usedCNY, 0);
  check("覆盖来源", state.breakdown[0]?.source, "override");
  state = (await call(ctx, "/plugin-billing/config", { method: "POST", body: { price: { key: "deepseek/deepseek-v4-pro", reset: true }, rate: 7.2 } })).body;
  near("恢复官方价", state.usedUSD, 3.036 + 2 * 3.96);
  check("恢复后来源", state.breakdown[0]?.source, "official");
  check("历史按旧汇率折算过", before > 0, true);

  /* 6. 上限 = min(自设上限, 已充金额) ------------------------------------ */
  console.log("\n[6] 上限约束");
  state = (await call(ctx, "/plugin-billing/config", { method: "POST", body: { topUp: 100, limit: 5 } })).body;
  check("limit < topUp → 取 limit", [state.ceiling, state.ceilingSource], [5, "limit"]);
  state = (await call(ctx, "/plugin-billing/config", { method: "POST", body: { topUp: 3, limit: 5 } })).body;
  check("limit > topUp → 夹到 topUp", [state.ceiling, state.ceilingSource], [3, "limit"]);
  state = (await call(ctx, "/plugin-billing/config", { method: "POST", body: { topUp: 20, limit: 0 } })).body;
  check("未设上限 → 用已充金额", [state.ceiling, state.ceilingSource], [20, "topUp"]);
  state = (await call(ctx, "/plugin-billing/config", { method: "POST", body: { topUp: 0 } })).body;
  check("未充值 → 不限额", [state.ceiling, state.ceilingSource], [0, "none"]);

  /* 7. 守卫：超限 reject，放行语义 -------------------------------------- */
  console.log("\n[7] agent/pre-step 守卫");
  const used = (await call(ctx, "/plugin-billing/state")).body.usedCNY;
  await call(ctx, "/plugin-billing/config", { method: "POST", body: { topUp: used / 2, limit: 0, guard: true } });
  check("已超限 → blocked", (await call(ctx, "/plugin-billing/state")).body.blocked, true);
  check("entry 决策会被拒绝", (await preStep(ctx)).kind, "reject");
  const blockedState = (await call(ctx, "/plugin-billing/state")).body;
  check("阻断时间戳已记录", blockedState.lastBlockAt > 0, true);
  check("重复调用仍拒绝", (await preStep(ctx)).kind, "reject");

  let st = (await call(ctx, "/plugin-billing/override", { method: "POST", body: { mode: "once" } })).body;
  check("放行一次后 blocked=false", st.blocked, false);
  check("第一次放行通过", (await preStep(ctx)).kind, "enter");
  check("第二次又拒绝", (await preStep(ctx)).kind, "reject");

  st = (await call(ctx, "/plugin-billing/override", { method: "POST", body: { mode: "session" } })).body;
  check("整会话放行", (await preStep(ctx)).kind, "enter");
  check("整会话放行持续生效", (await preStep(ctx)).kind, "enter");

  await call(ctx, "/plugin-billing/override", { method: "POST", body: { mode: "off" } });
  await call(ctx, "/plugin-billing/config", { method: "POST", body: { guard: false } });
  check("守卫关闭 → 不阻断", (await preStep(ctx)).kind, "enter");
  await call(ctx, "/plugin-billing/config", { method: "POST", body: { guard: true } });

  check("链上他人拒绝时本插件不改变决策", (await (async () => {
    const handlers = ctx.listeners.get("agent/pre-step") ?? [];
    let decision = { kind: "reject", reason: "别的插件" };
    for (const handler of handlers) {
      const inner = decision;
      decision = await handler({}, async () => inner);
    }
    return decision;
  })()).reason, "别的插件");

  /* 8. 账本只存 token，不存金额 ----------------------------------------- */
  console.log("\n[8] 持久化：只存 token");
  const raw = JSON.parse(readFileSync(storeFile, "utf8"));
  const text = JSON.stringify(raw);
  check("账本无 CNY 字段", /"cny"|"usedCNY"/i.test(text), false);
  check("账本记录了模型键", raw.sessions.s1.steps["1:1"].m, "deepseek/deepseek-v4-pro");
  check("账本记录了 4 类 token", raw.sessions.s1.steps["1:1"].t, [2000000, 100000, 0, 0]);

  /* 9. 重启后按新汇率现算 ----------------------------------------------- */
  console.log("\n[9] 重启后按当前规则重算");
  const ctx2 = makeCtx();
  apply(ctx2, { storeFile, rate: 3 });
  const fresh = (await call(ctx2, "/plugin-billing/state")).body;
  near("重启后沿用 7.2 汇率（账本优先）", fresh.rate, 7.2);
  near("重启后重算出的 CNY", fresh.usedCNY, fresh.usedUSD * 7.2);
  near("重启后 USD 与内存态一致", fresh.usedUSD, state.usedUSD, 1e-9);

  /* 10. 未知模型 → 估算价 ----------------------------------------------- */
  console.log("\n[10] 未识别路由用估算价");
  const ctx3 = makeCtx();
  apply(ctx3, { storeFile: join(dir, "l3.json") });
  const s3 = fakeSession("s3", []);
  emit(ctx3, s3);
  s3.events.push(usage(1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  emit(ctx3, s3);
  const st3 = (await call(ctx3, "/plugin-billing/state")).body;
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

  /* 12. 归零 -------------------------------------------------------------- */
  console.log("\n[12] 用量归零");
  const zeroed = (await call(ctx, "/plugin-billing/reset", { method: "POST", body: {} })).body;
  near("归零后 CNY = 0", zeroed.usedCNY, 0);
  check("归零后无明细", zeroed.breakdown.length, 0);

  /* 13. effect 清理 ------------------------------------------------------- */
  console.log("\n[13] effect 清理器");
  check("注册了 1 个 effect", ctx.effects.length, 1);
  ctx.effects[0].dispose();
  check("清理后路由已注销", ctx.routes.size, 0);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} —— ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
