# Research Agent v2

Research Agent v2 是在现有 `arxiv-digest` 插件内增量加入的研究助理层。它保留原有
QQ → NapCat → Koishi → ChatLuna 链路和 arXiv/CCFDDL/Open-Meteo 采集，不改变端口
暴露方式，也不替换 Koishi 项目。

## 1. 数据流

```text
arXiv RSS/API ─┐
CCFDDL ────────┼─> 归一化/去重 ─> SQLite ─> 研究画像粗排 ─> 新论文批量分析
Open-Meteo ────┤                    │                         │
GitHub API ────┘                    ├─> 分析缓存（摘要哈希）   ├─> Top 3
                                    ├─> 任务队列               ├─> 完整候选
                                    └─> API 用量/预算         └─> Markdown 知识库
```

核心原则：

1. 先由确定性代码完成 ID 归一化、去重、缓存查询、摘要哈希、粗排和预算检查。
2. 只有「摘要哈希 + prompt 版本 + 研究画像版本 + 模型」变化时才重新分析论文。
3. 分析结果逐篇写入 SQLite；即使日报发送失败，也不会重复支付分析成本。
4. 推荐分项、理由、证据边界和「初步判断」都会保留，避免把摘要推断写成已验证结论。
5. 所有发送阶段分别记录：采集、分析、报告、QQ 消息、详细文件。

## 2. 文件与配置

| 路径 | 作用 |
| --- | --- |
| `config/research-profile.json` | 研究方向、项目问题、权重、预算、GitHub 白名单 |
| `data/research-agent/research.db` | 论文、分析、版本、任务、API 用量、GitHub 事件、发送记录 |
| `data/research-agent/migration-report.json` | 历史迁移的只读审计结果 |
| `knowledge/papers/` | 每篇论文的 Obsidian 兼容 Markdown |
| `knowledge/research-projects/` 等 | 人工维护的研究项目、综述、问题、复现笔记 |
| `scripts/research-migrate.js` | 幂等迁移历史状态 |
| `scripts/research-dry-run.js` | 真实抓取 arXiv、mock LLM、零 QQ 发送的端到端演练 |
| `scripts/restore-drill.sh` | 只读恢复演练 |
| `tests/research.test.js` | 缓存、迁移、知识库、任务、GitHub、预算测试 |

### 2.1 修改研究优先级

编辑 `config/research-profile.json`：

- `researchDirections[].weight`：初始优先级权重，供候选排序和 Top 3 去重参考。
  当前音乐 `0.40` 最高，其后是 ML Systems `0.28`、RL `0.19`、多模态 `0.13`；
  多模态方向已包含 ViT 关键词与独立项目问题。
- 方向权重会以最高 10 分的排序微调参与候选排序，但论文展示的 S 分项仍保留原始
  值，不会把优先级加成伪装成相关性分数。
- `projects[].questions`：会影响 LLM 的「与我的研究关系」和推荐理由。
- `scoring.minTopScore`：低于该分数不会进入 Top 3，宁缺毋滥。
- `scoring.dailyAnalysisLimit` / `analysisBatchSize`：每日新分析上限与单批篇数。
- `budget.dailyUsd` / `weeklyUsd`：研究 LLM 的预算硬限制，不是平台账单。
- `github.repositories`：仓库白名单、研究用途与关注原因。

权重和项目问题改变后建议把 `version` 递增，便于区分分析版本。

### 2.2 成本相关设置

- `budget.thinkingMode` 默认为 `disabled`。DeepSeek V4.1-Flash 的 thinking 模式默认
  开启且会消耗输出 token；结构化 JSON 抽取不需要它。关闭后实测单篇
  AlphaBet 分析为 input 1766 / output 693 tokens（首次调用，cache hit 0）。
- `budget.maxOutputTokens` 默认 8000，批处理时按 `max(1800, 篇数 × 900)` 申请，
  防止 8 篇批量 JSON 被截断。
- `modelPrices` 明确区分 cache hit、cache miss、output 和 peak/offpeak。费用只是
  根据 API 返回 usage 与配置价格计算的估算值，不是平台账单。
- 峰值时段按 UTC 周一至周五 01:00–04:00、06:00–10:00 判断；中国节假日需要在
  `modelPrices.holidays` 中维护，否则会按工作日估算。

## 3. 缓存与版本规则

