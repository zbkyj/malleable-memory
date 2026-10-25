// 配置 Schema（2026-10-25，GPT 审核发现的一项 P1）
//
// ## 为什么需要这个文件
//
// 原先插件只导出 `apply(ctx, config)`，没有 `Config`。
// 于是全部配置项靠运行时宽松读取：
//
//   - 字段名拼错（`budget` 写成 `budgets`）→ 静默用默认值
//   - 类型错（`budgets: "abc"`）→ 静默用默认值
//   - 值越界（负数预算）→ 预算变成负数，注入为空
//
// 用户会以为改配置生效了，实际什么都没变。**这是最难排查的一类问题。**
//
// ## 为什么是「手写 JSON Schema」而不是 schemastery
//
// 第一版用了 `@deepseek-ai/schemastery`（dsh-ui-tweaks 等插件用它）。
// **实测失败**：本插件以**符号链接**形式装在 profile 的 node_modules 下，
// 而 Node 解析符号链接时会把模块路径还原成**真实源码目录**，
// 于是从真实目录向上找不到 `@deepseek-ai/schemastery`
// （它只在 profile 的 node_modules 里）。
//
//   ✗ Cannot find package '@deepseek-ai/schemastery' imported from
//     E:\...\03_工作过程\src\dsh-malleable-memory\lib\config.js
//
// 也就是说：用 schemastery 会让**开发环境（符号链接安装）直接加载失败**。
// 而这里恰恰是本项目自己的开发方式 —— 不能用。
//
// 改用纯数据 JSON Schema：
//   - 零依赖，任何环境都能加载
//   - Cordis loader 的 `Config` 接受 JSON Schema 形状
//   - 校验能力略弱于 schemastery（没有 transform），但足以挡住拼写与类型错误
//
// ## 设计原则
//
// **严格校验"会静默出错"的字段，宽松对待"错了也无所谓"的字段。**
//   - budgets / hotCapacity / timeout 必须正整数（负数会导致注入为空且无提示）→ 严格
//   - dbPath 只要求字符串（错路径会自己报错暴露）→ 宽松
//   - 布尔开关错了就是开/关，无静默风险 → 宽松

/** 正整数 schema 的复用片段。 */
const positiveInt = (def, max, description) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  default: def,
  description,
});

export const Config = {
  type: "object",
  additionalProperties: false,
  properties: {
    // ---------------- 记忆 ----------------
    dbPath: {
      type: "string",
      default: "",
      description:
        "记忆库路径。留空用默认位置（$DSH_HOME/memory/malleable-memory.db；" +
        "若同目录已有旧版 memory.db 且新文件不存在，会沿用旧文件以保留已有记忆）",
    },
    capture: {
      type: "boolean",
      default: true,
      description:
        "是否自动从对话捕获记忆。关闭后不再写入新记忆，但已有记忆、面板、人格仍然工作",
    },
    budgets: {
      type: "object",
      additionalProperties: false,
      default: { perm: 700, hot: 900, cold: 400 },
      description: "三层注入预算（近似 token，按字符规则估算）",
      properties: {
        perm: positiveInt(700, 100000, "永久层预算"),
        hot: positiveInt(900, 100000, "加强层预算"),
        cold: positiveInt(400, 100000, "卸载层预算"),
      },
    },
    hotCapacity: positiveInt(200, 100000, "加强层最大条数，超出时最弱的下沉"),
    migration: {
      type: "boolean",
      default: true,
      description: "是否自动迁移（下沉 / 升温）",
    },
    migrateIntervalMs: positiveInt(1800000, 86400000, "迁移节流间隔（毫秒），默认 30 分钟"),

    // ---------------- 人格 ----------------
    persona: {
      type: "boolean",
      default: true,
      description: '人格总开关。false 等价于 personaMode: "off"',
    },
    personaMode: {
      type: "string",
      enum: ["full", "light", "off"],
      default: "full",
      description: "人设强度：full=完整人设+心情 / light=工作优先（不含心情，篇幅约 1/3）/ off=不注入",
    },
    personaPreset: {
      type: "string",
      default: "dafeiyu",
      description: "初始人格预设：dafeiyu / assistant-warm / assistant-sharp",
    },
    personaShowMood: {
      type: "boolean",
      default: true,
      description: "是否把当前心情注入提示词（light 档不注入）",
    },

    // ---------------- 心情判定 ----------------
    moodJudge: {
      type: ["string", "boolean"],
      enum: ["rule", "llm", false],
      default: "rule",
      description:
        "心情事件判定：rule=规则版（零成本，默认）/ llm=规则兜底+LLM（需配 llmProvider 与 llmModel）/ false=不判定，只随时间衰减",
    },
    moodJudgeTimeoutMs: positiveInt(8000, 120000, "LLM 心情判定超时（毫秒）"),

    // ---------------- LLM 记忆打分 ----------------
    llmScoring: {
      type: "boolean",
      default: false,
      description: "是否用 LLM 给记忆候选打分。默认关（有成本与延迟）",
    },
    llmProvider: { type: "string", default: "", description: "LLM 提供方，如 deepseek" },
    llmModel: { type: "string", default: "", description: "LLM 模型，如 deepseek-chat" },
    llmTimeoutMs: positiveInt(12000, 120000, "LLM 打分超时（毫秒）"),

    // ---------------- 面板 ----------------
    panel: {
      type: "boolean",
      default: true,
      description: "是否注册面板数据路由。路由只接受本机回环请求，但这不是身份认证",
    },

    // ---------------- 向量检索 ----------------
    embedding: {
      type: "boolean",
      default: true,
      description: "是否启用向量检索（默认内置 hash 版，无需外部服务）",
    },
    embeddingDim: positiveInt(256, 4096, "hash 向量维度，默认 256"),
    embeddingExternal: {
      type: "string",
      default: "",
      description:
        "外部向量 provider。这是**代码集成接口而非 YAML 字符串**：实现要求函数或 {embed} 对象，" +
        "通过 patch 只能填字符串，所以一般用户请留空使用内置 hash 版",
    },
    embeddingUseHashFallback: {
      type: "boolean",
      default: true,
      description: "外部 provider 失败时是否回落内置 hash 版",
    },
  },
};

export default Config;
