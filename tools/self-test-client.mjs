/**
 * 浏览器半边自测：模块外壳、inject/apply、三个槽位注册，以及
 * 双角标 / 侧边栏余额 / 面板 / 超额确认框的渲染文本。
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

function makeReact(seed = []) {
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
  // 假 React 没有渲染边界，测试里每次调用组件前手动重置游标。
  react.__reset = () => {
    cursor = 0;
  };
  return react;
}

const reactDomStub = {
  createPortal(node) {
    return node;
  },
};

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

/** 从 createElement 假树里收集所有 props.type === "number" 的输入框。 */
function numberInputs(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) numberInputs(child, out);
    return out;
  }
  if (typeof node === "object" && "props" in node) {
    if (node.props.type === "number") out.push(node);
    numberInputs(typeof node.type === "function" ? node.type(node.props) : node.props.children, out);
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
    if (id === "react-dom") return reactDomStub;
    throw new Error(`意外的 require：${id}`);
  };
  return { module: loaded, exports: loaded.factory(requireStub) };
}

console.log("\n[1] 模块外壳");
requireCalls = [];
const react = makeReact([]);
const { module: wrapper, exports: plugin } = loadPlugin(react);
check("bundle id", wrapper.id, "yoka-dsh-billing");
check("只 require react 与 react-dom", requireCalls, ["react", "react-dom"]);
check("inject 是服务名列表", plugin.inject, ["slots"]);
check("导出 apply", typeof plugin.apply, "function");
check("导出角标组件", typeof plugin.BillingDock, "function");
check("导出侧边栏组件", typeof plugin.BalanceAction, "function");
check("导出浮层组件", typeof plugin.BillingOverlay, "function");

console.log("\n[2] 槽位注册");
const injected = [];
const registered = [];
let disposerCalls = 0;
const ctx = {
  slots: {
    inject(name, callback) {
      injected.push(name);
      callback();
    },
    register(definition, component) {
      registered.push({ definition, component });
      return () => {
        disposerCalls += 1;
      };
    },
  },
};
plugin.apply(ctx);
check("注册三个槽位", injected, ["conversation.composer.dock", "sidebar.footer.action", "shell.overlay"]);
check("角标槽位名", registered[0].definition.name, "conversation.composer.dock");
check("角标条目 id", registered[0].definition.id, "billing");
check("角标排序值", registered[0].definition.order, 20);
check("角标组件就是导出组件", registered[0].component === plugin.BillingDock, true);
check("侧边栏槽位名", registered[1].definition.name, "sidebar.footer.action");
check("侧边栏条目 id", registered[1].definition.id, "billing-balance");
check("侧边栏组件就是导出组件", registered[1].component === plugin.BalanceAction, true);
check("浮层槽位名", registered[2].definition.name, "shell.overlay");
check("浮层条目 id", registered[2].definition.id, "billing-panel");
check("浮层组件就是导出组件", registered[2].component === plugin.BillingOverlay, true);
check("三个槽位都返回清理函数", typeof registered[2].component === "function", true);

/* -------------------------------- 状态夹具 -------------------------------- */

const state = {
  ok: true,
  version: 2,
  symbol: "¥",
  rate: 7.2,
  guard: true,
  balance: {
    available: true,
    cny: 1007.2,
    bonusCNY: 7.2,
    wallets: [
      { currency: "CNY", amount: 1000, cny: 1000, bonus: false },
      { currency: "USD", amount: 1, cny: 7.2, bonus: true },
    ],
    error: "",
    at: 1,
    stale: false,
    topUpUrl: "https://platform.deepseek.com/top_up",
    signedIn: true,
  },
  limit: 1000,
  ceiling: 1000,
  ceilingAvailable: true,
  ceilingSource: "limit",
  ceilingClamped: false,
  balanceCap: 1007.2,
  usedCNY: 12.3552,
  usedUSD: 1.716,
  totalCNY: 111.072,
  totalUSD: 15.4267,
  baselineCNY: 98.7168,
  resetAt: 1712345678000,
  tokens: [2000000, 1100000, 0, 0],
  totalTokens: [22000000, 11100000, 0, 0],
  remainingCNY: 994.8448,
  percent: 1.2267,
  blocked: false,
  blockScope: null,
  session: {
    id: "session-abc",
    usedCNY: 12.3552,
    usedUSD: 1.716,
    totalCNY: 12.3552,
    totalUSD: 1.716,
    resetAt: 0,
    tokens: [2000000, 1100000, 0, 0],
    ceiling: 50,
    ceilingSource: "own",
    percent: 24.7104,
    allowed: false,
    blocked: false,
  },
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
      totalTokens: [22000000, 11100000, 0, 0],
      totalUSD: 15.4267,
      totalCNY: 111.072,
      price: [1.32, 3.96, 0.044, 0],
      source: "official",
      percent: 1.2267,
    },
  ],
  sessions: [
    {
      id: "session-abc",
      tokens: [2000000, 1100000, 0, 0],
      usd: 1.716,
      cny: 12.3552,
      totalTokens: [2000000, 1100000, 0, 0],
      totalUSD: 1.716,
      totalCNY: 12.3552,
      resetAt: 0,
      ceiling: 50,
      ceilingSource: "own",
      percent: 24.7104,
      allowed: false,
      updated: 1,
      lastSeen: 12,
    },
  ],
  ledgerFile: "C:/Users/x/.dsh/billing/ledger.json",
  pricing: { count: 605, generatedAt: "2026", unit: "USD / 百万 token" },
  updatedAt: 1,
};

