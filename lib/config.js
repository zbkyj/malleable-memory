// 配置 Schema（2026-10-25）
//
// ## 为什么需要它
//
// 插件做记忆捕获与心情判定，配置项有 20 多个。没有 schema 时全靠运行时宽松读取：
//   - 字段名拼错（`budget` 写成 `budgets`）→ 静默用默认值
//   - 类型错（`budgets: "abc"`）→ 静默用默认值
//   - 值越界（负数预算）→ 预算变成负数，注入为空
// 用户会以为改配置生效了，实际什么都没变。这是最难排查的一类问题。
//
// ## 为什么必须用 schemastery（2026-10-25 血的教训）
//
// 第一版我"聪明"地改成了纯 JSON Schema（普通对象），理由是"零依赖"。
// 结果**整个插件加载失败**，记忆功能全线消失，报错只表现为
// 面板 405、工具全部不见。
//
// 根因：宿主把 `Config` 当作 **schemastery 可调用函数**来用。
// 对照两个工作正常的插件：
//   dsh-zhihu-search  → typeof Config === "function"，调用返回 object
//   dsh-context       → 同上
// 我导出的是 `typeof === "object"`，宿主一调用就抛
// `TypeError: Config is not a function`，于是把整个插件条目判为
// `status: "unsupported"` 并**静默跳过加载**。
//
// 所以：**Config 必须是 schemastery 实例，不能是普通对象。**
//
// ## 关于 schemastery 的解析（也踩过）
//
// `@deepseek-ai/schemastery` 由宿主提供（在 profile 的 node_modules 里），
// 是标准 peerDependency，与 dsh-zhihu-search 等插件的做法一致。
//
// ⚠️ **源码开发时用符号链接安装会解析失败**：
// 插件以 symlink 指向源码目录时，Node 还原真实路径后从源码目录向上
// 找不到 profile 的 node_modules，报 ERR_MODULE_NOT_FOUND。
// 用 npm 实体安装则正常。
//
// 因此下面用**动态 import + 兜底**：拿不到 schemastery 时降级成
// 一个"可被调用、返回默认值"的极简替身 —— 保证插件**永远不会因为
// Config 而加载失败**。这是刻意的取舍：宁可少一层配置校验，
// 也不能让整个记忆功能消失。

/**
 * 极简 schemastery 替身。
 *
 * 只在 `@deepseek-ai/schemastery` 解析失败时使用（符号链接开发场景）。
 * 它必须满足宿主的最低期望：**是个函数，返回对象**。
 *
 * 它不做任何校验 —— 校验会在 `apply()` 里用我们自己的字段检查补上
 * （见 index.js 的 budgets 校验与配置自检告警）。
 */
function makeFallbackSchema(defaults) {
  const schema = (input) => ({ ...defaults, ...(input && typeof input === "object" ? input : {}) });
  // schemastery 实例上常用的几个方法给它一个无害实现，避免宿主探测时报错
  schema.meta = () => schema;
  schema.description = () => schema;
  schema.default = () => schema;
  schema.toJSON = () => ({ type: "object", properties: {} });
  return schema;
}

/**
 * 尝试加载真正的 schemastery；失败则返回 null（不抛错）。
 *
 * 用 `createRequire` 而不是顶层 `import`：
 * 顶层 import 失败会让**整个模块加载失败**，那正是我们要避免的。
 */
async function loadSchemastery() {
  try {
    const mod = await import("@deepseek-ai/schemastery");
    const z = mod && (mod.default || mod);
    return typeof z === "function" && typeof z.object === "function" ? z : null;
  } catch {
    return null;
  }
}

/** 默认值表。替身与真 schema 共用同一份，避免两处漂移。 */
const DEFAULTS = {
  dbPath: "",
  capture: true,
  budgets: { perm: 700, hot: 900, cold: 400 },
  hotCapacity: 200,
  migration: true,
  migrateIntervalMs: 1800000,
  persona: true,
  personaMode: "full",
  personaPreset: "dafeiyu",
  personaShowMood: true,
  moodJudge: "rule",
  moodJudgeTimeoutMs: 8000,
  llmScoring: false,
  llmProvider: "",
  llmModel: "",
  llmTimeoutMs: 12000,
  panel: true,
  embedding: true,
  embeddingDim: 256,
  embeddingExternal: "",
  embeddingUseHashFallback: true,
};

