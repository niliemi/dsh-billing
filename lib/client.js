/**
 * yoka-dsh-billing —— 浏览器半边。
 *
 * 四件事：
 *  1. conversation.composer.dock：聊天框下常驻两枚角标，左边是**本会话**计费、右边是**全局**计费，
 *     各自带一个颜色指示点（绿 <60% / 橙 60–90% / 红 ≥90%），格式 `（货币符号）（数值）/（上限）`。
 *  2. sidebar.footer.action：左侧边栏底部（设置旁）显示账户余额，点开同一个计费面板。
 *  3. shell.overlay：整帧浮层，承载计费面板与超额确认框（用 body portal，避免被侧栏的 transform 困住）。
 *  4. 宿主因超额阻断该轮时，弹出确认框（一次性放行 / 本会话放行 / 提高上限 / 去充值 / 暂不放行）。
 *
 * 手写 CJS 包装，无需构建；只 require 基座已冻结的 react 与 react-dom。
 */
window.__ModuleLoader__.load({
	id: "yoka-dsh-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;
		const Fragment = React.Fragment;

		const API = "/plugin-billing";
		const POLL_MS = 2000;
		const DANGER_COLOR = "#d9480f";
		const WARN_COLOR = "#c2760a";
		const OK_COLOR = "#3f9142";
		const UNKNOWN_COLOR = "var(--dsw-alias-label-tertiary, #8a8a8e)";

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

		/** 轮询 /state；`sessionId` 有值时顺带取该会话的费用与上限。 */
		function useBillingState(sessionId) {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState("");
			const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
			React.useEffect(() => {
				let alive = true;
				let timer = null;
				const tick = async () => {
					try {
						const next = await request(`/state${query}`);
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
			}, [query]);
			return { state, error, setState };
		}

		/* --------------------------- 面板开关（跨槽位共享） --------------------------- */

		const ui = {
			open: false,
			confirm: false,
			sessionId: "",
			listeners: new Set(),
			set(patch) {
				Object.assign(ui, patch);
				for (const listener of [...ui.listeners]) listener();
			},
			subscribe(listener) {
				ui.listeners.add(listener);
				return () => {
					ui.listeners.delete(listener);
				};
			},
		};

		function useUi() {
			const [, bump] = React.useState(0);
			React.useEffect(() => ui.subscribe(() => bump((n) => n + 1)), []);
			return ui;
		}

		function portal(node) {
			if (typeof document === "undefined" || !ReactDOM?.createPortal) return node;
			return ReactDOM.createPortal(node, document.body);
		}

		/* ------------------------------- 格式化 ------------------------------- */

		function money(value, symbol) {
			const n = Number.isFinite(Number(value)) ? Number(value) : 0;
			const digits = Math.abs(n) >= 1 ? 2 : 4;
			return `${symbol ?? "¥"}${n.toFixed(digits)}`;
		}

		function percentText(value) {
			const n = Number.isFinite(Number(value)) ? Number(value) : 0;
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

		/** 三档颜色：<60% 绿、60–90% 橙、≥90% 红。 */
		function toneFor(percent) {
			const n = Number(percent) || 0;
			if (n >= 90) return DANGER_COLOR;
			if (n >= 60) return WARN_COLOR;
			return OK_COLOR;
		}

		function walletText(wallet) {
			const amount = Number(wallet?.amount ?? 0).toFixed(2);
			const cny = money(wallet?.cny ?? 0, "¥");
			return `${wallet?.currency ?? ""} ${amount}${wallet?.bonus ? "（赠金）" : ""} ≈ ${cny}`;
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

		const dotStyle = (color) => ({
			width: 6,
			height: 6,
			borderRadius: 999,
			background: color,
			flex: "none",
		});

		/** 角标后面那个「↺ 重置计费起点」：小、淡、只在悬停时才显眼。 */
		const resetButtonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 18,
			height: 18,
			padding: 0,
			marginLeft: 1,
			border: "none",
			borderRadius: 999,
			background: "transparent",
			color: "var(--dsw-alias-text-tertiary, #9aa0aa)",
			font: "inherit",
			fontSize: 12,
			lineHeight: 1,
			cursor: "pointer",
			flex: "none",
			alignSelf: "center",
		};

		/** 角标 + 它自己的重置符号绑在一起，别在换行处被拆开。 */
		const pairStyle = { display: "inline-flex", alignItems: "center", flex: "none" };

		const cardStyle = {
			position: "fixed",
			left: "50%",
			bottom: 96,
			transform: "translateX(-50%)",
			zIndex: 80,
			width: "min(560px, calc(100vw - 32px))",
			maxHeight: "min(70vh, 640px)",
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

		function chipNode({ color, text, title, onClick }) {
			return h(
				"button",
				{ type: "button", onClick, title, style: chipStyle },
				h("span", { "aria-hidden": true, style: dotStyle(color) }),
				h("span", null, text),
			);
		}

		/** 两个角标的公共数据源。/state 每 2s 拉一次，带当前会话。 */
		function BillingDock({ sessionId }) {
			const { state, error, setState } = useBillingState(sessionId);
			const seenBlock = React.useRef(0);

			const blocked = state?.blocked === true;
			const lastBlockAt = Number(state?.lastBlockAt ?? 0);

			React.useEffect(() => {
				if (!blocked) return;
				if (lastBlockAt === 0 || lastBlockAt === seenBlock.current) return;
				seenBlock.current = lastBlockAt;
				ui.set({ confirm: true, open: false, sessionId: sessionId ?? "" });
			}, [blocked, lastBlockAt, sessionId]);

			if (!state) {
				if (!error) return null;
				return h(
					"span",
					{ style: { ...chipStyle, color: UNKNOWN_COLOR, cursor: "default" }, title: error },
					"计费不可用",
				);
			}

			const symbol = state.symbol ?? "¥";
			const balance = state.balance ?? {};
			const balanceReady = balance.available === true;
			const session = state.session ?? null;
			const globalBlocked = blocked && state.blockScope !== "session";
			const sessionBlocked = blocked && state.blockScope === "session";

			/** 「重置计费起点」：把当前用量前移成基线 → 本次归零、历史进累计。 */
			const doReset = async (scope) => {
				try {
					const next = await request("/reset", { scope, sessionId: sessionId ?? "" });
					setState(next);
				} catch {
					/* 失败就让下一次轮询自愈 */
				}
			};

			const resetNode = (scope, title) =>
				h(
					"button",
					{
						type: "button",
						title,
						"aria-label": title,
						onClick: (event) => {
							event.stopPropagation();
							void doReset(scope);
						},
						style: resetButtonStyle,
					},
					"↺",
				);

			const pairs = [];

			if (session) {
				const cap = Number(session.ceiling ?? 0);
				const capText = cap > 0 ? money(cap, symbol) : "未设";
				pairs.push(
					h("span", { style: pairStyle, key: "session" }, [
						chipNode({
							color: sessionBlocked ? DANGER_COLOR : toneFor(session.percent),
							text: `${money(session.usedCNY, symbol)} / ${capText}`,
							title:
								`本会话本次计费：${money(session.usedCNY, symbol)}，上限 ${
									cap > 0 ? money(cap, symbol) : "未设（可点击设置）"
								}${session.allowed ? "（本会话已放行）" : ""}` +
								` · 本会话累计 ${money(session.totalCNY ?? session.usedCNY, symbol)}` +
								" · 右侧 ↺ 重置本会话的计费起点（只动本会话，本次归零、历史只进累计）",
							onClick: () => ui.set({ open: true, confirm: false, sessionId: sessionId ?? "" }),
						}),
						resetNode("session", "重置本会话的计费起点（只动本会话，本次归零、历史只进累计）"),
					]),
				);
			}

			const globalCap = Number(state.ceiling ?? 0);
			const globalText =
				globalCap > 0 ? `${money(state.usedCNY, symbol)} / ${money(globalCap, symbol)}` : `${money(state.usedCNY, symbol)} / 未设`;
			const capNote =
				globalCap > 0
					? state.ceilingClamped === true
						? `（你填的 ${money(state.limit, symbol)} 超过余额，已夹到余额）`
						: ""
					: "（不设上限 · 不阻断）";
			pairs.push(
				h("span", { style: pairStyle, key: "global" }, [
					chipNode({
						color: globalBlocked ? DANGER_COLOR : globalCap > 0 ? toneFor(state.percent) : UNKNOWN_COLOR,
						text: globalText,
						title:
							`全局本次计费：${money(state.usedCNY, symbol)}，上限 ${
								globalCap > 0 ? money(globalCap, symbol) : "未设"
							}${capNote}` +
							` · 全局累计 ${money(state.totalCNY ?? state.usedCNY, symbol)}` +
							(balanceReady
								? ` · 账户余额 ${money(balance.cny, symbol)}（含赠金 ${money(balance.bonusCNY ?? 0, symbol)}）`
								: ` · 余额不可用${balance.error ? `（${balance.error}）` : ""}`) +
							" · 点击打开计费面板 · 右侧 ↺ 重置全局计费起点（只动全局，本次归零、历史只进累计，不碰各会话）",
						onClick: () => ui.set({ open: true, confirm: false, sessionId: sessionId ?? "" }),
					}),
					resetNode("global", "重置全局计费起点（只动全局，本次归零、历史只进累计，不碰各会话）"),
				]),
			);

			void setState;
			return h(Fragment, null, pairs);
		}

		/* --------------------------- 左侧边栏底部：余额 --------------------------- */

		function BalanceAction({ wide }) {
			const { state, setState } = useBillingState("");
			const symbol = state?.symbol ?? "¥";
			const balance = state?.balance ?? {};
			const ready = balance.available === true;
			const text = ready ? money(balance.cny, symbol) : "—";
			const title = ready
				? `账户余额 ${money(balance.cny, symbol)}（其中赠金 ${money(balance.bonusCNY ?? 0, symbol)}）` +
					(state
						? ` · 本次已用 ${money(state.usedCNY, symbol)} / 累计 ${money(state.totalCNY ?? state.usedCNY, symbol)}`
						: "") +
					" · 点击打开计费面板"
				: `余额不可用${balance.error ? `：${balance.error}` : ""} · 点击打开计费面板`;

			void setState;
			return h(
				"button",
				{
					type: "button",
					title,
					onClick: () => ui.set({ open: true, confirm: false }),
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						width: "100%",
						justifyContent: wide === false ? "center" : "flex-start",
						padding: wide === false ? "6px 0" : "6px 10px",
						border: "none",
						borderRadius: 9,
						background: "transparent",
						color: "var(--dsw-alias-label-secondary, inherit)",
						font: "inherit",
						fontSize: "var(--dsh-content-font-size-secondary, 12px)",
						cursor: "pointer",
						fontVariantNumeric: "tabular-nums",
					},
				},
				h("span", { "aria-hidden": true, style: dotStyle(ready ? toneFor(state?.percent) : UNKNOWN_COLOR) }),
				wide === false
					? null
					: h(
							"span",
							{
								style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" },
							},
							`余额 ${text}`,
						),
			);
		}

		/* --------------------------- 整帧浮层：面板 / 确认框 --------------------------- */

		function BillingOverlay() {
			const view = useUi();
			const { state, setState } = useBillingState(view.sessionId);

			if (!state) return null;

			const onSaved = (next) => {
				setState(next);
				ui.set({ confirm: false });
			};

			if (view.confirm && state.blocked) {
				return h(ConfirmDialog, {
					state,
					onClose: () => ui.set({ confirm: false }),
					onRaise: () => ui.set({ confirm: false, open: true }),
					onSaved,
				});
			}
			if (view.open) {
				return h(Panel, {
					state,
					sessionId: view.sessionId,
					onClose: () => ui.set({ open: false }),
					onSaved,
				});
			}
			return null;
		}

		/* ------------------------------- 面板 ------------------------------- */

		function Panel({ state, sessionId, onClose, onSaved }) {
			const symbol = state.symbol ?? "¥";
			const balance = state.balance ?? {};
			const [draft, setDraft] = React.useState(() => ({
				rate: String(state.rate ?? 7.2),
				guard: state.guard !== false,
				limit: Number(state.limit ?? 0) > 0 ? String(state.limit) : "",
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
			const officialLabel = source === "override" && resolvedPrice ? "已覆盖" : official ? "官方价" : "估算价";
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
						rate: Number(draft.rate) || state.rate,
						guard: draft.guard,
						limit: Number(draft.limit) || 0,
					};
					if (priceTouched && editKey) {
						body.price = { key: editKey, value: priceDraftValue.map((v) => Number(v) || 0) };
					}
					const next = await request("/config", body);
					setPriceTouched(false);
					setNote(
						next?.limitClamped === true
							? `已保存；超过余额，已夹到 ${money(next.ceiling, symbol)}`
							: "已保存",
					);
					onSaved(next);
				} catch (err) {
					setNote(`保存失败：${String(err?.message ?? err)}`);
				} finally {
					setBusy(false);
				}
			};

			const refreshBalance = async () => {
				setBusy(true);
				try {
					const next = await request(`/state?refresh=1${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`);
					setNote("余额已刷新");
					onSaved(next);
				} catch (err) {
					setNote(`刷新失败：${String(err?.message ?? err)}`);
				} finally {
					setBusy(false);
				}
			};

			const setSessionCap = async (id, value) => {
				try {
					const next = await request("/config", { sessionId: id, sessionLimitFor: Number(value) || 0 });
					setNote(Number(value) > 0 ? "已设定该会话上限" : "已清除该会话上限");
					onSaved(next);
				} catch (err) {
					setNote(`操作失败：${String(err?.message ?? err)}`);
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

			/**
			 * 「重置计费起点」：把当前用量前移成基线 —— 本次归零、不再阻断，历史只进累计，
			 * token 记录一条不丢（硬重置才会清历史，那是另一个按钮）。
			 * 全局与单会话各算各的：scope="global" 只动全局起点，scope="session" 只动那一个会话。
			 */
			const resetBaseline = async (scope, id) => {
				setBusy(true);
				try {
					const next = await request("/reset", { scope, sessionId: id ?? sessionId ?? "" });
					setNote(
						scope === "session"
							? "已重置该会话的计费起点（只动这个会话：本次归零，历史进累计）"
							: "已重置全局计费起点（只动全局：本次归零，历史进累计，各会话自己的周期不变）",
					);
					onSaved(next);
				} catch (err) {
					setNote(`操作失败：${String(err?.message ?? err)}`);
				} finally {
					setBusy(false);
				}
			};

			/** 硬重置：把 token 记录整段清掉，累计也归零，不可恢复。 */
			const wipeUsage = async () => {
				setBusy(true);
				try {
					const next = await request("/reset", { hard: true });
					setNote("历史已清空（累计归零）");
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
					h("span", { style: { ...labelStyle, width: 96 } }, label),
					h("input", {
						type: "number",
						step: step ?? "0.01",
						min: "0",
						value,
						onChange: (event) => onChange(event.target.value),
						style: inputStyle,
					}),
					hint ? h("span", { style: { ...hintStyle, flex: "0 0 auto", maxWidth: 160 } }, hint) : null,
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

			const balanceRows = [];
			if (balance.available !== true) {
				balanceRows.push(h("div", { key: "none", style: hintStyle }, balance.error || "暂无余额信息"));
			} else {
				for (const [index, wallet] of (balance.wallets ?? []).entries()) {
					balanceRows.push(
						h(
							"div",
							{ key: `w${index}`, style: { ...rowStyle, alignItems: "baseline" } },
							h("span", { style: { ...labelStyle, width: 96 } }, wallet?.bonus ? "赠金" : "充值余额"),
							h("span", { style: { fontVariantNumeric: "tabular-nums" } }, walletText(wallet)),
						),
					);
				}
				balanceRows.push(
					h(
						"div",
						{ key: "total", style: { ...rowStyle, alignItems: "baseline" } },
						h("span", { style: { ...labelStyle, width: 96 } }, "余额合计"),
						h("span", { style: { fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, money(balance.cny, symbol)),
						h("span", { style: hintStyle }, `其中赠金 ${money(balance.bonusCNY ?? 0, symbol)}`),
					),
				);
			}

			/* 单会话上限：每个会话各设各的，互不共用 */
			const capInput = (row) =>
				h("input", {
					type: "number",
					min: "0",
					step: "0.01",
					defaultValue: Number(row.ceiling) > 0 ? String(row.ceiling) : "",
					placeholder: "不限",
					"aria-label": "该会话的费用上限",
					title: "该会话自己的费用上限（留空或 0 = 该会话不设上限；不与其他会话共用）",
					onBlur: (event) => {
						const next = Number(event.target.value) || 0;
						if (next === Number(row.ceiling ?? 0)) return;
						void setSessionCap(row.id, next);
					},
					onKeyDown: (event) => {
						if (event.key === "Enter") event.target.blur();
					},
					style: { ...inputStyle, flex: "none", width: 88, textAlign: "right", alignSelf: "center" },
				});

			const sessionRows = (state.sessions ?? []).map((row) => ({ ...row, current: row.id === sessionId }));
			if (sessionId && state.session && !sessionRows.some((row) => row.id === sessionId)) {
				sessionRows.unshift({
					id: sessionId,
					tokens: state.session.tokens ?? [],
					cny: state.session.usedCNY ?? 0,
					totalCNY: state.session.totalCNY ?? state.session.usedCNY ?? 0,
					percent: state.session.percent ?? 0,
					ceiling: state.session.ceiling ?? 0,
					allowed: state.session.allowed === true,
					current: true,
				});
			}

			const rowResetButton = (row) =>
				h(
					"button",
					{
						type: "button",
						disabled: busy,
						"aria-label": "重置该会话的计费起点",
						title:
							"重置该会话的计费起点：只动这个会话（本次归零、不再阻断），全局与其它会话的本次都不受影响，历史费用只进累计" +
							(Number(row.totalCNY ?? 0) > Number(row.cny ?? 0) ? ` · 该会话累计 ${money(row.totalCNY, symbol)}` : ""),
						onClick: () => void resetBaseline("session", row.id),
						style: resetButtonStyle,
					},
					"↺",
				);

			const sessionCapSection = h(
				"div",
				{ style: sectionStyle },
				h("div", { style: { ...labelStyle, marginBottom: 6 } }, "单会话上限"),
				h(
					"div",
					{ style: { ...hintStyle, marginBottom: 6 } },
					"每个会话各设各的，互不共用；留空或 0 = 该会话不限。填好回车或移开焦点即生效，单会话上限不受余额夹取。右侧 ↺ 只重置该会话自己的计费起点（不动全局、也不动别的会话；历史只进累计）。",
				),
				sessionRows.length === 0
					? h("div", { style: hintStyle }, "还没有会话用量记录。产生用量后这里会出现每个会话，可逐个设上限。")
					: h(
							"div",
							null,
							h(
								"div",
								{ style: { ...hintStyle, display: "flex", gap: 10, alignItems: "baseline", paddingBottom: 2 } },
								h("span", { style: { width: 6, flex: "none" } }, ""),
								h("span", { style: { flex: "1 1 auto" } }, "会话"),
								h("span", { style: { width: 96, textAlign: "right" } }, "用量"),
								h("span", { style: { width: 96, textAlign: "right" } }, "费用"),
								h("span", { style: { width: 52, textAlign: "right" } }, "占比"),
								h("span", { style: { width: 88, textAlign: "right" } }, "单会话上限"),
								h("span", { style: { width: 18, flex: "none" } }, ""),
							),
							h(
								"div",
								{ style: { ...hintStyle, marginBottom: 3 } },
								"每行两排：上排 = 本次（比的就是它），下排 = 累计（历史，重置只把起点前移进这里，一条不丢）。",
							),
							sessionRows.map((row) =>
								h(
									"div",
									{
										key: row.id,
										style: {
											display: "flex",
											gap: 10,
											alignItems: "flex-start",
											fontVariantNumeric: "tabular-nums",
											background: row.current ? "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))" : "transparent",
											padding: "2px 0",
										},
									},
									h("span", { "aria-hidden": true, style: { ...dotStyle(toneFor(row.percent)), alignSelf: "center" } }),
									h(
										"span",
										{
											style: {
												flex: "1 1 auto",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
												alignSelf: "center",
											},
										},
										`${row.id}${row.allowed ? "（已放行）" : ""}`,
									),
									row.current ? h("span", { style: { ...hintStyle, flex: "none", alignSelf: "center" } }, "当前") : null,
									h(
										"span",
										{ style: { width: 96, textAlign: "right", lineHeight: "15px" } },
										h("span", { style: { display: "block" } }, `${tokenText(row.tokens)} tok`),
										h(
											"span",
											{ style: { display: "block", ...hintStyle, fontSize: 11 } },
											`累计 ${tokenText(row.totalTokens ?? row.tokens)} tok`,
										),
									),
									h(
										"span",
										{ style: { width: 96, textAlign: "right", lineHeight: "15px" } },
										h("span", { style: { display: "block" } }, money(row.cny, symbol)),
										h(
											"span",
											{ style: { display: "block", ...hintStyle, fontSize: 11 } },
											`累计 ${money(row.totalCNY ?? row.cny, symbol)}`,
										),
									),
									h("span", { style: { ...hintStyle, width: 52, textAlign: "right", alignSelf: "center" } }, percentText(row.percent)),
									capInput(row),
									rowResetButton(row),
								),
							),
						),
			);

			return portal(
				h(
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
							h("span", { style: hintStyle }, "全局计费 · 上限由你设定，不得超过余额"),
							h("span", { style: { flex: "1 1 auto" } }),
							h("button", { type: "button", style: buttonStyle, onClick: onClose }, "关闭"),
						),
						// 概览：本次（上限比的就是它）+ 累计（历史，永不归零）
						h(
							"div",
							{ style: { ...rowStyle, marginTop: 12, alignItems: "baseline" } },
							h("span", { style: { ...hintStyle, flex: "none" } }, "本次"),
							h("span", { style: { fontSize: 24, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, money(state.usedCNY, symbol)),
							h("span", { style: { ...labelStyle, fontSize: 13 } }, `/ ${ceiling > 0 ? money(ceiling, symbol) : "上限未设"}`),
							h("span", { style: { flex: "1 1 auto" } }),
							h(
								"span",
								{ style: { ...hintStyle, fontVariantNumeric: "tabular-nums" } },
								`${percentText(percent)} · ≈$${Number(state.usedUSD ?? 0).toFixed(4)}`,
							),
						),
						h(
							"div",
							{ style: { ...rowStyle, marginTop: 4, alignItems: "baseline" } },
							h(
								"span",
								{ style: hintStyle },
								`累计 ${money(state.totalCNY ?? state.usedCNY, symbol)}（≈$${Number(state.totalUSD ?? state.usedUSD ?? 0).toFixed(4)}）· 重置只把起点前移：本次归零、历史费用只进累计，token 记录一条不丢。全局与单会话两个起点各自独立、互不牵连。`,
							),
							h("span", { style: { flex: "1 1 auto" } }),
							h(
								"button",
								{
									type: "button",
									style: buttonStyle,
									onClick: () => void resetBaseline("global"),
									disabled: busy,
									title: "重置全局计费起点：只把全局起点前移（本次归零、不再阻断），不碰各个会话自己的周期",
								},
								"↺ 重置计费起点",
							),
						),
						h(
							"div",
							{
								style: {
									marginTop: 8,
									height: 3,
									borderRadius: 999,
									background: "var(--dsw-alias-border-l1, rgba(0,0,0,.08))",
									overflow: "hidden",
								},
							},
							h("div", {
								style: {
									width: `${Math.max(0, Math.min(100, percent))}%`,
									height: "100%",
									background: state.blocked ? DANGER_COLOR : toneFor(percent),
								},
							}),
						),
						state.blocked
							? h(
									"div",
									{ style: { ...hintStyle, color: DANGER_COLOR, marginTop: 6 } },
									state.blockScope === "session"
										? "本会话已达上限：宿主会在每一步开始前阻断该会话的请求，可在下方提高该会话上限、重置该会话的计费起点（只动这个会话），或放行。"
										: "已达你设的全局上限：宿主会在每一步开始前阻断请求，可去充值、调高上限、重置全局计费起点（只动全局，本次归零、历史进累计），或放行一次 / 本会话。",
								)
							: null,
						// 账户余额（只读）
						h(
							"div",
							{ style: sectionStyle },
							h(
								"div",
								{ style: { ...rowStyle, justifyContent: "space-between" } },
								h("span", { style: { fontWeight: 600 } }, "账户余额"),
								h(
									"span",
									{ style: { display: "flex", gap: 8 } },
									h("button", { type: "button", style: buttonStyle, onClick: refreshBalance, disabled: busy }, "刷新"),
									balance.topUpUrl
										? h(
												"button",
												{
													type: "button",
													style: buttonStyle,
													onClick: () => {
														if (typeof window !== "undefined") window.open(balance.topUpUrl, "_blank", "noopener");
													},
												},
												"去充值",
											)
										: null,
								),
							),
							h("div", { style: { marginTop: 6 } }, balanceRows),
							h(
								"div",
								{ style: { ...hintStyle, marginTop: 6 } },
								balance.signedIn === false
									? "尚未登录 DeepSeek 账号，余额取不到；此时不夹取，你设的上限照旧生效。"
									: "余额 = 充值余额 + 赠金，来自 DeepSeek 账号，每 60 秒自动刷新；它只是全局上限的边界与参考。",
							),
						),
						// 额度设置
						h(
							"div",
							{ style: sectionStyle },
							numberField(
								"全局计费上限",
								draft.limit,
								(v) => setDraft({ ...draft, limit: v }),
								`${symbol}，留空 = 不设上限`,
								"0.01",
							),
							numberField("汇率", draft.rate, (v) => setDraft({ ...draft, rate: v }), "1 USD = ? CNY（内置 7.2）", "0.01"),
							h(
								"label",
								{ style: { ...rowStyle, cursor: "pointer" } },
								h("span", { style: { ...labelStyle, width: 96 } }, "超额阻断"),
								h("input", {
									type: "checkbox",
									checked: draft.guard,
									onChange: (event) => setDraft({ ...draft, guard: event.target.checked }),
								}),
								h("span", { style: hintStyle }, "达到上限时结束该轮，不发 LLM 请求"),
							),
							h(
								"div",
								{ style: hintStyle },
								balance.available === true
									? `全局上限由你填，超过账户余额（${money(balance.cny, symbol)}）会夹到余额；留空 = 不设上限、不阻断。余额只是边界与参考，不等于上限。每个会话的上限在下面的「单会话上限」里逐个设，各自独立、不共用。`
									: "余额取不到，此时不夹取：你填多少就是多少；留空 = 不设上限、不阻断。每个会话的上限在下面的「单会话上限」里逐个设，各自独立、不共用。",
							),
						),
						sessionCapSection,
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
							h(
								"div",
								{ style: { ...hintStyle, marginTop: 4 } },
								`官方：${priceText(official ?? [1, 4, 0.1, 0])}（输入 / 输出 / 缓存读 / 缓存写，USD 每百万 token）${officialNote}`,
							),
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
								h(
									"div",
									{ style: { ...hintStyle, marginBottom: 4 } },
									"按模型用量（本次 / 累计，点击可编辑其单价）",
								),
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
												h(
													"span",
													{ style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
													row.key || "(未识别路由)",
												),
												h("span", { style: hintStyle }, `${tokenText(row.tokens)} tok`),
												h("span", { style: { width: 88, textAlign: "right" } }, money(row.cny, symbol)),
												h(
													"span",
													{
														style: { ...hintStyle, width: 88, textAlign: "right" },
														title: "该模型的累计费用（含已重置前移的部分）",
													},
													`累计 ${money(row.totalCNY ?? row.cny, symbol)}`,
												),
												h(
													"span",
													{ style: { ...hintStyle, width: 74, textAlign: "right" } },
													row.source === "override" ? "覆盖" : row.source === "official" ? "官方" : "估算",
												),
											),
										),
							),
						),
						// 底部
						h(
							"div",
							{ style: { ...sectionStyle, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
							h("button", { type: "button", style: primaryButtonStyle, onClick: save, disabled: busy }, busy ? "处理中…" : "保存"),
							h(
								"button",
								{
									type: "button",
									style: buttonStyle,
									onClick: () => void resetBaseline("global"),
									disabled: busy,
									title: "重置全局计费起点：只把全局起点前移（本次归零、不再阻断），各会话自己的周期不变，历史费用只进累计",
								},
								"↺ 重置计费起点",
							),
							h(
								"button",
								{
									type: "button",
									style: { ...buttonStyle, color: DANGER_COLOR },
									onClick: () => void wipeUsage(),
									disabled: busy,
									title: "硬重置：清掉全部 token 记录，累计也归零，不可恢复",
								},
								"清空历史",
							),
							h("span", { style: { flex: "1 1 auto" } }),
							h("span", { style: hintStyle }, note),
						),
						h(
							"div",
							{ style: { ...hintStyle, marginTop: 8 } },
							`价格来自官方价目表（${state.pricing?.count ?? 0} 个模型，USD / 百万 token）。订阅制账号并不按此计费，此处为等效价值参考；账本：${
								state.ledgerFile ?? ""
							}`,
						),
					),
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

		function ConfirmDialog({ state, onClose, onOverride, onRaise, onSaved }) {
			const symbol = state.symbol ?? "¥";
			const balance = state.balance ?? {};
			const scope = state.blockScope === "session" ? "session" : "global";
			const session = state.session ?? null;
			const sessionId = state.lastBlock?.sessionId || session?.id || "";

			const detail =
				scope === "session" && session
					? `本会话本次已用 ${money(session.usedCNY, symbol)} / 上限 ${money(session.ceiling, symbol)}（${percentText(
							session.percent,
						)}）。本轮已被阻断。`
					: `全局本次已用 ${money(state.usedCNY, symbol)} / 你设的上限 ${
							Number(state.ceiling) > 0 ? money(state.ceiling, symbol) : "未设"
						}（${percentText(state.percent)}）。本轮已被阻断${
							balance.available === true ? `，继续会超出你的账户余额（${money(balance.cny, symbol)}）` : ""
						}。`;

			const act = async (mode) => {
				try {
					const next = await request("/override", { mode, sessionId });
					onSaved(next);
				} catch {
					onClose();
				}
			};

			// ↺ 重置计费起点：本次归零即可继续，不必放行、也不必调高上限。
			const actReset = async () => {
				try {
					const next = await request("/reset", { scope, sessionId });
					onSaved(next);
				} catch {
					onClose();
				}
			};

			return portal(
				h(
					Fragment,
					null,
					h("div", { style: backdropStyle, onClick: onClose }),
					h(
						"div",
						{
							style: { ...cardStyle, bottom: 120, width: "min(440px, calc(100vw - 32px))" },
							role: "alertdialog",
						},
						h(
							"div",
							{ style: { fontSize: 15, fontWeight: 600 } },
							scope === "session" ? "本会话已达上限" : "已达你设的全局上限",
						),
						h("div", { style: { marginTop: 8, fontVariantNumeric: "tabular-nums" } }, detail),
						h(
							"div",
							{ style: { ...hintStyle, marginTop: 6 } },
							scope === "session"
								? "放行只影响后续请求；重新发送刚才的消息即可继续。重置该会话的计费起点只动这个会话：本次归零、不再阻断，全局与其它会话不受影响，历史费用只进累计。"
								: "放行只影响后续请求；重新发送刚才的消息即可继续。重置全局计费起点只动全局：本次归零、不再阻断，各会话自己的周期不变，历史费用只进累计（不用清掉记录，也不必调高上限）。",
						),
						h(
							"div",
							{ style: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" } },
							h("button", { type: "button", style: primaryButtonStyle, onClick: () => act("once") }, "一次性放行"),
							h("button", { type: "button", style: buttonStyle, onClick: () => act("session") }, "本会话放行"),
							scope === "global" && balance.topUpUrl
								? h(
										"button",
										{
											type: "button",
											style: buttonStyle,
											onClick: () => {
												if (typeof window !== "undefined") window.open(balance.topUpUrl, "_blank", "noopener");
											},
										},
										"去充值",
									)
								: null,
							h("button", { type: "button", style: buttonStyle, onClick: onRaise }, "调高上限"),
							h(
								"button",
								{
									type: "button",
									style: buttonStyle,
									title:
										scope === "session"
											? "重置该会话的计费起点（只动这个会话）：本次归零、不再阻断，全局与其它会话不受影响，历史只进累计"
											: "重置全局计费起点（只动全局）：本次归零、不再阻断，各会话自己的周期不变，历史只进累计",
									onClick: () => actReset(),
								},
								"↺ 重置计费起点",
							),
							h("span", { style: { flex: "1 1 auto" } }),
							h("button", { type: "button", style: buttonStyle, onClick: onClose }, "暂不放行"),
						),
					),
				),
			);
		}

		/* ------------------------------- 插件 ------------------------------- */

		const inject = ["slots"];

		function apply(ctx) {
			// 聊天框下：本会话 + 全局两个角标，紧挨官方 token 环左侧。
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
			// 左侧边栏底部：余额。
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "billing-balance",
						order: 20,
					},
					BalanceAction,
				),
			);
			// 整帧浮层：面板与超额确认框。
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "billing-panel",
						order: 20,
					},
					BillingOverlay,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.BillingDock = BillingDock;
		exports.BalanceAction = BalanceAction;
		exports.BillingOverlay = BillingOverlay;
		exports.Panel = Panel;
		exports.ConfirmDialog = ConfirmDialog;
		exports.ui = ui;
		return module.exports;
	},
});
