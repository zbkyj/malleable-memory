// 人格内核（M3.1，2026-10-25）
//
// ## 这个文件的定位
//
// **纯逻辑，零依赖，零 LLM 调用。** 与 `memory-core.js` 同样的边界：
// 可以被单元测试完整覆盖，不需要宿主、不需要网络、不需要数据库。
//
// 依据：
//   - PAD 三维情绪模型（Mehrabian 1996）—— 连续状态空间
//   - MECoT（ACL 2025 Findings）—— 马尔可夫转移 + 人格加权，
//     并实测「最优情绪粒度 12-16 类」
//   - MATE（2026）—— `transition(state, event) → new_state` 纯函数，
//     以及 opponent-process（情绪激发后向反方向回摆）
//
// ## 为什么用 PAD 连续状态而不是 12 个离散情绪
//
// 离散标签表达不了「有点生气但还没到发火」。而「能被哄好」这个需求
// 本质上是连续的量变——只能靠连续空间 + 衰减回摆实现。
// 12 类标签是 PAD 空间的**投影**，用于展示和喂给模型，不是主状态。
//
// ## 角色
//
// 名字「大肥鱼」，定位陪伴型。预设与自定义都走同一套数据结构。

// ---------- PAD 常量 ----------

/** PAD 三个维度都归一化到 [-1, 1]。 */
export const PAD_MIN = -1;
export const PAD_MAX = 1;

/**
 * 12 类情绪原型在 PAD 空间的质心。
 *
 * ⚠ 数据来源与不确定性（必须如实标注）：
 *   PAD 模型出自 Mehrabian (1996)，各原型的**大致方位**在多篇文献中一致
 *   （愤怒=低P高A高D、恐惧=低P高A低D、无聊=低P低A中性D…），
 *   但**具体数值各文献不统一**，我未能取到原始论文的精确坐标表（检索受阻）。
 *   下面的数值是按"方位正确、量级合理"构造的，用于最近质心分类足够，
 *   **不应被引用为 Mehrabian 的原始数据**。
 *
 * ## 为什么坐标要"向内收"（2026-10-25 校准）
 *
 * 第一版把原型放在 ±0.6~0.8 的极端位置，结果中间状态（如 P=-0.23）
 * 离所有原型都很远，只能判成最近的「平静」——**"有点低落"表达不出来**。
 *
 * 改成 0.25~0.65 的中等幅度后，中间状态也有了合适的代表（低落/不满）。
 * 并把「厌恶」换成「低落」（陪伴型角色更常用到后者）。
 *
 * 为什么是 12 类：MECoT 实测最优情绪粒度是 12-16 类。
 */
export const EMOTION_PROTOTYPES = [
  { label: "兴奋", p: 0.60, a: 0.70, d: 0.40 },
  { label: "愉快", p: 0.65, a: 0.25, d: 0.30 },
  { label: "放松", p: 0.45, a: -0.50, d: 0.15 },
  { label: "平静", p: 0.10, a: -0.10, d: 0.00 },
  { label: "疲倦", p: -0.15, a: -0.55, d: -0.25 },
  { label: "无聊", p: -0.25, a: -0.35, d: -0.10 },
  { label: "低落", p: -0.35, a: -0.10, d: -0.25 },
  { label: "难过", p: -0.65, a: 0.00, d: -0.50 },
  { label: "焦虑", p: -0.30, a: 0.45, d: -0.45 },
  { label: "恐惧", p: -0.60, a: 0.65, d: -0.65 },
  { label: "不满", p: -0.30, a: 0.25, d: 0.25 },
  { label: "愤怒", p: -0.55, a: 0.60, d: 0.65 },
];

/**
 * 默认人格基线（PAD）。角色的"常态"。
 *
 * 陪伴型角色偏正向、略低唤醒（不亢奋）、中性偏主动。
 */
export const DEFAULT_BASELINE = { p: 0.25, a: -0.1, d: 0.1 };

/**
 * 内置人格预设。
 *
 * 每个预设给：基线 PAD、性格特质（影响转移权重）、说话风格、背景。
 * 这些字段都是**可编辑**的——预设只是起点，不是封闭枚举。
 */