/** 用真 schemastery 构建完整 schema。 */
function buildSchemastery(z) {
  const posInt = (def, max, desc) =>
    z.natural().min(1).max(max).default(def).description(desc);

  return z.object({
    // ---------------- 记忆 ----------------
    dbPath: z.string().default("").description(
      "记忆库路径。留空用默认位置（$DSH_HOME/memory/malleable-memory.db）"
    ),
    capture: z.boolean().default(true).description(
      "是否自动从对话捕获记忆。关闭后不再写入新记忆，但已有记忆、面板、人格仍工作"
    ),
    budgets: z
      .object({
        perm: posInt(700, 100000, "永久层 token 预算（估算值）"),
        hot: posInt(900, 100000, "加强层 token 预算（估算值）"),
        cold: posInt(400, 100000, "卸载层 token 预算（估算值）"),
      })
      .default({ perm: 700, hot: 900, cold: 400 })
      .description("三层注入预算（近似 token，按字符规则估算）"),
    hotCapacity: posInt(200, 100000, "加强层最大条数，超出时最弱的下沉"),
    migration: z.boolean().default(true).description("是否自动迁移（下沉 / 升温）"),
    migrateIntervalMs: posInt(1800000, 86400000, "迁移节流间隔（毫秒），默认 30 分钟"),

    // ---------------- 人格 ----------------
    persona: z.boolean().default(true).description('人格总开关。false 等价于 personaMode: "off"'),
    personaMode: z
      .union([z.const("full"), z.const("light"), z.const("off")])
      .default("full")
      .description("人设强度：full=完整 / light=工作优先（不含心情）/ off=不注入"),
    personaPreset: z
      .string()
      .default("dafeiyu")
      .description("初始人格预设：dafeiyu / assistant-warm / assistant-sharp"),
    personaShowMood: z.boolean().default(true).description("是否把心情注入提示词"),

    // ---------------- 心情判定 ----------------
    moodJudge: z
      .union([z.const("rule"), z.const("llm"), z.const(false)])
      .default("rule")
      .description(
        "心情事件判定：rule=规则版（零成本）/ llm=规则兜底+LLM（需配 llmProvider 与 llmModel）/ false=不判定"
      ),
    moodJudgeTimeoutMs: posInt(8000, 120000, "LLM 心情判定超时（毫秒）"),

    // ---------------- LLM 记忆打分 ----------------
    llmScoring: z.boolean().default(false).description("是否用 LLM 给记忆候选打分"),
    llmProvider: z.string().default("").description("LLM 提供方，如 deepseek"),
    llmModel: z.string().default("").description("LLM 模型，如 deepseek-chat"),
    llmTimeoutMs: posInt(12000, 120000, "LLM 打分超时（毫秒）"),

    // ---------------- 面板 ----------------
    panel: z.boolean().default(true).description(
      "是否注册面板数据路由（只接受本机回环请求，但这不是身份认证）"
    ),

    // ---------------- 向量检索 ----------------
    embedding: z.boolean().default(true).description("是否启用向量检索（内置 hash 版）"),
    embeddingDim: posInt(256, 4096, "hash 向量维度，默认 256"),
    embeddingExternal: z.string().default("").description(
      "外部向量 provider。这是代码集成接口而非 YAML 字符串，一般用户请留空"
    ),
    embeddingUseHashFallback: z.boolean().default(true).description("外部 provider 失败时回落 hash"),
  });
}

const z = await loadSchemastery();
export const SCHEMA_IS_REAL = z !== null;

/**
 * 导出的 Config。
 *
 * - 正常（npm 实体安装）→ 真 schemastery，宿主可校验
 * - 特殊（符号链接开发）→ 可调用的替身，保证插件仍能加载
 */
export const Config = z ? buildSchemastery(z) : makeFallbackSchema(DEFAULTS);

export { DEFAULTS };
export default Config;
