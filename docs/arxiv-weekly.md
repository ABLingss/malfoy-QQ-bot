# arXiv 每日精选、CCFDDL 会议提醒与周报

这套功能由本地 Koishi 插件 `koishi/plugins/arxiv-digest` 实现，不依赖第三方
SaaS，也不会把 QQ 号、API Key 或聊天内容发送到额外服务。

## 1. 功能概览

### 每日简报 + 详细日报

- 时间：每天 `07:30`（`Asia/Shanghai`），可在 `config/arxiv.json` 修改。
- QQ 发一条**简报**：日期/周数、成都当天天气、3 个近期会议截稿、
  3 篇论文标题；随后发送详细日报 Markdown 文件（失败时回退完整分段）。
- 同时保存**详细日报 Markdown**：
  `<PROJECT_ROOT>/data/arxiv-digest/reports/daily/YYYY-MM-DD.md`，
  并更新同目录的 `latest.md`。详细日报包含：
  1. 日期、星期、周数和本周日期范围；
  2. 成都未来 3 天天气（Open-Meteo，和 `config/weekly.json` 共用城市配置）；
  3. CCFDDL 会议截稿提醒：未来 120 天内、与音频/语音/音乐/信号/多媒体/
     机器学习/视觉/NLP 相关的会议；每条带领域关键词、摘要截止、全文截止、
     北京时间换算和剩余天数；
  4. arXiv 泛 Audio 精选 20 篇：模糊关键词匹配 + 中文摘要 + OpenAlex 脉络。
- 目标：默认私聊，目标 QQ 只写在 `config/arxiv.json` 和
  `config/weekly.json`，不在代码或日志中打印。
- 手动触发：私聊机器人发送 `arxiv.今日`。手动触发会发送简报和详细 MD，
  不会改变“今天已自动发送”的状态。
- 如需把完整内容分段发到 QQ，把 `config/arxiv.json` 的
  `delivery.briefInChat` 改为 `false`。

### 每周简报 + 详细周报

- 时间：每周日 `09:00`（`Asia/Shanghai`），可在 `config/weekly.json` 修改。
- QQ 发一条**周报简讯**：周数/日期范围、成都天气、近 7 天论文数和热词、
  3 个近期会议截稿；随后发送详细周报 Markdown 文件（失败时回退完整分段）。
- 同时保存**详细周报 Markdown**：
  `<PROJECT_ROOT>/data/arxiv-digest/reports/weekly/YYYY-Www.md`，
  并更新同目录的 `latest.md`。详细周报包含：
  - 日期、周数、本周日期范围；
  - 成都未来 7 天天气（Open-Meteo，可改城市/坐标）；
  - 近 7 天 arXiv 泛 Audio 精选与关键词热度；
  - 未来 60 天会议截稿；
  - 你的待办提醒（仅私聊目标）；
  - 机器人运行状态、内存、磁盘、每日 arXiv 上次发送日期。
- 手动触发：私聊机器人发送 `周报` 或 `weekly`。手动触发同样发简讯和详细周报 MD。
- 如需完整内容分段发到 QQ，把 `config/weekly.json` 的
  `delivery.briefInChat` 改为 `false`。

## 2. 命令

| 命令 | 作用 |
| --- | --- |
| `arxiv.今日` / `arxiv.today` | 立即生成每日简报，并发送/保存详细日报 MD |
| `arxiv.状态` / `arxiv.status` | 查看 arXiv、会议、周报配置和上次发送 |
| `ccf.今日` / `会议` | 立即查看 CCFDDL 会议截稿 |
| `ccf.状态` / `ccf.status` | 查看 CCFDDL 数据源和缓存时间 |
| `脉络 <主题>` | 用 OpenAlex + DeepSeek 查研究方向演进 |
| `周报` / `weekly` | 立即生成周报简讯，并发送/保存详细周报 MD |

群聊中仍受 `config/bot.json` 的白名单和 @ 规则限制；日报/周报的自动推送
走私聊，不经过群聊。

## 3. 配置文件

