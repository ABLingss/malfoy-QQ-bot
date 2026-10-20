# Contributing

1. 不要提交 `.env`、真实 QQ/群号、Koishi/NapCat 登录态、个人知识库或备份。
2. 新功能优先复用现有 `arxiv-digest` 和 `bot-services` 模块，不要重写 Koishi。
3. 修改研究缓存、任务、迁移或评分逻辑时，请补充 `tests/research.test.js`。
4. 提交前运行：

   ```bash
   node --test tests/research.test.js
   node scripts/research-migrate.js --dry-run
   node scripts/research-dry-run.js --papers 3
   bash -n scripts/*.sh
   ```

5. API 调用测试请使用 mock；不要为了验证缓存重复调用真实 DeepSeek。
6. 新配置必须有示例文件，并避免绝对个人路径。
