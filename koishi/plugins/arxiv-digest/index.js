'use strict'

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../..')
const { Schema, h } = require('koishi')
const {
  buildDigest,
  deepseekChat,
  formatDateParts,
  loadJson,
  openAlexSearch,
  parseTime,
  saveJson,
  sleep,
  clean,
} = require('./lib/arxiv')
const { buildCcfReminder } = require('./lib/ccfddl')
const { buildWeeklyReport, getWeekInfo } = require('./lib/weekly')
const {
  buildDailyReport,
  makeDailyBrief,
  makeWeeklyBrief,
  saveMarkdownReport,
} = require('./lib/report')
const { ResearchService } = require('./lib/research/service')
const { registerResearchCommands } = require('./lib/research/commands')

exports.name = 'arxiv-digest'

exports.Config = Schema.object({
  configFile: Schema.string().default(path.join(PROJECT_ROOT, 'config', 'arxiv.json')),
  ccfddlConfigFile: Schema.string().default(path.join(PROJECT_ROOT, 'config', 'ccfddl.json')),
  weeklyConfigFile: Schema.string().default(path.join(PROJECT_ROOT, 'config', 'weekly.json')),
  researchProfileFile: Schema.string().default(path.join(PROJECT_ROOT, 'config', 'research-profile.json')),
  researchDataDir: Schema.string().default(path.join(PROJECT_ROOT, 'data', 'research-agent')),
})

function splitForQQ(text, limit = 1800) {
  const source = String(text || '')
  if (source.length <= limit) return [source]
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.6)) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