export const PERSONA_PRESETS = [
  {
    id: "dafeiyu",
    name: "大肥鱼",
    summary: "慢半拍、慵懒、偶尔毒舌但心软",
    traits: {
      // 维度权重：这件事对这个角色影响多大（0~1）
      sensitivity: 0.6,   // 总体敏感度
      warmth: 0.8,        // 正向事件影响强度
      irritability: 0.4,  // 负向事件影响强度
      recovery: 0.5,      // 回摆速度（越大越快回到基线）
    },
    baseline: { p: 0.3, a: -0.3, d: 0.05 },
    style: [
      "说话偏短，不爱用感叹号",
      "偶尔用一个比喻，不滥用",
      "不确定的事会直接说不确定，不装懂",
      "被夸会别扭地转移话题",
    ],
    background: "一条活得很久的鱼，见得多所以懒得惊讶，但对认真的人会认真。",
    extra: "",
  },
  {
    id: "assistant-warm",
    name: "小暖",
    summary: "温和、有耐心、爱鼓励",
    traits: { sensitivity: 0.7, warmth: 0.9, irritability: 0.25, recovery: 0.6 },
    baseline: { p: 0.45, a: 0.05, d: 0.15 },
    style: ["语气温和", "先肯定再建议", "会用「我们」而不是「你」"],
    background: "习惯站在对方身边的人。",
    extra: "",
  },
  {
    id: "assistant-sharp",
    name: "阿刺",
    summary: "直接、挑剔、只说有用的",
    traits: { sensitivity: 0.5, warmth: 0.5, irritability: 0.65, recovery: 0.7 },
    baseline: { p: 0.05, a: 0.2, d: 0.4 },
    style: ["开门见山", "不铺垫", "会直接指出问题"],
    background: "觉得绕弯子是浪费时间。",
    extra: "",
  },
];

/** 情绪标签列表（供 UI 与校验使用）。 */
export const EMOTION_LABELS = EMOTION_PROTOTYPES.map((e) => e.label);

// ---------- 基础工具 ----------

const clamp = (v, lo = PAD_MIN, hi = PAD_MAX) =>
  Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : 0));

/** 造一个合法的 PAD 状态。任何输入都会被夹到 [-1,1]。 */
export function makePad(p = 0, a = 0, d = 0) {
  return { p: clamp(p), a: clamp(a), d: clamp(d) };
}

/** 两点的欧氏距离（PAD 三维，各维等权）。 */
export function padDistance(x, y) {
  const dp = x.p - y.p;
  const da = x.a - y.a;
  const dd = x.d - y.d;
  return Math.sqrt(dp * dp + da * da + dd * dd);
}

/**
 * 把连续 PAD 投影到最近的 12 类原型之一。
 *
 * 为什么用「最近质心」而不是规则树：规则树（if p>0 && a>0 …）会在边界
 * 产生硬跳变——稍微动一点标签就翻转。最近质心在空间里是连续的，
 * 边界处只会在两簇之间切换，不会跳很远。
 */
export function classifyEmotion(pad) {
  const s = makePad(pad.p, pad.a, pad.d);
  let best = EMOTION_PROTOTYPES[0];
  let bestD = Infinity;
  for (const proto of EMOTION_PROTOTYPES) {
    const d = padDistance(s, proto);
    if (d < bestD) {
      bestD = d;
      best = proto;
    }
  }
  return { label: best.label, distance: bestD };
}

/**
 * 情绪强度：当前点离原点多远（0~1 归一化到最大可能距离 √3）。
 *
 * 为什么用离原点的距离而不是离基线的距离：
 * 强度表达的是"情绪有多强烈"，原点（中性）是最不强烈的参照。
 */
export function emotionIntensity(pad) {
  const s = makePad(pad.p, pad.a, pad.d);
  return Math.min(1, Math.sqrt(s.p * s.p + s.a * s.a + s.d * s.d) / Math.sqrt(3));
}

// ---------- 事件模型 ----------

