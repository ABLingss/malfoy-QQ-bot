'use strict'

const fs = require('fs')
const path = require('path')
const { buildDigest, clean } = require('./arxiv')
const { fetchWeather, getWeekInfo } = require('./weekly')
const { buildCcfReminder } = require('./ccfddl')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../../..')

function daysUntil(date, now = Date.now()) {
  return Math.ceil((date.getTime() - now) / 86400000)
}

function formatCcfBrief(item, now = Date.now()) {
  const days = daysUntil(item.earliest.date, now)
  const when = item.earliest.raw.slice(5, 10)
  return `${item.title} ${when}（${days <= 1 ? '今天' : `${days} 天`}）`
}

function truncate(text, limit) {
  const value = clean(text, limit + 1)
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function weatherOneLine(weatherText) {
  const first = String(weatherText || '')
    .split('\n')
    .find((line) => line.startsWith('·'))
  if (!first) return ''
  return first
    .replace(/^·\s*\d{2}-\d{2}\s*\S+：\s*/, '')
    .replace(/^·\s*/, '')
    .trim()
}

function displayPath(file) {
  if (!file) return ''
  const relative = path.relative(PROJECT_ROOT, file)
  return relative.startsWith('..') ? file : relative
}

async function buildDailyReport(arxivCfg, deps = {}) {
  const now = deps.now || new Date()
  const state = deps.state || { summaries: {}, lineage: {} }
  const weeklyCfg = deps.weeklyCfg || {}
  const ccfCfg = deps.ccfCfg

  const result = await buildDigest(arxivCfg, state)
  const week = getWeekInfo(now, arxivCfg.timezone || 'Asia/Shanghai')
  const dateText = `🗓 ${week.date} ${week.weekdayLabel} · 第 ${week.weekNumber} 周 · ${week.rangeLabel}`

  let weatherText = ''
  const weatherCfg = weeklyCfg.weather
  if (weatherCfg && weatherCfg.enabled !== false) {
    try {
      weatherText = await fetchWeather({
        ...weatherCfg,
        forecastDays: weatherCfg.dailyDays || 3,
      })
    } catch (error) {
      console.warn(`[report] 每日天气获取失败: ${error.message}`)
    }
  }

  let ccfChunks = []
  let ccfItems = []
  if (ccfCfg && ccfCfg.enabled) {
    try {
      const ccf = await buildCcfReminder(ccfCfg, now)
      ccfChunks = ccf.chunks
      ccfItems = ccf.items
    } catch (error) {
      console.warn(`[report] CCFDDL 会议提醒失败: ${error.message}`)
    }
  }

  const header = weatherText ? `${dateText}\n\n${weatherText}` : dateText
  const chunks = [header, ...ccfChunks, ...result.chunks]
  const markdownLines = [
    `# arXiv 泛 Audio 日报 · ${result.date}`,
    '',
    `> ${dateText}`,
    '',
  ]
  if (weatherText) {
    markdownLines.push('## 天气', '', weatherText, '')
  }
  if (ccfChunks.length) {
    markdownLines.push('## 会议截稿', '', ccfChunks.join('\n\n'), '')
  }
  markdownLines.push('## arXiv 精选', '', result.chunks.join('\n\n'), '')
  markdownLines.push('---', '')
  markdownLines.push('数据来源：arXiv、CCFDDL、OpenAlex、Open-Meteo；摘要由 DeepSeek 生成。')
  const markdown = markdownLines.join('\n')

  return {
    result,
    week,
    dateText,
    weatherText,
    weatherCity: weatherCfg && weatherCfg.city ? weatherCfg.city : '成都',
    ccfItems,
    chunks,
    markdown,
  }
}

function makeDailyBrief(report, options = {}) {
  const now = options.now || Date.now()
  const lines = [
    `🗓 ${report.week.date} ${report.week.weekdayLabel} · 第 ${report.week.weekNumber} 周`,
  ]
  const weather = weatherOneLine(report.weatherText)
  if (weather) lines.push(`🌤 ${report.weatherCity || '成都'}：${weather}`)
  if (report.ccfItems && report.ccfItems.length) {
    lines.push(
      `📅 近期截稿：${report.ccfItems
        .slice(0, options.maxConferences || 3)
        .map((item) => formatCcfBrief(item, now))
        .join('｜')}`,
    )
  } else {
    lines.push('📅 近期暂无会议截稿')
  }
  const papers = report.result.papers || []
  const top3 = report.top3 || []
  if (top3.length) {
    lines.push(`🎯 今日 Top ${top3.length}`)
    top3.forEach((item, index) => {
      const paper = item.paper || item
      const analysis = item.analysis || {}
      const reason = analysis.recommendation || analysis.summary || ''
      lines.push(`${index + 1}. ${truncate(paper.title, 48)}`)
      if (reason) lines.push(`   ${truncate(reason, 90)}`)
    })
    lines.push(`📚 今日共 ${papers.length} 篇候选，详细分析见文件。`)
  } else if (papers.length) {
    lines.push(
      `📚 今日 ${papers.length} 篇：${papers
        .slice(0, options.maxPapers || 3)
        .map((paper) => truncate(paper.title, 50))
        .join('；')}`,
    )
    lines.push('今日没有达到 Top 3 推荐标准的论文。')
  } else {
    lines.push('📚 今日暂无 arXiv 精选')
  }
  if (options.reportPath) {
    lines.push(`📄 详细日报：${displayPath(options.reportPath)}`)
  }
  return lines.join('\n')
}

function makeWeeklyBrief(report, options = {}) {
  const now = options.now || Date.now()
  const data = report.briefData || {}
  const week = report.week || data.week
  const lines = [`🗓 第 ${week.weekNumber} 周周报 · ${week.rangeLabel}`]
  const weather = weatherOneLine(data.weatherText)
  if (weather) lines.push(`🌤 ${data.weatherCity || '成都'}：${weather}`)
  const papers = data.papers || []
  const keywordText = data.keywords ? ` · 热词：${data.keywords}` : ''
  lines.push(`📚 近 7 天 ${papers.length} 篇${keywordText}`)
  if (data.ccfItems && data.ccfItems.length) {
    lines.push(
      `📅 近期截稿：${data.ccfItems
        .slice(0, options.maxConferences || 3)
        .map((item) => formatCcfBrief(item, now))
        .join('｜')}`,
    )
  } else {
    lines.push('📅 未来 60 天暂无会议截稿')
  }
  if (options.reportPath) {
    lines.push(`📄 详细周报：${displayPath(options.reportPath)}`)
  }
  return lines.join('\n')
}

function saveMarkdownReport(dataDir, kind, name, content) {
  const dir = path.join(dataDir || path.join(PROJECT_ROOT, 'data', 'arxiv-digest'), 'reports', kind)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${name}.md`)
  fs.writeFileSync(file, content, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  const latest = path.join(dir, 'latest.md')
  fs.writeFileSync(latest, content, { mode: 0o600 })
  fs.chmodSync(latest, 0o600)
  return file
}

module.exports = {
  buildDailyReport,
  makeDailyBrief,
  makeWeeklyBrief,
  saveMarkdownReport,
  formatCcfBrief,
  weatherOneLine,
  truncate,
  displayPath,
}