| 文件 | 作用 |
| --- | --- |
| `config/arxiv.json` | 每日 arXiv 抓取、关键词、模型、推送目标和时间 |
| `config/ccfddl.json` | CCFDDL 数据源、会议领域、 rank、窗口和条数 |
| `config/weekly.json` | 周报时间、天气、arXiv、会议、提醒和系统状态 |

三个文件都按修改时间热加载：改完保存后，下一次命令/定时任务生效，不需要
重启 Koishi。插件代码或 `koishi.yml` 改动需要
`sudo systemctl restart koishi.service`。

### 3.1 `config/arxiv.json` 关键字段

- `enabled`：每日自动推送开关。
- `time` / `timezone`：默认 `07:30` / `Asia/Shanghai`。
- `target`：`{"type":"private","userId":"..."}` 或
  `{"type":"group","groupId":"..."}`。
- `maxPapers`：每日精选篇数，默认 20。
- `lookbackHours`：优先窗口，默认 48 小时。
- `fallbackLookbackDays`：优先窗口不足时的回退窗口，默认 7 天。
- `categories`：抓取的 arXiv 分类，默认
  `eess.AS, cs.SD, cs.MM, cs.LG, cs.CV, cs.CL, eess.SP`。
- `audioCategories`：只要属于这些分类就视为音频上下文，默认
  `eess.AS, cs.SD, cs.MM`；`eess.SP` 需要摘要中出现音频词才算。
- `audioTerms`：音频上下文词，如 audio/speech/music/voice/codec 短语等。
- `excludeTerms`：排除词，如 sonar、underwater、image coding、video QA，
  用来减少声呐、图像编码、纯视频检索等误报。
- `keywordGroups`：重点关键词组及权重：
  `benchmark`、`music generation`、`music understanding`、`codec`、
  `SVC`、`VC`、`JEV`、`JEPA`、`ViT`、`post-training`、
  `efficient training/inference`。
  - 标题命中权重加倍，摘要命中按组权重加分；
  - 24 小时内加 2 分、48 小时内加 1 分；
  - 按分数排序取前 `maxPapers` 篇。
- `maxSummaryTokens`：DeepSeek 完成 token 上限，默认 3000。`deepseek-flash`
  会先产生 reasoning token，额度太小会导致正文被截断；实际每次约 400–800
  completion tokens。
- `lineageEnabled` / `lineageRefs`：OpenAlex 脉络开关和每篇引用数。
- `openAlexEmail`：可选，填入后 OpenAlex 走 polite pool；留空也可用。
- `delivery.briefInChat`：`true`（默认）只发一条简报；`false` 把完整内容
  分段发到 QQ。
- `delivery.saveMarkdown`：`true`（默认）保存详细 MD 并更新 `latest.md`。
- `delivery.sendMarkdownFile`：`true`（默认）把详细 MD 作为 QQ 文件发送；
  文件发送失败时自动回退为完整分段。`false` 则只在简报里显示路径。
- `chunkSize`：每条 QQ 消息放几篇论文，默认 4。
- `maxConcurrentSummaries`：摘要并发数，默认 3。

### 3.2 `config/ccfddl.json` 关键字段

- `source`：默认 `https://ccfddl.com/conference/initial.json`（CCFDDL 的
  汇总 JSON，约 200 KB）。
- `cacheFile`：本地缓存；在线获取失败时最多使用 7 天内的缓存。
- `lookaheadDays` / `maxItems`：每日默认 120 天 / 10 条；周报用
  `weekly.json` 里的 60 天 / 8 条。
- `includeRanks`：默认 A/B/C。
- `includeUnrankedForCoreFields`：对音乐/信号/多媒体等核心领域，允许
  CCF `N`（未评级）但领域相关的会议，如 EvoMUSART、EUSIPCO、MMSys。
- `excludeTitles`：默认排除 NOSSDAV（网络/系统方向的音频视频 workshop）。
- `fields`：领域标签和匹配词；每条会议会带至少一个标签，例如
  `音频/语音`、`音乐`、`信号处理`、`多媒体`、`机器学习`、`计算机视觉`、
  `自然语言处理`、`数据挖掘/检索`。
- 截止时间按 CCFDDL 的 `timezone`（AoE/UTC±）换算为 UTC，再显示北京时间
  和剩余天数；`摘要` 或 `全文` 缺失时显示 `未公布`，已过时显示 `已截止`。

