// LLM 打分适配层（2026-10-24 M2）
//
// ## 为什么放在单独文件
//
// `memory-core.js` 的定位是「纯逻辑、零宿主依赖」（M1 就定下的边界，
// 测试也因此不需要 mock 宿主）。LLM 打分离不开「调模型」这件事，
// 混进去会让核心逻辑被迫依赖宿主。
//
// 所以这里只做**三件纯事**：
//   1. 构造打分提示词
//   2. 解析模型返回的 JSON（含各种脏格式兜底）
//   3. 把 LLM 结果与规则结果**合并**成最终判定
//
// 真正的 `ctx.llm.stream(...)` 调用放在 index.js 里，由它把文本喂进来。

/**
 * 打分输出的 JSON Schema 约定。
 *
 * 模型必须返回：
 *   {
 *     "keep": true/false,      要不要入库
 *     "kind": "fact|pref|...", 类别
 *     "salience": 0..1,        重要度
 *     "title": "≤30 字",       索引行标题（独立可懂）
 *     "why": "一句话理由"       给用户看的解释
 *   }
 *
 * 为什么要模型也给出 title：规则版的 title 是从原文切出来的（含省略号、
 * 可能断在半句）。LLM 能把它改写成真正独立可懂的短句，这是 D012 之后
 * 索引行可读性的关键改进点。
 */
export const SCORE_FIELDS = ["keep", "kind", "salience", "title", "why"];

export const VALID_KINDS = ["fact", "pref", "event", "promise", "decision", "lesson"];

/**
 * 构造打分提示词。
 *
 * 设计要点：
 *   - 明确「这不是给用户的回复」，避免模型输出客套话
 *   - 给出 few-shot 边界（什么该记、什么不该记）
 *   - **只允许输出 JSON**，并在解析侧做脏格式兜底
 *   - 明确「宁可少记」的倾向：误记会永久污染上下文，漏记只是少一条线索
 */
export function buildScorePrompt(text) {
  return [
    "你在为一个「长期记忆系统」判定：下面这句话是否值得长期记住。",
    "",
    "判定标准：",
    "- 该记：长期有效的偏好、约定、决定、环境事实、踩过的坑、承诺。",
    "- 不该记：一次性任务指令（帮我做X、继续做Y）、闲聊、应答、",
    "  对当前对话的即时提问（现在几点、你刚才说的什么意思）。",
    "- 宁可少记：误记会永久占用上下文，漏记只是少一条线索。",
    "",
    "输出要求：",
    "- 只输出一个 JSON 对象，不要代码块、不要解释、不要前后缀。",
    "- 字段：",
    '  "keep": 布尔，是否值得长期记住',
    '  "kind": "fact" | "pref" | "event" | "promise" | "decision" | "lesson"',
    '  "salience": 0 到 1 的小数，重要度',
    '  "title": 不超过 30 字的标题，必须脱离原文也能看懂',
    '  "why": 一句话说明为什么这样判定',
    "",
    "被判定的话：",
    "<<<",
    String(text || "").slice(0, 1000),
    ">>>",
  ].join("\n");
}

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 模型经常不守规矩，实测过的脏格式：
 *   - 包在 ```json ... ``` 代码块里
 *   - 前后带「好的，我的判断是：」这类客套话
 *   - 用的是中文全角引号
 *   - 多输出了一层数组
 *
 * 这个函数只负责"尽可能抠出来"，抠不出来返回 null（由调用方回退规则版）。
 */
export function parseScoreResponse(raw) {
  const s = String(raw || "").trim();
  if (s.length === 0) return null;

  // 1) 去掉 ``` 围栏
  let body = s;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();

  // 2) 直接尝试
  let obj = tryJson(body);

  // 3) 退一步：抠第一个 { 到最后一个 } 之间
  if (!obj) {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryJson(body.slice(start, end + 1));
  }

  // 4) 再退一步：全角引号替换后再试
  if (!obj) {
    const fixed = body
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    const start = fixed.indexOf("{");
    const end = fixed.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryJson(fixed.slice(start, end + 1));
  }

  if (!obj) return null;

  // 5) 如果模型给的是数组，取第一个对象
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || typeof obj !== "object") return null;

  return normalizeScore(obj);
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把模型给的字段归一成可信形状。任何字段不合法就丢弃该字段
 * （而不是整体丢弃或硬塞默认值），由合并层决定用什么兜底。
 */
export function normalizeScore(obj) {
  const out = {};

  if (typeof obj.keep === "boolean") out.keep = obj.keep;
  else if (typeof obj.keep === "string") {
    const v = obj.keep.trim().toLowerCase();
    if (["true", "yes", "是", "1"].includes(v)) out.keep = true;
    if (["false", "no", "否", "0"].includes(v)) out.keep = false;
  }

  if (VALID_KINDS.includes(obj.kind)) out.kind = obj.kind;

  const sal = Number(obj.salience ?? obj.S);
  if (Number.isFinite(sal)) {
    // 兼容模型给出 0-100 的情况
    out.salience = Math.max(0, Math.min(1, sal > 1 ? sal / 100 : sal));
  }

  if (typeof obj.title === "string") {
    const t = obj.title.trim().replace(/\s+/g, " ");
    if (t.length > 0) out.title = t.slice(0, 40); // 稍后由调用方再按 30 字收
  }

  if (typeof obj.why === "string" && obj.why.trim().length > 0) {
    out.why = obj.why.trim().slice(0, 120);
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 合并 LLM 判定与规则判定。
 *
 * ## 三条硬规则（不能被 LLM 推翻）
 *
 * 1. **任务指令绝不入库** —— 即使用户说了「帮我实现登录」而模型认为该记，
 *    也拒绝。`isTaskInstruction` 是 M1 反复调过的防线（D4），
 *    不能让 LLM 的误判把它冲掉。
 * 2. **显式「记住」必须入库** —— 用户说「记住这个」时，
 *    模型不能因为觉得不重要就丢掉。
 * 3. **pin / perm 不受影响** —— 层级判定的最终决定权仍在规则侧。
 *
 * 除此之外，LLM 的 `keep` / `kind` / `salience` / `title` / `why` 可以覆盖规则结果。
 * LLM 缺失的字段一律回退到规则值。
 */
export function mergeScores(ruleCand, llmScore, ctx) {
  const { taskInstruction = false, explicitRemember = false } = ctx || {};

  // 硬规则 1：任务指令一律拒绝
  if (taskInstruction) {
    return { accepted: false, reason: "task-instruction", source: "rule-override" };
  }

  // LLM 完全没给出有效结果 → 全用规则
  if (!llmScore) {
    return { accepted: ruleCand !== null, merged: ruleCand, source: "rule" };
  }

  // 硬规则 2：显式记住必须入库
  const keep = explicitRemember ? true : llmScore.keep === true;

  if (!keep) {
    return { accepted: false, reason: "llm-says-skip", source: "llm" };
  }

  // 规则侧本来就判定不该入库（例如 S 低于入库门槛），
  // 但 LLM 说要记 —— 这时候以 LLM 为准，但要记录来源便于审计。
  const base = ruleCand || {};
  const merged = {
    ...base,
    kind: llmScore.kind || base.kind || "fact",
    salience:
      typeof llmScore.salience === "number" ? llmScore.salience : (base.salience ?? 0.5),
    title: llmScore.title ? llmScore.title.slice(0, 30) : base.title,
    why: llmScore.why || base.why || "LLM 判定",
  };

  return {
    accepted: true,
    merged,
    source: ruleCand ? "llm+rule" : "llm-only",
  };
}
