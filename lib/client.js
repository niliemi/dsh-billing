/**
 * yoka-dsh-billing —— 浏览器半边。
 *
 * 只做三件事：
 *  1. 在 conversation.composer.dock 槽位常驻一枚角标：`¥已用 / ¥上限`，
 *     它就是聊天框下方 token 环（ContextMeter）左边那一格。
 *  2. 点击角标打开面板：设置已充金额、自设上限、汇率、模型单价、守卫开关、用量归零。
 *  3. 宿主因超额阻断该轮时，弹出确认框（一次性放行 / 本会话放行 / 提高上限 / 暂不放行）。
 *
 * 手写 CJS 包装，无需构建；只 require 基座已冻结的 react 与 react/jsx-runtime。
 */
window.__ModuleLoader__.load({
	id: "yoka-dsh-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const Fragment = React.Fragment;

		const API = "/plugin-billing";
		const POLL_MS = 2000;
		const OVERRIDE_COLOR = "#d9480f";
		const WARN_COLOR = "#c2760a";
		const OK_COLOR = "#3f9142";

		/* ------------------------------- 数据 ------------------------------- */

		async function request(path, body) {
			const init = { credentials: "same-origin", method: body === undefined ? "GET" : "POST" };
			if (body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(body);
			}
			const res = await fetch(`${API}${path}`, init);
			const text = await res.text();
			let parsed;
			try {
				parsed = text ? JSON.parse(text) : {};
			} catch {
				parsed = {};
			}
			if (!res.ok || parsed.ok === false) {
				throw new Error(parsed.error ?? `billing HTTP ${res.status}`);
			}
			return parsed;
		}

		function useBillingState() {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState("");
			React.useEffect(() => {
				let alive = true;
				let timer = null;
				const tick = async () => {
					try {
						const next = await request("/state");
						if (!alive) return;
						setState(next);
						setError("");
					} catch (err) {
						if (alive) setError(String(err?.message ?? err));
					}
					if (alive) timer = setTimeout(tick, POLL_MS);
				};
				tick();
				return () => {
					alive = false;
					if (timer !== null) clearTimeout(timer);
				};
			}, []);
			return { state, error, setState };
		}

		/* ------------------------------- 格式化 ------------------------------- */

		function money(value, symbol) {
			const n = Number.isFinite(value) ? value : 0;
			const digits = Math.abs(n) >= 1 ? 2 : 4;
			return `${symbol ?? "¥"}${n.toFixed(digits)}`;
		}

		function percentText(value) {
			const n = Number.isFinite(value) ? value : 0;
			if (n > 0 && n < 0.01) return "<0.01%";
			return `${n.toFixed(n >= 10 ? 0 : 2)}%`;
		}

		function tokenText(tokens) {
			if (!Array.isArray(tokens)) return "0";
			const total = tokens.reduce((acc, v) => acc + (Number(v) || 0), 0);
			if (total >= 1000000) return `${(total / 1000000).toFixed(2)}M`;
			if (total >= 1000) return `${(total / 1000).toFixed(1)}K`;
			return String(total);
		}

		function priceText(price) {
			if (!Array.isArray(price)) return "—";
			return price.map((v) => (Number(v) || 0).toFixed(Number(v) >= 1 ? 2 : 3)).join(" / ");
		}

		/* ------------------------------- 样式 ------------------------------- */

		const chipStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			height: 22,
			padding: "0 8px",
			border: "none",
			borderRadius: 999,
			background: "transparent",
			font: "inherit",
			fontSize: "var(--dsh-content-font-size-secondary, 12px)",
			lineHeight: "20px",
			fontVariantNumeric: "tabular-nums",
			cursor: "pointer",
			whiteSpace: "nowrap",
		};

		const cardStyle = {
			position: "fixed",
			left: "50%",
			bottom: 96,
			transform: "translateX(-50%)",
			zIndex: 80,
			width: "min(540px, calc(100vw - 32px))",
			maxHeight: "min(70vh, 620px)",
			overflow: "auto",
			boxSizing: "border-box",
			padding: "16px 18px 14px",
			borderRadius: 14,
			// 官方 menu 面色（#f8f9faf0 / #303136f0，94% 不透明）叠在完全不透明的层色上：
			// 保住原有色调，同时彻底不透视（CSS 简写里颜色只能出现在最后一层）。
			background:
				"linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent)), var(--dsw-alias-bg-layer-1, #ffffff)",
			color: "var(--dsw-alias-label-primary, #1d1d1f)",
			boxShadow: "var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,.18))",
			border: "1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.08))",
			fontSize: 13,
			lineHeight: "20px",
		};

		const backdropStyle = {
			position: "fixed",
			inset: 0,
			zIndex: 79,
			background: "rgba(0,0,0,.34)",
		};

		const labelStyle = { color: "var(--dsw-alias-label-tertiary, #8a8a8e)", flex: "none" };
		const rowStyle = { display: "flex", alignItems: "center", gap: 10, minHeight: 30 };
		const inputStyle = {
			flex: "1 1 auto",
			minWidth: 0,
			boxSizing: "border-box",
			padding: "4px 8px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14))",
			background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
			color: "inherit",
			font: "inherit",
			fontVariantNumeric: "tabular-nums",
		};
		const buttonStyle = {
			padding: "5px 12px",
			borderRadius: 9,
			border: "1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14))",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			cursor: "pointer",
		};
		const primaryButtonStyle = {
			...buttonStyle,
			background: "var(--dsw-alias-label-primary, #1d1d1f)",
			color: "var(--dsw-specific-menu, #fff)",
			borderColor: "transparent",
		};
		const sectionStyle = {
			marginTop: 14,
			paddingTop: 12,
			borderTop: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))",
		};
		const hintStyle = { color: "var(--dsw-alias-label-tertiary, #8a8a8e)", fontSize: 12, lineHeight: "18px" };

		/* ------------------------------- 角标 ------------------------------- */

		function BillingDock() {
			const { state, error, setState } = useBillingState();
			const [open, setOpen] = React.useState(false);
			const [confirm, setConfirm] = React.useState(false);
			const [flash, setFlash] = React.useState("");
			const seenBlock = React.useRef(0);

			const blocked = state?.blocked === true;
			const lastBlockAt = Number(state?.lastBlockAt ?? 0);

			React.useEffect(() => {
				if (!blocked) return;
				if (lastBlockAt === 0 || lastBlockAt === seenBlock.current) return;
				seenBlock.current = lastBlockAt;
				setConfirm(true);
			}, [blocked, lastBlockAt]);

			if (!state) {
				if (!error) return null;
				return h(
					"span",
					{ style: { ...chipStyle, color: "var(--dsw-alias-label-tertiary)", cursor: "default" }, title: error },
					"计费不可用",
				);
			}

			const symbol = state.symbol ?? "¥";
			const ceiling = Number(state.ceiling ?? 0);
			const percent = Number(state.percent ?? 0);
			const tone = blocked ? OVERRIDE_COLOR : percent >= 80 ? WARN_COLOR : "var(--dsw-alias-label-tertiary, #8a8a8e)";
			const dot = blocked ? OVERRIDE_COLOR : percent >= 80 ? WARN_COLOR : OK_COLOR;
			const ceilingText = ceiling > 0 ? money(ceiling, symbol) : "未设上限";

			const chip = h(
				"button",
				{
					type: "button",
					onClick: () => setOpen(true),
					title: `计费：已用 ${money(state.usedCNY, symbol)}，上限 ${ceilingText}（点击设置）`,
					style: { ...chipStyle, color: tone },
				},
				h("span", {
					"aria-hidden": true,
					style: { width: 6, height: 6, borderRadius: 999, background: dot, flex: "none" },
				}),
				h("span", null, `${money(state.usedCNY, symbol)} / ${ceilingText}`),
			);

			return h(
				Fragment,
				null,
				chip,
				open
					? h(Panel, {
							state,
							onClose: () => setOpen(false),
							onSaved: (next) => {
								setState(next);
								setFlash("已保存");
							},
						})
					: null,
				confirm && blocked
					? h(ConfirmDialog, {
							state,
							onClose: () => setConfirm(false),
							onRaise: () => {
								setConfirm(false);
								setOpen(true);
							},
							onOverride: async (mode) => {
								try {
									const next = await request("/override", { mode });
									setState(next);
									setConfirm(false);
									setFlash(mode === "once" ? "已放行一次：请重新发送刚才的消息" : "本会话已放行");
								} catch (err) {
									setFlash(String(err?.message ?? err));
								}
							},
						})
					: null,
				flash
					? h(
							"div",
							{
								style: {
									...cardStyle,
									bottom: 60,
									width: "auto",
									maxHeight: "none",
									padding: "8px 14px",
									borderRadius: 999,
									cursor: "pointer",
								},
								onClick: () => setFlash(""),
							},
							flash,
						)
					: null,
			);
		}

		/* ------------------------------- 面板 ------------------------------- */

		function Panel({ state, onClose, onSaved }) {
			const symbol = state.symbol ?? "¥";
			const [draft, setDraft] = React.useState(() => ({
				topUp: String(state.topUp ?? 0),
				limit: String(state.limit ?? 0),
				rate: String(state.rate ?? 7.2),
				guard: state.guard !== false,
			}));
			const [editKey, setEditKey] = React.useState(state.current?.key ?? state.breakdown?.[0]?.key ?? "");
			const [priceDraftValue, setPriceDraftValue] = React.useState(() => priceToDraft(state.current?.price));
			const [priceTouched, setPriceTouched] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState("");

			const ceiling = Number(state.ceiling ?? 0);
			const percent = Number(state.percent ?? 0);
			const editing = findBreakdown(state, editKey);
			const resolvedPrice = editing?.price ?? (state.current?.key === editKey ? state.current?.price : null);
			const source = editing?.source ?? (state.current?.key === editKey ? state.current?.source : "fallback");

			// 输入一个尚未产生用量的模型名时，去价目表里查它的官方价。
			const [lookup, setLookup] = React.useState(null);
			React.useEffect(() => {
				const key = String(editKey ?? "").trim();
				if (!key || findBreakdown(state, key)) {
					setLookup(null);
					return undefined;
				}
				let alive = true;
				const timer = setTimeout(async () => {
					try {
						const result = await request(`/pricing?q=${encodeURIComponent(key)}`);
						if (alive) setLookup(result.rows?.[0] ?? null);
					} catch {
						if (alive) setLookup(null);
					}
				}, 250);
				return () => {
					alive = false;
					clearTimeout(timer);
				};
			}, [editKey]);

			const official = resolvedPrice ?? lookup?.price ?? null;
			const officialLabel =
				source === "override" && resolvedPrice ? "已覆盖" : official ? "官方价" : "估算价";
			const officialNote = lookup && !resolvedPrice ? `（匹配到 ${lookup.key}）` : "";

			const pickRow = (key) => {
				setEditKey(key);
				const row = findBreakdown(state, key);
				setPriceDraftValue(priceToDraft(row?.price ?? state.current?.price));
				setPriceTouched(false);
			};

			const save = async () => {
				setBusy(true);
				setNote("");
				try {
					const body = {
						topUp: Number(draft.topUp) || 0,
						limit: Number(draft.limit) || 0,
						rate: Number(draft.rate) || state.rate,
						guard: draft.guard,
					};
					if (priceTouched && editKey) {
						body.price = { key: editKey, value: priceDraftValue.map((v) => Number(v) || 0) };
					}
					const next = await request("/config", body);
					setPriceTouched(false);
					setNote("已保存");
					onSaved(next);
				} catch (err) {
					setNote(`保存失败：${String(err?.message ?? err)}`);
				} finally {
					setBusy(false);
				}
			};

			const resetPrice = async () => {
				setBusy(true);
				try {
					const next = await request("/config", { price: { key: editKey, reset: true } });
					setPriceDraftValue(priceToDraft(findBreakdown(next, editKey)?.price ?? next.current?.price));
					setPriceTouched(false);
					setNote("已恢复官方价");
					onSaved(next);
				} catch (err) {
					setNote(`操作失败：${String(err?.message ?? err)}`);
				} finally {
					setBusy(false);
				}
			};

			const resetUsage = async () => {
				setBusy(true);
				try {
					const next = await request("/reset", {});
					setNote("用量已归零");
					onSaved(next);
				} catch (err) {
					setNote(`操作失败：${String(err?.message ?? err)}`);
				} finally {
					setBusy(false);
				}
			};

			const numberField = (label, value, onChange, hint, step) =>
				h(
					"label",
					{ style: { ...rowStyle, alignItems: "baseline" } },
					h("span", { style: { ...labelStyle, width: 76 } }, label),
					h("input", {
						type: "number",
						step: step ?? "0.01",
						min: "0",
						value,
						onChange: (event) => onChange(event.target.value),
						style: inputStyle,
					}),
					hint ? h("span", { style: { ...hintStyle, flex: "0 0 auto", maxWidth: 150 } }, hint) : null,
				);

			const priceField = (label, index) =>
				h(
					"label",
					{ style: { ...rowStyle, flex: "1 1 120px", minWidth: 120, alignItems: "baseline" } },
					h("span", { style: { ...labelStyle, width: 56 } }, label),
					h("input", {
						type: "number",
						step: "0.001",
						min: "0",
						value: priceDraftValue[index] ?? "0",
						onChange: (event) => {
							const next = [...priceDraftValue];
							next[index] = event.target.value;
							setPriceDraftValue(next);
							setPriceTouched(true);
						},
						style: inputStyle,
					}),
				);

			return h(
				Fragment,
				null,
				h("div", { style: backdropStyle, onClick: onClose }),
				h(
					"div",
					{ style: cardStyle, role: "dialog", "aria-label": "计费设置" },
					// 标题
					h(
						"div",
						{ style: { display: "flex", alignItems: "baseline", gap: 8 } },
						h("span", { style: { fontSize: 15, fontWeight: 600 } }, "计费"),
						h("span", { style: hintStyle }, "全局 · 按官方价目表现算"),
						h("span", { style: { flex: "1 1 auto" } }),
						h("button", { type: "button", style: buttonStyle, onClick: onClose }, "关闭"),
					),
					// 概览
					h(
						"div",
						{ style: { ...rowStyle, marginTop: 12, alignItems: "baseline" } },
						h("span", { style: { fontSize: 24, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, money(state.usedCNY, symbol)),
						h("span", { style: { ...labelStyle, fontSize: 13 } }, `/ ${ceiling > 0 ? money(ceiling, symbol) : "未设上限"}`),
						h("span", { style: { flex: "1 1 auto" } }),
						h("span", { style: { ...hintStyle, fontVariantNumeric: "tabular-nums" } },
							`${percentText(percent)} · ≈$${Number(state.usedUSD ?? 0).toFixed(4)}`),
					),
					h("div", {
						style: {
							marginTop: 8,
							height: 3,
							borderRadius: 999,
							background: "var(--dsw-alias-border-l1, rgba(0,0,0,.08))",
							overflow: "hidden",
						},
					}, h("div", {
						style: {
							width: `${Math.max(0, Math.min(100, percent))}%`,
							height: "100%",
							background: state.blocked ? OVERRIDE_COLOR : percent >= 80 ? WARN_COLOR : OK_COLOR,
						},
					})),
					state.blocked
						? h("div", { style: { ...hintStyle, color: OVERRIDE_COLOR, marginTop: 6 } },
								"已达上限：宿主会在每一步开始前阻断本轮请求，可在下方放行或提高上限。")
						: null,
					// 额度设置
					h(
						"div",
						{ style: sectionStyle },
						numberField("已充金额", draft.topUp, (v) => setDraft({ ...draft, topUp: v }), `${symbol}，硬上限`, "0.01"),
						numberField("自设上限", draft.limit, (v) => setDraft({ ...draft, limit: v }), `${symbol}，不得超过已充金额`, "0.01"),
						numberField("汇率", draft.rate, (v) => setDraft({ ...draft, rate: v }), "1 USD = ? CNY（内置 7.2）", "0.01"),
						h(
							"label",
							{ style: { ...rowStyle, cursor: "pointer" } },
							h("span", { style: { ...labelStyle, width: 76 } }, "超额阻断"),
							h("input", {
								type: "checkbox",
								checked: draft.guard,
								onChange: (event) => setDraft({ ...draft, guard: event.target.checked }),
							}),
							h("span", { style: hintStyle }, "达到上限时结束该轮，不发 LLM 请求"),
						),
						h("div", { style: hintStyle }, `上限取值：${state.ceilingSource === "limit" ? "自设上限" : state.ceilingSource === "topUp" ? "已充金额" : "未设置"}`),
					),
					// 单价
					h(
						"div",
						{ style: sectionStyle },
						h(
							"div",
							{ style: { ...rowStyle, gap: 8 } },
							h("span", { style: labelStyle }, "模型单价"),
							h("input", {
								type: "text",
								value: editKey,
								onChange: (event) => pickRow(event.target.value),
								placeholder: "provider/model",
								style: { ...inputStyle, fontFamily: "inherit" },
							}),
							h("span", { style: { ...hintStyle, flex: "none" } }, officialLabel),
						),
						h("div", { style: { ...hintStyle, marginTop: 4 } },
							`官方：${priceText(official ?? [1, 4, 0.1, 0])}（输入 / 输出 / 缓存读 / 缓存写，USD 每百万 token）${officialNote}`),
						h(
							"div",
							{ style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 } },
							priceField("输入", 0),
							priceField("输出", 1),
							priceField("缓存读", 2),
							priceField("缓存写", 3),
						),
						h(
							"div",
							{ style: { ...rowStyle, marginTop: 8, gap: 8 } },
							h("button", { type: "button", style: buttonStyle, onClick: resetPrice, disabled: busy }, "恢复官方价"),
							h("span", { style: hintStyle }, "留空该模型即用官方价；改动会重算全部历史用量"),
						),
						// 用量明细
						h(
							"div",
							{ style: { marginTop: 10 } },
							h("div", { style: { ...hintStyle, marginBottom: 4 } }, "按模型用量（点击可编辑其单价）"),
							(state.breakdown ?? []).length === 0
								? h("div", { style: hintStyle }, "暂无用量记录")
								: (state.breakdown ?? []).map((row) =>
										h(
											"button",
											{
												key: row.key,
												type: "button",
												onClick: () => pickRow(row.key),
												style: {
													display: "flex",
													width: "100%",
													gap: 10,
													alignItems: "baseline",
													padding: "3px 0",
													border: "none",
													background: "transparent",
													color: "inherit",
													font: "inherit",
													textAlign: "left",
													cursor: "pointer",
													fontVariantNumeric: "tabular-nums",
												},
											},
											h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.key || "(未识别路由)"),
											h("span", { style: hintStyle }, `${tokenText(row.tokens)} tok`),
											h("span", { style: { width: 88, textAlign: "right" } }, money(row.cny, symbol)),
											h("span", { style: { ...hintStyle, width: 74, textAlign: "right" } },
												row.source === "override" ? "覆盖" : row.source === "official" ? "官方" : "估算"),
										),
									),
						),
						(state.sessions ?? []).length > 0
							? h(
									"div",
									{ style: { marginTop: 10 } },
									h("div", { style: { ...hintStyle, marginBottom: 4 } }, "会话用量（全局计费按会话累加）"),
									(state.sessions ?? []).map((row) =>
										h(
											"div",
											{ key: row.id, style: { display: "flex", gap: 10, alignItems: "baseline", fontVariantNumeric: "tabular-nums" } },
											h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.id),
											h("span", { style: hintStyle }, `${tokenText(row.tokens)} tok`),
											h("span", { style: { width: 88, textAlign: "right" } }, money(row.cny, symbol)),
										),
									),
								)
							: null,
					),
					// 底部
					h(
						"div",
						{ style: { ...sectionStyle, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
						h("button", { type: "button", style: primaryButtonStyle, onClick: save, disabled: busy }, busy ? "处理中…" : "保存"),
						h("button", { type: "button", style: buttonStyle, onClick: resetUsage, disabled: busy }, "用量归零"),
						h("span", { style: { flex: "1 1 auto" } }),
						h("span", { style: hintStyle }, note),
					),
					h("div", { style: { ...hintStyle, marginTop: 8 } },
						`价格来自官方价目表（${state.pricing?.count ?? 0} 个模型，USD / 百万 token）。订阅制账号并不按此计费，此处为等效价值参考；账本：${state.ledgerFile ?? ""}`),
				),
			);
		}

		function findBreakdown(state, key) {
			if (!state || !key) return null;
			return (state.breakdown ?? []).find((row) => row.key === key) ?? null;
		}

		function priceToDraft(price) {
			if (!Array.isArray(price) || price.length !== 4) return ["", "", "", ""];
			return price.map((v) => String(Number(v) || 0));
		}

		/* ------------------------------- 超额确认 ------------------------------- */

		function ConfirmDialog({ state, onClose, onOverride, onRaise }) {
			const symbol = state.symbol ?? "¥";
			return h(
				Fragment,
				null,
				h("div", { style: backdropStyle, onClick: onClose }),
				h(
					"div",
					{ style: { ...cardStyle, bottom: 120, width: "min(420px, calc(100vw - 32px))" }, role: "alertdialog" },
					h("div", { style: { fontSize: 15, fontWeight: 600 } }, "费用已达上限"),
					h("div", { style: { marginTop: 8, fontVariantNumeric: "tabular-nums" } },
						`已用 ${money(state.usedCNY, symbol)} / 上限 ${money(state.ceiling, symbol)}（${percentText(state.percent)}）。本轮已被阻断，继续会超出你设置的上限。`),
					h("div", { style: { ...hintStyle, marginTop: 6 } }, "放行只影响后续请求；重新发送刚才的消息即可继续。"),
					h(
						"div",
						{ style: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" } },
						h("button", { type: "button", style: primaryButtonStyle, onClick: () => onOverride("once") }, "一次性放行"),
						h("button", { type: "button", style: buttonStyle, onClick: () => onOverride("session") }, "本会话放行"),
						h("button", { type: "button", style: buttonStyle, onClick: onRaise }, "提高上限"),
						h("span", { style: { flex: "1 1 auto" } }),
						h("button", { type: "button", style: buttonStyle, onClick: onClose }, "暂不放行"),
					),
				),
			);
		}

		/* ------------------------------- 插件 ------------------------------- */

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "billing",
						order: 20,
					},
					BillingDock,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.BillingDock = BillingDock;
		return module.exports;
	},
});
