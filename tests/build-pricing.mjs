/**
 * 从 @earendil-works/pi-ai 的官方 provider 数据生成 lib/pricing.json。
 *
 * 用法：node tests/build-pricing.mjs <pi-ai/dist/providers/data 目录>
 * 默认：C:\Users\walex lin\.dsh\billing-src\pi-ai-data
 *
 * 输出（紧凑格式，金额单位 USD / 百万 token）：
 *   { generatedAt, source, unit, count,
 *     providers: { <provider>: { <modelId>: [输入, 输出, 缓存读, 缓存写] } },
 *     byModel:   { <modelId>: <provider> } }
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "lib", "pricing.json");
const srcDir = process.argv[2] ?? join(process.env.USERPROFILE ?? "", ".dsh", "billing-src", "pi-ai-data");

/** 聚合型巨型价目表（20 万行级别），不进内置表；需要时可在面板里手填覆盖价。 */
const SKIP = new Set(["openrouter.json", "amazon-bedrock.json", "vercel-ai-gateway.json"]);

const providers = {};
const byModel = {};
let count = 0;

for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
  const fallbackProvider = entry.name.replace(/\.json$/, "");
  let data;
  try {
    data = JSON.parse(readFileSync(join(srcDir, entry.name), "utf8"));
  } catch {
    continue;
  }
  if (!data || typeof data !== "object") continue;
  for (const models of Object.values(data)) {
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models)) {
      const cost = model?.cost;
      if (!cost || typeof cost !== "object") continue;
      const price = [Number(cost.input) || 0, Number(cost.output) || 0, Number(cost.cacheRead) || 0, Number(cost.cacheWrite) || 0];
      if (price.every((v) => v === 0)) continue;
      const provider = typeof model.provider === "string" && model.provider ? model.provider : fallbackProvider;
      providers[provider] ??= {};
      providers[provider][modelId] = price;
      byModel[modelId] ??= provider;
      count += 1;
    }
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: "@earendil-works/pi-ai/dist/providers/data",
  unit: "usd-per-million-tokens",
  count,
  providers,
  byModel,
};

writeFileSync(outFile, `${JSON.stringify(payload)}\n`, "utf8");
const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`wrote ${outFile}`);
console.log(`providers=${Object.keys(providers).length} models=${count} jsonBytes=${bytes}`);