### 3.3 `config/weekly.json` 关键字段

- `dayOfWeek`：1=周一，…，7=周日；默认 7（周日，非工作日）。
- `time` / `timezone`：默认 `09:00` / `Asia/Shanghai`。
- `catchupMinutes`：错过准点后的补发窗口，默认 120 分钟。
- `weather`：城市、经纬度、时区和预报天数；默认成都。日报使用
  `dailyDays`（默认 3 天），周报使用 `forecastDays`（默认 7 天）；两处共用
  同一份 `config/weekly.json` 配置。
- `arxiv`：`days`（回看天数）、`maxPapers`、`maxKeywords`、
  `liveFallback`（没有足够每日缓存时是否实时抓取并总结）。
- `ccf`：周报会议窗口和条数。
- `reminders`：是否显示待办提醒及最多条数。
- `system`：是否显示机器人/内存/磁盘状态。
- `delivery.briefInChat` / `delivery.saveMarkdown` / `delivery.sendMarkdownFile`：
  与日报相同；默认只发一条周报简讯、保存详细周报 MD，并把 MD 作为 QQ 文件
  发送（失败回退完整分段）。

## 4. 数据源与实现

- **arXiv**：优先使用 `https://rss.arxiv.org/rss/<category>`，RSS 是缓存
  友好的每日公告；RSS 为空或失败时才回退到
  `https://export.arxiv.org/api/query`。API 有 429 限流，因此不作为首选。
- **OpenCode Go / DeepSeek**：`deepseek-flash`，通过 `OPENCODE_API_KEY`
  调用 OpenCode Go 的 `/v1/chat/completions`，用于中文摘要和 `脉络` 总结。
- **OpenAlex**：`https://api.openalex.org`，按 arXiv DOI 查
  `referenced_works` / `related_works`，再批量取标题、年份、引用数。
  新论文可能尚未被 OpenAlex 收录，此时显示 `脉络：暂无`。
- **CCFDDL**：`https://ccfddl.com/conference/initial.json`，MIT License，
  数据由 CCFDDL 社区维护；截止时间以会议官网为准。
- **Open-Meteo**：`https://api.open-meteo.com`，免费、无需 Key；
  日报/周报天气和成都坐标来自 `config/weekly.json`。
- **提醒**：只读 `<PROJECT_ROOT>/data/reminders.json`，不修改
  `bot-services` 的提醒状态；群目标不显示个人提醒。

## 5. 数据与缓存

目录：`<PROJECT_ROOT>/data/arxiv-digest/`（目录 700，文件 600）

- `state.json`：最后一次自动发送日期、摘要缓存、脉络缓存。
- `weekly-state.json`：最后一次周报周编号。
- `ccfddl-cache.json`：CCFDDL 汇总数据和抓取时间。
- `digests/YYYY-MM-DD.json`：每日精选的结构化记录。
- `digests/YYYY-MM-DD.md`：arXiv 段落的文本备份。
- `reports/daily/YYYY-MM-DD.md` + `latest.md`：详细日报（天气 + 会议 +
  arXiv 全量）。
- `reports/weekly/YYYY-Www.md` + `latest.md`：详细周报（天气 + arXiv +
  会议 + 提醒 + 系统）。

每日摘要/脉络缓存会保留，避免重复调用 DeepSeek/OpenAlex；空的脉络结果
不缓存，后续 OpenAlex 收录后可重试。

## 6. 成本与限额

- arXiv、OpenAlex、Open-Meteo、CCFDDL：免费；没有新增付费 API。
- DeepSeek：
  - 每日 20 篇摘要，每篇 `max_tokens=3000`，实际约 400–800 completion
    tokens；按 DeepSeek 当前单价计费，远低于每天几分钱人民币的量级。
  - 周报优先用每日缓存；只有缓存少于 3 篇且 `liveFallback=true` 时，
    才实时抓取最多 15 篇并总结。
  - `脉络` 每人每天最多 3 次，6 小时结果缓存。
- arXiv API 全局限流：RSS 优先；API 429 时只影响回退请求，不会导致整个
  日报崩溃。
