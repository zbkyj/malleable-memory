// 面板的 Host 侧数据路由（M3.3a，2026-10-25）
//
// ## 为什么需要这个文件
//
// 面板是 Client（浏览器）侧代码。它拿不到 Host 的 `MemoryStore` ——
// SQLite 句柄在 Host 进程里，浏览器里根本没有。
//
// 宿主的标准做法（与本 profile 里已装的 `dsh-what-changed` 一致）：
//   Host 用 `ctx.webServer.register()` 注册一条本地 HTTP 路由
//   Client 用 `fetch()` 调它
//
// ## 安全设计（用户已确认走本地路由）
//
// 这是一个**新的 HTTP 端点**，所以按最窄的方式做：
//   ① `isLoopbackRequest()` —— 只接受回环来源（校验 remoteAddress + Host 头），
//      局域网/外网请求一律 403
//   ② 只允许 POST + application/json（避免被当作 GET 图片/表单触发）
//   ③ 请求体限制大小
//   ④ 只暴露**本项目自己的**数据（记忆分层、人格、心情），
//      不提供任意 SQL、不提供文件读写、不提供 exec
//   ⑤ 写操作只到 persona / mood 两张表，**不碰 memories 的正文与状态**
//
// 依赖是**可选**的：`webServer` 不在时（比如无 Web UI 的部署）整个模块静默跳过，
// 不影响记忆与人格注入这些核心功能。

import {
  normalizePersona,
  personaFromPreset,
  applyPersonaPatch,
  renderPersonaBlock,
  classifyEmotion,
  emotionIntensity,
  makePad,
  summarizeMoodHistory,
  PERSONA_PRESETS,
  PERSONA_MODES,
  EMOTION_LABELS,
  EVENT_KINDS,
  normalizePersonaMode,
} from "./persona-core.js";

/** 路由前缀。用项目名，避免与其它插件冲突。 */
const ROUTE_PREFIX = "/malleable-memory";

/** 请求体上限（面板只发小 JSON）。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 判断是不是回环来源。
 *
 * 双重校验：
 *   - socket 的对端地址必须是 127.0.0.1 / ::1
 *   - Host 头必须是 localhost / 127.0.0.1 / ::1
 *
 * 注意：**不能只看 Host 头**。Host 头是客户端可控的，只看它等于没有防护。
 *
 * 但要如实理解这层校验的作用边界（见 hasTrustedOrigin）：
 * 它只证明"请求来自本机"，**不证明请求者是我们自己的页面**。
 */
function isLoopbackRequest(req) {
  const address = (req.socket && req.socket.remoteAddress) || "";
  const local = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  if (!local) return false;
  const host = String((req.headers && req.headers.host) || "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * 校验请求**确实来自本插件的页面**，而不是本机上的任意网页/进程。
 *
 * ## 为什么需要这一层（2026-10-25 GPT 审核发现）
 *
 * 只做 `isLoopbackRequest` 是**不够**的，它有两个漏洞：
 *
 * **漏洞一：跨站简单请求绕过 CORS 预检。**
 * 恶意网页可以发 `Content-Type: text/plain` 的 POST（这是 CORS 里的
 * "简单请求"，浏览器**不做预检**）。此时 `remoteAddress` 是 127.0.0.1、
 * `Host` 是 localhost —— 两道检查全过。浏览器虽然不会把**响应**交给该网页，
 * 但**请求已经执行完了**：persona 被改、mood 被重置。
 *
 * **漏洞二：本机任意进程都能调。**
 * `isLoopbackRequest` 只区分"本机/非本机"，不区分"哪个程序"。
 *
 * ## 现在的三道防御
 *
 * ① **Content-Type 必须是 application/json**
 *    这直接把"简单请求"这条绕过路堵死 —— 带 `application/json` 的跨源请求
 *    必然触发 CORS 预检，而我们不返回任何 CORS 允许头，预检就会失败。
 *
 * ② **`Sec-Fetch-Site` 必须是 same-origin 或 none**
 *    现代浏览器强制发送这个头（脚本无法伪造）。它是识别跨站请求最可靠的手段。
 *    不是所有客户端都发（curl/脚本不发），所以缺失时**不拒绝**，
 *    由第 ③ 条兜底。
 *
 * ③ **Origin 头存在时，必须与 Host 同源**
 *    浏览器发跨源请求一定带 Origin。同源请求现代浏览器也会带。
 *
 * 组合后：浏览器里的恶意跨站请求被 ① 和 ②/③ 挡住；
 * 本机其它**原生程序**仍然可以调（这是刻意的——它和用户自己有同等权限，
 * 我们无法也不应在本机做进程级鉴权，那需要 OS 能力）。
 *
 * ## 必须如实说明的边界
 *
 * 这不是"身份认证"。本机上以用户权限运行的程序（任何脚本、任何 CLI）
 * 依然可以直接 POST 这些路由。要挡住它们需要 CSRF token 或 OS 级隔离，
 * 本插件没有做。README 必须照实写。
 */
function hasTrustedOrigin(req) {
  const headers = req.headers || {};

  // ① Content-Type 必须是 JSON。
  //    注意：浏览器对跨源请求若用 text/plain 就不会预检，所以这条是必需的。
  const contentType = String(headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) return false;

  // ② Sec-Fetch-Site：浏览器强制发送、脚本不可伪造。
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;

  // ③ Origin 存在时必须与 Host 同源。
  const origin = headers["origin"];
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(String(origin)).host;
    } catch {
      return false; // Origin 不是合法 URL → 可疑
    }
    const host = String(headers["host"] || "");
    if (originHost !== host) return false;
  }

  return true;
}