- 规范化 arXiv ID（去掉版本号）作为主要实体键；DOI/OpenAlex ID 预留。
- `abstract_hash = sha256(NFKC + 小写 + 压缩空白 + 标点规范化的摘要)`。
- 输入哈希 = `abstract_hash | prompt 版本 | 研究画像版本 | 模型 | 分析类型`。
- 同一哈希已有 `full` 分析：直接复用，不调用 DeepSeek。
- 摘要不变、仅元数据变化：只更新元数据。
- 摘要发生实质变化：保留旧分析作为历史版本，新分析使用新哈希；旧记录不删除。
- arXiv 版本号变化但摘要哈希不变：不重新分析。
- 失败只重试当前失败论文，不重跑整个历史集合；失败次数记录在 `analysis_attempts`。
- 预算不足时论文状态为 `deferred`，不会静默重复请求；任务会延迟并在状态中显示。

## 4. QQ 命令

```text
研究.菜单                 独立研究菜单（直接发 研究 也可以）
日报                      立即生成并私信日报 + 详细 MD
周报                      立即生成并私信周报 + 详细 MD
研究.今日                 今日 Top 3 + 补发今日详细 MD（不调用模型）
研究.清单                 今日完整候选标题
研究.搜索 <关键词>        本地 SQLite，不调用模型
研究.总结 <ID> [深度]     默认只读缓存/摘要；带「深度」才创建分析任务
研究.对比 <A> <B>         对比贡献、证据边界、局限和研究关系
研究.已读 <ID>            标记已读
研究.复现 <ID>            标记待复现并创建笔记模板
研究.反馈 <ID> <反馈>     记录「值得读 / 不相关 / 值得复现 / 创新不足」等
研究.问题 <方向>          基于已存论文证据生成候选问题（可缓存 7 天）
研究.状态                 数据库、预算、日报送达、GitHub、任务状态
研究.成本                 今日/本周 token、缓存命中、估算费用
研究.任务 [ID]            任务列表或单个任务详情
研究.同步                 手动同步 GitHub 白名单
研究.测试                 私信测试日报 + 周报（每天 2 次）
研究.缓存                 缓存与预算状态（等同于 研究.状态）
```

方向 ID：`music`（最高优先）、`mlsys`、`rl`、`multimodal`。

研究菜单与默认的 `菜单` 分开，避免研究指令和聊天/天气/提醒指令混在一起。

`研究.总结` 默认只读 SQLite 缓存或原文摘要，不会调用 API。只有用户显式加上
`深度`（例如 `研究.总结 2610.22989 深度`）才会创建 `analyze_paper` 任务；任务在
后台执行并通过 QQ 通知。

## 5. 每日日报

- 原有 07:30（Asia/Shanghai）调度保留。
- 采集后先按研究画像粗排；对新论文最多做 `dailyAnalysisLimit` 篇结构化分析。
- Top 3 只从已完成结构化分析、分数达到阈值、未读/未推送的论文中选择；同一方向
  默认最多 2 篇。没有合格论文时明确写“没有达到标准”，不凑数。
- 完整候选仍保存到 `data/arxiv-digest/digests/YYYY-MM-DD.json`、
  `reports/daily/YYYY-MM-DD.md`，并可通过 `研究.清单` 或 `研究.搜索` 查询。
- 已读论文默认不再进入 Top 3；摘要出现实质变化的论文可重新进入候选。
- 日报发送失败不会把 `state.lastRunDate` 写成成功；最多自动重试 3 次，并逐步
  拉长间隔。
- `delivery_runs` 分别记录 collect/analyze/report/message/file 是否成功。

## 6. GitHub 监控

首次同步只建立基线，不推送历史事件。之后：

- Release：新正式版本，major/minor 或包含 breaking/API/权重/数据格式等关键字。
- PR：已合并且标签或标题涉及 performance、kernel、compiler、memory、correctness、
  GRPO、RL 等。
- Issue：近期更新、评论较多且有 bug/performance/regression 等标签。
- 事件键包含 release/PR/issue ID 和更新时间，重复同步不会重复记录。
- 日报最多展示 3 条；只有 QQ 消息成功发送后才标记为已通知。
- 可选 `GITHUB_TOKEN` 环境变量提高 API 速率；不配置也能运行（未认证 60 次/小时）。

## 7. 知识库

每篇论文会生成 `knowledge/papers/arxiv-<id>.md`，包含：

- frontmatter：标题、arXiv、DOI、方向、阅读状态。
- `research-agent:managed` 区块：自动分析、分项分数、证据边界、链接。
- `research-agent:user` 区块：留给人工笔记。

