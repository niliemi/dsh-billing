/**
 * yoka-dsh-billing —— 宿主半边。
 *
 * 职责：
 *  1. 折叠每个会话的用量事件，把 provider 上报的四类 token 累计下来（不累计金额，只存 token）。
 *  2. 金额永远是「按当前规则现算」的派生值：改汇率/改单价即刻反映到全部历史用量上。
 *  3. 账本持久化到 ~/.dsh/billing/ledger.json（可在 config.storeFile 覆盖）。
 *  4. 通过本地 HTTP 路由给浏览器半边读写（/plugin-billing/*）。
 *  5. 在 agent/pre-step 上做限额守卫：**全局上限 = 账户余额**（deepseekAccount.getBalance，
 *     充值钱包 + 赠金钱包合计），**单会话上限 = 账本里的默认值 / 按会话覆盖**；
 *     任一越线都以 {kind:"reject"} 结束该轮，不发 LLM 请求。
 *  6. 余额带 60s 缓存（它不随 token 变化，不必每次轮询都打 Platform）；查不到余额时**不阻断**。
 *
 * 只有 node 内置模块依赖；不 import 任何 @deepseek-ai/* 包，避免解析风险。
 * 唯一的外部服务是 ctx.get("deepseekAccount")，可选取用：服务不存在时插件照常工作。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "yoka-dsh-billing";
export const inject = ["webServer"];

const API = "/plugin-billing";
const DEFAULT_RATE = 7.2;
const DEFAULT_SYMBOL = "¥";
const MAX_BODY = 262144;
const MAX_SESSIONS = 40;
const MAX_BREAKDOWN = 24;
/** 余额缓存时长：余额不随 token 变化，避免每次 2s 轮询都打 Platform。 */
const BALANCE_TTL_MS = 60000;
/** 余额主动刷新间隔（浏览器没开着时也要让守卫看得到余额）。 */
const BALANCE_POLL_MS = 60000;
/** 未知模型时的保守估算价（USD / 1M tokens）：[输入, 输出, 缓存读, 缓存写] */
const FALLBACK_PRICE = [1, 4, 0.1, 0];

/* ------------------------------- 价目表 ------------------------------- */

function loadBundledPricing() {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./pricing.json", import.meta.url), "utf8"));
    return {
      providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {},
      byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {},
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
      count: Number.isFinite(parsed.count) ? parsed.count : 0,
    };
  } catch {
    return { providers: {}, byModel: {}, generatedAt: "", count: 0 };
  }
}

/* ------------------------------- 小工具 ------------------------------- */

function expandHome(file) {
  if (typeof file !== "string" || file.length === 0) return file;
  if (file === "~") return homedir();
  if (file.startsWith("~/") || file.startsWith("~\\")) return join(homedir(), file.slice(2));
  return file;
}

function num(value, fallback = 0) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function clampMoney(value) {
  const n = Math.max(0, num(value, 0));
  return Math.round(n * 10000) / 10000;
}

function isPrice(value) {
  return Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

function splitKey(key) {
  const text = typeof key === "string" ? key : "";
  const at = text.indexOf("/");
  if (at <= 0) return { provider: "", model: text };
  return { provider: text.slice(0, at), model: text.slice(at + 1) };
}

function keyOf(provider, model) {
  const p = typeof provider === "string" ? provider : "";
  const m = typeof model === "string" ? model : "";
  if (p && m) return `${p}/${m}`;
  return m || p || "";
}

function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const t = [
    Math.max(0, num(usage.inputTokens)),
    Math.max(0, num(usage.outputTokens)),
    Math.max(0, num(usage.cacheReadTokens)),
    Math.max(0, num(usage.cacheWriteTokens)),
  ];
  if (t[0] + t[1] + t[2] + t[3] === 0) return null;
  return t;
}

function addTokens(target, tokens) {
  for (let i = 0; i < 4; i += 1) target[i] += tokens[i] ?? 0;
}

function sameTokens(a, b) {
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function lastUsageFromStream(stream) {
  const list = Array.isArray(stream) ? stream : Array.isArray(stream?.chunks) ? stream.chunks : null;
  if (list === null) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const chunk = list[i];
    if (chunk && chunk.type === "usage" && chunk.usage) return chunk.usage;
  }
  return undefined;
}

/** 与官方 tokenUsage 投影的 usageOf 语义一致。 */
function usageOf(event) {
  const data = event?.data ?? {};
  if (event?.type === "assistant/message" && data.usage !== undefined) return data.usage;
  if (event?.type !== "assistant/message" && event?.type !== "assistant/attempt") return undefined;
  return lastUsageFromStream(data.stream);
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch {
    /* 连接已断开 */
  }
}

