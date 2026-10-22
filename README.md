<p align="center">
  <img src="assets/brand/banner.svg" alt="Malfoy QQ Bot" width="100%">
</p>

<p align="center">
  <a href="https://github.com/ABLingss/malfoy-QQ-bot/releases"><img src="https://img.shields.io/github/v/release/ABLingss/malfoy-QQ-bot?style=flat-square&color=2f6b4e" alt="version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f6b4e?style=flat-square" alt="license: MIT"></a>
  <a href="https://github.com/ABLingss/malfoy-QQ-bot/actions/workflows/test.yml"><img src="https://github.com/ABLingss/malfoy-QQ-bot/actions/workflows/test.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://koishi.chat"><img src="https://img.shields.io/badge/Koishi-4.18-2f6b4e?style=flat-square" alt="Koishi 4.18"></a>
  <img src="https://img.shields.io/badge/Node.js-24-2f6b4e?style=flat-square" alt="Node.js 24">
  <img src="https://img.shields.io/badge/QQ-NapCat-2f6b4e?style=flat-square" alt="QQ NapCat">
  <img src="https://img.shields.io/badge/LLM-OpenCode%20Go-2f6b4e?style=flat-square" alt="OpenCode Go">
</p>

<h1 align="center">Malfoy QQ Bot</h1>

<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  会读论文的斯莱特林大小姐。<br>
  一个自托管的 QQ 研究助理：每天跟踪 arXiv、按你的研究画像排序、维护论文知识库，<br>
  同时负责聊天、搜索、天气、翻译、提醒、猜词和语音回复。
</p>

<p align="center">
  <img src="assets/brand/malfoy-portrait.svg" alt="Malfoy persona portrait" width="260">
</p>

---

## 功能

### 研究主线

- **每日 arXiv 日报**：按计划抓取、去重、粗排和结构化分析，私信 Top 3 推荐与完整 Markdown 日报。
- **每周研究周报**：汇总近 7 天精选论文、热词、会议截稿、天气、待办和系统状态。
- **个性化研究画像**：方向、权重、优先级、项目问题和评分门槛全部可配置；分数只反映相关性，不把优先级加成伪装成相关性。
- **多维评分**：相关性、创新性、证据可信度、复现价值、时效性加权；仅基于摘要的判断会明确标记为初步结论。
- **研究知识库**：SQLite 存储论文、摘要版本、分析版本、任务、用量、反馈和发送记录；Markdown 笔记兼容 Obsidian。
- **Managed / User 分区**：自动分析只更新 managed 区块，手写笔记永远不会被覆盖。
- **论文查询与反馈**：搜索、总结、深度分析、对比、已读、待复现、反馈、候选研究问题、任务状态、用量与费用。
- **研究问题生成**：基于已存论文证据生成候选问题、反例、最小实验和不确定性；证据不足会明确说明。
- **持久化任务队列**：深度分析、问题生成、GitHub 同步等后台任务支持任务 ID、重试、重启恢复和完成通知。
- **GitHub 科研工具监控**：Release、重要 PR 和 Issue 去重提醒；首次同步只建立基线。
- **会议与脉络**：CCFDDL 截稿提醒，OpenAlex 研究方向演进查询。
- **成本控制**：每日/每周预算硬限制，记录 token、缓存命中、耗时和估算费用。

### QQ 助手

- **ChatLuna 对话**：内置通用助手与 Malfoy 角色预设，可自由切换或扩展。
- **多模态输入**：私聊或 @机器人 发图即可分析；GIF 和表情包会自动抽帧。
- **日常工具**：DeepSeek 网页搜索、天气、翻译、网页总结（带 SSRF 防护）。
- **提醒**：到点提醒、提醒列表、取消提醒。
- **Wordle**：单词、成语、数字、方程式等多种玩法，带战绩和排行榜。
- **新三国梗**：毒舌点评彩蛋。
- **Edge TTS 语音**：`念一下/朗读/语音：` 直接朗读；`说一说/讲一讲` 在文字回答后补一条语音。
- **群聊与私聊**：群白名单、@触发、速率限制、独立研究菜单。

### 运维

- 一键初始化配置与密钥，示例配置不含真实账号或研究数据。
- systemd 单元模板，管理端口仅监听回环地址。
- SQLite 在线备份、加密备份、只读恢复演练。
- 状态脚本、真实抓取 + mock LLM 的端到端演练、迁移脚本和单元测试。

---

## 快速开始

```bash
git clone https://github.com/ABLingss/malfoy-QQ-bot.git
cd malfoy-QQ-bot

# 1. 从示例生成本地配置（不会覆盖已有配置）
bash scripts/init-config.sh

# 2. 写入 API Key、机器人 QQ 和 OneBot token
bash scripts/setup-secrets.sh

# 3. 安装锁定版本的依赖
cd koishi
npm ci
```

然后按需编辑：

- `config/arxiv.json` / `config/weekly.json`：日报/周报时间与投递目标
- `config/bot.json`：群白名单、功能开关、默认城市、人格
- `config/research-profile.json`：研究方向、权重、项目问题、预算、GitHub 白名单
- `config/tts.json`：Edge TTS 音色、语速、限流和缓存
- `koishi/koishi.yml`：由 `koishi.example.yml` 复制，本地运行配置

