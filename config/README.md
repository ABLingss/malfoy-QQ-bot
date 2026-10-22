# 配置目录

实际运行配置包含个人 QQ、群号、研究画像和服务路径，**不提交到 Git**。
新部署请复制示例：

```bash
cp config/arxiv.example.json config/arxiv.json
cp config/weekly.example.json config/weekly.json
cp config/bot.example.json config/bot.json
cp config/tts.example.json config/tts.json
cp config/research-profile.example.json config/research-profile.json
```

然后至少修改：

- `arxiv.json` / `weekly.json` 的 `target.userId`
- `bot.json` 的 `groupWhitelist`（可为空）
- `research-profile.json` 的方向、项目问题和权重
- 需要时修改 `ccfddl.json` 的会议领域优先级

`ccfddl.json` 是通用默认配置，可以直接提交和复用。

相对路径（如 `../data/arxiv-digest`）是相对于 Koishi 工作目录
`koishi/` 解析的；如果使用 systemd，`WorkingDirectory` 必须指向 `koishi/`。

实际文件已在根 `.gitignore` 中排除：

- `config/arxiv.json`
- `config/weekly.json`
- `config/bot.json`
- `config/tts.json`
- `config/research-profile.json`

不要把真实 QQ 号、群号、API Key 或带个人信息的画像提交到公开仓库。