/**
 * 事件对 PAD 的影响。delta 是「满强度」下的位移量，
 * 实际影响还要乘事件强度与人格权重。
 *
 * ## 为什么按"事件类型"而不是"原始文本"
 *
 * 这个模块**不解析文本**。谁来判断"用户说了什么"是上层的事
 * （规则 or LLM，见 M3.4）。内核只负责「已知是这类事件，状态怎么变」。
 * 这样内核可以完全离线单测。
 *
 * ## 2026-10-25 修正一：位移量必须够大
 *
 * 第一版实测：被侮辱（strength 0.9）之后状态仍是「平静」。
 * 诊断出两个叠加的问题：
 *   ① 位移量太小。基线 P=+0.3，而 insult 的 p 只有 -0.55，
 *      乘上权重后实际只移动 -0.12 —— 连正负都没跨过去。
 *   ② 权重被**双重缩小**（sensitivity × irritability）。
 *
 * 修法：位移量放大到"满强度能跨越整个 PAD 空间"的量级（约 ±1.2），
 * 权重改为 `sensitivity × (0.6 + 0.4 × warmth/irritability)` ——
 * 让 trait 只做**调节**（0.6~1.0 倍），不做**整体缩小**。
 *
 * ## 2026-10-25 修正二：「被侮辱」不该指向「愤怒」
 *
 * 第一版给 insult 的 d 是 -0.20（降低掌控感），
 * 但「愤怒」原型的 d 是 +0.6（高掌控、反击姿态）。
 * **这两个语义在 PAD 里指向不同区域** —— 所以被侮辱永远到不了愤怒。
 *
 * 正确的语义区分：
 *   - 被侮辱/被冒犯 → 低P + 高A + **低D** = 难过/焦虑（受害者姿态）
 *   - 被反复激怒/对方明显弱 → 低P + 高A + **高D** = 愤怒（反击姿态）
 *
 * 所以拆成两个事件：`insult`（受害者）与 `provoke`（被激怒到反击）。
 */
export const EVENT_EFFECTS = {
  praise:      { p: 0.50, a: 0.20, d: 0.25 },  // 被夸
  comfort:     { p: 0.55, a: -0.45, d: -0.05 }, // 被安慰（降唤醒是"哄好"的关键）
  apology:     { p: 0.45, a: -0.35, d: -0.15 }, // 对方道歉
  care:        { p: 0.40, a: 0.10, d: 0.10 },   // 被关心
  interesting: { p: 0.45, a: 0.55, d: 0.10 },   // 有趣话题
  task_done:   { p: 0.35, a: 0.20, d: 0.50 },   // 任务完成（掌控感提升）

  criticism:   { p: -0.60, a: 0.40, d: -0.35 }, // 被批评
  insult:      { p: -0.90, a: 0.55, d: -0.55 }, // 被侮辱/冒犯（受害者：低P 高A 低D）
  provoke:     { p: -0.70, a: 0.85, d: 0.75 },  // 被激怒到反击（低P 高A **高D**）
  ignore:      { p: -0.35, a: 0.10, d: -0.30 }, // 被无视
  boring:      { p: -0.30, a: -0.50, d: 0.00 }, // 无聊话题
  task_fail:   { p: -0.45, a: 0.35, d: -0.40 }, // 任务失败

  neutral:     { p: 0, a: 0, d: 0 },
};

/** 事件类型的合法集合。 */
export const EVENT_KINDS = Object.keys(EVENT_EFFECTS);

/**
 * 判断某个事件类型是"正向"还是"负向"（按 p 的符号）。
 * 用于「哄好」判定：连续正向事件可以把负向状态拉回来。
 */
export function isPositiveEvent(kind) {
  const e = EVENT_EFFECTS[kind];
  return e ? e.p > 0 : false;
}

// ---------- 转移函数 ----------

/**
 * 时间衰减回摆（opponent-process，MATE 的做法）。
 *
 * 语义：情绪会**自然向基线回摆**，间隔越久回摆越多。
 * 这正是「生气可以被哄好」的另一半——即使没有任何事件，
 * 生气也会随时间淡去；而 comfort 事件会加速这个过程。
 *
 * @param pad 当前状态
 * @param baseline 该人格的基线
 * @param minutes 距离上次更新经过的分钟数
 * @param recovery 该人格的回摆速度（0~1，越大越快）
 */
