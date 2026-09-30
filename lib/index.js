/**
 * yoka-dsh-billing —— 宿主半边。
 *
 * 职责：
 *  1. 折叠每个会话的用量事件，把 provider 上报的四类 token 累计下来（不累计金额，只存 token）。
 *  2. 金额永远是「按当前规则现算」的派生值：改汇率/改单价即刻反映到全部历史用量上。
 *  3. 账本持久化到 ~/.dsh/billing/ledger.json（可在 config.storeFile 覆盖）。
 *  4. 通过本地 HTTP 路由给浏览器半边读写（/plugin-billing/*）。
 *  5. 在 agent/pre-step 上做限额守卫：达到上限时以 {kind:"reject"} 结束该轮，不发 LLM 请求。
 *
 * 只有 node 内置模块依赖；不 import 任何 @deepseek-ai/* 包，避免解析风险。
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
    version: 1,
    rate: DEFAULT_RATE,
    symbol: DEFAULT_SYMBOL,
    topUp: 0,
    limit: 0,
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
  try {
    state = normalizeLedger(JSON.parse(readFileSync(storeFile, "utf8")));
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

  function ceilingOf() {
    if (state.topUp <= 0) return { ceiling: 0, source: "none" };
    if (state.limit > 0) return { ceiling: Math.min(state.limit, state.topUp), source: "limit" };
    return { ceiling: state.topUp, source: "topUp" };
  }

  function sessionsSummary(limit) {
    const rows = Object.entries(state.sessions).map(([id, record]) => {
      let usd = 0;
      const tokens = [0, 0, 0, 0];
      for (const step of Object.values(record.steps)) {
        usd += costUSD(step.t, resolvePrice(step.m || "").price);
        addTokens(tokens, step.t);
      }
      return { id, tokens, usd, cny: usd * state.rate, updated: record.updated, lastSeen: record.lastSeq };
    });
    rows.sort((a, b) => b.cny - a.cny);
    return rows.slice(0, limit);
  }

  function buildState() {
    const spend = computeSpend();
    const { ceiling, source } = ceilingOf();
    // 待生效的一次性/整会话放行期间，不再显示为「受阻」状态。
    const blocked =
      state.guard !== false &&
      ceiling > 0 &&
      spend.cny >= ceiling &&
      !state.overrideSession &&
      !state.overrideOnce;
    const currentKey = currentRouteKey();
    const current = currentKey ? { key: currentKey, ...resolvePrice(currentKey) } : null;
    return {
      ok: true,
      version: 1,
      symbol: state.symbol,
      currency: "CNY",
      rate: state.rate,
      topUp: state.topUp,
      limit: state.limit,
      ceiling,
      ceilingSource: source,
      usedCNY: spend.cny,
      usedUSD: spend.usd,
      tokens: spend.tokens,
      remainingCNY: ceiling > 0 ? Math.max(0, ceiling - spend.cny) : null,
      percent: ceiling > 0 ? Math.min(100, (spend.cny / ceiling) * 100) : 0,
      blocked,
      guard: state.guard !== false,
      overrideOnce: state.overrideOnce,
      overrideSession: state.overrideSession,
      lastBlockAt: lastBlock?.at ?? 0,
      lastBlock: lastBlock,
      current,
      breakdown: spend.breakdown.slice(0, MAX_BREAKDOWN),
      sessions: sessionsSummary(5),
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
  function guardVerdict() {
    if (state.guard === false) return null;
    const { ceiling } = ceilingOf();
    if (ceiling <= 0) return null;
    const spend = computeSpend();
    if (spend.cny < ceiling) return null;
    if (state.overrideSession) return null;
    if (state.overrideOnce) {
      state.overrideOnce = false;
      scheduleSave();
      lastBlock = null;
      return null;
    }
    return { usedCNY: spend.cny, ceiling };
  }

  const disposers = [];

  // 限额守卫：先让链上的其它 listener 表态，只在它们都允许时才由本插件拒绝。
  const onPreStep = async (payload, next) => {
    const decision = typeof next === "function" ? await next() : { kind: "enter" };
    if (!decision || decision.kind !== "enter") return decision;
    let verdict;
    try {
      verdict = guardVerdict();
    } catch {
      verdict = null;
    }
    if (!verdict) return decision;
    lastBlock = {
      at: Date.now(),
      usedCNY: verdict.usedCNY,
      ceiling: verdict.ceiling,
      agent: typeof payload?.agent?.id === "string" ? payload.agent.id : undefined,
    };
    scheduleSave();
    ctx.logger?.info?.(`billing: 已达费用上限 ${verdict.usedCNY.toFixed(4)} / ${verdict.ceiling.toFixed(2)}，本轮已阻断`);
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

  route("/state", (req, res) => {
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    writeJson(res, 200, buildState());
  });

  route("/config", async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const body = await readBody(req);
    if (body.topUp !== undefined) state.topUp = clampMoney(body.topUp);
    if (body.limit !== undefined) state.limit = clampMoney(body.limit);
    if (state.topUp > 0 && state.limit > 0) state.limit = Math.min(state.limit, state.topUp);
    if (state.topUp <= 0) state.limit = 0;
    if (body.rate !== undefined) {
      const rate = num(body.rate, state.rate);
      if (rate > 0 && rate < 1000) state.rate = rate;
    }
    if (body.guard !== undefined) state.guard = body.guard !== false;
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
    writeJson(res, 200, buildState());
  });

  route("/override", async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const body = await readBody(req);
    const mode = typeof body.mode === "string" ? body.mode : "once";
    if (mode === "once") {
      state.overrideOnce = true;
      lastBlock = null;
    } else if (mode === "session") {
      state.overrideSession = true;
      lastBlock = null;
    } else if (mode === "off") {
      state.overrideOnce = false;
      state.overrideSession = false;
    }
    saveNow();
    writeJson(res, 200, buildState());
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
    const out = { ok: true, plugin: name, api: API, storeFile, pricing: pricing.count, browser: null, error: null };
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

  ctx.effect(
    () => () => {
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
    `billing: 已就绪（账本 ${storeFile}，价目表 ${pricing.count} 个模型，汇率 ${state.rate}，上限 ${ceilingOf().ceiling || "未设置"}）`,
  );
}