console.log("\n[3] 两个角标（本会话 + 全局，各自带颜色点）");
{
  const r = makeReact([state, ""]);
  const { exports: p } = loadPlugin(r);
  const rendered = p.BillingDock({ sessionId: "session-abc" });
  const list = texts(rendered);
  check("本会话角标 ¥12.36 / ¥50.00", list.includes("¥12.36 / ¥50.00"), true);
  check("全局角标 ¥12.36 / ¥1000.00", list.includes("¥12.36 / ¥1000.00"), true);
  const chips = rendered.props.children.map((pair) => pair.props.children[0]);
  const resets = rendered.props.children.map((pair) => pair.props.children[1]);
  check("两组（本会话 + 全局），每组 = 角标 + 重置符号", [rendered.props.children.length, chips.length, resets.length], [2, 2, 2]);
  check("两个角标都是 button", [chips[0].type, chips[1].type], ["button", "button"]);
  check("两个重置符号都是 button", [resets[0].type, resets[1].type], ["button", "button"]);
  check("重置符号是 ↺", [resets[0].props.children, resets[1].props.children], ["↺", "↺"]);
  check("本会话角标 title", /本会话本次计费/.test(chips[0].props.title), true);
  check("全局角标 title", /账户余额 ¥1007\.20/.test(chips[1].props.title), true);
  check("角标 title 带累计", [chips[0].props.title, chips[1].props.title].every((t) => /累计 ¥/.test(t)), true);
  check(
    "重置符号 title 说明只进累计",
    resets.every((b) => /本次归零/.test(b.props.title) && /历史只进累计/.test(b.props.title)),
    true,
  );
  check("本会话 ↺ 说明只动本会话", /只动本会话/.test(resets[0].props.title), true);
  check("全局 ↺ 说明只动全局、不碰各会话", /只动全局/.test(resets[1].props.title) && /不碰各会话/.test(resets[1].props.title), true);
  check("每个角标一个颜色点", [chips[0].props.children.length, chips[1].props.children.length], [2, 2]);
  check("颜色点是 6px 圆", chips[0].props.children[0].props.style.borderRadius, 999);
}

console.log("\n[4] 未设会话上限 / 余额不可用");
{
  const partial = {
    ...state,
    session: { ...state.session, ceiling: 0, ceilingSource: "none", percent: 0 },
    balance: { ...state.balance, available: false, cny: null, bonusCNY: 0, wallets: [], error: "账户服务不可用" },
    ceiling: 0,
    ceilingAvailable: false,
    ceilingSource: "unset",
    ceilingClamped: false,
    balanceCap: null,
    limit: 0,
    percent: 0,
  };
  const r = makeReact([partial, ""]);
  const { exports: p } = loadPlugin(r);
  const list = texts(p.BillingDock({ sessionId: "session-abc" }));
  check("会话未设上限", list.includes("¥12.36 / 未设"), true);
  check("全局未设上限也显示未设", list.filter((t) => t === "¥12.36 / 未设").length, 2);
}

console.log("\n[5] state 未就绪 → 不渲染");
{
  const r = makeReact([null, ""]);
  const { exports: p } = loadPlugin(r);
  check("轮询未返回时返回 null", p.BillingDock({ sessionId: "session-abc" }), null);
}

console.log("\n[6] 左侧边栏底部余额");
{
  const r = makeReact([state, ""]);
  const { exports: p } = loadPlugin(r);
  const wide = p.BalanceAction({ wide: true });
  const list = texts(wide);
  check("显示余额", list.includes("余额 ¥1007.20"), true);
  check("title 含赠金", /其中赠金 ¥7\.20/.test(wide.props.title), true);
  check("title 含本次已用与累计", /本次已用 ¥12\.36 \/ 累计 ¥111\.07/.test(wide.props.title), true);
  r.__reset();
  const collapsed = p.BalanceAction({ wide: false });
  check("收起态只留圆点", texts(collapsed), []);
  check("收起态仍是 button", collapsed.type, "button");}

