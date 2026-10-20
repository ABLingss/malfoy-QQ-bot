'use strict'

const path = require('path')
const { pathToFileURL } = require('url')
const { h } = require('koishi')

function sessionChannel(session) {
  if (!session) return null
  if (session.channelId) return session.channelId
  if (session.guildId) return String(session.guildId)
  if (session.userId) return `private:${session.userId}`
  return null
}

function sessionUser(session) {
  return String((session && (session.userId || session.username)) || 'unknown')
}

function makeRateLimiter() {
  const buckets = new Map()
  return function allow(key, limit, windowMs) {
    const now = Date.now()
    const recent = (buckets.get(key) || []).filter((time) => now - time < windowMs)
    if (recent.length >= limit) {
      buckets.set(key, recent)
      return false
    }
    recent.push(now)
    buckets.set(key, recent)
    return true
  }
}


function buildResearchMenu(service) {
  const stats = service.db.stats().papers
  const digest = service.todayDigest()
  const directions = service.profile.researchDirections
    .map((direction) => `${direction.id}（${direction.label}）`)
    .join('、')
  return [
    '🧪 研究菜单',
    '',
    '【每天看什么】',
    '· 日报 —— 立即生成并私信日报 + 详细 MD',
    '· 周报 —— 立即生成并私信周报 + 详细 MD',
    '· 研究.今日 —— 查看今日 Top 3，并补发详细 MD',
    '· 研究.清单 —— 今日完整候选标题',
    '· 研究.测试 —— 私信测试日报 + 周报（会调用少量 API，每天 2 次）',
    '',
    '【查论文】',
    '· 研究.搜索 <关键词> —— 查本地知识库，不调用模型',
    '· 研究.总结 <arXiv ID> —— 看缓存/摘要，不调用模型',
    '· 研究.总结 <arXiv ID> 深度 —— 后台分析，完成私信通知',
    '· 研究.对比 <论文A> <论文B>',
    '· 研究.已读 <ID> / 研究.复现 <ID>',
    '· 研究.反馈 <ID> <值得读|不相关|值得复现|创新不足>',
    '',
    '【选题与运维】',
    '· 研究.问题 <方向> —— 基于已有论文证据生成候选问题',
    '· 研究.状态 —— 数据库、预算、日报送达、任务状态',
    '· 研究.成本 —— 今日/本周 token、缓存命中和估算费用',
    '· 研究.任务 [任务ID] —— 查看队列或任务结果',
    '· 研究.同步 —— 手动同步 GitHub 白名单',
    '',
    `研究方向：${directions}`,
    `当前知识库：${stats.total} 篇 · 已分析 ${stats.analyzed || 0} · 历史摘要 ${stats.legacy || 0}`,
    `今日日报：${digest ? digest.date : '尚未生成'}`,
    '',
    '提示：私聊直接发；群里通常需要 @机器人。深度分析会排队，不会当场阻塞。',
    '直接发「研究」或「研究.菜单」都能打开本菜单。',
  ].join('\n')
}