- CCFDDL 在线获取失败时使用 7 天内缓存；无缓存时日报跳过会议段，
  arXiv 段仍会发送。

### 6.1 DeepSeek 缓存与峰谷

- **ChatLuna 预设审计**：`malfoy.yml` 的 system 段落和示例对话都是固定
  文本；没有 `{date}`、`{time}`、随机 ID 或每轮变化的系统前缀。唯一的
  动态占位符 `{sender}` 在 `format_user_prompt` 里，属于用户消息，不会
  破坏系统提示的缓存前缀。
- **本插件的提示词**：摘要和 `脉络` 都把固定角色/格式要求放在 system
  消息，动态的论文标题、摘要、论文列表放在 user 消息；同一批请求可以
  复用 system 前缀。
- **峰谷时段**：日报已从 `08:30` 挪到 `07:30`；周报从周一 `09:00` 挪到
  周日 `09:00`（非工作日）。两者都在 DeepSeek 工作日高峰
  `09:00–12:00`、`14:00–18:00` 之外。若要改时间，尽量避开这两个区间。
- **不要在前缀放时间戳**：DeepSeek 上下文缓存从消息列表最开头匹配；把
  日期、时间、随机 ID 放进 system 提示或历史消息开头会让缓存命中率下降。
- **mega-knowledge**：当前未安装。现有角色预设很小，没有大型知识文档；
  安装它会增加插件依赖和可选的缓存保活探测请求。后续如果要把常用文档/
  规则作为稳定前缀，再评估 `koishi-plugin-chatluna-mega-knowledge`。

## 7. 测试与排障

```bash
# 语法检查
node --check koishi/plugins/arxiv-digest/index.js
node --check koishi/plugins/arxiv-digest/lib/arxiv.js
node --check koishi/plugins/arxiv-digest/lib/ccfddl.js
node --check koishi/plugins/arxiv-digest/lib/weekly.js

# 小规模 dry-run，不发 QQ；需要 .env 里的 OpenCode Go Key
set -a; . <PROJECT_ROOT>/.env; set +a
node <PROJECT_ROOT>/scripts/arxiv-dry-run.js --papers 3 --weekly
unset OPENCODE_API_KEY

# 服务日志
journalctl -u koishi.service -n 100 --no-pager | grep -Ei 'arxiv|ccf|weekly|error'
```

常见问题：

- `arXiv 配置未加载`：检查 `config/arxiv.json` 是否存在、JSON 是否合法。
- `arXiv 生成失败：没有抓到符合条件的 arXiv 论文`：可能是 RSS/API 同时
  限流或当天没有新公告；稍后重发 `arxiv.今日`。
- 摘要被截断：提高 `maxSummaryTokens`（`deepseek-flash` 的 reasoning 也
  计入 completion tokens）。
- 会议提醒为空：检查 `ccfddl.json` 的 `fields`、`includeRanks`、
  `lookaheadDays`，或确认 CCFDDL 当天数据是否可访问。
- 周报没有 arXiv 段：确认 `weekly.json` 的 `arxiv.enabled` 和
  `arxiv.json` 已加载；第一次周报会尝试 `liveFallback`。
- 天气失败：Open-Meteo 临时不可达或经纬度不合法；周报其余段落仍会发送。
- 修改配置后不生效：命令/定时任务会按 mtime 热加载；代码改动需要
  `sudo systemctl restart koishi.service`。

## 8. 来源与许可

- arXiv RSS/API：arXiv.org，内容版权归原作者；仅用于个人研究阅读。
- OpenAlex：开放学术图谱，数据以 CC0 发布。
- CCFDDL：MIT License，`https://github.com/ccfddl/ccf-deadlines`。
- Open-Meteo：免费天气 API，使用时保留 `数据：Open-Meteo` 标识。
- DeepSeek：按 DeepSeek 平台条款使用。

CCFDDL 只收录 CCF 推荐列表中的会议；ISMIR、WASPAA、ASRU 等音频会议
目前不在 CCFDDL 数据中。如需补录，可在 `ccfddl.json` 外维护额外的静态
会议表，或在 CCFDDL 上游补充数据。
