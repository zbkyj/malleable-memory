// 事件判定（M3.4，2026-10-25）
//
// ## 职责边界
//
// `persona-core.js` 回答「已知是这类事件，状态怎么变」。
// 这个文件回答**「这句话算哪类事件」**。
//
// 分开的理由：内核必须零依赖可离线单测；判定要读文本，
// 而文本判定以后可能要走 LLM（网络、有失败模式）。
//
// ## 两档判定（M3.4 的 C 方案：混合）
//
//   1. 规则版（默认）：关键词 + 轻量打分。零成本、永远可用。
//   2. LLM 版（可选）：由调用方传入 `llmJudger`，失败自动回退规则。
//
// ## 为什么规则版要"宁可不判定"（返回 neutral）
//
// 误判的代价不对称：
//   - 把中性话误判成「侮辱」→ 角色无缘无故生气，很出戏
//   - 漏判一句真侮辱 → 只是这次没生气，无感
//
// 所以规则版只认**高置信度**的信号，模糊的一律 neutral。

import { EVENT_KINDS } from "./persona-core.js";

/**
 * 规则库。每条给：匹配模式 + 事件类型 + 基础强度。
 *
 * 顺序有意义：先匹配到的先赢，所以强信号写在前面
 * （「你真烦」要判 insult，不能被「你真」这种弱正向词抢走）。
 */
const RULES = [
  // ---------- 强负向（必须排最前）----------
  //
  // 为什么 insult 要放第一条：正向词和负向词可能同时出现
  // （"你真蠢"里的"你真"也是 praise 的前缀）。**负向优先**是刻意的：
  // 把骂人的话判成夸奖，比反过来严重得多。
  { re: /你(真|好|太)?(是)?(个)?(烦|讨厌|恶心|垃圾|蠢|傻|笨)|滚(开|蛋)|闭嘴|废物|没用|去死|蠢货|傻逼|智障/i, kind: "insult", strength: 0.85 },
  { re: /(胡说|乱说|瞎说|放屁|扯淡)|(根本|完全)(不对|错)/, kind: "criticism", strength: 0.7 },
  { re: /(你|这个)(做|弄|搞)(错|砸)了|(又|怎么又)(错|失败)了/, kind: "criticism", strength: 0.6 },
  { re: /不理你|不想理|别(跟我|和我)说|懒得(理|说)/, kind: "ignore", strength: 0.7 },
  { re: /(好|真|太)?(无聊|没意思|没劲)/, kind: "boring", strength: 0.6 },
  { re: /失败|报错|崩了|挂了|炸了|又不行/, kind: "task_fail", strength: 0.55 },

  // ---------- 强正向 ----------
  { re: /(谢谢|多谢|感谢|thx|thanks)|(帮了我|帮大忙)/i, kind: "praise", strength: 0.7 },
  // 注意：这里**不能**写成 /(你|做得)(真|好|棒...)/ ——
  // "你真" 会先匹配到 "你真是个蠢货"，把骂人的话判成夸奖（实测踩到）。
  // 必须要求正向词紧跟其后。
  { re: /(你|做得)(真|好|棒|厉害|不错)(?!.*(蠢|傻|笨|烦|恶心))|厉害(啊|呀)?$|优秀|牛(啊|呀|逼)/, kind: "praise", strength: 0.8 },
  { re: /对不起|抱歉|不好意思|是我(的)?错/, kind: "apology", strength: 0.75 },
  { re: /(别|不要)(难过|伤心|生气|自责)|(没关系|没事的)|(哄|安慰)(你|一下)/, kind: "comfort", strength: 0.8 },
  { re: /辛苦了|累了吧|休息(一下)?吧|注意身体|照顾好自己/, kind: "care", strength: 0.7 },
  { re: /(有意思|有趣|好玩|好奇|想了解)|为什么(会|是)/, kind: "interesting", strength: 0.6 },
  { re: /(成功|跑通了|通过了|搞定了|完成了|解决了)/, kind: "task_done", strength: 0.65 },
];

/** 强负向与正向后都会"放大"的标志词（加强语气）。 */
const INTENSIFIERS = /(非常|特别|真的|极其|太|超级|巨|贼)/;

/**
 * 规则版判定：返回 `{ kind, strength, reason }`。
 *
 * 判定不出来时返回 `neutral` 且 strength=0 —— **宁可不判定**。
 */
export function judgeByRules(text) {
  const s = String(text || "");
  if (s.length === 0) return { kind: "neutral", strength: 0, reason: "空文本" };

  for (const rule of RULES) {
    const m = s.match(rule.re);
    if (!m) continue;
    // 命中标志词时轻微加强（上限 1.0）
    const boost = INTENSIFIERS.test(s) ? 0.15 : 0;
    return {
      kind: rule.kind,
      strength: Math.min(1, rule.strength + boost),
      reason: "规则命中「" + m[0].slice(0, 12) + "」",
    };
  }
  return { kind: "neutral", strength: 0, reason: "无规则命中" };
}

/**
 * 判定入口：优先 LLM，失败或未配置则用规则。
 *
 * @param text 用户这句话
 * @param opts { llmJudger?, signal? }
 *   `llmJudger` 是一个 `async (text, signal) => {kind, strength} | null` 的函数，
 *   由 index.js 注入（它要拿 ctx.llm，属于宿主依赖，不放在纯逻辑文件里）。
 *
 * ## 为什么 LLM 的结论也要校验
 *
 * LLM 可能返回 `kind: "unknown_event"` 或超大 strength。
 * 这里统一夹一遍：未知 kind 视为 neutral（不猜），strength 夹到 0~1。
 */
export async function judgeEvent(text, opts = {}) {
  const s = String(text || "");

  if (typeof opts.llmJudger === "function") {
    try {
      const r = await opts.llmJudger(s, opts.signal);
      if (r && typeof r === "object") {
        const kind = EVENT_KINDS.includes(r.kind) ? r.kind : "neutral";
        const strength = Number(r.strength);
        return {
          kind,
          strength: kind === "neutral" ? 0 : Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0.5)),
          reason: "LLM 判定" + (r.reason ? "：" + String(r.reason).slice(0, 40) : ""),
          source: "llm",
        };
      }
      // LLM 返回空 → 回退规则
    } catch {
      // LLM 失败 → 静默回退规则（不能因为判定失败就丢了心情系统）
    }
  }

  const r = judgeByRules(s);
  return { ...r, source: "rule" };
}

/** 构造给 LLM 的判定提示词（与 llm-scorer 的风格一致）。 */
export function buildJudgePrompt(text) {
  return [
    "判断下面这句用户的话，对这个 AI 角色来说是哪一类事件。",
    "",
    "可选类型（只能选一个）：",
    EVENT_KINDS.filter((k) => k !== "neutral").map((k) => "- " + k).join("\n"),
    "- neutral（不属于以上任何一类）",
    "",
    "只输出一个 JSON 对象，不要代码块、不要解释：",
    '{"kind":"事件类型","strength":0到1的小数,"reason":"不超过20字的理由"}',
    "",
    "用户的话：",
    "<<<",
    String(text || "").slice(0, 500),
    ">>>",
  ].join("\n");
}
