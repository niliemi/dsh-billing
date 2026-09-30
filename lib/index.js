/**
 * yoka-dsh-billing —— 宿主半边。
 *
 * 职责：
 *  1. 折叠每个会话的用量事件，把 provider 上报的四类 token 累计下来（不累计金额，只存 token）。
 *  2. 金额永远是「按当前规则现算」的派生值：改汇率/改单价即刻反映到全部历史用量上。
 *  3. 账本持久化到 ~/.dsh/billing/ledger.json（可在 config.storeFile 覆盖）。
 *  4. 通过本地 HTTP 路由给浏览器半边读写（/plugin-billing/*）。
 *  5. 在 agent/pre-step 上做限额守卫：**全局上限由主人自设**（账本 limit，0 = 不设上限），
 *     账户余额（充值 + 赠金）只是它的夹取边界与参考显示——设的值超过余额时夹到余额；
 *     **单会话上限 = 账本里的默认值 / 按会话覆盖**（不受余额夹取）；
 *     任一越线都以 {kind:"reject"} 结束该轮，不发 LLM 请求。
 *  6. 余额带 60s 缓存（它不随 token 变化，不必每次轮询都打 Platform）；查不到余额时只影响
 *     夹取与显示——主人自设的上限照旧生效，未设上限则不阻断。
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
    version: 3,
    rate: DEFAULT_RATE,
    symbol: DEFAULT_SYMBOL,
    // `topUp`（0.1 的「已充金额」）已废弃：余额现在直接读账户，只保留字段兼容旧账本。
    topUp: 0,
    /** 主人自设的全局计费上限（0 = 不设上限 = 不阻断）；余额只做它的夹取边界。 */
    limit: 0,
    /**
     * 单会话上限：{ [sessionId]: 金额 }。每个会话各设各的，互不影响；
     * 表里没有该会话 = 该会话不设上限。
     */
    sessionLimits: {},
    /** 已被「本会话放行」的会话：{ [sessionId]: true }。 */
    sessionAllow: {},
    guard: true,
    overrideOnce: false,
    overrideSession: false,
    overrides: {},
    sessions: {},
    /** 已折叠（超龄或重写）会话的 token：{ [模型键]: [四类 token] }。 */
    archivedByModel: {},
    /**
     * **全局**「重置计费起点」前移出去的 token：{ [模型键]: [四类 token] }。
     * 全局与单会话的计费起点各算各的：全局重置只动这里，不碰任何会话的基线；
     * 某个会话重置只动那个会话的 `baselineByModel`，不影响全局。
     * 金额永远现算，所以基线存的是 token 而不是金额——改汇率/单价时基线也会跟着重算。
     * 全局本次 = 全部 token − globalBaseline（逐模型相减，不会为负）。
     */
    globalBaseline: {},
    /** 上次重置计费起点的时间（软重置与硬重置都会更新）。 */
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

/** `{ [模型键]: [四类 token] }`（基线快照 / 归档用量都是这个形状）。 */
function tokenMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, tokens] of Object.entries(raw)) {
    if (!Array.isArray(tokens) || tokens.length !== 4) continue;
    const values = tokens.map((v) => Math.max(0, num(v)));
    if (values.some((v) => v > 0)) out[key] = values;
  }
  return out;
}