console.log("\n[7] 面板字段（不含「已充金额 / 自设上限」）");
{
  const r = makeReact([]);
  const { exports: p } = loadPlugin(r);
  const list = texts(p.Panel({ state, sessionId: "session-abc", onClose() {}, onSaved() {} }));
  for (const label of [
    "计费",
    "全局计费 · 上限由你设定，不得超过余额",
    "全局计费上限",
    "账户余额",
    "余额合计",
    "汇率",
    "超额阻断",
    "模型单价",
    "恢复官方价",
    "保存",
    "↺ 重置计费起点",
    "清空历史",
    "按模型用量（本次 / 累计，点击可编辑其单价）",
    "每个会话各设各的，互不共用；留空或 0 = 该会话不限。填好回车或移开焦点即生效，单会话上限不受余额夹取。右侧 ↺ 只重置该会话自己的计费起点（不动全局、也不动别的会话；历史只进累计）。",
    "刷新",
    "去充值",
  ]) {
    check(`含「${label}」`, list.includes(label), true);
  }
  check("备注不再叫「用量归零」", list.includes("用量归零"), false);
  check("概览标出「本次」", list.includes("本次"), true);
  check("概览标出累计", list.some((t) => t.includes("累计 ¥111.07") && t.includes("≈$15.4267")), true);
  check("说明重置只前移起点", list.some((t) => t.includes("本次归零、历史费用只进累计，token 记录一条不丢")), true);
  check("概览说明两个起点互不牵连", list.some((t) => t.includes("全局与单会话两个起点各自独立、互不牵连")), true);
  check("按模型用量的每行也标累计", list.some((t) => t.includes("累计 ¥111.07")), true);
  check("不再有「已充金额」", list.includes("已充金额"), false);
  check("不再有「自设上限」", list.includes("自设上限"), false);
  check("不再有共用的「单会话默认上限」字段", list.includes("单会话默认上限"), false);
  check("明细列出模型", list.includes("deepseek/deepseek-v4-pro"), true);
  check("明细列出会话", list.includes("session-abc"), true);
  check("官方价四档", list.some((t) => t.includes("1.32 / 3.96 / 0.044 / 0.000")), true);
  check("充值余额行", list.includes("CNY 1000.00 ≈ ¥1000.00"), true);
  check("赠金行带标记", list.includes("USD 1.00（赠金） ≈ ¥7.20"), true);
  check("赠金行左侧标签", list.includes("赠金"), true);
  check("全局上限可自设的说明", list.some((t) => t.includes("超过账户余额") && t.includes("余额只是边界与参考")), true);
  check("说明单会话上限在会话用量里逐个设", list.some((t) => t.includes("各自独立、不共用")), true);
  check("单会话上限独立成段", list.includes("单会话上限"), true);
  check("单会话上限有列标题", ["会话", "用量", "费用", "占比"].every((t) => list.includes(t)), true);
  check("当前会话带「当前」标记", list.includes("当前"), true);
  check("单会话段说明可单独重置起点", list.some((t) => t.includes("右侧 ↺ 只重置该会话自己的计费起点")), true);

  // 每行只显示该会话自己的上限：一格 5、一格空，互不共用。
  const r2 = makeReact([]);
  const { exports: p2 } = loadPlugin(r2);
  const twoSessions = {
    ...state,
    session: { ...state.session, id: "session-a", ceiling: 5, ceilingSource: "own" },
    sessions: [
      { ...state.sessions[0], id: "session-a", ceiling: 5, ceilingSource: "own" },
      { ...state.sessions[0], id: "session-b", ceiling: 0, ceilingSource: "none" },
    ],
  };
  const cells = numberInputs(p2.Panel({ state: twoSessions, sessionId: "session-a", onClose() {}, onSaved() {} })).filter(
    (node) => node.props.placeholder === "不限",
  );
  check("两个会话两格", cells.length, 2);
  check("每格只显示自己的上限（互不共用）", cells.map((node) => node.props.defaultValue), ["5", ""]);
  check("每格提示不与其他会话共用", cells.every((node) => /不与其他会话共用/.test(node.props.title)), true);

  // 重置过的会话：行里上排 = 本次、下排 = 累计（历史仍在，看得见）。
  const resetSession = {
    ...state,
    sessions: [
      {
        ...state.sessions[0],
        id: "session-reset",
        tokens: [12000, 0, 0, 0],
        cny: 0.0132,
        totalTokens: [3000000, 0, 0, 0],
        totalUSD: 3.96,
        totalCNY: 28.512,
        resetAt: 1790778917567,
        ceiling: 0,
        ceilingSource: "none",
      },
    ],
  };
  const resetList = texts(p2.Panel({ state: resetSession, sessionId: "", onClose() {}, onSaved() {} }));
  check("会话行上排是本次费用", resetList.includes("¥0.0132"), true);
  check("会话行下排是累计费用", resetList.includes("累计 ¥28.51"), true);
  check("会话行下排是累计 token", resetList.some((t) => t === "累计 3.00M tok"), true);
  check("会话行上排是本次 token", resetList.includes("12.0K tok"), true);
  check("表单说明上排本次、下排累计", resetList.some((t) => t.includes("上排 = 本次") && t.includes("下排 = 累计")), true);
}