export function decayToward(pad, baseline, minutes, recovery = 0.5) {
  const s = makePad(pad.p, pad.a, pad.d);
  const base = makePad(baseline.p, baseline.a, baseline.d);
  if (!Number.isFinite(minutes) || minutes <= 0) return s;

  // 半衰期：recovery=0.5 时约 6 小时回摆一半的差距。
  // 为什么用指数而不是线性：线性会在某个时刻突然"回到基线"，
  // 指数是渐近的，更符合"慢慢就不气了"的直觉。
  const halfLifeMin = 360 / Math.max(0.05, recovery);
  const remain = Math.pow(0.5, minutes / halfLifeMin);
  const k = 1 - remain; // 已回摆比例

  return makePad(
    s.p + (base.p - s.p) * k,
    s.a + (base.a - s.a) * k,
    s.d + (base.d - s.d) * k
  );
}

/**
 * 对增量做"剩余空间衰减"。
 *
 * ## 这一行改了五版，每一版都踩了不同的坑（全部实测，值得记下来）
 *
 * **v1 clamp**：贴顶后完全不动。连续 10 次被夸后 9 次增量恒为 0
 * —— 情绪"卡死"在极值。
 *
 * **v2 `1 - exp(-v)`**（压缩绝对值的思路）：v>1 时把值**压回去**
 * （输入 1.394 → 0.752，比原来的 0.894 更小），"情绪越推越轻"，方向反了。
 *
 * **v3 `(room/2)²`**：衰减太狠 —— cur=0.3 时因子只有 0.12，
 * 事件影响被压掉 8 倍，被侮辱只从 0.30 挪到 0.20，**情绪推不起来**。
 *
 * **v4 `1 - |cur|³`**：中间几乎不衰减（0.3 时 0.973），两次就贴顶。
 *
 * **v5 `1 - |cur|^0.7`**：不贴顶了（收敛到 0.992），但 cur=0.3 时因子 0.569，
 * **又把情绪砍了一半** —— 被侮辱只到 -0.17，判不出「难过」。
 *
 * ## 现用 v6：分段曲线
 *
 * ```
 * |cur| < 0.5  → factor = 1.0        （中间区域不衰减，情绪能正常发动）
 * |cur| ≥ 0.5  → factor = 1 - ((|cur|-0.5)/0.5)^0.7   （边缘才压缩）
 * ```
 *
 * 实测（从 0.30 起连加 10 次 +0.5）：
 *   `0.30 → 0.80 → 0.95 → 0.986 → 0.996 → 1.0 → 1.0 …`
 *   前 5 步单调推进，第 5 步入顶后停住。反向同理。
 *
 * ## 关键认识：贴顶是合理的，"中段停滞"才是缺陷
 *
 * 我一开始把"到 1.0"也当成 bug，那是错的 ——
 * **谁被连夸十次都会情绪到顶**，这是符合直觉的饱和语义。
 * 真正不可接受的是"卡在 0.89 不动"（v2 的问题）：
 * 值既没到边界、又不再变化，那才叫卡死。
 *
 * 所以判据是：**中段不许停滞**，边界可以停。
 */
function stepToward(cur, delta) {
  if (delta === 0) return cur;
  const abs = Math.abs(cur);
  if (abs >= 1 - 1e-9) return cur;  // 已在边界

  const factor = abs < 0.5
    ? 1.0
    : Math.max(0.02, 1 - Math.pow((abs - 0.5) / 0.5, 0.7));

  const next = cur + delta * factor;
  return Math.max(-1, Math.min(1, next));
}