function allowRate(buckets, key, limit, windowMs) {
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

exports.apply = function apply(ctx, config) {
  const logger = ctx.logger('arxiv')
  const arxivConfigFile = config.configFile || path.join(PROJECT_ROOT, 'config', 'arxiv.json')
  const ccfConfigFile = config.ccfddlConfigFile || path.join(PROJECT_ROOT, 'config', 'ccfddl.json')
  const weeklyConfigFile = config.weeklyConfigFile || path.join(PROJECT_ROOT, 'config', 'weekly.json')
  const dataDir = path.join(PROJECT_ROOT, 'data', 'arxiv-digest')
  const stateFile = path.join(dataDir, 'state.json')
  const weeklyStateFile = path.join(dataDir, 'weekly-state.json')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  function makeLoader(file, label) {
    let cached = null
    let mtime = 0
    let warned = false
    return function load() {
      try {
        const stat = fs.statSync(file)
        if (cached && stat.mtimeMs === mtime) return cached
        cached = JSON.parse(fs.readFileSync(file, 'utf8'))
        mtime = stat.mtimeMs
        warned = false
        return cached
      } catch (error) {
        if (!warned) {
          logger.warn('读取%s配置失败: %s', label, error.message)
          warned = true
        }
        return cached
      }
    }
  }

  const loadArxivConfig = makeLoader(arxivConfigFile, 'arXiv')
  const loadCcfConfig = makeLoader(ccfConfigFile, 'CCFDDL')
  const loadWeeklyConfig = makeLoader(weeklyConfigFile, '周报')

  let state
  try {
    state = loadJson(stateFile, { lastRunDate: null, summaries: {}, lineage: {} })
  } catch (error) {
    logger.warn('读取 arXiv 状态失败，使用空状态: %s', error.message)
    state = { lastRunDate: null, summaries: {}, lineage: {} }
  }
  state.summaries = state.summaries || {}
  state.lineage = state.lineage || {}

  let weeklyState
  try {
    weeklyState = loadJson(weeklyStateFile, { lastRunWeek: null })
  } catch (error) {
    weeklyState = { lastRunWeek: null }
  }
  weeklyState.lastRunWeek = weeklyState.lastRunWeek || null

  async function sendChunks(chunks, session, target) {
    if (!chunks || !chunks.length) return
    if (session) {
      for (const chunk of chunks) {
        await session.send(chunk)
        await sleep(600)
      }
      return
    }
    const bot = ctx.bots.find((item) => item.platform === 'onebot')
    if (!bot) throw new Error('OneBot 机器人尚未连接')
    const destination = target || {}
    let channelId
    if (destination.type === 'group') {
      if (!destination.groupId) throw new Error('未配置群推送目标')
      channelId = String(destination.groupId)
    } else {
      if (!destination.userId) throw new Error('未配置私聊推送 QQ')
      channelId = `private:${destination.userId}`
    }
    for (const chunk of chunks) {
      await bot.sendMessage(channelId, chunk)
      await sleep(800)
    }
  }

  function resolveChannel(target) {
    const destination = target || {}
    if (destination.type === 'group') {
      if (!destination.groupId) throw new Error('未配置群推送目标')
      return String(destination.groupId)
    }
    if (!destination.userId) throw new Error('未配置私聊推送 QQ')
    return `private:${destination.userId}`
  }

  async function sendFileTo(file, session, target) {
    const element = h.file(pathToFileURL(file).href, path.basename(file))
    if (session) {
      await session.send(element)
      return
    }
    const bot = ctx.bots.find((item) => item.platform === 'onebot')
    if (!bot) throw new Error('OneBot 机器人尚未连接')
    await bot.sendMessage(resolveChannel(target), element)
  }

  async function notifyChannel(channelId, text) {
    const bot = ctx.bots.find((item) => item.platform === 'onebot')
    if (!bot) throw new Error('OneBot 机器人尚未连接')
    for (const chunk of splitForQQ(text)) {
      await bot.sendMessage(channelId, chunk)
      await sleep(500)
    }
  }

  async function notifyFile(channelId, file) {
    const bot = ctx.bots.find((item) => item.platform === 'onebot')
    if (!bot) throw new Error('OneBot 机器人尚未连接')
    const element = h.file(pathToFileURL(file).href, path.basename(file))
    await bot.sendMessage(channelId, element)
  }

  let research = null
  try {
    research = new ResearchService({
      root: PROJECT_ROOT,
      logger,
      profileFile: config.researchProfileFile,
      dataDir: config.researchDataDir,
    })
    research.setNotifier(notifyChannel)
    research.setFileNotifier(notifyFile)
    research.startWorker()
    registerResearchCommands(ctx, research, { logger })
    ctx.on('dispose', () => research.close())
    logger.info(
      'Research Agent v2 已加载: 数据库=%s, 画像=%s, 任务恢复=%d',
      research.dbFile,
      research.profile.version,
      research.recoveredTasks,
    )
  } catch (error) {
    research = null
    logger.error('Research Agent v2 初始化失败，保留旧日报路径: %s', error.message)
  }

  let running = false

  function recordDailyFailure(date, error) {
    const previous = state.dailyAttempts
    if (!previous || previous.date !== date) {
      state.dailyAttempts = { date, count: 0, lastAt: null, lastError: null }
    }
    state.dailyAttempts.count += 1
    state.dailyAttempts.lastAt = new Date().toISOString()
    state.dailyAttempts.lastError = String((error && error.message) || error || 'unknown').slice(0, 300)
  }

  async function runDigest({ session, manual }) {
    const cfg = loadArxivConfig()
    if (!cfg) throw new Error('arXiv 配置未加载')
    if (running) {
      if (session) await session.send('arXiv 正在生成中，请稍等。')
      return null
    }
    running = true
    let report = null
    let sendError = null
    try {
      report = research && research.enabled
        ? await research.buildDailyReport(cfg, {
            state,
            weeklyCfg: loadWeeklyConfig(),
            ccfCfg: loadCcfConfig(),
            now: new Date(),
          })
        : await buildDailyReport(cfg, {
            state,
            weeklyCfg: loadWeeklyConfig(),
            ccfCfg: loadCcfConfig(),
            now: new Date(),
          })
      const delivery = cfg.delivery || {}
      const reportPath =
        delivery.saveMarkdown === false
          ? null
          : saveMarkdownReport(cfg.dataDir || dataDir, 'daily', report.result.date, report.markdown)
      const briefMode = delivery.briefInChat !== false
      const sendFile = briefMode && delivery.sendMarkdownFile !== false && !!reportPath
      const brief = makeDailyBrief(report, { reportPath: sendFile ? null : reportPath })
      let messageOk = false
      let fileSent = false
      try {
        if (briefMode) {
          await sendChunks([brief], session, cfg.target)
          messageOk = true
          if (sendFile) {
            try {
              await sendFileTo(reportPath, session, cfg.target)
              fileSent = true
            } catch (error) {
              logger.warn('详细日报文件发送失败，改为完整分段: %s', error.message)
              try {
                await sendChunks(report.chunks, session, cfg.target)
              } catch (fallbackError) {
                sendError = fallbackError
                logger.error('详细日报回退分段也失败: %s', fallbackError.message)
              }
            }
          }
        } else {
          await sendChunks(report.chunks, session, cfg.target)
          messageOk = true
        }
      } catch (error) {
        sendError = error
        logger.error('arXiv 推送失败: %s', error.message)
        if (session) await session.send(`arXiv 推送失败：${error.message}`)
      }

      if (messageOk) {
        state.lastRunDate = report.result.date
        if (!manual) state.dailyAttempts = null
        if (research && report.deliveryKey) {
          research.commitDailyReport(report, {
            messageOk: true,
            fileOk: fileSent,
            error: sendError || null,
          })
        }
        try {
          saveJson(stateFile, state)
        } catch (error) {
          logger.warn('保存旧 state.json 失败（SQLite 已记录发送状态）: %s', error.message)
        }
        logger.info(
          'arXiv 日报已发送: %s, %d 篇, manual=%s, brief=%s, file=%s, fileSent=%s',
          report.result.date,
          report.result.papers.length,
          !!manual,
          briefMode,
          reportPath || 'off',
          fileSent,
        )
        return report.result
      }

      if (!manual) {
        recordDailyFailure(report.result.date, sendError || new Error('消息未发送'))
        saveJson(stateFile, state)
      }
      if (research && report.deliveryKey) {
        try {
          research.rejectDailyReport(report, sendError || new Error('消息未发送'))
        } catch (recordError) {
          logger.warn('记录日报失败状态时出错: %s', recordError.message)
        }
      }
      return null
    } catch (error) {
      if (report && research && report.deliveryKey) {
        try {
          research.rejectDailyReport(report, error)
        } catch (recordError) {
          logger.warn('记录日报失败状态时出错: %s', recordError.message)
        }
      }
      if (!manual) {
        const date = report && report.result ? report.result.date : formatDateParts(new Date(), cfg.timezone).date
        recordDailyFailure(date, error)
        saveJson(stateFile, state)
      }
      throw error
    } finally {
      running = false
    }
  }

  let weeklyRunning = false

  function recordWeeklyFailure(weekKey, error) {
    if (weeklyState.failedWeek !== weekKey) {
      weeklyState.failedWeek = weekKey
      weeklyState.failedCount = 0
    }
    weeklyState.failedCount = Number(weeklyState.failedCount || 0) + 1
    weeklyState.lastErrorAt = new Date().toISOString()
    weeklyState.lastError = String((error && error.message) || error || 'unknown').slice(0, 300)
  }

  async function runWeekly({ session, manual }) {
    const weeklyCfg = loadWeeklyConfig()
    if (!weeklyCfg) throw new Error('周报配置未加载')
    if (weeklyRunning) {
      if (session) await session.send('周报正在生成中，请稍等。')
      return null
    }
    weeklyRunning = true
    let report = null
    let sendError = null
    let deliveryKey = null
    try {
      const arxivCfg = loadArxivConfig()
      const ccfCfg = loadCcfConfig()
      const botCount = ctx.bots.filter((item) => item.platform === 'onebot').length
      report = await buildWeeklyReport(weeklyCfg, {
        now: new Date(),
        dataDir,
        arxivCfg,
        arxivState: state,
        ccfCfg,
        botCount,
      })
      deliveryKey = manual
        ? `${report.week.weekKey}:manual:${Date.now()}`
        : report.week.weekKey
      if (research) research.beginWeekly(deliveryKey)
      const delivery = weeklyCfg.delivery || {}
      const reportPath =
        delivery.saveMarkdown === false
          ? null
          : saveMarkdownReport(dataDir, 'weekly', report.week.weekKey, report.markdown)
      const briefMode = delivery.briefInChat !== false
      const sendFile = briefMode && delivery.sendMarkdownFile !== false && !!reportPath
      const brief = makeWeeklyBrief(report, { reportPath: sendFile ? null : reportPath })
      let messageOk = false
      let fileSent = false
      try {
        if (briefMode) {
          await sendChunks([brief], session, weeklyCfg.target)
          messageOk = true
          if (sendFile) {
            try {
              await sendFileTo(reportPath, session, weeklyCfg.target)
              fileSent = true
            } catch (error) {
              logger.warn('详细周报文件发送失败，改为完整分段: %s', error.message)
              try {
                await sendChunks(report.chunks, session, weeklyCfg.target)
              } catch (fallbackError) {
                sendError = fallbackError
                logger.error('详细周报回退分段也失败: %s', fallbackError.message)
              }
            }
          }
        } else {
          await sendChunks(report.chunks, session, weeklyCfg.target)
          messageOk = true
        }
      } catch (error) {
        sendError = error
        logger.error('周报推送失败: %s', error.message)
        if (session) await session.send(`周报推送失败：${error.message}`)
      }

      if (messageOk) {
        if (!manual) {
          weeklyState.lastRunWeek = report.week.weekKey
          weeklyState.failedWeek = null
          weeklyState.failedCount = 0
          weeklyState.lastErrorAt = null
          weeklyState.lastError = null
        }
        saveJson(weeklyStateFile, weeklyState)
        if (research) {
          research.commitWeekly(deliveryKey, {
            messageOk: true,
            fileOk: fileSent,
            reportPath,
            error: sendError || null,
          })
        }
        logger.info(
          '周报已发送: %s, brief=%s, file=%s, fileSent=%s',
          report.week.weekKey,
          briefMode,
          reportPath || 'off',
          fileSent,
        )
        return report
      }

      if (!manual) {
        recordWeeklyFailure(report.week.weekKey, sendError || new Error('周报消息未发送'))
        saveJson(weeklyStateFile, weeklyState)
      }
      if (research) {
        research.commitWeekly(deliveryKey, {
          messageOk: false,
          fileOk: false,
          reportPath: reportPath || null,
          error: sendError || new Error('周报消息未发送'),
        })
      }
      return null
    } catch (error) {
      if (!manual && report) {
        recordWeeklyFailure(report.week.weekKey, error)
        saveJson(weeklyStateFile, weeklyState)
      }
      if (research && report && deliveryKey) {
        try {
          research.commitWeekly(deliveryKey, {
            messageOk: false,
            fileOk: false,
            reportPath: null,
            error,
          })
        } catch (recordError) {
          logger.warn('记录周报失败状态时出错: %s', recordError.message)
        }
      }
      throw error
    } finally {
      weeklyRunning = false
    }
  }

  ctx.command('arxiv', '研究日报：个性化论文、会议与工具更新').action(() => {
    return [
      '研究日报（arXiv / CCFDDL / GitHub）',
      '· arxiv.今日 —— 立即生成简报并发送详细日报文件',
      '· arxiv.状态 —— 查看配置和上次发送',
      '· 脉络 <主题> —— 查研究方向演进',
      '· 周报 —— 天气、arXiv、会议、提醒的周报简讯和详细 MD',
    ].join('\n')
  })

  ctx
    .command('arxiv.今日', '立即生成研究日报并发送详细 MD')
    .alias('arxiv.today')
    .alias('日报')
    .action(async ({ session }) => {
      const cfg = loadArxivConfig()
      if (!cfg) return 'arXiv 配置未加载，请检查 config/arxiv.json。'
      if (!cfg.enabled) return 'arXiv 每日推送已关闭，请检查 config/arxiv.json。'
      await session.send('正在生成研究日报：采集 arXiv、筛选研究画像、增量分析、天气与会议，大约 1–2 分钟……')
      try {
        await runDigest({ session, manual: true })
      } catch (error) {
        logger.warn('手动生成失败: %s', error.message)
        return `arXiv 生成失败：${error.message}`
      }
      return
    })

  ctx
    .command('arxiv.状态', '查看 arXiv 推送状态')
    .alias('arxiv.status')
    .action(() => {
      const cfg = loadArxivConfig()
      if (!cfg) return 'arXiv 配置未加载，请检查 config/arxiv.json。'
      const ccfCfg = loadCcfConfig()
      const weeklyCfg = loadWeeklyConfig()
      const weeklyDay = Number(weeklyCfg && weeklyCfg.dayOfWeek) || 1
      const weeklyDayLabel = ['一', '二', '三', '四', '五', '六', '日'][weeklyDay - 1] || weeklyDay
      const target =
        cfg.target && cfg.target.type === 'group'
          ? '群（已配置）'
          : cfg.target && cfg.target.userId
            ? '私聊（已配置）'
            : '未配置'
      return [
        `研究日报：${cfg.enabled ? '开启' : '关闭'}${research ? `（Research Agent v2, ${research.profile.version}）` : '（旧管线）'}`,
        `时间：${cfg.time} ${cfg.timezone}`,
        `每次篇数：${cfg.maxPapers}`,
        `分类：${(cfg.categories || []).join(', ')}`,
        `目标：${target}`,
        `日报发送：${cfg.delivery && cfg.delivery.briefInChat === false ? '完整分段' : '简报 + 详细 MD'}`,
        `上次自动发送：${state.lastRunDate || '无'}`,
        `旧摘要缓存：${Object.keys(state.summaries || {}).length} 篇`,
        ...(research
          ? [
              `Research DB：${research.db.stats().papers.total} 篇，已分析 ${research.db.stats().papers.analyzed || 0}，历史摘要 ${research.db.stats().papers.legacy || 0}`,
              `日报送达：${
                research.db.latestDelivery('daily')
                  ? `${research.db.latestDelivery('daily').run_key} ${research.db.latestDelivery('daily').status}（消息 ${research.db.latestDelivery('daily').message_ok ? '成功' : '未确认'}，文件 ${research.db.latestDelivery('daily').file_ok ? '成功' : '未确认'}）`
                  : '无记录'
              }`,
            ]
          : []),
        `会议提醒：${ccfCfg && ccfCfg.enabled ? '开启' : '关闭'}`,
        `天气：${weeklyCfg && weeklyCfg.weather ? `${weeklyCfg.weather.city || '已配置'}（每日+周报）` : '未配置'}`,
        `周报：${weeklyCfg && weeklyCfg.enabled ? `开启，周${weeklyDayLabel} ${weeklyCfg.time}` : '关闭'}`,
      ].join('\n')
    })

  ctx.command('ccf', 'CCFDDL 会议截稿提醒').action(() => {
    return [
      'CCFDDL 会议截稿提醒',
      '· ccf.今日 —— 立即查看未来会议截稿',
      '· ccf.状态 —— 查看数据源和缓存',
    ].join('\n')
  })

  ctx
    .command('ccf.今日', '立即查看 CCFDDL 会议截稿')
    .alias('会议')
    .action(async ({ session }) => {
      const cfg = loadCcfConfig()
      if (!cfg) return 'CCFDDL 配置未加载，请检查 config/ccfddl.json。'
      await session.send('正在获取 CCFDDL 会议截稿……')
      try {
        const result = await buildCcfReminder({ ...cfg, enabled: true }, new Date())
        if (!result.chunks.length) return '未来一段时间暂无符合领域的会议截稿。'
        await sendChunks(result.chunks, session)
      } catch (error) {
        logger.warn('手动获取 CCFDDL 失败: %s', error.message)
        return `会议提醒获取失败：${error.message}`
      }
      return
    })

  ctx
    .command('ccf.状态', '查看 CCFDDL 状态')
    .alias('ccf.status')
    .action(() => {
      const cfg = loadCcfConfig()
      if (!cfg) return 'CCFDDL 配置未加载，请检查 config/ccfddl.json。'
      let updated = '无缓存'
      try {
        const cacheFile = cfg.cacheFile || path.join(dataDir, 'ccfddl-cache.json')
        const cache = loadJson(cacheFile, null)
        if (cache && cache.fetchedAt) updated = cache.fetchedAt
      } catch (error) {
        updated = '缓存读取失败'
      }
      return [
        `CCFDDL 提醒：${cfg.enabled ? '开启' : '关闭'}`,
        `数据源：${cfg.source || 'https://ccfddl.com/conference/initial.json'}`,
        `未来窗口：${cfg.lookaheadDays || 120} 天`,
        `每次条数：${cfg.maxItems || 10}`,
        `缓存更新时间：${updated}`,
      ].join('\n')
    })

  const lineageBuckets = new Map()
  const lineageCache = new Map()

  ctx
    .command('脉络 <topic:text>', '查研究方向的论文脉络')
    .action(async ({ session }, topic) => {
      const cfg = loadArxivConfig()
      if (!cfg) return 'arXiv 配置未加载，请检查 config/arxiv.json。'
      const query = String(topic || '').trim()
      if (!query) return '要查什么主题？例如：脉络 music generation'
      const userId = String(session.userId || session.username || 'unknown')
      if (!allowRate(lineageBuckets, `lineage:${userId}`, 3, 86400000)) {
        return '今天的脉络查询次数用完了，明天再试。'
      }
      const cacheKey = query.toLowerCase()
      const cached = lineageCache.get(cacheKey)
      if (cached && cached.expires > Date.now()) return cached.text
      try {
        const works = await openAlexSearch(query, cfg)
        if (!works.length) return `没找到「${query}」的相关论文。`
        const sorted = works
          .filter((work) => work && work.title && work.publication_year)
          .sort((a, b) => a.publication_year - b.publication_year)
        if (!sorted.length) return `没找到「${query}」的相关论文。`
        const list = sorted.slice(0, 12)
        const lines = [`【脉络】${query}`]
        for (const work of list) {
          lines.push(`${work.publication_year} · ${clean(work.title, 90)} · 引用 ${work.cited_by_count || 0}`)
        }
        let summary = ''
        try {
          summary = await deepseekChat(
            [
              {
                role: 'system',
                content:
                  '你是研究脉络助手。根据给出的论文列表，用中文写 3-4 句，概括这个方向的关键演进、转折和代表工作；不要编造列表之外的事实。',
              },
              {
                role: 'user',
                content: `主题：${query}\n论文列表：\n${list
                  .map((work) => `${work.publication_year} ${work.title}，引用 ${work.cited_by_count || 0}`)
                  .join('\n')}`,
              },
            ],
            cfg,
            {
              maxTokens: 800,
              temperature: 0.2,
              requestType: 'lineage_summary',
              onUsage: (meta) => {
                if (research) research.recordExternalUsage(meta)
              },
            },
          )
        } catch (error) {
          logger.warn('脉络总结失败: %s', error.message)
        }
        if (summary) lines.push(`总结：${summary}`)
        lines.push('来源：OpenAlex')
        const text = lines.join('\n')
        lineageCache.set(cacheKey, { text, expires: Date.now() + 6 * 3600000 })
        return text
      } catch (error) {
        logger.warn('脉络查询失败: %s', error.message)
        return `脉络查询失败：${error.message}`
      }
    })

  ctx
    .command('周报', '生成本周周报')
    .alias('weekly')
    .action(async ({ session }) => {
      const cfg = loadWeeklyConfig()
      if (!cfg) return '周报配置未加载，请检查 config/weekly.json。'
      await session.send('正在生成本周周报简讯和详细周报：天气、arXiv、会议和提醒……')
      try {
        await runWeekly({ session, manual: true })
      } catch (error) {
        logger.warn('手动生成周报失败: %s', error.message)
        return `周报生成失败：${error.message}`
      }
      return
    })

  const dailyTimer = setInterval(async () => {
    const cfg = loadArxivConfig()
    if (!cfg || !cfg.enabled) return
    try {
      const { date, time } = formatDateParts(new Date(), cfg.timezone)
      if (state.lastRunDate === date) return
      if (research) {
        const delivered = research.db.getDelivery('daily', date)
        if (delivered && delivered.message_ok) return
      }
      const scheduled = parseTime(cfg.time)
      const current = parseTime(time)
      if (scheduled == null || current == null) return
      if (current < scheduled) return
      const attempts =
        state.dailyAttempts && state.dailyAttempts.date === date
          ? Number(state.dailyAttempts.count) || 0
          : 0
      const maxAttempts = Number(cfg.maxDailyAttempts) || 3
      if (attempts >= maxAttempts) return
      if (attempts > 0) {
        const lastAt = Date.parse(state.dailyAttempts.lastAt || '')
        const waitMinutes = Math.min(30, 5 * attempts)
        if (Number.isFinite(lastAt) && Date.now() - lastAt < waitMinutes * 60000) return
      } else if (!cfg.runOnStartup && current > scheduled + (Number(cfg.catchupMinutes) || 30)) {
        return
      }
      logger.info('arXiv 定时任务触发: %s %s, attempt=%d', date, time, attempts + 1)
      await runDigest({ session: null, manual: false })
    } catch (error) {
      logger.warn('arXiv 定时任务失败: %s', error.message)
    }
  }, 60000)
  ctx.on('dispose', () => clearInterval(dailyTimer))

  const weeklyTimer = setInterval(async () => {
    const cfg = loadWeeklyConfig()
    if (!cfg || !cfg.enabled) return
    try {
      const week = getWeekInfo(new Date(), cfg.timezone)
      if (weeklyState.lastRunWeek === week.weekKey) return
      if (research) {
        const delivered = research.db.getDelivery('weekly', week.weekKey)
        if (delivered && delivered.message_ok) return
      }
      if (week.weekdayIndex !== Number(cfg.dayOfWeek || 1)) return
      const scheduled = parseTime(cfg.time)
      const current = parseTime(week.time)
      if (scheduled == null || current == null) return
      if (current < scheduled) return
      const attempts = weeklyState.failedWeek === week.weekKey ? Number(weeklyState.failedCount) || 0 : 0
      const maxAttempts = Number(cfg.maxWeeklyAttempts) || 3
      if (attempts >= maxAttempts) return
      if (attempts > 0) {
        const lastAt = Date.parse(weeklyState.lastErrorAt || '')
        const waitMinutes = Math.min(60, 15 * attempts)
        if (Number.isFinite(lastAt) && Date.now() - lastAt < waitMinutes * 60000) return
      } else if (!cfg.runOnStartup && current > scheduled + (cfg.catchupMinutes || 120)) {
        return
      }
      logger.info('周报定时任务触发: %s %s, attempt=%d', week.weekKey, week.time, attempts + 1)
      await runWeekly({ session: null, manual: false })
    } catch (error) {
      logger.warn('周报定时任务失败: %s', error.message)
    }
  }, 60000)
  ctx.on('dispose', () => clearInterval(weeklyTimer))
}

exports._test = {
  buildDigest,
  buildCcfReminder,
  buildDailyReport,
  buildWeeklyReport,
  makeDailyBrief,
  makeWeeklyBrief,
  saveMarkdownReport,
  deepseekChat,
  formatDateParts,
  getWeekInfo,
  openAlexSearch,
  parseTime,
}
