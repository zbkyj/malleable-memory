// 向量与语义相似度（2026-10-24 · embedding 支持）
//
// ## 为什么单独一个文件
//
// 与 `llm-scorer.js` 同理：`memory-core.js` 的定位是「纯逻辑 + SQLite」，
// 向量数学独立出来才能单独测。
//
// ## 零依赖
//
// 不引第三方向量库（faiss / hnswlib 之类）。
// 理由：
//   ① 记忆量级是个位数千条，暴力余弦相似度足够（1 万条 × 256 维 ≈ 2.5M 次乘加，
//      实测在毫秒级）
//   ② 引一个原生依赖会让插件安装变重、跨平台变难
//   ③ 等真的到了十万条量级再考虑 ANN 索引，那时再引依赖有实测依据

/** 向量维度。不同提供方必须统一，否则无法比较。 */
export const DEFAULT_EMBED_DIM = 256;

/**
 * 把浮点数组归一化为单位向量。余弦相似度只需点积。
 *
 * 零向量（全是 0）无法归一化，返回 null —— 调用方必须当作"没有向量"处理，
 * 否则会得到 0/0 = NaN，污染后续所有比较。
 */
export function normalizeVector(values) {
  if (!values || values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) return null;
    sum += x * x;
  }
  if (sum === 0) return null;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = Number(values[i]) / norm;
  return out;
}

/**
 * 余弦相似度。两个向量必须已经归一化（否则要先归一化）。
 * 返回 [-1, 1]；任一为空返回 0（当作"无相关性"而不是抛错）。
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  // 归一化后点积即余弦；夹一下防浮点误差越界
  return Math.max(-1, Math.min(1, dot));
}

/** Float32Array → Buffer（用于存入 SQLite BLOB）。 */
export function vectorToBlob(vec) {
  if (!vec || vec.length === 0) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Buffer → Float32Array（从 SQLite BLOB 读出）。 */
export function blobToVector(blob) {
  if (!blob || blob.byteLength === 0) return null;
  if (blob.byteLength % 4 !== 0) return null; // 不是合法 float32 数组
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * 文本的**特征哈希**嵌入（fallback 提供方）。
 *
 * ## 这不是神经网络 embedding，必须说清楚
 *
 * 它做的是：把文本切成 n-gram，每个 n-gram 哈希到固定维度的某一维并累加，
 * 最后归一化。这叫 "hashing trick" / "feature hashing"。
 *
 * 能力边界（实测过才敢这么说）：
 *   ✅ 能捕捉**字面相近**：「部署改用 docker compose」
 *      vs「部署改用 docker compose 编排」→ 相似度很高
 *   ✅ 能捕捉**部分词重叠**：「终端用 pwsh」vs「pwsh 是终端方案」
 *   ❌ **不能**捕捉纯语义换词：「部署改用 docker」
 *      vs「容器编排换成 compose」→ 字面几乎无重叠，得分很低
 *
 * 所以它的定位是：**零依赖的兜底**，比纯关键词 LIKE 好一点
 * （有了连续的相似度分数、能排序），但**不解决**语义换词问题。
 *
 * 真要语义能力，必须接一个真正的模型提供方（见 embeddings.js 的 provider 接口）。
 * 这一点必须诚实记录，否则下一个维护者会误以为"已经有 embedding 了"。
 */
export function hashEmbedding(text, dim = DEFAULT_EMBED_DIM) {
  const s = String(text || "").toLowerCase().trim();
  const acc = new Float32Array(dim);
  if (s.length === 0) return null;

  // 拉丁词 + 中文二元组，与 keywordsOf 的策略保持一致
  const tokens = [];
  const latin = s.match(/[a-z][a-z0-9_.+-]{1,24}/g) || [];
  for (const w of latin) tokens.push("w:" + w);

  const cjkRuns = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.push("b:" + run.slice(i, i + 2));
    // 单字也加一点权重，避免两字词被完全切碎后丢失信息
    if (run.length === 1) tokens.push("c:" + run);
  }

  if (tokens.length === 0) return null;

  for (const tk of tokens) {
    const h = fnv1a(tk);
    const idx = h % dim;
    // 用哈希的另一位决定符号，减少碰撞带来的偏置
    const sign = (h >>> 16) & 1 ? 1 : -1;
    acc[idx] += sign;
  }
  return normalizeVector(acc);
}

/** FNV-1a 32 位哈希。快、分布够用、无需依赖。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