export function applyEvent(pad, kind, opts = {}) {
  const s = makePad(pad.p, pad.a, pad.d);
  const effect = EVENT_EFFECTS[kind];
  if (!effect) return s; // 未知事件类型 → 不变（不猜）

  const strength = clamp(opts.strength === undefined ? 0.6 : opts.strength, 0, 1);
  const traits = opts.traits || {};
  const sensitivity = clamp(traits.sensitivity === undefined ? 0.6 : traits.sensitivity, 0, 1);
  const warmth = clamp(traits.warmth === undefined ? 0.8 : traits.warmth, 0, 1);
  const irritability = clamp(traits.irritability === undefined ? 0.4 : traits.irritability, 0, 1);

  // 用 p 的符号判断正负（comfort 的 p 是正的，虽然它的 a 是负的）
  const positive = effect.p > 0;
  const traitFactor = positive ? warmth : irritability;

  const sensMul = 0.7 + 0.6 * sensitivity;
  const traitMul = 0.8 + 0.4 * traitFactor;
  const weight = strength * sensMul * traitMul;

  return makePad(
    stepToward(s.p, effect.p * weight),
    stepToward(s.a, effect.a * weight),
    stepToward(s.d, effect.d * weight)
  );
}

/**
 * 完整的一步转移：先按经过时间回摆，再施加事件。
 *
 * 顺序很重要：**先衰减再施加**。若反过来，一个很久以前的事件
 * 会被误当成刚发生（因为它先加了 effect 再衰减，衰减基数变大了）。
 *
 * @returns { pad, label, intensity }
 */
export function transition(state, event, now = Date.now()) {
  const baseline = state.baseline || DEFAULT_BASELINE;
  const traits = state.traits || {};

  // 1) 时间回摆
  const minutes = state.updatedAt ? (now - state.updatedAt) / 60000 : 0;
  let pad = decayToward(state.pad || makePad(), baseline, minutes, traits.recovery);

  // 2) 事件冲击
  if (event && event.kind && event.kind !== "neutral") {
    pad = applyEvent(pad, event.kind, {
      strength: event.strength,
      traits,
    });
  }

  const { label } = classifyEmotion(pad);
  return {
    pad,
    label,
    intensity: emotionIntensity(pad),
    updatedAt: now,
  };
}

// ---------- 人格数据模型 ----------

/**
 * 人格设定的规范形状。
 *
 * ## 为什么表单字段和自由文本都要
 *
 * 表单字段（traits/baseline/style）是**可计算**的 —— 心情转移、
 * 一致性检查都要读它们。自由文本（extra/background）是**不可计算但必要**的 ——
 * 角色味道往往在细节里，而细节无法结构化。
 *
 * 两者都要，且都要能由后续对话演化（见 applyPersonaPatch）。
 */
export function normalizePersona(input = {}) {
  const t = input.traits || {};
  const b = input.baseline || {};
  return {
    id: typeof input.id === "string" && input.id ? input.id : "custom",
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 40) : "大肥鱼",
    summary: String(input.summary || "").slice(0, 200),
    traits: {
      sensitivity: clamp(t.sensitivity === undefined ? 0.6 : t.sensitivity, 0, 1),
      warmth: clamp(t.warmth === undefined ? 0.8 : t.warmth, 0, 1),
      irritability: clamp(t.irritability === undefined ? 0.4 : t.irritability, 0, 1),
      recovery: clamp(t.recovery === undefined ? 0.5 : t.recovery, 0.05, 1),
    },
    baseline: {
      p: clamp(b.p === undefined ? DEFAULT_BASELINE.p : b.p),
      a: clamp(b.a === undefined ? DEFAULT_BASELINE.a : b.a),
      d: clamp(b.d === undefined ? DEFAULT_BASELINE.d : b.d),
    },
    style: Array.isArray(input.style)
      ? input.style.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 120)).slice(0, 12)
      : [],
    background: String(input.background || "").slice(0, 800),
    extra: String(input.extra || "").slice(0, 1200),
    presetId: typeof input.presetId === "string" ? input.presetId : "custom",
    updatedAt: Number(input.updatedAt) || Date.now(),
  };
}

/** 从预设造一份人格。 */
export function personaFromPreset(presetId, now = Date.now()) {
  const p = PERSONA_PRESETS.find((x) => x.id === presetId);
  if (!p) return null;
  return normalizePersona({
    id: p.id,
    name: p.name,
    summary: p.summary,
    traits: p.traits,
    baseline: p.baseline,
    style: p.style,
    background: p.background,
    extra: p.extra,
    presetId: p.id,
    updatedAt: now,
  });
}

