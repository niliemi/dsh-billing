#!/usr/bin/env node
/**
 * 验证「浏览器半边是否已经被 HMR 跟上」。
 *
 * 原理（来自 @deepseek-ai/dsh-client-modules / dsh-client-hmr 的源码）：
 *   - 每个条目的 revision = sha1("plugin-artifact" + 分帧的 mtimeMs / ctimeMs / size) 的前 12 位；
 *   - dsh-client-hmr 每 pollIntervalMs（默认 500ms）stat 一次每个条目的 client.js，
 *     元数据一变就调用 clientModules.rebuilt(id)，并通过 /plugins/events 的 SSE 广播 graph/rebuilt 帧。
 * 所以：只要「本地算出的 revision」== 「/plugins/events 图上该条目的 revision」，
 * 就说明运行中的宿主已经发布了新字节，页面上的插件已经被重挂载（无需刷新、无需重启）。
 *
 * 用法：node tools/probe-hmr.mjs [origin] [packageId]
 */

import { statSync } from "node:fs";
import { createHash } from "node:crypto";

const HASH_REVISION_LENGTH = 12;
const PROFILE = "C:\\Users\\walex lin\\.dsh\\profiles\\desktop\\node_modules";

function framedHash(domain, parts) {
	const hash = createHash("sha1").update(domain).update("\0");
	for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	return hash.digest("hex").slice(0, HASH_REVISION_LENGTH);
}

function artifactRevision(baseline) {
	return framedHash("plugin-artifact", [
		String(baseline.mtimeMs),
		String(baseline.ctimeMs),
		String(baseline.size),
	]);
}

const origin = process.argv[2] ?? "http://127.0.0.1:19387";
const packageId = process.argv[3] ?? "yoka-dsh-billing";

let local;
try {
	const st = statSync(`${PROFILE}\\${packageId}\\lib\\client.js`);
	local = artifactRevision({ mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size });
	console.log(`local   rev=${local}  size=${st.size}  mtimeMs=${st.mtimeMs}`);
} catch (error) {
	console.log(`local   ERR ${error.message}`);
	process.exit(2);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
let verdict = 1;

try {
	const res = await fetch(`${origin}/plugins/events`, {
		headers: { accept: "text/event-stream", "cache-control": "no-cache" },
		signal: controller.signal,
	});
	console.log(`sse     ${res.status} ${res.headers.get("content-type") ?? ""}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index;
		while ((index = buffer.indexOf("\n\n")) >= 0) {
			const block = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const data = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("");
			if (!data) continue;
			let frame;
			try {
				frame = JSON.parse(data);
			} catch {
				continue;
			}
			const graph = frame.graph ?? frame;
			const rows = graph.rows ?? graph.entries ?? [];
			const hit = rows.find((row) => row.id === packageId);
			if (!hit) continue;
			console.log(`live    rev=${hit.rev}  url=${hit.url}`);
			verdict = hit.rev === local ? 0 : 1;
			console.log(verdict === 0 ? "OK      宿主已发布本地这版字节（HMR 生效）" : "STALE   宿主仍在用旧 revision（尚未轮询到 / 未 watch 到）");
			controller.abort();
			break;
		}
		if (verdict === 0) break;
	}
} catch (error) {
	if (error.name !== "AbortError") console.log(`sse     FAILED: ${error.name}: ${error.message}`);
} finally {
	clearTimeout(timer);
}

process.exit(verdict);
