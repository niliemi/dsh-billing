// 探活脚本：确认宿主半边注册的 /plugin-billing/* 路由与浏览器半边 bundle 是否已由运行中的 DSH 提供。
// 用法：node tools/probe-http.mjs [origin]   （默认 http://127.0.0.1:19387）

const origin = process.argv[2] ?? "http://127.0.0.1:19387";

const targets = [
  { url: `${origin}/plugin-billing/state`, pick: (t) => t.slice(0, 600) },
  { url: `${origin}/plugin-billing/pricing?q=deepseek-v4-pro`, pick: (t) => t.slice(0, 300) },
  { url: `${origin}/plugin-billing/diag`, pick: (t) => t.slice(0, 1200) },
  { url: `${origin}/plugins/yoka-dsh-billing/client.js`, pick: (t) => t.slice(0, 200) },
];

for (const { url, pick } of targets) {
  try {
    const res = await fetch(url, { headers: { accept: "*/*" } });
    const text = await res.text();
    console.log("----", url);
    console.log("status:", res.status, "| type:", res.headers.get("content-type"), "| bytes:", text.length);
    console.log(pick(text));
  } catch (error) {
    console.log("----", url);
    console.log("ERROR:", error?.message ?? error);
  }
}