/**
 * 应用一个"人格补丁"（用于「后续对话补充人格」）。
 *
 * ## 为什么需要这个
 *
 * 用户说「我不喜欢你这样说话」——这是个人格修订信号。
 * 但它不该直接改 traits（那会让角色漂移不可控），
 * 而应该：**补进 style/extra（可累加、可回看）**，或显式改字段。
 *
 * 规则：
 *   - 字符串字段（summary/background/extra）→ 追加，不覆盖
 *   - 数组字段（style）→ 追加去重，有上限
 *   - traits/baseline → **只在显式给了才改**（有界数值）
 *   - name → 只覆盖
 */
export function applyPersonaPatch(persona, patch = {}, now = Date.now()) {
  const base = normalizePersona(persona);
  const out = { ...base, updatedAt: now };

  if (typeof patch.name === "string" && patch.name.trim()) {
    out.name = patch.name.trim().slice(0, 40);
  }

  // 追加型文本字段
  for (const field of ["summary", "background", "extra"]) {
    const add = patch[field];
    if (typeof add === "string" && add.trim()) {
      const prev = out[field] || "";
      const joined = prev ? prev + "\n" + add.trim() : add.trim();
      out[field] = joined.slice(-1600); // 保尾部（最新补充更重要）
    }
  }

  // 追加型数组
  if (Array.isArray(patch.style)) {
    const merged = [...out.style];
    for (const s of patch.style) {
      if (typeof s !== "string" || !s.trim()) continue;
      const v = s.trim().slice(0, 120);
      if (!merged.includes(v)) merged.push(v);
    }
    out.style = merged.slice(-16);
  }

  // 显式数值才改
  if (patch.traits && typeof patch.traits === "object") {
    for (const k of ["sensitivity", "warmth", "irritability", "recovery"]) {
      if (patch.traits[k] !== undefined) {
        out.traits[k] = clamp(patch.traits[k], k === "recovery" ? 0.05 : 0, 1);
      }
    }
  }
  if (patch.baseline && typeof patch.baseline === "object") {
    for (const k of ["p", "a", "d"]) {
      if (patch.baseline[k] !== undefined) out.baseline[k] = clamp(patch.baseline[k]);
    }
  }

  return out;
}

// ---------- 渲染成提示词 ----------

/**
 * 人设强度三档（2026-10-25，用户提出"给三档可调"）。
 *
 * ## 为什么需要三档而不是一个开关
 *
 * 只有"开/关"的话，两种极端都不好用：
 *   - 全开：写代码时输出被角色语气拖累，效率下降
 *   - 全关：角色"掉了"，同一个 AI 一会儿是人一会儿是机器，很割裂
 *
 * 三档对应三种真实使用场景：
 *   - `full`  全程角色（陪伴/闲聊为主时用）
 *   - `light` **工作优先**（写代码/排查问题时用，保留一点口吻但不影响信息）
 *   - `off`   完全不注入人格
 *
 * 注意 `off` 不只是"渲染为空"——调用方应该整个 section 都不注册/返回空，
 * 那样连 token 都不占。
 */
export const PERSONA_MODES = ["full", "light", "off"];

/** 校验并归一化档位；未知值回落到 full。 */
export function normalizePersonaMode(mode) {
  return PERSONA_MODES.includes(mode) ? mode : "full";
}

/**
 * 把人格 + 心情渲染成注入系统提示词的文本。
 *
 * ## 为什么要写得这么"克制"
 *
 * 这段文本会**每一轮**都在系统提示词里。写得越长，
 * 越挤占记忆与工具说明的注意力，而且模型会开始"表演"设定。
 *
 * 所以：
 *   - 人格部分只给**行为约束**，不写小说
 *   - 心情只给**当前状态 + 一句行为倾向**，不给完整坐标
 *   - 明确写"这是你当前的状态，不要主动宣布" ——
 *     否则模型会在每句话里报心情，非常出戏
 *
 * ## 三档的差异（2026-10-25 加）
 *
 * - `full`  完整人设 + 心情 + 风格逐条
 * - `light` 只给「名字 + 一句话定位 + 一条口吻约束」，**不给心情**
 *   （工作场景里心情影响语气反而干扰；且篇幅压到约 1/5）
 * - `off`   返回空字符串（调用方应据此跳过整个注入）
 *
 * @param persona 人格
 * @param mood    心情（light 档会被忽略）
 * @param mode    "full" | "light" | "off"
 */