自动更新只替换 managed 区块。若文件没有 managed 标记（例如用户手工创建的笔记），
程序不会覆盖它。复现笔记只在不存在时创建。

## 8. 迁移

```bash
node scripts/research-migrate.js --dry-run   # 临时库中演练
node scripts/research-migrate.js             # 实际迁移，先备份旧 state/digests/reports
node scripts/research-migrate.js --no-backup # 已确认备份后重跑，验证幂等
```

迁移的判定：

- 中文比例和长度合理、且不是摘要截断：标记为历史生成摘要。
- 与原文摘要前缀高度相同：标记为 `abstract_excerpt`，不冒充成功分析。
- 无法确认：标记为 `legacy_unverified`，允许后续重新分析。
- 仅出现在 Markdown 标题中：导入标题并标记 `titleOnly`。
- 所有历史论文 `pushed_at` 设置为当时日报日期，避免第二天重复推送。

## 9. 测试与演练

```bash
node --test tests/research.test.js
node scripts/research-dry-run.js --papers 5
bash scripts/backup.sh
bash scripts/restore-drill.sh
```

测试使用 mock LLM 和调用计数器，不消耗 DeepSeek 额度。`research-dry-run` 会真实
访问 arXiv，但不会调用 DeepSeek、不会发 QQ，只写 `/tmp`。

## 10. 备份与恢复

`backup.sh` 现在额外包含：

- `data/research-agent/research.db`（在线 SQLite backup API）
- `config/research-profile.json` 与其他 config
- `knowledge/`
- `data/arxiv-digest/` 的 state/digests/reports
- `koishi/plugins/`、`tests/`、`docs/`
- `.env`、Koishi/NapCat 配置

备份仍包含密钥，权限 600。加密：

```bash
# 密码文件放在密码管理器控制的路径，不要与备份同机
BACKUP_PASSPHRASE_FILE=/secure/path/passphrase bash scripts/backup.sh --encrypt
```

脚本优先使用 `gpg`，未安装时自动使用 `openssl enc -aes-256-cbc -salt -pbkdf2`，
输出 `.gpg` 或 `.enc`。解密示例：

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass file:/secure/path/passphrase \
  -in qq-bot-config-*.tar.gz.enc -out qq-bot-config.tar.gz
```

`restore-drill.sh` 只解包到临时目录，校验 SQLite integrity、必需表、论文/分析数量、
知识库笔记数量和 `.env` 权限，然后删除临时目录；不重启服务、不覆盖生产数据。

## 11. 回滚

1. 停止 Koishi：`sudo systemctl stop koishi.service`。
2. 恢复 `backup/pre-research-v2-code-*.tar.gz` 中的 `koishi/plugins/arxiv-digest`、
   `config/arxiv.json`、`config/ccfddl.json` 和 `data/arxiv-digest/state.json`。
3. 删除或改名 `config/research-profile.json`，让新插件初始化失败并回退到旧管线；
   或保留新文件但恢复旧插件代码。
4. 启动：`sudo systemctl start koishi.service`。
5. 新增的 `data/research-agent/` 与 `knowledge/` 不影响旧管线，可保留供以后恢复。

## 12. 已知限制

- 历史 digest JSON 没有保存原始英文摘要，迁移后的 20 篇论文只有历史中文摘要；
  `研究.总结 <ID> 深度` 会按需从 arXiv API 补齐元数据后再分析。
- 研究 API 成本覆盖论文分析、候选研究问题、`脉络` 摘要等本插件调用；ChatLuna
  聊天费用不在本表中。旧管线在 Research Agent 初始化失败时仍会调用 DeepSeek，
  但那条降级路径不写入新用量表。
- 标题/摘要分析不能替代全文核验；所有创新性判断都标记为初步。
- OpenAlex 脉络查询仍是原有命令 `脉络 <主题>`，尚未把 lineage 写入 SQLite。
- 没有部署向量数据库；当前 SQLite LIKE 搜索足够小规模知识库，后续可加 FTS5。
- 备份加密和异地保存需要用户提供密码文件与对象存储凭据；程序不会自行创建云资源。
- 2026-10-20 的受控真实调用验证：关闭 thinking 后，AlphaBet 单篇分析返回
  input 1766 / output 693 tokens，cache hit 0，耗时约 4.2 秒，按当时 off-peak
  价格估算 $0.00068。该调用写入临时库，未进入生产缓存；旧实现没有用量日志，
  因此无法给出可靠的“优化前百分比”。
