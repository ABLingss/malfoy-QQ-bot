# Wordle 与 ThreeKingdomMeme 安装说明

## 1. Wordle

### 已安装组件

| 组件 | 版本/路径 |
| --- | --- |
| `koishi-plugin-wordle-game` | 4.4.0 |
| `koishi-plugin-puppeteer` | 3.9.0 |
| Chromium | 155.0.8059.79，`/usr/bin/chromium` |
| 配置位置 | `koishi/koishi.yml` 的 `group:games` |

Puppeteer 配置：

```yaml
group:games:
  puppeteer:
    executablePath: /usr/bin/chromium
    args:
      - --no-sandbox
      - --disable-dev-shm-usage
  wordle-game:
    enableDirectInput: false
    isDarkThemeEnabled: false
```

`enableDirectInput: false` 是为了避免猜词消息同时触发 ChatLuna；猜词请用
`wordle.猜 <内容>`。

### 使用方式

私聊（不需要 @）：

```text
wordle                 # 查看指令列表
wordle.开始            # 开始，按提示选模式
wordle.开始.汉兜       # 直接开汉兜（四字成语）
wordle.猜 一丁不识      # 提交猜测
wordle.查询进度
wordle.结束
wordle.排行榜
wordle.战绩
wordle.玩法介绍
```

群聊（白名单群 `<YOUR_GROUP_ID>`）：

```text
@机器人 wordle
@机器人 wordle.开始.汉兜
@机器人 wordle.猜 一丁不识
```

群聊仍受“必须 @”规则约束；每条 Wordle 指令都要 @。私聊玩最省事。

### 依赖与资源

- Wordle 插件要求 `database` 与 `puppeteer` 服务；当前使用 SQLite + Chromium。
- Chromium/Puppeteer 常驻约 0.8–1.2 GB 内存；如果内存紧张，可停用该插件组，
  或改用文字版 Wordle。
- 词库/战绩保存在 `koishi/data/koishi.db`，备份时会一起打包。
- 若 Chromium 升级后路径变化，修改 `executablePath` 并重启 Koishi。

### 故障排查

```bash
systemctl status koishi.service
journalctl -u koishi.service -n 100 --no-pager
pgrep -a chromium
/usr/bin/chromium --headless=new --no-sandbox --dump-dom about:blank
```

如果 Wordle 图片发不出来，先确认 Chromium 能启动，再看 Koishi 日志里的
Puppeteer 报错。

## 2. ThreeKingdomMeme（新三国梗语料/Claude skill）

### 安装位置

```text
<PROJECT_ROOT>/integrations/ThreeKingdomMeme
```

包含：

- `knowledge_base/全集台词.md`（约 1.6 MB）
- `knowledge_base/台词精简版.md`
- `knowledge_base/玩梗指南.md`
- `knowledge_base/xinsanguo_corpus.json`
- `data/dialogues.json`（约 4.6 MB）
- `data/episodes/ep_01-95.json`
- `distill_output/`、`prompts/`、`skill/`

### Claude Code skill

已执行：

```bash
bash integrations/ThreeKingdomMeme/skill/install.sh claude
```

安装到：

```text
~/.claude/skills/xinsanguo-meme/SKILL.md
```

重启 Claude Code 后使用 `/xinsanguo` 激活新三国嘴替模式。

### 重要限制

- 该仓库 **没有 License**，且包含大量电视剧原始台词。
- 仅限本地个人使用/研究；不要公开分发、商用或整库搬进公开仓库。
- 目前它只是安装在本机，**还没有接入 QQ 机器人**。如果要让 bot 使用，
  建议先做一个 30–50 条的精选 `三国梗` 词库（短引用 + 解释 + 出处），
  而不是把整库台词直接塞进 bot。

## 3. 快速验证清单

- [ ] 私聊 `wordle` 能看到指令列表
- [ ] `wordle.开始.汉兜` 能开局并返回棋盘图片
- [ ] `wordle.猜 <成语>` 能正常反馈
- [ ] 群聊 `@机器人 wordle` 能响应，不带 @ 被忽略
- [ ] 重启 Claude Code 后 `/xinsanguo` 可用
- [ ] `systemctl status koishi napcat` 均为 active
