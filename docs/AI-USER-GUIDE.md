# PDF++ AI — 使用手册

> 面向最终用户的操作手册。技术设计见 [AI-PRD.md](./AI-PRD.md) / [AI-ARCHITECTURE.md](./AI-ARCHITECTURE.md)。
> AI 模块默认 **完全关闭**（`aiEnabled: false`），不启用时 PDF++ 的其余功能不受任何影响。

---

## 1. 快速开始

### 1.1 启用模块

1. 打开 `Settings → 第三方插件 → PDF++`，滚动到最下方 **"AI (MiniMax) — experimental"** 区块。
2. 打开 **Enable AI module** 开关（这一步会立即注册 AI 侧边栏 / 命令 / 右键菜单，无需重启 Obsidian）。
3. 打开 **Privacy consent** 开关 —— 使用任意 AI 功能前必须同意："当前 PDF 的选中文字/图片会被发送给 MiniMax"。
4. 在 **API key** 填入你的 MiniMax Bearer Token，**Group ID** 按需填写。
   - 国内版 Base URL：`https://api.minimaxi.com`（默认）
   - 国际版：`https://api.minimax.io`
5. 点击 **Test connection** 按钮，出现 `✓` 提示即表示密钥可用。

> API Key 明文存在 vault 的 `data.json` 里，如果启用了坚果云/远程同步插件，会一并同步，请自行评估风险。

### 1.2 打开 AI 侧边栏

- 命令面板 `Ctrl/Cmd+P` → 搜索 **"PDF++ AI: Open AI sidebar"**；
- 或任意一次 AI 操作（比如 Summarize）都会自动在右侧边栏弹出 **"PDF++ AI"** 面板。

侧边栏结构（从上到下）：
- 顶部工具栏：`Summarize paper` 按钮 + `Clear`（清空历史输出块）
- 中间：结果列表，每次操作生成一个「输出块」，新结果堆在最上面，每块自带 `Copy / Insert / Speak / Save` 四个按钮
- 底部："Ask AI about the current selection or paper…" 输入框（`Ctrl/Cmd+Enter` 发送）
- 页脚：本月 token 用量

---

## 2. 功能一览（命令面板全部以 `PDF++ AI:` 开头）

| 命令 | 作用 | 前置条件 |
|---|---|---|
| Open AI sidebar | 打开侧边栏 | — |
| Summarize paper | 整篇论文结构化摘要（流式输出） | 打开一个 PDF |
| Explain selection | 解释选中文本 | PDF 中有选区 |
| Summarize selection | 概括选中文本 | PDF 中有选区 |
| Translate selection | 翻译选中文本 | PDF 中有选区 |
| Ask AI about selection | 针对选区（或整篇论文）提问 | — |
| Analyze image (active page) | 用视觉模型解析当前页的图/表/公式 | 打开一个 PDF |
| Parse all figures | 扫描全篇 PDF，逐页解析所有图表 | 打开一个 PDF |
| Auto-annotate paper | 自动提取要点并生成可审核的批注 | 打开一个 PDF |
| Show references panel | 用 Semantic Scholar/Crossref/OpenAlex 富化参考文献 | PDF++ 已解析出参考文献列表 |
| Generate podcast from PDF | 把论文转成音频播客（单人/双人对话） | 打开一个 PDF |
| Generate knowledge map | 生成 Canvas 知识图谱或互链笔记 | 打开一个 PDF |
| Stop speaking | 停止朗读 | — |
| Toggle AI module | 等价于设置里的总开关 | — |

另外，选中 PDF 文字后右键菜单（需要 PDF++ 设置里开了"替换内置右键菜单"）会出现 **AI: Explain / AI: Summarize / AI: Translate / AI: Ask…** 四项快捷入口。

---

## 3. 详细用法 + 案例

### 3.1 论文速览 — `Summarize paper`

**用途**：把一整篇论文喂给 MiniMax-M3，流式生成结构化摘要（研究问题 / 方法 / 结果 / 局限等），结果实时显示在侧边栏，可一键 Copy/Insert 到笔记。

**案例**：你刚下载一篇 NeurIPS 论文 `2026-flash-attn3.pdf`，想 3 分钟内判断是否值得精读。
1. 用 PDF++ 打开该 PDF；
2. 命令面板执行 `PDF++ AI: Summarize paper`（或直接点侧边栏的 `Summarize paper` 按钮）；
3. 如果是扫描版无文字层 PDF，会弹提示"摘要质量可能较差，但图表解析仍可用"；
4. 结果出来后点 `Insert`，插入到你正在写的读书笔记里。

> 相同 PDF + 相同 prompt 版本 + 相同输出语言，会命中本地缓存（标题会带 `(cached)`），不重复计费。