/** 读 JSON 请求体，带大小上限。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 四条路由共用的前置检查。
 *
 * 为什么抽出来：原先每行都复制粘贴 `isLoopbackRequest + method`，
 * 加新检查时容易漏掉某一条路由（本次就差点漏）。
 * 集中一处，新增检查自动覆盖全部路由。
 */
function guard(req, res) {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: "loopback only" });
    return false;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "POST only" });
    return false;
  }
  if (!hasTrustedOrigin(req)) {
    // 注意：这个 403 的措辞不要暴露太多实现细节
    sendJson(res, 403, { ok: false, error: "request rejected" });
    return false;
  }
  return true;
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // 面板数据不该被任何中间层缓存
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * 注册面板路由。
 *
 * @param ctx   Cordis 上下文（需已确认 webServer 存在）
 * @param deps  { ensureStore, scopeOfRequest, budgets, state, logger }
 * @returns disposer
 */
export function registerPanelRoutes(ctx, deps) {
  const { ensureStore, budgets, logger } = deps;

  /**
   * 从请求里解析 scope。
   *
   * ## 为什么不用 body 里随便传的 scope
   *
   * 如果面板可以指定任意 scope，就等于可以读**别的 workspace** 的记忆。
   * 虽然都是本机数据，但跨工作区越权没有正当用途，属于不该给的权限。
   *
   * 所以：只接受**当前已知的** scope 之一（由调用方传入白名单），
   * 不在白名单里的一律拒绝。面板自己传的 scope 只用于"在已知集合里选"。
   */
  const resolveScope = (raw) => {
    const known = deps.knownScopes ? deps.knownScopes() : [];
    const wanted = typeof raw === "string" && raw.trim() ? raw.trim() : "";
    if (wanted) {
      const lc = wanted.toLowerCase();
      const hit = known.find((s) => String(s).toLowerCase() === lc);
      return hit || null;
    }
    // 没指定时：只有一个已知 scope 就用它，多个则不猜
    if (known.length === 1) return known[0];
    return null;
  };

  // ---------- GET /malleable-memory/state ----------
  //
  // 面板首屏：一次拿齐所有只读数据，避免多次往返。
  const stateHandler = async (req, res) => {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad body" });

    const store = await ensureStore();
    if (!store) return sendJson(res, 503, { ok: false, error: "store unavailable" });

    const known = deps.knownScopes ? deps.knownScopes() : [];
    const scope = resolveScope(body.scope);
    if (!scope) {
      // 多个已知 scope 且用户没指定 → 让面板显示选择器
      return sendJson(res, 200, {
        ok: true,
        needsScope: true,
        scopes: known,
      });
    }

    try {
      const persona = store.ensurePersona(scope, deps.seedPersona());
      const mood = store.getMood(scope);
      const tiers = {
        perm: store.listByTier(scope, "perm"),
        hot: store.listByTier(scope, "hot"),
        cold: store.listByTier(scope, "cold"),
      };
      const counts = store.countByTier(scope);
      const userInput = deps.lastUserInput(scope) || "";
      const built = store.buildBlock(scope, budgets, userInput);
      const history = store.listMoodHistory(scope, 30);
      const excluded = store.db
        .prepare("SELECT id, title, status FROM memories WHERE scope = ? AND status != 'active' ORDER BY id")
        .all(scope);

      const shapeRow = (r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        tier: r.tier,
        salience: Number(r.salience),
        hitCount: Number(r.hitCount),
        hitCount30d: Number(r.hitCount30d),
        pinned: Boolean(r.pinned),
        supersedes: r.supersedes ?? null,
        updatedAt: Number(r.updatedAt || r.lastHitAt || 0),
      });

      return sendJson(res, 200, {
        ok: true,
        scope,
        scopes: known,
        persona,
        mood: mood
          ? {
              pad: mood.pad,
              label: classifyEmotion(mood.pad).label,
              intensity: emotionIntensity(mood.pad),
              updatedAt: mood.updatedAt,
            }
          : null,
        tiers: {
          perm: tiers.perm.map(shapeRow),
          hot: tiers.hot.map(shapeRow),
          cold: tiers.cold.map(shapeRow),
        },
        counts,
        excluded: excluded.map((r) => ({ id: r.id, title: r.title, status: r.status })),
        // 面板的「实际注入文本」Tab：直接给模型真正看到的那段
        rendered: {
          text: built.block.text,
          usage: built.block.usage,
          budgets,
        },
        history: history.map((h) => ({
          at: Number(h.at),
          label: h.label,
          intensity: Number(h.intensity),
          pad: { p: Number(h.p), a: Number(h.a), d: Number(h.d) },
          eventKind: h.event_kind,
        })),
        meta: {
          schemaVersion: store.schemaVersion(),
          presets: PERSONA_PRESETS.map((p) => ({ id: p.id, name: p.name, summary: p.summary })),
          modes: PERSONA_MODES,
          emotions: EMOTION_LABELS,
          events: EVENT_KINDS,
          personaMode: deps.personaMode ? deps.personaMode() : "full",
        },
      });
    } catch (error) {
      logger?.warn?.("malleable-memory: panel state failed " + String(error && error.message));
      return sendJson(res, 500, { ok: false, error: "state failed" });
    }
  };

  // ---------- POST /malleable-memory/persona ----------
  //
  // 写人格。支持三种操作：
  //   { action: "patch",  scope, patch }   局部补充（对话式演化）
  //   { action: "set",    scope, persona } 整体替换（编辑器保存）
  //   { action: "preset", scope, presetId } 套用预设
  const personaHandler = async (req, res) => {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad body" });

    const store = await ensureStore();
    if (!store) return sendJson(res, 503, { ok: false, error: "store unavailable" });

    const scope = resolveScope(body.scope);
    if (!scope) return sendJson(res, 400, { ok: false, error: "unknown scope" });

    try {
      const current = store.ensurePersona(scope, deps.seedPersona());
      const action = String(body.action || "");

      let next = null;
      if (action === "preset") {
        const p = personaFromPreset(String(body.presetId || ""));
        if (!p) return sendJson(res, 400, { ok: false, error: "unknown preset" });
        next = p;
      } else if (action === "patch") {
        next = applyPersonaPatch(current, body.patch || {});
      } else if (action === "set") {
        // 整体替换：保留 presetId 之外的一切都由调用方给。
        // normalizePersona 会把越界值夹回来，所以不怕脏数据。
        next = normalizePersona({ ...current, ...(body.persona || {}) });
        next.updatedAt = Date.now();
      } else {
        return sendJson(res, 400, { ok: false, error: "unknown action" });
      }

      store.putPersona(scope, { ...next, scope });
      return sendJson(res, 200, { ok: true, persona: store.getPersona(scope) });
    } catch (error) {
      logger?.warn?.("malleable-memory: panel persona write failed " + String(error && error.message));
      return sendJson(res, 500, { ok: false, error: "persona write failed" });
    }
  };

  // ---------- POST /malleable-memory/mood ----------
  //
  // 心情操作：
  //   { action: "reset",  scope }           回到基线
  //   { action: "set",    scope, p,a,d }    手动指定（调试用）
  const moodHandler = async (req, res) => {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad body" });

    const store = await ensureStore();
    if (!store) return sendJson(res, 503, { ok: false, error: "store unavailable" });

    const scope = resolveScope(body.scope);
    if (!scope) return sendJson(res, 400, { ok: false, error: "unknown scope" });

    try {
      const persona = store.ensurePersona(scope, deps.seedPersona());
      const action = String(body.action || "");
      const now = Date.now();

      let pad;
      let eventKind = "neutral";
      if (action === "reset") {
        pad = makePad(persona.baseline.p, persona.baseline.a, persona.baseline.d);
        eventKind = "reset";
      } else if (action === "set") {
        pad = makePad(body.p, body.a, body.d);
        eventKind = "manual";
      } else {
        return sendJson(res, 400, { ok: false, error: "unknown action" });
      }

      const { label } = classifyEmotion(pad);
      const intensity = emotionIntensity(pad);
      store.putMood(scope, { pad, label, intensity }, now);
      store.pushMoodHistory(scope, { pad, label, intensity, eventKind, at: now });

      return sendJson(res, 200, { ok: true, mood: store.getMood(scope) });
    } catch (error) {
      logger?.warn?.("malleable-memory: panel mood write failed " + String(error && error.message));
      return sendJson(res, 500, { ok: false, error: "mood write failed" });
    }
  };

  // ---------- POST /malleable-memory/preview ----------
  //
  // 不写库，只按给定人格渲染一遍，用于编辑器实时预览。
  const previewHandler = async (req, res) => {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad body" });

    try {
      const persona = normalizePersona(body.persona || {});
      const mode = normalizePersonaMode(body.mode);
      let mood = null;
      if (body.mood && typeof body.mood === "object") {
        mood = { pad: makePad(body.mood.p, body.mood.a, body.mood.d) };
      }
      const text = renderPersonaBlock(persona, mood, mode);
      return sendJson(res, 200, { ok: true, text, length: text.length });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: "preview failed" });
    }
  };

  const disposers = [];
  const routes = [
    ["/state", stateHandler],
    ["/persona", personaHandler],
    ["/mood", moodHandler],
    ["/preview", previewHandler],
  ];

  for (const [suffix, handler] of routes) {
    disposers.push(
      ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + suffix,
        handler,
      })
    );
  }

  return () => {
    for (const d of disposers) {
      try {
        if (typeof d === "function") d();
      } catch {
        /* 清理失败不该阻断卸载 */
      }
    }
  };
}

/** 路由前缀导出，给 Client 侧对齐用。 */
export { ROUTE_PREFIX };