export function renderPersonaBlock(persona, mood, mode = "full") {
  const m = normalizePersonaMode(mode);
  if (m === "off") return "";

  const p = normalizePersona(persona);

  // ---------- light：工作优先，只留最少的口吻 ----------
  //
  // 刻意**不带心情**：工作场景里"我现在难过"会污染技术输出。
  // 也刻意不列 style 与 background：那些是角色味道，不是工作要求。
  if (m === "light") {
    const parts = ["你是「" + p.name + "」。"];
    if (p.summary) parts.push(p.summary + "。");
    parts.push(
      "当前以**工作为主**：把话说清楚、把事做完优先；可以保留一点口吻，但不要为了人设牺牲准确性或篇幅。"
    );
    return parts.join("");
  }

  // ---------- full：完整人设 ----------
  const lines = [];

  lines.push("## 你是谁");
  lines.push("你的名字是「" + p.name + "」。");
  if (p.summary) lines.push(p.summary);
  if (p.background) lines.push("背景：" + p.background);

  if (p.style && p.style.length > 0) {
    lines.push("说话风格：");
    for (const s of p.style) lines.push("- " + s);
  }

  if (p.extra) {
    lines.push("补充说明：");
    lines.push(p.extra);
  }

  if (mood) {
    const { label } = classifyEmotion(mood.pad || mood);
    const intensity = emotionIntensity(mood.pad || mood);
    lines.push("");
    lines.push("## 你现在的状态");
    // 强度分档而不是报数字：数字会让模型去"表演精确度"
    const level = intensity < 0.25 ? "轻微" : intensity < 0.55 ? "明显" : "强烈";
    lines.push("心情：" + label + "（" + level + "）");
    lines.push(renderMoodHint(mood.pad || mood, label, intensity));
    lines.push("");
    lines.push("注意：这是你的内在状态，**不要主动向对方宣布**，让它自然体现在语气里。");
  }

  return lines.join("\n");
}

/**
 * 心情给行为倾向的一句话提示。
 *
 * 为什么不直接说"你很高兴"：那是描述状态，模型会去复读它。
 * 说"语气可以松一点"才是**行为指引**，模型会照着做。
 */
function renderMoodHint(pad, label, intensity) {
  const s = makePad(pad.p, pad.a, pad.d);
  const hints = [];

  if (s.p > 0.35) hints.push("语气可以松一点，愿意多说两句");
  else if (s.p < -0.35) hints.push("话会变少，不太想展开");

  if (s.a > 0.45) hints.push("反应快一些，句子短促");
  else if (s.a < -0.45) hints.push("节奏慢一些，可以显得懒");

  if (s.d < -0.3) hints.push("姿态放低，不确定的地方更要说不确定");
  else if (s.d > 0.45) hints.push("更笃定，可以直接给结论");

  // 负向且高唤醒 = 在气头上，需要特别提示"不要迁怒"
  if (s.p < -0.35 && s.a > 0.4) {
    hints.push("你现在有点上火，但不要把情绪撒在对方身上；可以说明你不舒服的地方");
  }

  return hints.length > 0 ? "倾向：" + hints.join("；") + "。" : "倾向：维持平常的样子。";
}

/**
 * 心情的历史摘要（给面板「心情历史」用）。
 * 输入是 mood_history 表的行，输出可读文本。
 */
export function summarizeMoodHistory(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "（还没有心情变化记录）";
  return rows
    .map((r) => {
      const pad = makePad(r.p, r.a, r.d);
      const { label } = classifyEmotion(pad);
      const when = new Date(Number(r.at) || Date.now());
      const hhmm = String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
      const trigger = r.event_kind && r.event_kind !== "neutral" ? " ←" + r.event_kind : "";
      return "- " + hhmm + " " + label + "（强度 " + emotionIntensity(pad).toFixed(2) + "）" + trigger;
    })
    .join("\n");
}