启动 Koishi 后，通过 NapCat WebUI 扫码登录 QQ，并把 OneBot 反向 WebSocket 指向
`ws://127.0.0.1:5140/onebot`。完整步骤见 [部署文档](docs/research-agent.md) 与
[示例配置说明](config/README.md)。

> 实际配置、登录态、数据库、人设图片和知识库内容均已被 `.gitignore` 排除，不会进入仓库。

---

## 常用命令

私聊直接发送；群聊通常需要 @机器人。

| 场景 | 命令 |
| --- | --- |
| 日报 / 周报 | `日报`、`研究.今日`、`周报` |
| 研究菜单 | `研究`、`研究.菜单`、`研究.帮助` |
| 查询论文 | `研究.搜索 <关键词>`、`研究.总结 <arXiv ID>`、`研究.总结 <ID> 深度`、`研究.对比 <A> <B>` |
| 研究管理 | `研究.已读 <ID>`、`研究.复现 <ID>`、`研究.反馈 <ID> <反馈>`、`研究.问题 <方向>` |
| 任务与状态 | `研究.任务 [ID]`、`研究.同步`、`研究.状态`、`研究.缓存`、`研究.成本` |
| 会议与脉络 | `ccf.今日`、`ccf.状态`、`脉络 <主题>` |
| 日常助手 | `搜索 <关键词>`、`天气 [城市]`、`翻译 <文本>`、`总结 <链接>` |
| 提醒 | `提醒 <时间后> <内容>`、`提醒列表`、`取消提醒 <编号>` |
| 语音 | `念一下 <文本>`、`朗读 <文本>`、`语音：<文本>`、`说一说 <话题>` |
| 猜词 | `wordle`、`wordle.玩法介绍` |

更多命令和参数见 [研究 Agent 文档](docs/research-agent.md) 与
[Wordle / 新三国说明](docs/wordle-and-xinsanguo.md)。

---

## 技术栈

| 组件 | 用途 |
| --- | --- |
| [Koishi 4.18](https://koishi.chat) | 插件化机器人框架与控制台 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) + OneBot 11 | QQ 协议端，反向 WebSocket |
| [ChatLuna](https://github.com/ChatLunaLab/chatluna) | LLM 对话、预设与多模态 |
| OpenCode Go | 默认推理服务，模型可配置 |
| DeepSeek API | 可选，用于搜索与网页抓取工具 |
| SQLite | 研究库、会话数据、任务与用量 |
| Edge TTS | 在线语音合成，MP3 自动转 SILK |
| arXiv / OpenAlex / CCFDDL / Open-Meteo / GitHub | 研究、会议、天气与工具数据源 |

```text
QQ 客户端
   │
   ▼
NapCatQQ ──反向 WebSocket──> Koishi
                              ├── ChatLuna ──> OpenCode Go / LLM
                              ├── bot-services（搜索/天气/翻译/总结/提醒）
                              ├── tts-voice（Edge TTS）
                              ├── wordle-game
                              └── arxiv-digest
                                    ├── arXiv / OpenAlex / CCFDDL
                                    ├── GitHub / Open-Meteo
                                    └── Research Agent v2
                                          ├── SQLite 研究库
                                          ├── 结构化论文分析
                                          ├── 持久化任务队列
                                          └── Markdown 知识库
```

---

## 目录结构

```text
.
├── assets/brand/          # 原创 SVG 品牌资产（MIT）
├── config/                # 示例配置与本地配置（本地配置已忽略）
├── docs/                  # 研究 Agent、周报、Wordle 文档
├── koishi/
│   ├── plugins/
│   │   ├── arxiv-digest/  # 日报、周报、CCFDDL、脉络、Research Agent
│   │   ├── bot-services/  # 搜索、天气、翻译、总结、提醒
│   │   └── tts-voice/     # Edge TTS 语音
│   └── koishi.example.yml
├── presets/               # ChatLuna 预设示例
├── scripts/               # 初始化、密钥、备份、状态、演练
├── systemd/               # 服务单元模板
├── tests/                 # 单元测试
├── LICENSE
└── NOTICE
```

---

## 文档

- [Research Agent 架构与运维](docs/research-agent.md)
- [arXiv 日报 / 周报配置](docs/arxiv-weekly.md)
- [Wordle 与三国梗](docs/wordle-and-xinsanguo.md)
- [配置说明](config/README.md)
- [ChatLuna 预设](presets/README.md)

---

## 安全说明

- 仓库只包含示例配置；`.env`、`koishi.yml`、真实研究画像、数据库、登录态和人设图片均不提交。
- 管理端口默认只监听 `127.0.0.1`，请通过 SSH 隧道或端口转发访问。
- 不要把 API Key、WebUI token、登录二维码、密码或含登录态的备份发到聊天、截图或公开位置。
- NapCatQQ 是非官方协议端，使用前请自行确认 QQ 条款与账号风险，建议使用小号。
- 本项目按 MIT 许可提供，不附带任何可用性、合规性或账号安全保证。

---

## License

原创代码与 `assets/brand/` 下的 SVG 资产使用 [MIT License](LICENSE)。
Koishi、NapCatQQ、ChatLuna、QQNT、第三方插件、角色名称与相关素材分别遵循其原始许可证和条款，
详见 [NOTICE](NOTICE)。公开仓库不包含人设图片、知识库内容、真实研究画像或生产数据。