function registerResearchCommands(ctx, service, options = {}) {
  const logger = options.logger || ctx.logger('research')
  const allow = makeRateLimiter()

  ctx
    .command('研究', 'Research Agent：个性化论文推荐与研究知识库')
    .action(() => buildResearchMenu(service))

  ctx
    .command('研究.菜单', '查看研究指令菜单')
    .alias('研究菜单')
    .alias('研究.帮助')
    .action(() => buildResearchMenu(service))

  ctx
    .command('研究.今日', '查看今日研究日报 Top 3 并发送详细 MD')
    .action(async ({ session }) => {
      const text = service.todayText()
      const reportPath = service.todayReportPath()
      if (!reportPath) {
        return `${text}\n\n暂无详细 MD；发送「日报」立即生成并私信。`
      }
      if (!session) return text
      await session.send(text)
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        const element = h.file(pathToFileURL(reportPath).href, path.basename(reportPath))
        await session.send(element)
      } catch (error) {
        logger.warn('研究.今日 详细 MD 发送失败: %s', error.message)
        await session.send(`详细 MD 发送失败：${error.message}`)
      }
      return
    })

  ctx.command('研究.清单', '查看今日完整候选清单').action(() => service.listText(20))

  ctx
    .command('研究.搜索 <keyword:text>', '搜索本地研究知识库')
    .action(({ session }, keyword) => {
      const user = sessionUser(session)
      if (!allow(`search:${user}`, 30, 86400000)) return '今天的知识库查询次数用完了。'
      return service.searchText(keyword, 8)
    })

  ctx
    .command('研究.总结 <paper:text> [mode:text]', '查询或创建论文深度分析')
    .action(async ({ session }, paper, mode) => {
      const user = sessionUser(session)
      if (!allow(`summary:${user}`, 20, 86400000)) return '今天的论文分析请求次数用完了。'
      const deep = /深度|deep|force/i.test(String(mode || '')) || /深度$/.test(String(paper || ''))
      const ref = String(paper || '').replace(/\s*深度$/, '').trim()
      try {
        const result = await service.summaryCommand(ref, {
          deep,
          notifyChannel: sessionChannel(session),
        })
        return result.text
      } catch (error) {
        logger.warn('研究.总结失败: %s', error.message)
        return `分析请求失败：${error.message}`
      }
    })

  ctx
    .command('研究.对比 <paperA:text> <paperB:text>', '对比两篇论文')
    .action(({ session }, paperA, paperB) => {
      const user = sessionUser(session)
      if (!allow(`compare:${user}`, 20, 86400000)) return '今天的对比次数用完了。'
      return service.compareCommand(paperA, paperB)
    })

  ctx
    .command('研究.已读 <paper:text>', '标记论文已读')
    .action(({ session }, paper) => service.markRead(paper, 'read'))

  ctx
    .command('研究.复现 <paper:text>', '标记待复现并创建复现笔记')
    .action(({ session }, paper) => service.markRead(paper, 'reproduce'))

  ctx
    .command('研究.反馈 <paper:text> <feedback:text>', '记录论文反馈')
    .action(({ session }, paper, feedback) => {
      if (!feedback) return '用法：研究.反馈 <论文ID> <值得读|不相关|值得复现|创新不足|与当前项目高度相关>'
      return service.addFeedback(paper, feedback, '')
    })

  ctx
    .command('研究.问题 <direction:text>', '基于已存证据提出候选研究问题')
    .action(({ session }, direction) => {
      const user = sessionUser(session)
      if (!allow(`questions:${user}`, 5, 86400000)) return '今天的问题生成次数用完了。'
      const result = service.questionsCommand(direction, {
        notifyChannel: sessionChannel(session),
      })
      return result.text
    })

  ctx.command('研究.状态', '查看 Research Agent 状态').action(() => service.statusText())

  ctx.command('研究.成本', '查看研究 API token 与估算成本').action(() => service.costText())

  ctx
    .command('研究.任务 [id:text]', '查看任务队列或指定任务')
    .action(({ session }, id) => {
      return id ? service.taskStatus(id) : service.tasksText(8)
    })

  ctx
    .command('研究.同步', '同步 GitHub 科研工具白名单')
    .action(({ session }) => {
      const user = sessionUser(session)
      if (!allow(`github:${user}`, 3, 3600000)) return 'GitHub 同步太频繁，请稍后再试。'
      const created = service.enqueueTask('github_sync', {}, {
        dedupeKey: `github:${new Date().toISOString().slice(0, 13)}`,
        notifyChannel: sessionChannel(session),
        priority: 3,
        maxAttempts: 2,
      })
      return `已创建 GitHub 同步任务：${created.task.id}\n完成后通知你；也可发送「研究.任务 ${created.task.id}」。`
    })

  ctx
    .command('研究.测试', '私信测试日报与周报')
    .action(({ session }) => {
      const user = sessionUser(session)
      if (!allow(`test-reports:${user}`, 2, 86400000)) return '今天的日报/周报测试次数用完了。'
      const created = service.enqueueTask('deliver_test_reports', { kinds: ['daily', 'weekly'] }, {
        dedupeKey: `test-reports:${new Date().toISOString().slice(0, 10)}`,
        notifyChannel: sessionChannel(session),
        priority: 20,
        maxAttempts: 2,
      })
      return `${created.existing ? '已有测试任务在队列中' : '已创建日报/周报私信测试任务'}：${created.task.id}\n生成后会私信简报和详细文件。`
    })

  ctx.command('研究.缓存', '查看缓存与预算状态').action(() => service.statusText())
}

module.exports = {
  registerResearchCommands,
  buildResearchMenu,
  sessionChannel,
  sessionUser,
}