console.log("\n[8] 超余额确认框（全局）");
{
  const blockedState = {
    ...state,
    blocked: true,
    blockScope: "global",
    usedCNY: 1007.5,
    percent: 100,
    lastBlockAt: 1712345678000,
    lastBlock: { at: 1712345678000, scope: "global", sessionId: "session-abc" },
  };
  const r = makeReact([]);
  const { exports: p } = loadPlugin(r);
  const list = texts(p.ConfirmDialog({ state: blockedState, onClose() {}, onOverride() {}, onRaise() {}, onSaved() {} }));
  check("标题", list.includes("已达你设的全局上限"), true);
  check("一次性放行", list.includes("一次性放行"), true);
  check("本会话放行", list.includes("本会话放行"), true);
  check("去充值", list.includes("去充值"), true);
  check("调高上限（而非查看余额）", list.includes("调高上限"), true);
  check("暂不放行", list.includes("暂不放行"), true);
  check("展示全局本次已用/自设上限", list.some((t) => t.includes("全局本次已用 ¥1007.50 / 你设的上限 ¥1000.00")), true);
  check("展示余额作为参考", list.some((t) => t.includes("你的账户余额（¥1007.20）")), true);
  check("确认框也能重置起点", list.includes("↺ 重置计费起点"), true);
  check("确认框说明重置不必调高上限", list.some((t) => t.includes("不必调高上限")), true);
}

console.log("\n[9] 单会话超限确认框");
{
  const blockedState = {
    ...state,
    blocked: true,
    blockScope: "session",
    session: { ...state.session, usedCNY: 52.4, ceiling: 50, percent: 100, blocked: true },
  };
  const r = makeReact([]);
  const { exports: p } = loadPlugin(r);
  const list = texts(p.ConfirmDialog({ state: blockedState, onClose() {}, onOverride() {}, onRaise() {}, onSaved() {} }));
  check("标题", list.includes("本会话已达上限"), true);
  check("调高上限", list.includes("调高上限"), true);
  check("会话范围不给去充值", list.includes("去充值"), false);
  check("展示会话本次已用/上限", list.some((t) => t.includes("本会话本次已用 ¥52.40 / 上限 ¥50.00")), true);
  check("本会话放行仍在", list.includes("本会话放行"), true);
  check("会话确认框也可重置该会话起点", list.includes("↺ 重置计费起点"), true);
}

console.log("\n[10] 浮层按开关渲染面板 / 确认框");
{
  const r = makeReact([0, state, ""]);
  const { exports: p } = loadPlugin(r);
  p.ui.set({ open: false, confirm: false, sessionId: "" });
  r.__reset();
  check("都不开时返回 null", p.BillingOverlay(), null);
  p.ui.set({ open: true, sessionId: "session-abc" });
  r.__reset();
  const panelTexts = texts(p.BillingOverlay());
  check("打开时是面板", panelTexts.includes("余额合计"), true);
  p.ui.set({ open: false, confirm: true, sessionId: "session-abc" });
  r.__reset();
  const confirmTexts = texts(p.BillingOverlay());
  check("blocked=false 时确认框不弹", confirmTexts.includes("已达账户余额上限"), false);
}

console.log("\n[11] 轮询副作用已注册且可清理");
{
  const r = makeReact([state, ""]);
  const { exports: p } = loadPlugin(r);
  p.BillingDock({ sessionId: "session-abc" });
  check("注册了 2 个 effect（轮询 + 阻断监听）", r.__effects.length, 2);
  const cleanup = r.__effects[0]();
  check("effect 返回清理函数", typeof cleanup, "function");
  cleanup();
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} —— ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