function isTrusted(req) {
  try {
    const site = req.headers["sec-fetch-site"];
    if (site === "same-origin" || site === "same-site") return true;
    if (typeof req.headers.origin === "string" && req.headers.origin.length > 0) return true;
    const cookie = req.headers.cookie;
    if (typeof cookie === "string" && cookie.includes("dsh-auth-")) return true;
    const addr = String(req.socket?.remoteAddress ?? "");
    if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.endsWith("127.0.0.1")) return true;
    return false;
  } catch {
    return true;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/* ------------------------------- 账本 ------------------------------- */

function emptyLedger() {
  return {
    version: 2,
    rate: DEFAULT_RATE,
    symbol: DEFAULT_SYMBOL,
    // 旧字段：0.1 版用「已充金额 / 自设上限」做上限，0.2 起上限改为账户余额，仅为兼容旧账本保留。
    topUp: 0,
    limit: 0,
    /** 单会话默认上限（0 = 不设）。 */
    sessionLimit: 0,
    /** 按会话覆盖的上限：{ [sessionId]: 金额 }。 */
    sessionLimits: {},
    /** 已被「本会话放行」的会话：{ [sessionId]: true }。 */
    sessionAllow: {},
    guard: true,
    overrideOnce: false,
    overrideSession: false,
    overrides: {},
    sessions: {},
    archivedByModel: {},
    resetAt: 0,
    updatedAt: 0,
  };
}

function moneyMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const amount = clampMoney(value);
    if (amount > 0) out[key] = amount;
  }
  return out;
}

function flagMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === true || value === 1 || value === "true") out[key] = true;
  }
  return out;
}

function normalizeLedger(raw) {
  const base = emptyLedger();
  if (!raw || typeof raw !== "object") return base;
  const overrides = {};
  if (raw.overrides && typeof raw.overrides === "object") {
    for (const [key, value] of Object.entries(raw.overrides)) {
      if (isPrice(value)) overrides[key] = value.map((v) => num(v));
    }
  }
  const sessions = {};
  if (raw.sessions && typeof raw.sessions === "object") {
    for (const [id, record] of Object.entries(raw.sessions)) {
      if (!record || typeof record !== "object") continue;
      const steps = {};
      if (record.steps && typeof record.steps === "object") {
        for (const [stepKey, step] of Object.entries(record.steps)) {
          if (!step || typeof step !== "object") continue;
          const tokens = Array.isArray(step.t) ? step.t.map((v) => Math.max(0, num(v))) : null;
          if (!tokens || tokens.length !== 4) continue;
          steps[stepKey] = { t: tokens, m: typeof step.m === "string" ? step.m : "", at: num(step.at) };
        }
      }
      sessions[id] = {
        lastSeq: Math.max(0, Math.floor(num(record.lastSeq))),
        steps,
        updated: num(record.updated),
        title: typeof record.title === "string" ? record.title : "",
      };
    }
  }
  const archivedByModel = {};
  if (raw.archivedByModel && typeof raw.archivedByModel === "object") {
    for (const [model, tokens] of Object.entries(raw.archivedByModel)) {
      if (!Array.isArray(tokens) || tokens.length !== 4) continue;
      archivedByModel[model] = tokens.map((v) => Math.max(0, num(v)));
    }
  }
  return {
    ...base,
    rate: num(raw.rate, DEFAULT_RATE) > 0 ? num(raw.rate, DEFAULT_RATE) : DEFAULT_RATE,
    symbol: typeof raw.symbol === "string" && raw.symbol ? raw.symbol : DEFAULT_SYMBOL,
    topUp: clampMoney(raw.topUp),
    limit: clampMoney(raw.limit),
    sessionLimit: clampMoney(raw.sessionLimit),
    sessionLimits: moneyMap(raw.sessionLimits),
    sessionAllow: flagMap(raw.sessionAllow),
    guard: raw.guard !== false,
    overrideOnce: raw.overrideOnce === true,
    overrideSession: raw.overrideSession === true,
    overrides,
    sessions,
    archivedByModel,
    resetAt: num(raw.resetAt),
    updatedAt: num(raw.updatedAt),
  };
}

/* ------------------------------- 插件体 ------------------------------- */

