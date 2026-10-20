# 可选集成

`integrations/ThreeKingdomMeme/` 等第三方语料/技能默认不包含在公开仓库中，
以免提交受版权限制的台词、字幕或第三方项目内容。

需要时按对应项目自己的许可证单独安装，并在 `config/bot.json` 中配置：

- `features.threeKingdom`
- `threeKingdomFile`

如果文件不存在，对应功能应保持关闭。