### 3.2 划词追问 — `Explain / Summarize / Translate / Ask`

**用途**：选中 PDF 里任意一段文字，四选一操作；也可以不选中文字直接提问（针对整篇论文）。

**案例 A（读英文论文卡壳）**：读到一句 "we adopt a block-sparse attention pattern to amortize the KV-cache footprint"，看不懂，划选这句话 → 右键 `AI: Explain` → 侧边栏给出中文解释。

**案例 B（快速翻译摘要）**：划选 Abstract 全文 → 右键 `AI: Translate` → 得到中文翻译，点 `Speak` 直接听。

**案例 C（追问而不划词）**：不选中任何文字，命令面板 `Ask AI about selection`，在弹出的输入框里问"这篇论文的 baseline 是什么？"——模型会尝试基于当前打开的论文回答（没有选区时提示词会退化为"about the open paper if you can, else say so"）。

### 3.3 图表/公式解析 — `Analyze image` / `Parse all figures`

**用途**：把当前页渲染成图片发给视觉模型，返回结构化 JSON（`kind` 图表类型、`reading` 文字解读、可选 `markdown_table` 或 `latex`）。`Parse all figures` 会自动翻遍全文档每一页，把找到的图表汇总写成一份 `<论文名>.ai.md` 伴生笔记。

**案例**：论文 Table 3 是一堆消融实验数据，你想直接拿到 Markdown 表格贴进自己的笔记：
1. 翻到 Table 3 所在页；
2. `PDF++ AI: Analyze image (active page)`；
3. 侧边栏输出块里会包含可直接复制的 `markdown_table`（如果模型识别为表格）或 `$$...$$` LaTeX（如果是公式）。

**批量场景**：整理一篇图表很多的综述论文时，直接跑 `Parse all figures`，扫完后侧边栏提示"Parsed 12 figure(s) across 12 pages. Saved to [[xxx.ai.md]]"，点开链接就是全部图表的解读合集。

### 3.4 自动标注 — `Auto-annotate paper`

**用途**：让模型通读全文，挑出「研究问题 / 方法 / 关键结果 / 局限 / 贡献 / 定义」六类关键句，PDF++ 用文本层坐标把每条引用精确定位到 PDF 里的具体位置，**弹出审核弹窗，你勾选批准后才会真正写入**——未匹配到原文的句子会单独列出、永远不会被瞎猜写入。

写入方式由设置里的 **Auto-annotation default mode** 决定：
- **Vault-only**（默认，非破坏性）：生成一份 `<论文名>.ai.md` 伴生笔记，每条批注是一个带颜色的 PDF++ 选区链接；
- **Write into PDF**：调用 PDF++ 已有的"写入 PDF 文件"能力，把批注写成真正的高亮标注（需要先在 PDF++ 设置里打开"Editing PDF files"实验性功能）。

**案例**：精读一篇要写综述的论文，不想自己一段段找 Limitation 在哪：
1. `PDF++ AI: Auto-annotate paper`；
2. 等待"Asking M3 for important passages…" → "Locating N quotes in the text layer…"；
3. 弹出审核窗：已定位的条目默认勾选、可以单独取消，未定位的条目显示"⚠ not located — skipped"且不可勾选；
4. 点 `Write N annotations`；
5. Vault 模式下会打开新生成的 `<论文名>.ai.md`，每类标注用你在设置里配置的颜色（默认：研究问题=黄、方法=蓝、关键结果=绿、局限=红、贡献=紫、定义=橙）。

### 3.5 参考文献增强 — `Show references panel`

**用途**：读取 PDF++ 已经解析出的参考文献列表（依赖 PDF++ 原有的引文解析功能已经跑过），依次查询 **Semantic Scholar → Crossref → OpenAlex**（按标题相似度匹配，不用大模型编造），补上被引次数、DOI、开放获取链接，并生成 BibTeX。结果会缓存到 `vault/.pdf-plus-ai/citations.json`（默认 30 天过期）。

**案例**：文献综述阶段想知道论文列表里哪些是"高被引经典"：
1. 打开一篇参考文献已被 PDF++ 解析的论文；
2. `PDF++ AI: Show references panel`；
3. 侧边栏先提示"Resolved 38/42 references with citation data."；
4. 弹出的面板可按被引次数排序，逐条复制 BibTeX 或跳转 DOI/OA 链接。

> 若提示"no bibliography extracted"，说明 PDF++ 自带的参考文献解析还没跑起来（通常需要先配置 AnyStyle），这一步和 AI 无关。

### 3.6 生成播客 — `Generate podcast from PDF`

**用途**：整篇论文 → M3 写讲稿（单人旁白 / 双主播对话，可选 5/15/30 分钟档）→ 按讲话人分段调用 MiniMax TTS 异步合成 → 拼接成一个 mp3，同时生成带播放器的伴生笔记，全程可在进度弹窗里取消。