/** 把一串四类 token 累加进 `{ [模型键]: [四类 token] }`（归一化阶段用）。 */
function addTokensTo(map, key, tokens) {
  const slot = map[key] ?? [0, 0, 0, 0];
  for (let index = 0; index < 4; index += 1) slot[index] += Math.max(0, num(tokens[index]));
  if (slot.some((value) => value > 0)) map[key] = slot;
  return map;
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
        // 该会话上次「重置计费起点」时的 token 快照：本次已用 = steps − baselineByModel。
        baselineByModel: tokenMap(record.baselineByModel),
        resetAt: num(record.resetAt),
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
  const sessionLimits = moneyMap(raw.sessionLimits);
  // 0.2.1 及更早还有一个「单会话默认上限」，它对所有会话一起生效；0.2.2 起单会话上限各自独立。
  // 旧账本里若设过它，就把它落到当时已有记录的每个会话上——显式、看得见、可单独改，免得静默丢掉限额。
  const legacyDefault = clampMoney(raw.sessionLimit);
  if (legacyDefault > 0) {
    for (const id of Object.keys(sessions)) {
      if (!(id in sessionLimits)) sessionLimits[id] = legacyDefault;
    }
  }
  // 0.2.4 的基线是「合在一起」算的：全局本次 = 全部 − (archiveBaseline + 各会话基线)，
  // 因此那时的**全局重置会把基线写进每个会话**（主人报的 bug：全局重置后单会话也跟着重置）。
  // 0.2.5（version 3）起两者彻底分开：版本 3 之前的账本一次性迁移——
  // 把所有旧基线并进 globalBaseline（保持全局本次不变），并把「全局重置留下的」会话基线清掉
  // （这些会话的 resetAt 与顶层 resetAt 相同，说明它们来自一次全局重置，而不是主人单独重置的），
  // 这样被误伤的单会话立刻恢复成它自己的计费周期。
  const legacyVersion = Math.floor(num(raw.version, 0));
  const globalBaseline = tokenMap(raw.globalBaseline);
  if (legacyVersion < 3) {
    for (const [key, tokens] of Object.entries(tokenMap(raw.archiveBaseline))) addTokensTo(globalBaseline, key, tokens);
    const topResetAt = num(raw.resetAt);
    for (const record of Object.values(sessions)) {
      const own = record.baselineByModel;
      if (!own || Object.keys(own).length === 0) continue;
      const fromGlobalReset = topResetAt > 0 && record.resetAt === topResetAt;
      if (fromGlobalReset) {
        for (const [key, tokens] of Object.entries(own)) addTokensTo(globalBaseline, key, tokens);
        record.baselineByModel = {};
        record.resetAt = 0;
      } else {
        for (const [key, tokens] of Object.entries(own)) addTokensTo(globalBaseline, key, tokens);
      }
    }
  }
  return {
    ...base,
    rate: num(raw.rate, DEFAULT_RATE) > 0 ? num(raw.rate, DEFAULT_RATE) : DEFAULT_RATE,
    symbol: typeof raw.symbol === "string" && raw.symbol ? raw.symbol : DEFAULT_SYMBOL,
    topUp: clampMoney(raw.topUp),
    limit: clampMoney(raw.limit),
    sessionLimits,
    sessionAllow: flagMap(raw.sessionAllow),
    guard: raw.guard !== false,
    overrideOnce: raw.overrideOnce === true,
    overrideSession: raw.overrideSession === true,
    overrides,
    sessions,
    archivedByModel,
    globalBaseline,
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
    // 旧结构（version < 3）读进来会就地升级：立刻落盘，免得磁盘上长期是旧结构。
    migrated = num(disk?.version, 0) !== 3;
    state = normalizeLedger(disk);
  } catch {
    const fresh = emptyLedger();
    if (bundled.rate > 0) fresh.rate = bundled.rate;
    if (bundled.topUp > 0) fresh.topUp = clampMoney(bundled.topUp);
    if (bundled.limit > 0) fresh.limit = clampMoney(bundled.limit);
    if (typeof bundled.guard === "boolean") fresh.guard = bundled.guard;
    state = fresh;
  }

  /** WeakMap<Session, {header}> —— 每个会话当前折叠到哪条路由。 */
  const folds = new WeakMap();
  const live = new Set();
  let lastBlock = null;
  let saveTimer = null;
  let dirty = false;

  // 旧结构的账本读进来会就地升级到 version 3：立刻落盘，免得磁盘上长期是旧结构。
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
  const VERSION = "0.2.5";
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
  /** 把一个 `{ 模型键: 四类 token }` 表折成金额。 */
  function spendOfByModel(byModel) {
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

  function addByModel(byModel, key, tokens) {
    const existing = byModel.get(key) ?? [0, 0, 0, 0];
    addTokens(existing, tokens);
    byModel.set(key, existing);
    return byModel;
  }

  /** 全部 token（含归档）按模型汇总 = 「累计」。 */
  function totalByModel() {
    const byModel = new Map();
    for (const [key, tokens] of Object.entries(state.archivedByModel)) addByModel(byModel, key, tokens);
    for (const record of Object.values(state.sessions)) {
      for (const step of Object.values(record.steps)) addByModel(byModel, step.m || "", step.t);
    }
    return byModel;
  }

  /** 全局「重置计费起点」已经前移出去、只算进「累计」的 token（与单会话的基线互不影响）。 */
  function globalBaselineByModel() {
    const byModel = new Map();
    for (const [key, tokens] of Object.entries(state.globalBaseline)) addByModel(byModel, key, tokens);
    return byModel;
  }

  /** 逐模型相减（模型价不同，所以只能逐模型减），结果不会为负。 */
  function subtractByModel(all, cut) {
    const out = new Map();
    for (const [key, tokens] of all) {
      const base = cut.get(key) ?? [0, 0, 0, 0];
      const fresh = tokens.map((value, index) => Math.max(0, value - (base[index] ?? 0)));
      if (fresh.some((value) => value > 0)) out.set(key, fresh);
    }
    return out;
  }

  /** 累计（终身，永不归零，只有硬重置才清）。 */
  function computeSpend() {
    return spendOfByModel(totalByModel());
  }

  /**
   * 全局「本次」（自上次**全局**重置计费起点以来）= 累计 − globalBaseline。
   * 只看全局基线：任何单会话的重置都不会改变它。
   */
  function computeFreshSpend() {
    return spendOfByModel(subtractByModel(totalByModel(), globalBaselineByModel()));
  }

  /** 按模型视图：同一行给「本次」与「累计」两个口径（面板显示本次，累计作参考）。 */
  function combinedBreakdown(fresh, total) {
    const rows = new Map();
    for (const row of fresh.breakdown) {
      rows.set(row.key, { ...row, totalTokens: [0, 0, 0, 0], totalUSD: 0, totalCNY: 0 });
    }
    for (const row of total.breakdown) {
      const slot =
        rows.get(row.key) ??
        { key: row.key, tokens: [0, 0, 0, 0], usd: 0, cny: 0, price: row.price, source: row.source };
      slot.totalTokens = row.tokens;
      slot.totalUSD = row.usd;
      slot.totalCNY = row.cny;
      rows.set(row.key, slot);
    }
    const out = [...rows.values()];
    out.sort((a, b) => b.totalUSD - a.totalUSD || b.usd - a.usd);
    return out.slice(0, MAX_BREAKDOWN);
  }

  /**
   * 全局计费上限：**由主人自己设**（`state.limit`，0 = 不设上限 = 不阻断）。
   * 账户余额（充值 + 赠金）不是上限本身，只是它的夹取边界：设的值超过余额就夹到余额。
   * 余额读不到时无法夹取，此时尊重主人自己设的值（自设上限的意义就是拦住花费）。
   */
  function ceilingOf() {
    const hard = balance.available && balance.cny !== null && balance.cny > 0 ? balance.cny : 0;
    const raw = clampMoney(state.limit);
    if (raw <= 0) return { ceiling: 0, source: "unset", available: false, hard, raw: 0 };
    const clamped = hard > 0 && raw > hard;
    return { ceiling: clamped ? hard : raw, source: clamped ? "limit-clamped" : "limit", available: true, hard, raw };
  }

  /** 单会话上限：只认该会话自己的值（0 = 该会话不设上限，不与其他会话共用）。 */
  function sessionCeilingOf(sessionId) {
    const id = typeof sessionId === "string" ? sessionId : "";
    const own = id ? clampMoney(state.sessionLimits[id]) : 0;
    if (own > 0) return { ceiling: own, source: "own" };
    return { ceiling: 0, source: "none" };
  }

  /**
   * 单个会话的用量。`cny/usd/tokens` 是**本次**（自该会话上次重置计费起点以来，
   * 上限比的就是它），`totalCNY/totalUSD/totalTokens` 是该会话的**累计**（历史保留）。
   */
  function sessionSpend(sessionId) {
    const record = sessionId ? state.sessions[sessionId] : undefined;
    const all = new Map();
    const base = new Map();
    if (record) {
      for (const step of Object.values(record.steps)) addByModel(all, step.m || "", step.t);
      for (const [key, tokens] of Object.entries(record.baselineByModel ?? {})) addByModel(base, key, tokens);
    }
    const total = spendOfByModel(all);
    const fresh = spendOfByModel(subtractByModel(all, base));
    return {
      usd: fresh.usd,
      cny: fresh.cny,
      tokens: fresh.tokens,
      totalUSD: total.usd,
      totalCNY: total.cny,
      totalTokens: total.tokens,
    };
  }

  /** 某个会话 `steps` 的 token 快照（重置计费起点时把它记成基线）。 */
  function snapshotRecord(record) {
    const map = {};
    for (const step of Object.values(record?.steps ?? {})) {
      const key = step.m || "";
      const slot = map[key] ?? [0, 0, 0, 0];
      addTokens(slot, step.t);
      map[key] = slot;
    }
    return map;
  }

  /** 全部用量（归档 + 所有会话的 steps）的 token 快照 —— 全局重置计费起点时用它。 */
  function snapshotAll() {
    const map = {};
    for (const [key, tokens] of Object.entries(state.archivedByModel)) {
      const slot = map[key] ?? [0, 0, 0, 0];
      addTokens(slot, tokens);
      map[key] = slot;
    }
    for (const record of Object.values(state.sessions)) {
      for (const [key, tokens] of Object.entries(snapshotRecord(record))) {
        const slot = map[key] ?? [0, 0, 0, 0];
        addTokens(slot, tokens);
        map[key] = slot;
      }
    }
    return map;
  }

  /**
   * 「重置计费起点」：把当前用量前移成基线，历史费用只进「累计」。
   * **全局与单会话各算各的**：全局重置只写 `state.globalBaseline`，一个会话的基线都不碰；
   * 单会话重置只写那个会话的 `baselineByModel`，全局本次分毫不动。
   * 上限比的是各自的「本次」，所以重置后立刻不再阻断——不需要调高上限，也不用清掉 token 记录。
   */
  function resetBaseline(scope, sessionId) {
    const now = Date.now();
    if (scope === "session" && sessionId && state.sessions[sessionId]) {
      state.sessions[sessionId].baselineByModel = snapshotRecord(state.sessions[sessionId]);
      state.sessions[sessionId].resetAt = now;
    } else {
      state.globalBaseline = snapshotAll();
    }
    state.resetAt = now;
    saveNow();
    return now;
  }

  /** 该会话是否已被「本会话放行」（整会话放行 state.overrideSession 对全部会话生效）。 */
  function sessionAllowed(sessionId) {
    if (state.overrideSession === true) return true;
    return typeof sessionId === "string" && sessionId !== "" && state.sessionAllow[sessionId] === true;
  }

  function sessionsSummary(limit) {
    const rows = Object.keys(state.sessions).map((id) => {
      const record = state.sessions[id];
      const spend = sessionSpend(id);
      const cap = sessionCeilingOf(id);
      return {
        id,
        tokens: spend.tokens,
        usd: spend.usd,
        cny: spend.cny,
        totalTokens: spend.totalTokens,
        totalUSD: spend.totalUSD,
        totalCNY: spend.totalCNY,
        ceiling: cap.ceiling,
        ceilingSource: cap.source,
        percent: cap.ceiling > 0 ? Math.min(100, (spend.cny / cap.ceiling) * 100) : 0,
        allowed: state.sessionAllow[id] === true,
        resetAt: num(record.resetAt),
        updated: record.updated,
        lastSeen: record.lastSeq,
      };
    });
    rows.sort((a, b) => b.cny - a.cny || b.totalCNY - a.totalCNY);
    return rows.slice(0, limit);
  }

  function buildState(sessionId = "") {
    const spend = computeSpend();
    const fresh = computeFreshSpend();
    const { ceiling, source, available, hard, raw } = ceilingOf();
    // 待生效的一次性/整会话放行期间，不再显示为「受阻」状态。
    const globalBlocked =
      state.guard !== false && ceiling > 0 && fresh.cny >= ceiling && !state.overrideSession && !state.overrideOnce;
    const cap = sessionCeilingOf(sessionId);
    const perSession = sessionSpend(sessionId);
    const allowed = sessionAllowed(sessionId);
    const sessionBlocked =
      sessionId !== "" && state.guard !== false && cap.ceiling > 0 && perSession.cny >= cap.ceiling && !state.overrideOnce && !allowed;
    const currentKey = currentRouteKey();
    const current = currentKey ? { key: currentKey, ...resolvePrice(currentKey) } : null;
    return {
      ok: true,
      version: 3,
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
      // `limit` = 主人自设的全局上限（0 = 不设）；`topUp` 是 0.1 的遗留字段，不参与计算。
      topUp: state.topUp,
      limit: raw,
      ceiling,
      ceilingAvailable: available,
      ceilingSource: source,
      // 余额只做夹取边界与参考显示，不是上限本身。
      balanceCap: hard > 0 ? hard : null,
      ceilingClamped: source === "limit-clamped",
      // 「本次」= 自上次重置计费起点以来；上限比的就是它。「累计」永不归零，只有硬重置才清。
      usedCNY: fresh.cny,
      usedUSD: fresh.usd,
      tokens: fresh.tokens,
      totalCNY: spend.cny,
      totalUSD: spend.usd,
      totalTokens: spend.tokens,
      baselineCNY: Math.max(0, spend.cny - fresh.cny),
      resetAt: state.resetAt,
      remainingCNY: ceiling > 0 ? Math.max(0, ceiling - fresh.cny) : null,
      percent: ceiling > 0 ? Math.min(100, (fresh.cny / ceiling) * 100) : 0,
      blocked: globalBlocked || sessionBlocked,
      blockScope: globalBlocked ? "global" : sessionBlocked ? "session" : null,
      sessionLimits: state.sessionLimits,
      session:
        sessionId === ""
          ? null
          : {
              id: sessionId,
              usedCNY: perSession.cny,
              usedUSD: perSession.usd,
              tokens: perSession.tokens,
              totalCNY: perSession.totalCNY,
              totalUSD: perSession.totalUSD,
              totalTokens: perSession.totalTokens,
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
      breakdown: combinedBreakdown(fresh, spend),
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
      record = { lastSeq: 0, steps: {}, baselineByModel: {}, resetAt: 0, updated: Date.now(), title: "" };
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
    // 该会话的 steps 已经进归档（总量不变，所以全局本次不受影响）。
    // 它自己的基线跟着丢掉：会话周期就此结束，同一个 id 若再出现要从头算。
    record.baselineByModel = {};
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
    const spend = computeFreshSpend();
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
    // `limit` = 主人自设的全局上限（0 / 留空 = 不设上限）。它不来自余额，
    // 只在超过余额时被夹到余额（余额读不到就不夹）。`topUp` 是 0.1 遗留，忽略。
    // 存原值：夹取只在 ceilingOf() 里做，这样余额涨回来 / 主人改主意时原值还在。
    if (body.limit !== undefined) state.limit = clampMoney(body.limit);
    if (body.rate !== undefined) {
      const rate = num(body.rate, state.rate);
      if (rate > 0 && rate < 1000) state.rate = rate;
    }
    if (body.guard !== undefined) state.guard = body.guard !== false;
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
    const next = buildState(typeof body.sessionId === "string" ? body.sessionId : "");
    const limitClamped = next.ceilingClamped === true;
    writeJson(res, 200, limitClamped ? { ...next, limitClamped: true } : next);
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
    const body = await readBody(req);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const scope = body.scope === "session" ? "session" : "global";
    if (body.hard === true) {
      // 硬重置（清空历史）：token 记录整段抹掉，「累计」也一起归零，不可恢复。
      for (const session of live) {
        let id;
        let tail = 0;
        try {
          id = String(session.id);
          tail = Math.max(0, Math.floor(num(session.seq)));
        } catch {
          continue;
        }
        const record = state.sessions[id];
        if (record) {
          record.steps = {};
          record.baselineByModel = {};
          record.lastSeq = tail;
        }
      }
      state.sessions = {};
      state.archivedByModel = {};
      state.globalBaseline = {};
      state.resetAt = Date.now();
      lastBlock = null;
      saveNow();
      writeJson(res, 200, buildState(scope === "session" ? sessionId : ""));
      return;
    }
    // 软重置（默认）：「重置计费起点」。当前用量前移成基线 → 本次归零、不再阻断，
    // 历史只进累计，token 记录一条不丢。全局或单个会话都行。
    resetBaseline(scope, sessionId);
    lastBlock = null;
    state.overrideOnce = false;
    if (scope === "session" && sessionId) delete state.sessionAllow[sessionId];
    else state.overrideSession = false;
    saveNow();
    writeJson(res, 200, buildState(sessionId));
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
      sessionLimits: { ...state.sessionLimits },
      spend: (() => {
        const total = computeSpend();
        const fresh = computeFreshSpend();
        return {
          freshCNY: fresh.cny,
          totalCNY: total.cny,
          baselineCNY: Math.max(0, total.cny - fresh.cny),
          freshTokens: fresh.tokens,
          totalTokens: total.tokens,
          resetAt: state.resetAt,
          // 全局与单会话的计费起点各算各的：globalBaseline 只受全局 ↺ 影响，
          // sessionBaselines 只受各自会话的 ↺ 影响。
          globalBaseline: { ...state.globalBaseline },
          sessionBaselines: Object.fromEntries(
            Object.entries(state.sessions)
              .filter(([, record]) => Object.keys(record.baselineByModel ?? {}).length > 0)
              .map(([id, record]) => [id, { ...record.baselineByModel, resetAt: num(record.resetAt) }]),
          ),
        };
      })(),
      limit: (() => {
        const g = ceilingOf();
        return { set: g.raw, effective: g.ceiling, source: g.source, balanceCap: g.hard > 0 ? g.hard : null };
      })(),
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
      `全局上限 ${state.limit > 0 ? state.limit : "未设"}，单会话上限各自独立（已设 ${Object.keys(state.sessionLimits).length} 个会话））`,
  );
}
