// Embedding 提供方接口（2026-10-24）
//
// ## 为什么要「提供方」这层抽象
//
// 取证结论（见 notes/Hook与MCP适用性判定_v01.md）：
//   - 宿主**没有** embedding 服务
//   - 本机 profile **没有**任何 embedding/向量包
//
// 所以不能假设有可用的模型。同时又要满足两个硬约束：
//   ① 默认关闭（不能让用户装个插件就被迫下载模型）
//   ② 零强制依赖（不能 import 一个没装的包）
//
// 解法：定义 provider 接口，内置一个零依赖的哈希实现做兜底，
// 真正需要语义能力时由用户配置一个外部 provider。
//
// ## 能力边界必须先说清楚（实测数据）
//
// `hashEmbedding` 是特征哈希，**不是神经网络 embedding**。
// 实测三组对照：
//
//   «部署改用 docker compose»  vs «部署改用 docker compose 编排»  → 0.913
//   «终端统一用 pwsh 7»        vs «pwsh 是终端方案»               → 0.400
//   «部署改用 docker»          vs «容器编排换成 compose»          → 0.000  ← 语义换词
//   «部署改用 docker»          vs «今天天气不错»                  → 0.000
//
// 注意最后两组**同分**：哈希嵌入完全无法区分「同义换词」和「毫不相干」。
//
// 所以它的定位是：比纯 `LIKE %关键词%` 好一点（有连续相似度、能排序、
// 能匹配部分重叠），但**不解决语义检索**。
// 想要语义能力必须配真模型 —— 这一点必须诚实标注，
// 否则下一个维护者会误以为"已经有 embedding 了"。

import { hashEmbedding, normalizeVector, cosineSimilarity, DEFAULT_EMBED_DIM } from "./vector.js";

/** 内置兜底 provider 的名字。 */
export const PROVIDER_HASH = "hash";
/** 表示「没有可用的外部模型」时的显式标记。 */
export const PROVIDER_NONE = "none";

/**
 * 内置哈希 provider。**同步**，零依赖，永远可用。
 *
 * ## 2026-10-25 修正（GPT 审核发现）
 *
 * 原先 `dim` 与 `embed()` 都硬编码 `DEFAULT_EMBED_DIM`，
 * 于是配置项 `embeddingDim` 对默认的 hash 模式**完全无效** ——
 * 用户改成 512 或 128，什么都不会变，也没有任何提示。
 *
 * 现在改成工厂函数：接受维度，返回对应的 provider。
 * `hashProvider` 保留为「默认维度」的那个实例，向后兼容。
 *
 * @param dim 向量维度，非法值回落到默认 256
 */
export function makeHashProvider(dim) {
  const n = Number(dim);
  const d = Number.isFinite(n) && n > 0 && n <= 4096 ? Math.floor(n) : DEFAULT_EMBED_DIM;
  return {
    name: PROVIDER_HASH,
    dim: d,
    /** 哈希嵌入声称的语义能力等级。用于日志与文档，也供测试断言。 */
    semantic: false,
    async embed(texts) {
      const arr = Array.isArray(texts) ? texts : [texts];
      return arr.map((t) => hashEmbedding(t, d));
    },
    /**
     * 同步版本。哈希嵌入本身就是同步的，提供这个入口
     * 可以让「写入记忆时顺手算向量」不需要 await（捕获路径上省一次挂起）。
     */
    embedSync(text) {
      return hashEmbedding(text, d);
    },
  };
}

/** 默认维度的 hash provider（向后兼容的导出）。 */
export const hashProvider = makeHashProvider(DEFAULT_EMBED_DIM);

/**
 * 把用户配置的外部 provider 包装成统一接口。
 *
 * 支持两种形态：
 *   1. 函数：`async (texts: string[]) => number[][]`
 *   2. 对象：`{ embed: fn, dim?: number, semantic?: boolean }`
 *
 * 任何异常都返回 null 数组（逐个位置），由调用方决定回退 ——
 * **不能让 embedding 失败影响记忆主流程**。
 */
export function wrapExternalProvider(raw, opts = {}) {
  if (!raw) return null;

  const fn = typeof raw === "function" ? raw : raw && typeof raw.embed === "function" ? raw.embed : null;
  if (!fn) return null;

  const dim = Number(opts.dim || (raw && raw.dim)) || 0;

  return {
    name: (raw && raw.name) || "external",
    dim,
    // 外部模型默认为真语义；调用方可以显式覆盖
    semantic: (raw && raw.semantic) !== false,
    async embed(texts) {
      const arr = Array.isArray(texts) ? texts : [texts];
      try {
        const out = await fn(arr);
        if (!Array.isArray(out) || out.length !== arr.length) {
          return arr.map(() => null);
        }
        return out.map((vec) => (Array.isArray(vec) || vec instanceof Float32Array
          ? normalizeVector(vec)
          : null));
      } catch {
        return arr.map(() => null);
      }
    },
  };
}

/**
 * 选中一个 provider。
 *
 * 优先级：显式配置的外部 provider > 内置哈希 > null。
 * `enabled === false` 时返回 null（语义能力整体关闭）。
 */
export function resolveProvider(config = {}) {
  if (config.enabled === false) return null;

  const ext = wrapExternalProvider(config.external, { dim: config.dim });
  if (ext) return ext;

  if (config.useHashFallback === false) return null;
  return hashProvider;
}

/** 两条向量的相似度（provider 无关）。 */
export function similarity(a, b) {
  return cosineSimilarity(a, b);
}

export { normalizeVector, hashEmbedding, DEFAULT_EMBED_DIM };
