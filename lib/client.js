/* dsh-malleable-memory 面板 client bundle（M3.3b，2026-10-25）
 *
 * ## 这是什么
 *
 * 浏览器侧代码。为「记忆 / 人格」面板提供：
 *   - 侧栏入口（sidebar.panellist）
 *   - 中央面板页（main，key = malleable-memory）
 *
 * ## 为什么是手写的 bundle 外壳
 *
 * 宿主用 `window.__ModuleLoader__.load({ id, factory })` 加载 client 半边。
 * 这里按同样的信封写，`factory(require)` 返回 `{ apply, inject }`。
 * 不做构建步骤（不需要 tsdown/rolldown）—— 这个面板不复杂，手写更可控。
 *
 * ## 数据来源
 *
 * 全部通过 `fetch("/malleable-memory/...")` 调 Host 侧路由。
 * 那条路由有回环校验，只接受本机请求。
 *
 * ## 依赖
 *
 * 只依赖 `react`（宿主提供）和 `slots` 服务。
 * 不依赖任何 `@deepseek-ai/dsh-client-*` 包 —— 那些在 profile 里不可见，
 * 引用了会加载失败。
 */
window.__ModuleLoader__.load({
  id: "dsh-malleable-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    // ============================================================
    // 常量
    // ============================================================
    var API = "/malleable-memory";
    var PANEL_ID = "malleable-memory";
    var NS = "malleable-memory";

    var TIER_LABEL = { perm: "永久层", hot: "加强层", cold: "卸载层" };
    var TIER_HINT = {
      perm: "每轮全文注入",
      hot: "每轮全文注入",
      cold: "只给目录，按需 recall",
    };

    // ============================================================
    // 样式（一次插入，卸载时清理）
    // ============================================================
    // ============================================================
    // 样式
    //
    // ## 2026-10-25 重写（用户反馈：文字几乎看不见）
    //
    // 第一版犯了两个错：
    //
    // ① **用了不存在的 CSS 变量**：--fg-primary / --accent / --bg-hover /
    //    --bg-active / --border-subtle 这些**宿主根本没定义**。
    //    查 Theme.listTokens 才知道真名是 --dsw-alias-*（见下）。
    // ② **兜底色是按暗色主题写死的**：var(--fg-primary, #e6e6e6)。
    //    变量不存在 → 每次都走兜底 → 浅色主题下浅灰字配浅背景，
    //    对比度几乎为零。
    //
    // 现在全部改用宿主真实变量，且**兜底值也按浅色主题选**：
    // 万一哪天变量改名，浅色下仍可读（本项目默认主题是浅色）。
    //
    // 正确的宿主变量（来自 Theme.listTokens）：
    //   --dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / bg-overlay
    //   --dsw-alias-border-l1 / border-l2
    //   --dsw-alias-brand-primary
    //   --dsw-alias-label-primary / label-secondary
    //   --dsw-alias-state-error-primary / success / warn / idle
    // ============================================================
    var STYLES = [
      // 外层容器只负责布局，颜色全部继承（避免自作主张）
      ".m3t-panel{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f)}",

      ".m3t-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e5e5);flex:none}",
      ".m3t-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary,#1f1f1f)}",
      ".m3t-scope{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",

      ".m3t-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e5e5);flex:none;overflow-x:auto}",
      ".m3t-tab{padding:6px 12px;border:none;background:none;color:var(--dsw-alias-label-secondary,#6b6b6b);cursor:pointer;border-radius:6px 6px 0 0;font-size:12px;white-space:nowrap}",
      ".m3t-tab:hover{color:var(--dsw-alias-label-primary,#1f1f1f);background:var(--dsw-alias-bg-layer-2,#f5f5f5)}",
      ".m3t-tab[data-on='1']{color:var(--dsw-alias-label-primary,#1f1f1f);font-weight:600;background:var(--dsw-alias-bg-layer-2,#f5f5f5);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#3b82f6)}",

      ".m3t-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;color:var(--dsw-alias-label-primary,#1f1f1f)}",

      ".m3t-sec{margin-bottom:16px}",
      ".m3t-sec-h{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;margin-bottom:6px;color:var(--dsw-alias-label-primary,#1f1f1f)}",
      ".m3t-badge{font-size:10px;padding:1px 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f0f0f0);color:var(--dsw-alias-label-secondary,#6b6b6b);font-weight:400}",

      ".m3t-row{display:flex;align-items:baseline;gap:8px;padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#eee);font-size:12px}",
      ".m3t-row:last-child{border-bottom:none}",
      ".m3t-id{font-family:ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:11px;flex:none;min-width:26px}",
      ".m3t-rowtitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1f1f1f)}",
      ".m3t-num{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b);flex:none}",

      ".m3t-empty{color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:12px;padding:6px 0;font-style:italic}",

      // 代码块：用 layer-2 做底，避免纯黑/纯白与主题冲突
      ".m3t-pre{font-family:ui-monospace,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2,#f7f7f7);color:var(--dsw-alias-label-primary,#1f1f1f);padding:10px;border-radius:6px;margin:0;border:1px solid var(--dsw-alias-border-l1,#e5e5e5)}",

      ".m3t-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin:8px 0}",
      ".m3t-k{color:var(--dsw-alias-label-secondary,#6b6b6b)}",
      ".m3t-v{font-family:ui-monospace,monospace;color:var(--dsw-alias-label-primary,#1f1f1f)}",

      ".m3t-pad{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}",
      ".m3t-padbar{flex:1;min-width:120px}",
      ".m3t-padbar-l{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b);margin-bottom:3px}",
      ".m3t-track{position:relative;height:7px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#ececec);overflow:hidden}",
      ".m3t-zero{position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l2,#d0d0d0)}",
      ".m3t-fill{position:absolute;top:0;bottom:0;border-radius:4px}",

      ".m3t-hist{font-size:12px;line-height:1.9;color:var(--dsw-alias-label-primary,#1f1f1f)}",

      ".m3t-btn{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);border-radius:6px;cursor:pointer;font-size:12px}",
      ".m3t-btn:hover{background:var(--dsw-alias-bg-layer-2,#f5f5f5)}",
      ".m3t-btn[data-kind='primary']{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}",
      ".m3t-btn[data-kind='danger']{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".m3t-btn:disabled{opacity:.45;cursor:default}",

      ".m3t-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
      ".m3t-field-l{font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b)}",
      ".m3t-in,.m3t-ta{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d0d0d0);color:var(--dsw-alias-label-primary,#1f1f1f);border-radius:5px;padding:6px 8px;font-size:12px;font-family:inherit;width:100%;box-sizing:border-box}",
      ".m3t-in:focus,.m3t-ta:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".m3t-ta{resize:vertical;min-height:54px;line-height:1.55}",

      ".m3t-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}",
      ".m3t-note{font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b);line-height:1.6;margin:6px 0}",

      ".m3t-err{padding:8px 12px;margin:10px 14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626)}",
      ".m3t-ok{padding:8px 12px;margin:10px 14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-state-success-primary,#16a34a);font-size:12px;border:1px solid var(--dsw-alias-state-success-primary,#16a34a)}",

      ".m3t-sel{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d0d0d0);color:var(--dsw-alias-label-primary,#1f1f1f);border-radius:5px;padding:4px 6px;font-size:12px;font-family:inherit}",

      ".m3t-chip{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f0f0f0);color:var(--dsw-alias-label-primary,#1f1f1f);margin:0 4px 4px 0;cursor:pointer;border:1px solid transparent}",
      ".m3t-chip[data-on='1']{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:var(--dsw-alias-bg-layer-2,#eef4ff);color:var(--dsw-alias-brand-primary,#1d4ed8)}",
    ].join("\n");

    // ============================================================
    // 小工具
    // ============================================================

    /** 统一的 API 调用。Host 侧的失败模式都已归一化成 { ok:false, error }。 */
    async function api(path, body) {
      const res = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error("响应不是 JSON（HTTP " + res.status + "）");
      }
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || "HTTP " + res.status);
      }
      return data;
    }

    function fmtTime(ts) {
      if (!ts) return "—";
      const d = new Date(Number(ts));
      if (isNaN(d.getTime())) return "—";
      const p = function (n) { return String(n).padStart(2, "0"); };
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function fmtAgo(ts) {
      if (!ts) return "";
      const ms = Date.now() - Number(ts);
      if (ms < 0) return "";
      const m = Math.floor(ms / 60000);
      if (m < 1) return "刚刚";
      if (m < 60) return m + " 分钟前";
      const hr = Math.floor(m / 60);
      if (hr < 24) return hr + " 小时前";
      const d = Math.floor(hr / 24);
      return d + " 天前";
    }

    /** PAD 三维条。数值在 [-1,1]，中间是 0。 */
    function PadBar(props) {
      const label = props.label;
      const v = Math.max(-1, Math.min(1, Number(props.value) || 0));
      const pct = Math.abs(v) * 50;
      const style = v >= 0
        ? { left: "50%", width: pct + "%", background: "var(--dsw-alias-brand-primary,#3b82f6)" }
        : { right: "50%", width: pct + "%", background: "var(--dsw-alias-state-warn-primary,#d97706)" };
      return h("div", { className: "m3t-padbar" },
        h("div", { className: "m3t-padbar-l" }, h("span", null, label), h("span", null, v.toFixed(2))),
        h("div", { className: "m3t-track" },
          h("div", { className: "m3t-zero" }),
          h("div", { className: "m3t-fill", style: style })
        )
      );
    }

    // ============================================================
    // Tab 1：三层明细
    // ============================================================
    function LayersTab(props) {
      const d = props.data;
      const tiers = ["perm", "hot", "cold"];
      return h("div", null,
        h("div", { className: "m3t-note" },
          "配额（tokens）：永久层 " + d.rendered.budgets.perm +
          " / 加强层 " + d.rendered.budgets.hot +
          " / 卸载层 " + d.rendered.budgets.cold +
          "　·　本次实际用量：永久 " + d.rendered.usage.perm +
          " / 加强 " + d.rendered.usage.hot +
          " / 卸载 " + d.rendered.usage.cold
        ),
        tiers.map(function (tier) {
          const rows = d.tiers[tier] || [];
          return h("div", { className: "m3t-sec", key: tier },
            h("div", { className: "m3t-sec-h" },
              h("span", null, TIER_LABEL[tier]),
              h("span", { className: "m3t-badge" }, rows.length + " 条"),
              h("span", { className: "m3t-badge" }, TIER_HINT[tier])
            ),
            rows.length === 0
              ? h("div", { className: "m3t-empty" }, "（空）")
              : rows.map(function (r) {
                  return h("div", { className: "m3t-row", key: r.id },
                    h("span", { className: "m3t-id" }, "#" + r.id),
                    h("span", { className: "m3t-rowtitle", title: r.title }, r.title),
                    r.pinned ? h("span", { className: "m3t-num", title: "已钉住" }, "📌") : null,
                    r.supersedes ? h("span", { className: "m3t-num", title: "取代了旧条目" }, "←#" + r.supersedes) : null,
                    h("span", { className: "m3t-num", title: "重要度" }, "S=" + Number(r.salience).toFixed(2)),
                    h("span", { className: "m3t-num", title: "命中次数" }, "命中 " + r.hitCount)
                  );
                })
          );
        }),
        d.excluded && d.excluded.length > 0
          ? h("div", { className: "m3t-sec" },
              h("div", { className: "m3t-sec-h" },
                h("span", null, "不在任何层（已失效）"),
                h("span", { className: "m3t-badge" }, d.excluded.length + " 条")
              ),
              d.excluded.map(function (r) {
                return h("div", { className: "m3t-row", key: "x" + r.id },
                  h("span", { className: "m3t-id" }, "#" + r.id),
                  h("span", { className: "m3t-rowtitle" }, r.title),
                  h("span", { className: "m3t-num" }, r.status)
                );
              })
            )
          : null
      );
    }

    // ============================================================
    // Tab 2：实际注入文本
    // ============================================================
    function RenderedTab(props) {
      const d = props.data;
      const u = d.rendered.usage;
      return h("div", null,
        h("div", { className: "m3t-note" },
          "这是模型**真正看到**的记忆块（含人格段之外的记忆部分）。" +
          "它每轮重算，内容变化会影响 KV 缓存命中。"
        ),
        h("div", { className: "m3t-kv" },
          h("span", { className: "m3t-k" }, "总字符"), h("span", { className: "m3t-v" }, String(d.rendered.text.length)),
          h("span", { className: "m3t-k" }, "总 tokens"), h("span", { className: "m3t-v" }, String(u.total || 0)),
          h("span", { className: "m3t-k" }, "被跳过"), h("span", { className: "m3t-v" },
            "永久 " + (u.permSkipped || 0) + " / 加强 " + (u.hotSkipped || 0) + " / 卸载 " + (u.coldSkipped || 0)),
          h("span", { className: "m3t-k" }, "降级为摘要"), h("span", { className: "m3t-v" }, String(u.hotDegraded || 0))
        ),
        h("pre", { className: "m3t-pre" }, d.rendered.text || "（当前没有记忆块）")
      );
    }

    // ============================================================
    // Tab 3：当前心情
    // ============================================================
    function MoodTab(props) {
      const d = props.data;
      const mood = d.mood;
      const p = d.persona;

      const doReset = function () {
        props.onWrite("/mood", { action: "reset", scope: d.scope }, "心情已重置到基线");
      };

      return h("div", null,
        mood
          ? h("div", null,
              h("div", { className: "m3t-sec-h" },
                h("span", null, "当前心情：" + mood.label),
                h("span", { className: "m3t-badge" }, "强度 " + (mood.intensity * 100).toFixed(0) + "%"),
                h("span", { className: "m3t-badge" }, fmtAgo(mood.updatedAt))
              ),
              h("div", { className: "m3t-pad" },
                h(PadBar, { label: "愉悦度 P", value: mood.pad.p }),
                h(PadBar, { label: "唤醒度 A", value: mood.pad.a }),
                h(PadBar, { label: "掌控感 D", value: mood.pad.d })
              ),
              h("div", { className: "m3t-note" },
                "这个状态会随时间自动向基线回摆（越久越淡），也会被对话里的事件推动。" +
                "基线来自人格设定。"
              )
            )
          : h("div", { className: "m3t-empty" }, "还没有心情记录（下次对话就会开始积累）"),

        h("div", { style: { marginTop: "14px" } },
          h("div", { className: "m3t-sec-h" }, h("span", null, "人格基线")),
          h("div", { className: "m3t-kv" },
            h("span", { className: "m3t-k" }, "P"), h("span", { className: "m3t-v" }, Number(p.baseline.p).toFixed(2)),
            h("span", { className: "m3t-k" }, "A"), h("span", { className: "m3t-v" }, Number(p.baseline.a).toFixed(2)),
            h("span", { className: "m3t-k" }, "D"), h("span", { className: "m3t-v" }, Number(p.baseline.d).toFixed(2))
          ),
          h("div", { className: "m3t-note" }, "心情无事件时会向这里回归。要改基线请到「人格设定」。")
        ),

        h("div", { className: "m3t-actions" },
          h("button", { className: "m3t-btn", "data-kind": "danger", onClick: doReset }, "重置心情到基线")
        )
      );
    }

    // ============================================================
    // Tab 4：心情历史
    // ============================================================
    function HistoryTab(props) {
      const d = props.data;
      const hist = d.history || [];
      if (hist.length === 0) {
        return h("div", { className: "m3t-empty" }, "（还没有心情变化记录）");
      }
      const EVENT_ZH = {
        praise: "被夸", comfort: "被安慰", apology: "道歉", care: "被关心",
        interesting: "有趣", task_done: "任务完成",
        criticism: "被批评", insult: "被冒犯", provoke: "被激怒", ignore: "被无视",
        boring: "无聊", task_fail: "任务失败",
        reset: "手动重置", manual: "手动设定", neutral: "—",
      };
      return h("div", { className: "m3t-hist" },
        h("div", { className: "m3t-note" },
          "最近 " + hist.length + " 次变化。事件类型是触发原因，用来区分" +
          "「因为什么而愉快」——PAD 本身分不出这个。"
        ),
        hist.map(function (e, i) {
          const zh = EVENT_ZH[e.eventKind] || e.eventKind;
          return h("div", { className: "m3t-row", key: i },
            h("span", { className: "m3t-num" }, fmtTime(e.at)),
            h("span", { className: "m3t-rowtitle" },
              e.label + "　强度 " + (e.intensity * 100).toFixed(0) + "%"),
            h("span", { className: "m3t-badge" }, zh)
          );
        })
      );
    }

    // ============================================================
    // Tab 5：人格设定编辑器
    // ============================================================
    function PersonaTab(props) {
      const d = props.data;
      const base = d.persona;
      const meta = d.meta;

      const [form, setForm] = useState(function () {
        return {
          name: base.name,
          summary: base.summary || "",
          background: base.background || "",
          extra: base.extra || "",
          styleText: (base.style || []).join("\n"),
          sensitivity: base.traits.sensitivity,
          warmth: base.traits.warmth,
          irritability: base.traits.irritability,
          recovery: base.traits.recovery,
          bp: base.baseline.p,
          ba: base.baseline.a,
          bd: base.baseline.d,
        };
      });
      const [preview, setPreview] = useState("");
      const [mode, setMode] = useState(d.meta.personaMode || "full");
      const [saving, setSaving] = useState(false);

      // 人格在外部变了（比如套了预设）→ 重填表单
      useEffect(function () {
        setForm({
          name: base.name,
          summary: base.summary || "",
          background: base.background || "",
          extra: base.extra || "",
          styleText: (base.style || []).join("\n"),
          sensitivity: base.traits.sensitivity,
          warmth: base.traits.warmth,
          irritability: base.traits.irritability,
          recovery: base.traits.recovery,
          bp: base.baseline.p,
          ba: base.baseline.a,
          bd: base.baseline.d,
        });
      }, [base.updatedAt, base.name]);

      const set = function (k, v) {
        setForm(function (f) {
          const next = Object.assign({}, f);
          next[k] = v;
          return next;
        });
      };

      const buildPersona = function () {
        return {
          name: form.name,
          summary: form.summary,
          background: form.background,
          extra: form.extra,
          style: form.styleText.split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
          traits: {
            sensitivity: Number(form.sensitivity),
            warmth: Number(form.warmth),
            irritability: Number(form.irritability),
            recovery: Number(form.recovery),
          },
          baseline: { p: Number(form.bp), a: Number(form.ba), d: Number(form.bd) },
        };
      };

      const doPreview = useCallback(async function () {
        try {
          const r = await api("/preview", {
            persona: buildPersona(),
            mode: mode,
            mood: d.mood ? d.mood.pad : null,
          });
          setPreview(r.text || "（这一档不注入任何内容）");
        } catch (e) {
          setPreview("预览失败：" + String(e.message || e));
        }
      }, [form, mode, d.mood]);

      const doSave = async function () {
        setSaving(true);
        try {
          await api("/persona", { action: "set", scope: d.scope, persona: buildPersona() });
          props.onSaved("人格已保存");
        } catch (e) {
          props.onSaved("保存失败：" + String(e.message || e), true);
        } finally {
          setSaving(false);
        }
      };

      const doPreset = async function (id) {
        try {
          await api("/persona", { action: "preset", scope: d.scope, presetId: id });
          props.onSaved("已套用预设 " + id);
        } catch (e) {
          props.onSaved("套用失败：" + String(e.message || e), true);
        }
      };

      const slider = function (key, label, min, max) {
        return h("div", { className: "m3t-field", key: key },
          h("div", { className: "m3t-field-l" }, label + "　" + Number(form[key]).toFixed(2)),
          h("input", {
            type: "range", min: min, max: max, step: 0.05,
            value: Number(form[key]),
            onChange: function (e) { set(key, Number(e.target.value)); },
            style: { width: "100%" },
          })
        );
      };

      return h("div", null,
        // ---- 预设 ----
        h("div", { className: "m3t-sec" },
          h("div", { className: "m3t-sec-h" }, h("span", null, "内置预设")),
          h("div", null,
            meta.presets.map(function (p) {
              return h("span", {
                key: p.id,
                className: "m3t-chip",
                "data-on": base.presetId === p.id ? "1" : "0",
                title: p.summary,
                onClick: function () { doPreset(p.id); },
              }, p.name);
            })
          ),
          h("div", { className: "m3t-note" },
            "套用预设会**覆盖**当前人格。当前：" + (base.presetId || "custom")
          )
        ),

        // ---- 基本信息 ----
        h("div", { className: "m3t-field" },
          h("div", { className: "m3t-field-l" }, "名字"),
          h("input", {
            className: "m3t-in", value: form.name,
            onChange: function (e) { set("name", e.target.value); },
          })
        ),
        h("div", { className: "m3t-field" },
          h("div", { className: "m3t-field-l" }, "一句话定位（会出现在注入里）"),
          h("input", {
            className: "m3t-in", value: form.summary,
            onChange: function (e) { set("summary", e.target.value); },
          })
        ),
        h("div", { className: "m3t-field" },
          h("div", { className: "m3t-field-l" }, "背景"),
          h("textarea", {
            className: "m3t-ta", value: form.background,
            onChange: function (e) { set("background", e.target.value); },
          })
        ),
        h("div", { className: "m3t-field" },
          h("div", { className: "m3t-field-l" }, "说话风格（每行一条）"),
          h("textarea", {
            className: "m3t-ta", style: { minHeight: "78px" }, value: form.styleText,
            onChange: function (e) { set("styleText", e.target.value); },
          })
        ),
        h("div", { className: "m3t-field" },
          h("div", { className: "m3t-field-l" }, "补充说明（自由文本，可后续对话补充）"),
          h("textarea", {
            className: "m3t-ta", value: form.extra,
            onChange: function (e) { set("extra", e.target.value); },
          })
        ),

        // ---- 性格权重 ----
        h("div", { className: "m3t-sec" },
          h("div", { className: "m3t-sec-h" },
            h("span", null, "性格权重"),
            h("span", { className: "m3t-badge" }, "只调节幅度，不决定有无情绪")
          ),
          slider("sensitivity", "敏感度", 0, 1),
          slider("warmth", "对正向事件的热度", 0, 1),
          slider("irritability", "对负向事件的易怒度", 0, 1),
          slider("recovery", "回摆速度（越大越快平复）", 0.05, 1)
        ),

        // ---- 基线 ----
        h("div", { className: "m3t-sec" },
          h("div", { className: "m3t-sec-h" },
            h("span", null, "心情基线"),
            h("span", { className: "m3t-badge" }, "无事件时心情朝这里回归")
          ),
          slider("bp", "愉悦度 P", -1, 1),
          slider("ba", "唤醒度 A", -1, 1),
          slider("bd", "掌控感 D", -1, 1)
        ),

        // ---- 操作 ----
        h("div", { className: "m3t-actions" },
          h("button", { className: "m3t-btn", "data-kind": "primary", onClick: doSave, disabled: saving },
            saving ? "保存中…" : "保存"),
          h("select", {
            className: "m3t-sel", value: mode,
            onChange: function (e) { setMode(e.target.value); },
          },
            h("option", { value: "full" }, "注入档位：全开"),
            h("option", { value: "light" }, "注入档位：工作优先"),
            h("option", { value: "off" }, "注入档位：关闭")
          ),
          h("button", { className: "m3t-btn", onClick: doPreview }, "预览注入文本")
        ),

        h("div", { className: "m3t-note" },
          "档位说明：全开 = 完整人设 + 心情；工作优先 = 只有名字与一句口吻约束、" +
          "不注入心情；关闭 = 完全不注入。改档位需在插件配置里改 personaMode，这里的下拉只影响预览。"
        ),

        preview
          ? h("div", { className: "m3t-sec" },
              h("div", { className: "m3t-sec-h" },
                h("span", null, "注入预览"),
                h("span", { className: "m3t-badge" }, preview.length + " 字符")
              ),
              h("pre", { className: "m3t-pre" }, preview)
            )
          : null
      );
    }

    // ============================================================
    // 面板主体
    // ============================================================
    function Panel() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [tab, setTab] = useState("layers");
      const [scope, setScope] = useState("");
      const [loading, setLoading] = useState(true);
      const [toast, setToast] = useState("");
      const [reloadKey, setReloadKey] = useState(0);

      const load = useCallback(async function () {
        setLoading(true);
        setErr("");
        try {
          const r = await api("/state", scope ? { scope: scope } : {});
          if (r.needsScope) {
            setData({ needsScope: true, scopes: r.scopes || [] });
          } else {
            setData(r);
            if (r.scope && r.scope !== scope) setScope(r.scope);
          }
        } catch (e) {
          setErr(String((e && e.message) || e));
          setData(null);
        } finally {
          setLoading(false);
        }
      }, [scope]);

      useEffect(function () {
        load();
      }, [reloadKey]);

      const refresh = function () { setReloadKey(function (k) { return k + 1; }); };

      const onWrite = async function (path, body, okMsg) {
        try {
          await api(path, body);
          setToast(okMsg);
          refresh();
        } catch (e) {
          setToast("操作失败：" + String((e && e.message) || e));
        }
      };

      const onSaved = function (msg, isErr) {
        setToast(msg);
        if (!isErr) refresh();
      };

      useEffect(function () {
        if (!toast) return;
        const t = setTimeout(function () { setToast(""); }, 3200);
        return function () { clearTimeout(t); };
      }, [toast]);

      // ---- 加载中 / 错误 / 需选 scope ----
      if (loading && !data) {
        return h("div", { className: "m3t-panel" }, h("div", { className: "m3t-body" }, "加载中…"));
      }
      if (err) {
        return h("div", { className: "m3t-panel" },
          h("div", { className: "m3t-head" }, h("span", { className: "m3t-title" }, "可塑性记忆")),
          h("div", { className: "m3t-err" }, err),
          h("div", { className: "m3t-body" },
            h("div", { className: "m3t-note" },
              "连不上 Host 侧路由。可能原因：①插件未启用；②插件版本不含面板路由；" +
              "③这不是 Web 部署。"),
            h("button", { className: "m3t-btn", onClick: refresh }, "重试")
          )
        );
      }
      if (!data) {
        return h("div", { className: "m3t-panel" }, h("div", { className: "m3t-body" }, "没有数据"));
      }
      if (data.needsScope) {
        return h("div", { className: "m3t-panel" },
          h("div", { className: "m3t-head" }, h("span", { className: "m3t-title" }, "可塑性记忆")),
          h("div", { className: "m3t-body" },
            data.scopes && data.scopes.length > 0
              ? h("div", null,
                  h("div", { className: "m3t-note" }, "这个面板按工作区隔离。请选择要查看的工作区："),
                  data.scopes.map(function (s) {
                    return h("div", { key: s, className: "m3t-row", style: { cursor: "pointer" },
                      onClick: function () { setScope(s); setReloadKey(function (k) { return k + 1; }); } },
                      h("span", { className: "m3t-rowtitle" }, s)
                    );
                  })
                )
              : h("div", { className: "m3t-note" },
                  "还没有任何工作区有记忆。先正常对话一次，这里就会出现。")
          )
        );
      }

      const tabs = [
        ["layers", "三层明细"],
        ["rendered", "注入文本"],
        ["mood", "当前心情"],
        ["history", "心情历史"],
        ["persona", "人格设定"],
      ];

      const bodyFor = function () {
        if (tab === "layers") return h(LayersTab, { data: data });
        if (tab === "rendered") return h(RenderedTab, { data: data });
        if (tab === "mood") return h(MoodTab, { data: data, onWrite: onWrite });
        if (tab === "history") return h(HistoryTab, { data: data });
        return h(PersonaTab, { data: data, onSaved: onSaved });
      };

      return h("div", { className: "m3t-panel" },
        h("div", { className: "m3t-head" },
          h("span", { className: "m3t-title" }, "可塑性记忆"),
          h("span", { className: "m3t-scope", title: data.scope }, data.scope),
          h("button", { className: "m3t-btn", onClick: refresh, disabled: loading },
            loading ? "…" : "刷新")
        ),
        h("div", { className: "m3t-tabs" },
          tabs.map(function (t) {
            return h("button", {
              key: t[0], className: "m3t-tab",
              "data-on": tab === t[0] ? "1" : "0",
              onClick: function () { setTab(t[0]); },
            }, t[1]);
          })
        ),
        toast ? h("div", { className: "m3t-ok" }, toast) : null,
        h("div", { className: "m3t-body" }, bodyFor())
      );
    }

    // ============================================================
    // 侧栏入口
    // ============================================================
    function SidebarEntry() {
      return h("div", {
        title: "可塑性记忆",
        style: { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" },
      }, h("span", { style: { fontSize: "15px", lineHeight: 1 } }, "🐟"));
    }

    // ============================================================
    // apply
    // ============================================================
    var inject = ["slots"];

    function apply(ctx) {
      // 样式
      ctx.effect(function () {
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dsh-malleable-memory");
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        return function () {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
        };
      }, "dsh-malleable-memory: styles");

      // 侧栏图标
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: "可塑性记忆" },
          SidebarEntry
        );
      });

      // 中央面板页。key 必须与侧栏 id 一致 —— 点击侧栏图标时宿主按 id 派发。
      ctx.slots.inject("main", function () {
        return ctx.slots.register({ name: "main", key: PANEL_ID }, Panel);
      });
    }

    module.exports = { name: NS, inject: inject, apply: apply };
    return module.exports;
  },
});
