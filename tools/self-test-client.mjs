/**
 * 浏览器半边自测：模块外壳、inject/apply、槽位注册、以及角标/面板/确认框的渲染文本。
 * 用法：node tools/self-test-client.mjs
 */
import { readFileSync } from "node:fs";

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

/* --------------------------- 假 React（只够渲染一次） --------------------------- */

function makeReact(seed) {
  const queue = [...seed];
  let cursor = 0;
  const effects = [];
  const react = {
    Fragment: "Fragment",
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
      return { type, props: { ...(props ?? {}), children: kids } };
    },
    useState(initial) {
      const value = cursor < queue.length ? queue[cursor] : typeof initial === "function" ? initial() : initial;
      cursor += 1;
      return [value, () => {}];
    },
    useEffect(fn) {
      effects.push(fn);
    },
    useRef(initial) {
      return { current: initial };
    },
  };
  react.__effects = effects;
  react.__cursor = () => cursor;
  return react;
}

/** 从 createElement 假树里收集所有文本（会调用函数组件）。 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (typeof node === "object" && "props" in node) {
    if (typeof node.type === "function") texts(node.type(node.props), out);
    else texts(node.props.children, out);
  }
  return out;
}

/* -------------------------------- 载入 client.js -------------------------------- */

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let loaded = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(config) {
      loaded = config;
    },
  },
};

let requireCalls = [];
function loadPlugin(react) {
  loaded = null;
  let error = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function("window", source)(fakeWindow);
  } catch (err) {
    error = err;
  }
  if (error) throw error;
  const requireStub = (id) => {
    requireCalls.push(id);
    if (id === "react") return react;
    throw new Error(`意外的 require：${id}`);
  };
  return { module: loaded, exports: loaded.factory(requireStub) };
}

console.log("\n[1] 模块外壳");
requireCalls = [];
const react = makeReact([]);
const { module: wrapper, exports: plugin } = loadPlugin(react);
check("bundle id", wrapper.id, "yoka-dsh-billing");
check("只 require 了 react", requireCalls, ["react"]);
check("inject 是服务名列表", plugin.inject, ["slots"]);
check("导出 apply", typeof plugin.apply, "function");
check("导出组件", typeof plugin.BillingDock, "function");

console.log("\n[2] 槽位注册");
let injected = null;
let registered = null;
let disposerCalls = 0;
const ctx = {
  slots: {
    inject(name, callback) {
      injected = name;
      callback();
    },
    register(definition, component) {
      registered = { definition, component };
      return () => {
        disposerCalls += 1;
      };
    },
  },
};
plugin.apply(ctx);
check("inject 到 composer.dock", injected, "conversation.composer.dock");
check("槽位名", registered.definition.name, "conversation.composer.dock");
check("条目 id", registered.definition.id, "billing");
check("排序值", registered.definition.order, 20);
check("注册的组件就是导出组件", registered.component === plugin.BillingDock, true);

/* -------------------------------- 渲染角标 -------------------------------- */

const state = {
  ok: true,
  symbol: "¥",
  rate: 7.2,
  topUp: 100,
  limit: 50,
  ceiling: 50,
  ceilingSource: "limit",
  usedCNY: 12.3552,
  usedUSD: 1.716,
  tokens: [2000000, 1100000, 0, 0],
  remainingCNY: 37.6448,
  percent: 24.7104,
  blocked: false,
  guard: true,
  overrideOnce: false,
  overrideSession: false,
  lastBlockAt: 0,
  lastBlock: null,
  current: { key: "deepseek/deepseek-v4-pro", price: [1.32, 3.96, 0.044, 0], source: "official" },
  breakdown: [
    {
      key: "deepseek/deepseek-v4-pro",
      tokens: [2000000, 1100000, 0, 0],
      usd: 1.716,
      cny: 12.3552,
      price: [1.32, 3.96, 0.044, 0],
      source: "official",
    },
  ],
  sessions: [{ id: "session-abc", tokens: [2000000, 1100000, 0, 0], usd: 1.716, cny: 12.3552, updated: 1, lastSeen: 12 }],
  ledgerFile: "C:/Users/x/.dsh/billing/ledger.json",
  pricing: { count: 605, generatedAt: "2026", unit: "USD / 百万 token" },
  updatedAt: 1,
};

console.log("\n[3] 角标文案（（货币符号）（数值）/（限制费用））");
{
  const panelReact = makeReact([state, "", false, false, ""]);
  const { exports: p2 } = loadPlugin(panelReact);
  const rendered = p2.BillingDock();
  const list = texts(rendered);
  check("显示 ¥12.36 / ¥50.00", list.includes("¥12.36 / ¥50.00"), true);
  check("角标是 button", rendered.props.children[0].type, "button");
  check("按钮 title 含上限", /上限 ¥50\.00/.test(rendered.props.children[0].props.title), true);
}

console.log("\n[4] 未设上限时的文案");
{
  const noCeiling = { ...state, topUp: 0, limit: 0, ceiling: 0, ceilingSource: "none", percent: 0 };
  const r = makeReact([noCeiling, "", false, false, ""]);
  const { exports: p } = loadPlugin(r);
  check("显示「未设上限」", texts(p.BillingDock()).includes("¥12.36 / 未设上限"), true);
}

console.log("\n[5] state 未就绪 → 不渲染");
{
  const r = makeReact([null, "", false, false, ""]);
  const { exports: p } = loadPlugin(r);
  check("轮询未返回时返回 null", p.BillingDock(), null);
}

console.log("\n[6] 面板字段");
{
  const r = makeReact([state, "", true, false, ""]);
  const { exports: p } = loadPlugin(r);
  const list = texts(p.BillingDock());
  for (const label of ["计费", "已充金额", "自设上限", "汇率", "超额阻断", "模型单价", "恢复官方价", "保存", "用量归零", "按模型用量（点击可编辑其单价）"]) {
    check(`含「${label}」`, list.includes(label), true);
  }
  check("概览数字带货币符号", list.filter((t) => t === "¥12.36").length >= 2, true);
  check("上限来自自设上限", list.some((t) => t.includes("上限取值：自设上限")), true);
  check("明细列出模型", list.includes("deepseek/deepseek-v4-pro"), true);
  check("明细列出会话", list.includes("session-abc"), true);
  check("官方价四档", list.some((t) => t.includes("1.32 / 3.96 / 0.044 / 0.000")), true);
}

console.log("\n[7] 超额确认框");
{
  const blockedState = { ...state, blocked: true, lastBlockAt: 1712345678000, usedCNY: 50.5, percent: 100 };
  const r = makeReact([blockedState, "", false, true, ""]);
  const { exports: p } = loadPlugin(r);
  const list = texts(p.BillingDock());
  check("标题", list.includes("费用已达上限"), true);
  check("一次性放行", list.includes("一次性放行"), true);
  check("本会话放行", list.includes("本会话放行"), true);
  check("提高上限", list.includes("提高上限"), true);
  check("暂不放行", list.includes("暂不放行"), true);
  check("展示已用/上限", list.some((t) => t.includes("已用 ¥50.50 / 上限 ¥50.00")), true);
}

console.log("\n[8] 轮询副作用已注册且可清理");
{
  const r = makeReact([state, "", false, false, ""]);
  const { exports: p } = loadPlugin(r);
  p.BillingDock();
  check("注册了 2 个 effect（轮询 + 阻断监听）", r.__effects.length, 2);
  const cleanup = r.__effects[0]();
  check("effect 返回清理函数", typeof cleanup, "function");
  cleanup();
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} —— ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