export function apply(ctx, config = {}) {
  const pricing = loadBundledPricing();
  const storeFile = expandHome(config.storeFile) || join(homedir(), ".dsh", "billing", "ledger.json");
  const bundled = {
    rate: num(config.rate, 0) > 0 ? num(config.rate, 0) : 0,
    topUp: num(config.topUp, 0),
    limit: num(config.limit, 0),
    guard: config.guard,
  };

  let state = emptyLedger();
  let migrated = false;
  try {
    const disk = JSON.parse(readFileSync(storeFile, "utf8"));
    // 0.1 的账本只有 version 1：读进来会就地补成 version 2，随后立刻落盘。
    migrated = num(disk?.version, 0) !== 2;
    state = normalizeLedger(disk);
  } catch {
    const fresh = emptyLedger();
    if (bundled.rate > 0) fresh.rate = bundled.rate;
    if (bundled.topUp > 0) fresh.topUp = clampMoney(bundled.topUp);
    if (bundled.limit > 0) fresh.limit = clampMoney(bundled.limit);
    if (typeof bundled.guard === "boolean") fresh.guard = bundled.guard;
    state = fresh;
  }
  if (state.limit > 0 && state.topUp > 0) state.limit = Math.min(state.limit, state.topUp);

  /** WeakMap<Session, {header}> —— 每个会话当前折叠到哪条路由。 */
  const folds = new WeakMap();
  const live = new Set();
  let lastBlock = null;
  let saveTimer = null;
  let dirty = false;

  // 0.1 的账本读进来会就地升级到 version 2：立刻落盘，免得磁盘上长期是旧结构。
  if (migrated) saveNow();

  /* ---- 持久化 ---- */
  function saveNow() {
    dirty = false;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    state.updatedAt = Date.now();
    try {
      mkdirSync(dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(tmp, storeFile);
    } catch (error) {
      ctx.logger?.warn?.(`billing: 账本写入失败 ${storeFile}: ${String(error?.message ?? error)}`);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) saveNow();
    }, 1200);
    saveTimer.unref?.();
  }

  /* ---- 账户余额（全局上限的唯一来源） ---- */
  const VERSION = "0.2.0";
  let balance = {
    available: false,
    cny: null,
    at: 0,
    error: "",
    wallets: [],
    bonusCNY: 0,
    currency: null,
    topUpUrl: null,
    signedIn: null,
  };
  let balanceInflight = null;

  function walletCNY(wallet) {
    const amount = num(wallet?.balance, 0);
    const currency = typeof wallet?.currency === "string" ? wallet.currency.toUpperCase() : "CNY";
    if (currency === "USD") return amount * state.rate;
    return amount;
  }

  function refreshBalance(force = false) {
    const now = Date.now();
    if (!force && balance.at > 0 && now - balance.at < BALANCE_TTL_MS) return Promise.resolve(balance);
    if (balanceInflight) return balanceInflight;
    const fail = (patch) => ({ ...balance, at: now, available: false, cny: null, ...patch });
    balanceInflight = (async () => {
      let next;
      try {
        const account = typeof ctx.get === "function" ? ctx.get("deepseekAccount") : undefined;
        if (!account || typeof account.getBalance !== "function") {
          balance = fail({ error: "账户服务不可用" });
          return balance;
        }
        const meta = {
          version: VERSION,
          locale: "zh-CN",
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        const [details, view] = await Promise.all([
          account.getBalance(meta).catch((error) => ({ __error: String(error?.message ?? error) })),
          typeof account.getState === "function" ? account.getState().catch(() => null) : Promise.resolve(null),
        ]);
        const patch = {};
        if (view && typeof view === "object") {
          patch.signedIn = view.status === "credential-stored";
          if (typeof view.links?.topUpUrl === "string") patch.topUpUrl = view.links.topUpUrl;
        }
        if (details && details.__error !== undefined) {
          balance = fail({ ...patch, error: `余额查询失败：${details.__error}` });
        } else if (details === null || details === undefined) {
          balance = fail({ ...patch, error: patch.signedIn === false ? "未登录 DeepSeek 账号" : "暂无余额信息" });
        } else if (details.status === "ready") {
          const rows = [];
          let topUpCNY = 0;
          for (const wallet of Array.isArray(details.value) ? details.value : []) {
            const cny = walletCNY(wallet);
            topUpCNY += cny;
            rows.push({ currency: String(wallet?.currency ?? "CNY"), amount: num(wallet?.balance, 0), cny, bonus: false });
          }
          let bonusCNY = 0;
          for (const wallet of Array.isArray(details.bonusWallets) ? details.bonusWallets : []) {
            const cny = walletCNY(wallet);
            bonusCNY += cny;
            rows.push({ currency: String(wallet?.currency ?? "CNY"), amount: num(wallet?.balance, 0), cny, bonus: true });
          }
          const total = Math.round((topUpCNY + bonusCNY) * 10000) / 10000;
          balance = {
            ...balance,
            ...patch,
            available: true,
            cny: total,
            wallets: rows,
            bonusCNY: Math.round(bonusCNY * 10000) / 10000,
            currency: rows[0]?.currency ?? null,
            error: total <= 0 ? "余额为 0" : "",
            at: now,
          };
        } else {
          balance = fail({ ...patch, error: "余额状态未知" });
        }
      } catch (error) {
        balance = fail({ error: String(error?.message ?? error) });
      }
      return balance;
    })().finally(() => {
      balanceInflight = null;
    });
    return balanceInflight;
  }

  /* ---- 定价 ---- */
  function officialPrice(provider, model) {
    const byProvider = pricing.providers[provider];
    if (byProvider && isPrice(byProvider[model])) return byProvider[model];
    const owner = pricing.byModel[model];
    if (owner && pricing.providers[owner] && isPrice(pricing.providers[owner][model])) return pricing.providers[owner][model];
    const lower = String(model).toLowerCase();
    for (const [key, table] of Object.entries(pricing.providers)) {
      const hit = Object.keys(table).find((id) => id.toLowerCase() === lower);
      if (hit) return table[hit];
    }
    return null;
  }

  function resolvePrice(key) {
    const { provider, model } = splitKey(key);
    if (isPrice(state.overrides[key])) return { price: state.overrides[key], source: "override" };
    if (model && isPrice(state.overrides[model])) return { price: state.overrides[model], source: "override" };
    const official = model ? officialPrice(provider, model) : null;
    if (official) return { price: official, source: "official" };
    return { price: FALLBACK_PRICE, source: "fallback" };
  }

  function costUSD(tokens, price) {
    const [ai, ao, ar, aw] = price ?? FALLBACK_PRICE;
    const [ti, to, tr, tw] = tokens ?? [0, 0, 0, 0];
    return (ti * ai + to * ao + tr * ar + tw * aw) / 1e6;
  }

  /* ---- 派生金额（永远现算，改规则立即生效） ---- */
  function computeSpend() {
    const byModel = new Map();
    const take = (key, tokens) => {
      const existing = byModel.get(key) ?? [0, 0, 0, 0];
      addTokens(existing, tokens);
      byModel.set(key, existing);
    };
    for (const [key, tokens] of Object.entries(state.archivedByModel)) take(key, tokens);
    for (const record of Object.values(state.sessions)) {
      for (const step of Object.values(record.steps)) take(step.m || "", step.t);
    }
    let usd = 0;
    let cny = 0;
    let tokensTotal = [0, 0, 0, 0];
    const breakdown = [];
    for (const [key, tokens] of byModel) {
      const resolved = resolvePrice(key);
      const modelUSD = costUSD(tokens, resolved.price);
      usd += modelUSD;
      cny += modelUSD * state.rate;
      addTokens(tokensTotal, tokens);
      breakdown.push({
        key: key || "(未识别路由)",
        tokens,
        usd: modelUSD,
        cny: modelUSD * state.rate,
        price: resolved.price,
        source: resolved.source,
      });
    }
    breakdown.sort((a, b) => b.usd - a.usd);
    return { usd, cny, tokens: tokensTotal, breakdown };
  }

  /** 全局上限 = 账户余额（充值 + 赠金）。余额不可得或为 0 时 ceiling=0，且不阻断。 */
  function ceilingOf() {
    const value = balance.cny;
    if (!balance.available || value === null || !(value > 0)) {
      return { ceiling: 0, source: balance.available ? "balance-empty" : "balance-unavailable", available: false };
    }
    return { ceiling: value, source: "balance", available: true };
  }

  /** 单会话上限：按会话覆盖优先，其次默认值（0 = 不设）。 */
  function sessionCeilingOf(sessionId) {
    const id = typeof sessionId === "string" ? sessionId : "";
    const override = id ? clampMoney(state.sessionLimits[id]) : 0;
    if (override > 0) return { ceiling: override, source: "override" };
    if (state.sessionLimit > 0) return { ceiling: state.sessionLimit, source: "default" };
    return { ceiling: 0, source: "none" };
  }

  function sessionSpend(sessionId) {
    const record = sessionId ? state.sessions[sessionId] : undefined;
    let usd = 0;
    const tokens = [0, 0, 0, 0];
    if (record) {
      for (const step of Object.values(record.steps)) {
        usd += costUSD(step.t, resolvePrice(step.m || "").price);
        addTokens(tokens, step.t);
      }
    }
    return { usd, cny: usd * state.rate, tokens };
  }

  /** 该会话是否已被「本会话放行」（整会话放行 state.overrideSession 对全部会话生效）。 */
  function sessionAllowed(sessionId) {
    if (state.overrideSession === true) return true;
    return typeof sessionId === "string" && sessionId !== "" && state.sessionAllow[sessionId] === true;
  }

  function sessionsSummary(limit) {
    const rows = Object.entries(state.sessions).map(([id, record]) => {
      let usd = 0;
      const tokens = [0, 0, 0, 0];
      for (const step of Object.values(record.steps)) {
        usd += costUSD(step.t, resolvePrice(step.m || "").price);
        addTokens(tokens, step.t);
      }
      const cny = usd * state.rate;
      const cap = sessionCeilingOf(id);
      return {
        id,
        tokens,
        usd,
        cny,
        ceiling: cap.ceiling,
        ceilingSource: cap.source,
        percent: cap.ceiling > 0 ? Math.min(100, (cny / cap.ceiling) * 100) : 0,
        allowed: state.sessionAllow[id] === true,
        updated: record.updated,
        lastSeen: record.lastSeq,
      };
    });
    rows.sort((a, b) => b.cny - a.cny);
    return rows.slice(0, limit);
  }

  function buildState(sessionId = "") {
    const spend = computeSpend();
    const { ceiling, source, available } = ceilingOf();
    // 待生效的一次性/整会话放行期间，不再显示为「受阻」状态。
    const globalBlocked =
      state.guard !== false && ceiling > 0 && spend.cny >= ceiling && !state.overrideSession && !state.overrideOnce;
    const cap = sessionCeilingOf(sessionId);
    const perSession = sessionSpend(sessionId);
    const allowed = sessionAllowed(sessionId);
    const sessionBlocked =
      sessionId !== "" && state.guard !== false && cap.ceiling > 0 && perSession.cny >= cap.ceiling && !state.overrideOnce && !allowed;
    const currentKey = currentRouteKey();
    const current = currentKey ? { key: currentKey, ...resolvePrice(currentKey) } : null;
    return {
      ok: true,
      version: 2,
      symbol: state.symbol,
      currency: "CNY",
      rate: state.rate,
      balance: {
        available: balance.available,
        cny: balance.cny,
        bonusCNY: balance.bonusCNY,
        wallets: balance.wallets,
        currency: balance.currency,
        error: balance.error,
        at: balance.at,
        stale: balance.at > 0 && Date.now() - balance.at > BALANCE_TTL_MS * 2,
        topUpUrl: balance.topUpUrl,
        signedIn: balance.signedIn,
      },
      // 旧字段：0.1 版的「已充金额 / 自设上限」，不再参与上限计算。
      topUp: state.topUp,
      limit: state.limit,
      ceiling,
      ceilingAvailable: available,
      ceilingSource: source,
      usedCNY: spend.cny,
      usedUSD: spend.usd,
      tokens: spend.tokens,
      remainingCNY: ceiling > 0 ? Math.max(0, ceiling - spend.cny) : null,
      percent: ceiling > 0 ? Math.min(100, (spend.cny / ceiling) * 100) : 0,
      blocked: globalBlocked || sessionBlocked,
      blockScope: globalBlocked ? "global" : sessionBlocked ? "session" : null,
      sessionLimit: state.sessionLimit,
      session:
        sessionId === ""
          ? null
          : {
              id: sessionId,
              usedCNY: perSession.cny,
              usedUSD: perSession.usd,
              tokens: perSession.tokens,
              ceiling: cap.ceiling,
              ceilingSource: cap.source,
              percent: cap.ceiling > 0 ? Math.min(100, (perSession.cny / cap.ceiling) * 100) : 0,
              allowed,
              blocked: sessionBlocked,
            },
      guard: state.guard !== false,
      overrideOnce: state.overrideOnce,
      overrideSession: state.overrideSession,
      lastBlockAt: lastBlock?.at ?? 0,
      lastBlock: lastBlock,
      current,
      breakdown: spend.breakdown.slice(0, MAX_BREAKDOWN),
      sessions: sessionsSummary(20),
      ledgerFile: storeFile,
      pricing: { count: pricing.count, generatedAt: pricing.generatedAt, unit: "USD / 百万 token" },
      updatedAt: state.updatedAt,
    };
  }

  function currentRouteKey() {
    let best = null;
    for (const record of Object.values(state.sessions)) {
      if (!best || record.updated > best.updated) best = record;
    }
    if (!best) return "";
    let latest = "";
    let latestAt = -Infinity;
    for (const step of Object.values(best.steps)) {
      if (step.at >= latestAt) {
        latestAt = step.at;
        latest = step.m || "";
      }
    }
    return latest;
  }

  /* ---- 会话折叠 ---- */
  function recordFor(sessionId) {
    let record = state.sessions[sessionId];
    if (!record) {
      record = { lastSeq: 0, steps: {}, updated: Date.now(), title: "" };
      state.sessions[sessionId] = record;
    }
    return record;
  }

  function freezeRecord(record) {
    for (const step of Object.values(record.steps)) {
      const key = step.m || "";
      const existing = state.archivedByModel[key] ?? [0, 0, 0, 0];
      addTokens(existing, step.t);
      state.archivedByModel[key] = existing;
    }
    record.steps = {};
  }

  function pruneSessions() {
    const ids = Object.keys(state.sessions);
    if (ids.length <= MAX_SESSIONS) return;
    const liveIds = new Set();
    for (const session of live) {
      try {
        liveIds.add(session.id);
      } catch {
        /* ignore */
      }
    }
    const ranked = ids
      .filter((id) => !liveIds.has(id))
      .sort((a, b) => (state.sessions[a].updated ?? 0) - (state.sessions[b].updated ?? 0));
    let excess = ids.length - MAX_SESSIONS;
    for (const id of ranked) {
      if (excess <= 0) break;
      freezeRecord(state.sessions[id]);
      delete state.sessions[id];
      excess -= 1;
    }
  }

  function foldSession(session) {
    let record;
    let sessionId;
    try {
      sessionId = String(session.id);
    } catch {
      return;
    }
    record = recordFor(sessionId);
    const tail = Math.max(0, Math.floor(num(session.seq)));
    if (tail < record.lastSeq) {
      // 会话被截断/重写：把已计入的用量冻结进归档，然后从头重折。
      freezeRecord(record);
      record.lastSeq = 0;
    }
    let fold = folds.get(session);
    if (!fold) {
      fold = { header: "" };
      folds.set(session, fold);
    }
    if (record.lastSeq === 0) fold.header = "";
    let changed = false;
    let seq = record.lastSeq;
    let guardSteps = 0;
    while (seq < tail && guardSteps < 20000) {
      guardSteps += 1;
      let event;
      try {
        event = session.eventAt(seq);
      } catch {
        break;
      }
      if (!event) break;
      if (foldEvent(record, fold, event, seq)) changed = true;
      seq += 1;
    }
    record.lastSeq = seq;
    record.updated = Date.now();
    if (changed) {
      pruneSessions();
      scheduleSave();
    }
    return changed;
  }

  function foldEvent(record, fold, event, seq) {
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === "request/header") {
      const cfg = data.header?.config ?? data.config ?? data.header ?? {};
      const key = keyOf(cfg.provider, cfg.model);
      if (key) fold.header = key;
      return false;
    }
    if (type === "llm/retry-started") {
      const key = `${num(data.turn)}:${num(data.step)}`;
      if (fold.lastKey === key) fold.lastKey = undefined;
      return false;
    }
    if (type !== "assistant/message" && type !== "assistant/attempt") return false;
    const tokens = tokensOf(usageOf(event));
    if (!tokens) return false;
    const stepKey = `${num(data.turn)}:${num(data.step)}`;
    const previous = fold.lastKey === stepKey ? record.steps[stepKey] : undefined;
    const modelKey = fold.header || "";
    if (previous && previous.m === modelKey && sameTokens(previous.t, tokens)) return false;
    record.steps[stepKey] = { t: tokens, m: modelKey, at: Date.now() };
    fold.lastKey = stepKey;
    return true;
  }

  /* ---- 限额守卫 ---- */
  /** agent/pre-step 的 payload 形如 { messages, turn, step, signal, agent }（agent 由 dispatch 注入）。 */
  function sessionIdOf(payload) {
    try {
      const id = payload?.agent?.session?.id;
      if (id !== undefined && id !== null) return String(id);
    } catch {
      /* ignore */
    }
    return "";
  }

  function guardVerdict(sessionId) {
    if (state.guard === false) return null;
    const spend = computeSpend();
    const global = ceilingOf();
    const globalHit = global.ceiling > 0 && spend.cny >= global.ceiling;
    const cap = sessionCeilingOf(sessionId);
    const perSession = sessionId ? sessionSpend(sessionId) : { cny: 0 };
    const sessionHit = sessionId !== "" && cap.ceiling > 0 && perSession.cny >= cap.ceiling;
    if (!globalHit && !sessionHit) return null;
    // 整会话放行（旧字段）＝对所有会话放行；按会话放行只免掉该会话的单会话上限。
    if (state.overrideSession === true) return null;
    if (sessionHit && sessionAllowed(sessionId) && !globalHit) return null;
    if (state.overrideOnce) {
      state.overrideOnce = false;
      scheduleSave();
      lastBlock = null;
      return null;
    }
    if (globalHit) return { scope: "global", usedCNY: spend.cny, ceiling: global.ceiling, sessionId };
    return { scope: "session", usedCNY: perSession.cny, ceiling: cap.ceiling, sessionId };
  }

  const disposers = [];

  // 限额守卫：先让链上的其它 listener 表态，只在它们都允许时才由本插件拒绝。
  const onPreStep = async (payload, next) => {
    const decision = typeof next === "function" ? await next() : { kind: "enter" };
    if (!decision || decision.kind !== "enter") return decision;
    const sessionId = sessionIdOf(payload);
    let verdict;
    try {
      verdict = guardVerdict(sessionId);
    } catch {
      verdict = null;
    }
    if (!verdict) return decision;
    lastBlock = {
      at: Date.now(),
      scope: verdict.scope,
      usedCNY: verdict.usedCNY,
      ceiling: verdict.ceiling,
      sessionId: verdict.sessionId || undefined,
      agent: typeof payload?.agent?.id === "string" ? payload.agent.id : undefined,
    };
    scheduleSave();
    const label = verdict.scope === "session" ? "单会话上限" : "账户余额上限";
    ctx.logger?.info?.(
      `billing: 已达${label} ${verdict.usedCNY.toFixed(4)} / ${verdict.ceiling.toFixed(2)}，本轮已阻断`,
    );
    return { kind: "reject" };
  };
  ctx.on("agent/pre-step", onPreStep);

  const onSessionEvent = (session) => {
    live.add(session);
    try {
      foldSession(session);
    } catch (error) {
      ctx.logger?.warn?.(`billing: 用量折叠失败 ${String(error?.message ?? error)}`);
    }
  };
  ctx.on("session/event", onSessionEvent);

  /* ---- HTTP 路由 ---- */
  function route(path, handler) {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: `${API}${path}`,
      handler: async (req, res) => {
        if (!isTrusted(req)) {
          writeJson(res, 403, { ok: false, error: "forbidden" });
          return;
        }
        try {
          await handler(req, res);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    });
    if (typeof dispose === "function") disposers.push(dispose);
  }

  route("/state", async (req, res) => {
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const url = new URL(req.url ?? API, "http://127.0.0.1");
    const sessionId = (url.searchParams.get("session") ?? "").trim();
    const force = url.searchParams.get("refresh") === "1";
    try {
      await refreshBalance(force);
    } catch {
      /* 失败已记在 balance.error 里 */
    }
    writeJson(res, 200, buildState(sessionId));
  });

  route("/config", async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const body = await readBody(req);
    // 0.1 的 topUp / limit 已废弃：全局上限固定等于账户余额，发送这两个字段会被忽略。
    if (body.rate !== undefined) {
      const rate = num(body.rate, state.rate);
      if (rate > 0 && rate < 1000) state.rate = rate;
    }
    if (body.guard !== undefined) state.guard = body.guard !== false;
    if (body.sessionLimit !== undefined) state.sessionLimit = clampMoney(body.sessionLimit);
    if (typeof body.sessionId === "string" && body.sessionId !== "") {
      const forSession = clampMoney(body.sessionLimitFor);
      if (forSession > 0) {
        state.sessionLimits[body.sessionId] = forSession;
      } else {
        delete state.sessionLimits[body.sessionId];
        delete state.sessionAllow[body.sessionId];
      }
    }
    if (body.price && typeof body.price === "object" && typeof body.price.key === "string") {
      const key = body.price.key;
      if (body.price.reset === true) {
        delete state.overrides[key];
        delete state.overrides[splitKey(key).model];
      } else if (isPrice(body.price.value)) {
        state.overrides[key] = body.price.value.map((v) => num(v));
      }
    }
    if (body.resetPrices === true) state.overrides = {};
    saveNow();
    writeJson(res, 200, buildState(typeof body.sessionId === "string" ? body.sessionId : ""));
  });

  route("/override", async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const body = await readBody(req);
    const mode = typeof body.mode === "string" ? body.mode : "once";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (mode === "once") {
      state.overrideOnce = true;
      lastBlock = null;
    } else if (mode === "session") {
      // 带 sessionId = 只放行这个会话；不带 = 旧语义，放行所有会话。
      if (sessionId !== "") state.sessionAllow[sessionId] = true;
      else state.overrideSession = true;
      lastBlock = null;
    } else if (mode === "off") {
      state.overrideOnce = false;
      state.overrideSession = false;
      if (sessionId !== "") delete state.sessionAllow[sessionId];
    } else if (mode === "reset") {
      state.overrideOnce = false;
      state.overrideSession = false;
      state.sessionAllow = {};
      lastBlock = null;
    }
    saveNow();
    writeJson(res, 200, buildState(sessionId));
  });

  route("/reset", async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    for (const session of live) {
      let sessionId;
      let tail = 0;
      try {
        sessionId = String(session.id);
        tail = Math.max(0, Math.floor(num(session.seq)));
      } catch {
        continue;
      }
      const record = state.sessions[sessionId];
      if (record) {
        record.steps = {};
        record.lastSeq = tail;
      }
    }
    state.sessions = {};
    state.archivedByModel = {};
    state.resetAt = Date.now();
    lastBlock = null;
    saveNow();
    writeJson(res, 200, buildState());
  });

  route("/pricing", (req, res) => {
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const url = new URL(req.url ?? API, "http://127.0.0.1");
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const rows = [];
    for (const [provider, table] of Object.entries(pricing.providers)) {
      for (const [model, price] of Object.entries(table)) {
        const key = `${provider}/${model}`;
        if (query && !key.toLowerCase().includes(query)) continue;
        rows.push({ key, provider, model, price, source: isPrice(state.overrides[key]) ? "override" : "official" });
      }
    }
    // 精确命中优先，其次「provider 与模型同源」的条目，避免聚合类 provider 抢先。
    if (query) {
      rows.sort((a, b) => {
        const rank = (row) => {
          const key = row.key.toLowerCase();
          const model = row.model.toLowerCase();
          if (key === query) return 0;
          if (model === query) return row.provider.toLowerCase() && model.startsWith(row.provider.toLowerCase()) ? 1 : 2;
          if (key.startsWith(query)) return 3;
          return 4;
        };
        return rank(a) - rank(b) || a.key.length - b.key.length || a.key.localeCompare(b.key);
      });
    }
    writeJson(res, 200, { ok: true, count: pricing.count, generatedAt: pricing.generatedAt, rows: rows.slice(0, 200) });
  });

  // 诊断：确认浏览器半边（dsh.client bundle）是否已被 clientModules 收进启动图。
  route("/diag", (req, res) => {
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const out = {
      ok: true,
      plugin: name,
      api: API,
      storeFile,
      pricing: pricing.count,
      balance: {
        available: balance.available,
        cny: balance.cny,
        bonusCNY: balance.bonusCNY,
        wallets: balance.wallets,
        error: balance.error,
        at: balance.at,
        topUpUrl: balance.topUpUrl,
        signedIn: balance.signedIn,
      },
      sessionLimit: state.sessionLimit,
      browser: null,
      error: null,
    };
    try {
      const modules = typeof ctx.get === "function" ? ctx.get("clientModules") : ctx.clientModules;
      if (!modules) {
        out.error = "clientModules 服务不可用";
      } else {
        const graph = typeof modules.graph === "function" ? modules.graph() : undefined;
        const entries = Array.isArray(graph?.entries) ? graph.entries : [];
        const batches = Array.isArray(graph?.batches) ? graph.batches : [];
        out.browser = {
          rev: graph?.rev ?? null,
          clientPath: typeof modules.clientPath === "function" ? modules.clientPath(name) ?? null : null,
          hasEntry: entries.some((entry) => entry?.id === name),
          entries: entries.map((entry) => ({ id: entry?.id, rev: entry?.rev })),
          batches: batches.map((batch) =>
            batch && typeof batch === "object"
              ? Object.fromEntries(Object.entries(batch).filter(([key]) => key !== "body"))
              : batch,
          ),
        };
      }
    } catch (error) {
      out.error = String(error?.message ?? error);
    }
    writeJson(res, 200, out);
  });

  // 余额：启动时拉一次，之后每 60s 刷一次（浏览器没开着时守卫也要看得到余额）。
  const balanceTimer = setInterval(() => {
    refreshBalance(true).catch(() => {});
  }, BALANCE_POLL_MS);
  balanceTimer.unref?.();
  refreshBalance(true).catch(() => {});

  ctx.effect(
    () => () => {
      clearInterval(balanceTimer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      if (dirty) saveNow();
    },
    "yoka-dsh-billing: routes",
  );

  ctx.logger?.info?.(
    `billing: 已就绪（账本 ${storeFile}，价目表 ${pricing.count} 个模型，汇率 ${state.rate}，` +
      `全局上限=账户余额，单会话上限 ${state.sessionLimit || "未设"}）`,
  );
}
