# 可塑性记忆 · Malleable Memory

[![npm](https://img.shields.io/npm/v/dsh-malleable-memory.svg)](https://www.npmjs.com/package/dsh-malleable-memory)
[![license](https://img.shields.io/npm/l/dsh-malleable-memory.svg)](https://github.com/zbkyj/malleable-memory/blob/main/LICENSE)
[![DeepSeek-Harness](https://img.shields.io/badge/DeepSeek--Harness-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](https://github.com/zbkyj/malleable-memory)

> 给 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) 的三层记忆与人格插件。
> 解决 AI 跨会话「不知道你是谁」的问题——记忆按重要度分层注入，用得多的升温、不用的退到后台但不消失。人格随经历改变，心情可以被哄好。

[English](./README.en.md) · [更新日志](./CHANGELOG.md) · [问题反馈](https://github.com/zbkyj/malleable-memory/issues)

---


## 30 秒上手

```bash
dsh plugin install dsh-malleable-memory
```

装完**不需要任何配置**就会开始工作。你会看到：

- 侧栏多一个 🐟 图标 → 点开是「可塑性记忆」面板（五个 Tab）
- 模型多出 5 个工具：`memory_search` / `memory_recall` /
  `memory_pin` / `memory_forget` / `memory_debug`
- 下一轮对话起，它会开始记住你说过的事

> ⚠️ **默认会自动从对话中提取记忆并存在本地 SQLite**
> （`$DSH_HOME/memory/malleable-memory.db`）。
> 想关掉自动提取：配置 `capture: false`（已有记忆与面板仍可用）。
> 想彻底清空：删除该文件即可。

---

## 它解决什么问题

长期对话里，AI 会忘。不是"记不住细节"，而是**根本不知道你是谁**——
上次你说的部署方式、你讨厌的代码风格、你不喜欢被怎么称呼，换个会话就没了。

市面上的长期记忆方案多数是**向量检索堆砌**：把对话切片存起来，每次按相似度捞几条。问题有两个：

1. **贵**：存得越多、检索越慢、上下文塞得越满
2. **没有优先级**：三个月前随口一句话和昨天反复强调的偏好，权重一样

可塑性记忆的做法：**按重要度分层，按预算注入，按使用升温**。

可塑性记忆把记忆分成三层，按**重要度**而不是**时间**决定谁留在上下文里：

| 层 | 注入方式 | 预算 | 放什么 |
|---|---|---|---|
| **永久层** perm | 每轮全文 | 700 tokens | 你明确说"记住"的事、被反复强化的习惯 |
| **加强层** hot | 每轮全文 | 900 tokens | 近期重要的事，会随时间与实际使用自然下沉 |
| **卸载层** cold | 只给目录 | 400 tokens | 久远的事——索引行在上下文里，正文用 `memory_recall` 按需取回 |

关键设计：**卸载层不删除记忆，只是不占预算。** 4 条 cold 记忆在上下文里只占
4 行索引，模型看到目录就知道"我好像记得这个"，需要时再用 `memory_recall` 取回正文。
这是与"向量库无限堆积"方案的核心差异——**我们控制预算，而不是任由上下文膨胀**。

除了记忆，还带一套**人格与心情**：
你给它起名字、写性格、它被夸会高兴、被冒犯会不高兴、会随时间平复、
你哄它也会好起来。而且**这些都写进系统提示词**，不是装饰。

---

## 快速开始

```bash
# 装到当前 DSH profile
dsh plugin install dsh-malleable-memory
```

或在你的 bundle 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: malleable-memory
      name: dsh-malleable-memory
```

装好后：

- 记忆自动开始工作，**无需配置**
- 侧栏多一个 🐟 图标 → 点开是「记忆与人格」面板（五个 Tab）
- 模型多了 5 个工具：`memory_search` / `memory_recall` / `memory_pin` /
  `memory_forget` / `memory_debug`

数据存在 `$DSH_HOME/memory/memory.db`（SQLite，WAL 模式），
**这是插件自己的库文件**（首次运行自动创建 memory 目录）。它不会读写其他插件的数据库；只有当你有意把 dbPath 指到同一个文件时才会共用。

---

## 面板

| Tab | 看什么 |
|---|---|
| **三层明细** | 每层有哪些条目、重要度 S 值、命中次数、取代关系；已失效的也列出来 |
| **注入文本** | **模型真正看到的那段文本** + token 用量 + 被跳过/降级的条目 |
| **当前心情** | 12 类情绪标签 + 强度 + PAD 三维（愉悦/唤醒/掌控）条形图 |
| **心情历史** | 最近 30 次变化，含**触发事件**（区分"因为被夸而开心"和"因为任务完成而开心"） |
| **人格设定** | 预设选择 + 名字/定位/背景/说话风格 + 4 个性格权重 + 3 个基线 + 实时预览 |

「注入文本」这个 Tab 是排查神器：当记忆"好像没生效"时，这里能直接看到
模型到底收到了什么。

---

## 配置

全部可选。写在 bundle 的 `cordis.patch.yml` 对应条目下：

```yaml
- insert:
    - id: malleable-memory
      name: dsh-malleable-memory
      config:
        # ---- 记忆 ----
        dbPath: "C:/Users/you/.dsh/memory/memory.db"   # 默认 $DSH_HOME/memory/memory.db
        capture: true                # 自动捕获记忆，默认 true
        budgets:                     # 三层 token 预算
          perm: 700
          hot: 900
          cold: 400
        hotCapacity: 200             # 加强层最多条数，超出挤到卸载层
        migration: true              # 自动迁移（下沉/升温），默认 true
        migrateIntervalMs: 1800000   # 迁移节流，默认 30 分钟

        # ---- 人格 ----
        persona: true                # 总开关
        personaMode: "full"          # full / light / off（见下）
        personaPreset: "dafeiyu"     # 初始预设：dafeiyu / assistant-warm / assistant-sharp
        personaShowMood: true        # 是否把心情注入提示词

        # ---- 心情事件判定 ----
        moodJudge: "rule"            # rule（默认，零成本）/ "llm" / false
        moodJudgeTimeoutMs: 8000

        # ---- 记忆打分（可选 LLM）----
        llmScoring: false            # 默认关
        llmProvider: ""              # 例 "deepseek"
        llmModel: ""                 # 例 "deepseek-chat"
        llmTimeoutMs: 12000

        # ---- 面板 ----
        panel: true                  # 是否注册面板路由（仅本机回环可访问）

        # ---- 向量检索（进阶，默认不需要动）----
        embedding: true              # 是否启用向量检索（默认 hash 版）
        embeddingDim: 256            # hash 向量维度
        embeddingExternal: ""        # 外部向量提供方（留空 = 用 hash）
        embeddingUseHashFallback: true  # 外部提供方失败时回落 hash
```

### `personaMode` 三档

| 档位 | 内容 | 篇幅 |
|---|---|---|
| `full` | 完整人设 + 心情 + 说话风格逐条 | ~225 字符 |
| `light` | 名字 + 一句定位 + 一条口吻约束，**不含心情** | ~73 字符 |
| `off` | 不注入 | 0 |

写代码时建议 `light`：保留角色口吻，但不会让情绪干扰技术输出。

---

## 设计要点

### 为什么按重要度分层，而不是按时间

时间衰减是必要的，但**不能只看时间**。一条三个月前的、
你反复强化的偏好，比昨天随口说的一句话重要得多。

所以每条记忆有一个重要度 `S`：

```
S = 0.35 × 明确度 + 0.25 × 重复度 + 0.20 × 情绪强度 + 0.20 × 结构完整度
```

并且**被用到会升温**：`memory_recall` 会记录命中，一段时间内命中多次的
cold 条目会升回 hot。这就是"可塑性"——用得多的记忆变强。

### 心情为什么是连续量

如果只有"开心/生气"两个状态，表达不了"有点不高兴但还没到生气"。
所以主状态是 **PAD 三维连续量**（愉悦度、唤醒度、掌控感，各 -1~1），
12 类情绪标签是它的**投影**，只用来展示和喂给模型。

这样"被哄好"才能自然发生：安慰事件把愉悦度推正、唤醒度推低，
加上时间回摆，状态会连续地从"难过"→"低落"→"平静"→"放松"。

「生气」和「难过」在 PAD 里指向**不同区域**：
愤怒是低愉悦 + 高唤醒 + **高掌控**（反击姿态），
难过是低愉悦 + 中唤醒 + **低掌控**（受害者姿态）。
所以"被冒犯"和"被激怒"是两个不同事件，不会混为一谈。

> **学术依据**：PAD 模型（Mehrabian 1996）定义了情绪的三维空间；
> MECoT（ACL 2025 Findings）通过马尔可夫转移 + 人格加权矩阵验证了
> **12-16 类是最优情绪粒度**；MATE（2026）实现了纯函数转移与 opponent-process 回摆。
>
> ⚠️ **不确定性声明**：PAD 各原型的方位在多篇文献中一致，但**具体坐标数值不统一**，
> 本项目未获得 Mehrabian 原始论文的精确坐标表。代码里的 12 类质心坐标是
> "方位正确、量级合理"的构造值，**不可引用为原始数据**。

### 为什么默认不用向量模型

我们认真评估过外部向量模型（`bge-small-zh-v1.5`，int8 ONNX 22.9 MB），
在本项目的评测集上：

- **BM25（中文按二元组切分）的 MRR 是 0.540**
- **向量方案的 MRR 是 0.552**
- 基本持平，但向量方案会带来 **472.6 MB 的安装体积**（onnxruntime-node 287.1 + onnxruntime-web 138.7）

结论：**默认不用向量**，保留外部 provider 作为逃生口。这是"工程判断优于跟风"的证据——
不是所有场景都需要向量，BM25 在命中准确度可接受时更轻量。

### 安全边界

- 面板路由**只接受本机回环**：校验 socket 地址 + Host 头，并拒绝非 JSON 的 Content-Type、校验 Sec-Fetch-Site 与 Origin，用来挡住浏览器发起的跨站请求
- ⚠ **这不是身份认证**：本机上以你权限运行的其他程序仍可直接调用这些路由。本插件不做进程级鉴权（那需要 OS 能力）
- 只接受 POST，请求体上限 64 KB
- **只允许访问已经见过的工作区**，不能越权读别处
- 面板的写操作**只到人格与心情两张表**，不碰记忆正文与状态
- **默认不联网**。只有显式开启以下功能时才发网络请求：
  - llmScoring: true → 把待入库候选文本发给 llmProvider 指定的模型
  - moodJudge: "llm" → 把每轮用户消息发给该模型判定事件
  - embeddingExternal 配了外部 provider → 把记忆文本发给它做向量化
  以上都走你自己配置的服务，不经过本项目作者的任何服务器

---

## 已知限制

诚实说明，这些是实测确认的：

1. **进程被强杀时，收尾迁移不执行**。正常关闭会执行；强杀靠 WAL 保证数据
   一致性，但"该下沉的没下沉"要等下次启动。
2. **`agent/disposed` 拿不到工作区路径**。多工作区同时使用时这个钩子会跳过
   收尾（不猜，猜错会把 A 的迁移跑到 B 上）。
3. **面板的视觉效果只做了结构验证**。功能与数据链路有 893 条断言覆盖，
   但"看起来对不对"需要人眼确认。
4. **memory_forget 没有撤销工具**。它只把状态改成 vetoed，行仍在库里，但插件**不提供**恢复功能；要恢复得手工改数据库，且不保证后续版本仍可行 —— 动手前请先备份。
5. **embedding 只支持 hash 版**（默认）。外部向量模型是可选项，但实测在本项目
   的评测集上没有超过 BM25，所以默认不用。

---

## 开发

**技术栈**：
- 运行时：Node ≥22.19 或 ≥24（依赖 `node:sqlite`）
- 数据库：SQLite，WAL 模式，schema 版本 4
- 依赖：**零运行时 npm 依赖**（用 Node 内置模块）
- 包体积：19 个文件，解压约 316 KB
- 测试：**893 条断言，29 个测试文件**（在项目仓库，不在 npm 包里）

```bash
# 源码结构
lib/
  index.js         插件入口：hook、工具、prompt section
  memory-core.js   记忆引擎：SQLite schema、迁移、BM25 检索、分层装配
  persona-core.js  人格内核：PAD 模型、情绪转移、纯函数、零依赖
  event-judge.js   事件判定：规则版 + 可选 LLM
  panel-routes.js  面板 Host 侧路由（回环鉴权）
  client.js        面板 Client bundle（手写，无构建链）
  llm-scorer.js    可选的 LLM 记忆打分
  embeddings.js    向量提供方
  vector.js        向量计算
```

设计上有一条硬边界：**`memory-core.js` 与 `persona-core.js` 不依赖宿主**。
它们可以在 Node 里直接 `import` 并单测，不需要 DSH 运行时。
这是为什么测试能跑到 893 条断言。

测试在项目仓库的 `05_验证与测试/`，不在 npm 包里。

---

## 许可

MIT。见 [LICENSE](./LICENSE)。