**案例**：通勤路上想"听"一篇论文而不是读：
1. 打开论文，`PDF++ AI: Generate podcast from PDF`；
2. 依次经历"extracting paper text…" → 讲稿生成 → "Synthesizing N audio segment(s)…"（弹窗显示实时进度，可点取消中止）；
3. 完成后自动打开 `<论文名>.podcast.md`，里面嵌入 `![[<论文名>.podcast.mp3]]` 播放器和完整逐句讲稿；
4. 想要更闲聊风格，去设置里把 **Podcast mode** 切成 "Two-host dialogue"，并分别设置两个主播的音色（`Podcast host A/B voice`）。

### 3.7 知识图谱 — `Generate knowledge map`

**用途**：把论文提炼成 5–8 个章节的结构化大纲（研究问题/方法/结果/局限/贡献），按设置输出成：
- **Canvas**（默认）：一个 `.canvas` 文件，中心节点是论文本身，四周环绕章节卡片，每张卡片带回跳 PDF 对应页码的链接；
- **Graph notes**：一个文件夹，`index.md` + 每章一个互链笔记，末尾带 `#pdf-plus-ai/paper` / `#pdf-plus-ai/section` 标签方便 Dataview/Bases 聚合。

**案例**：读完一篇长论文，想要一张"一眼看懂全文结构"的画布：
1. `PDF++ AI: Generate knowledge map (canvas/graph notes)`；
2. 生成完自动用 Canvas 视图打开 `<论文名>.canvas`；
3. 点任意章节卡片上的页码链接，直接跳回 PDF 对应页。

如果你更想要能被 Dataview/Bases 检索、能被其他笔记反链的产出（比如接入本仓库这种知识库工作流），把 **Knowledge map output** 切成 "Graph notes"。

### 3.8 语音播放 — 任意输出块的 `Speak` 按钮

每个 AI 输出块（不管来自哪个功能）都自带 `Speak` 按钮，点了直接用 MiniMax TTS 朗读这段文字；命令面板 `PDF++ AI: Stop speaking` 随时打断。

---

## 4. 关键设置速查

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Enable AI module | 关 | 总开关 |
| Privacy consent | 关 | 任何功能调用前的强制前置条件 |
| Output language | Auto | 跟随 PDF 语种自动判断中/英；也可强制 |
| Podcast mode / length | 双人对话 / 15 分钟 | |
| Auto-annotation default mode | Vault-only | 是否直接写入 PDF |
| Enable citation enrichment | 开 | 关掉后"参考文献面板"直接返回空列表 |
| Monthly token budget | 无限制 | 超额后所有 AI 操作会被 `assertBudget()` 拦截并报错 |

---

## 5. 常见问题

**Q: 设置里翻不到 "AI (MiniMax)" 区块？**
A: 说明 Obsidian 还在跑旧版 `main.js`。去 `Settings → 第三方插件` 里把 PDF++ 关闭再重新打开一次（或重启 Obsidian），文件替换不会自动热重载。

**Q: 开关都打开了，API Key 也填了，命令还是提示"enable the AI module first"？**
A: 检查设置里的开关是否真的处于"开"状态并已保存——`Enable AI module` 的 onChange 会同时触发 `plugin.ai.setActive(true)`，理论上切换后立刻生效，不需要重载。

**Q: 提示 "privacy consent required"？**
A: 光打开 `Enable AI module` 不够，`Privacy consent` 开关必须单独打开。

**Q: 每次操作都提示 "Monthly token budget reached"？**
A: 设置里把 `Monthly token budget` 清空（留空 = 无限制），或点旁边的重置按钮清零当月计数。

**Q: 结果标题带了 "(cached)"，怎么强制重新生成？**
A: 目前没有 UI 按钮清缓存；缓存 key 包含文件内容指纹 + prompt 版本号 + 输出语言，PDF 或输出语言变化会自动失效。

**Q: 扫描版 PDF（没有文字层）能用吗？**
A: `Summarize paper` / 划词类功能效果会很差（因为提取不到文字），但 `Analyze image` / `Parse all figures` 这类基于页面截图的视觉功能不受影响。

---

## 6. 隐私与费用提醒

- 只有你主动触发的操作才会把内容发给 MiniMax（选中的文字、渲染的页面截图、或整篇提取出的正文），没有后台静默上传。
- API Key 明文保存在 `data.json`，会随 vault 同步方案一起同步，请自行判断是否可接受。
- 参考文献增强会向 Semantic Scholar / Crossref / OpenAlex 三个外部公共 API 发起匿名查询（不含论文全文，只有标题/作者/年份），与 MiniMax 无关。
