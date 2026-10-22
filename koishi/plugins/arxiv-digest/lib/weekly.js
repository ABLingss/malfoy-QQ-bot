'use strict'

const fs = require('fs')
const path = require('path')
const {
  fetchWithRetry,
  fetchArxivPapers,
  selectPapers,
  summarizePaper,
  mapLimit,
  formatDateParts,
  loadJson,
  clean,
  cleanText,
} = require('./arxiv')
const { buildCcfSection } = require('./ccfddl')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../../..')

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const WMO = {
  0: '晴',
  1: '基本晴',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '雷暴伴冰雹',
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function isoWeekOf(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7)
  return { year: target.getUTCFullYear(), week }
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function getWeekInfo(now, timezone) {
  const { date, time } = formatDateParts(now, timezone || 'Asia/Shanghai')
  const [year, month, day] = date.split('-').map(Number)
  const base = new Date(Date.UTC(year, month - 1, day))
  const weekdayIndex = base.getUTCDay() || 7
  const monday = new Date(base)
  monday.setUTCDate(base.getUTCDate() - weekdayIndex + 1)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const iso = isoWeekOf(base)
  return {
    date,
    time,
    weekdayIndex,
    weekdayLabel: WEEKDAYS[weekdayIndex - 1],
    weekKey: `${iso.year}-W${pad(iso.week)}`,
    weekNumber: iso.week,
    weekStart: formatUtcDate(monday),
    weekEnd: formatUtcDate(sunday),
    rangeLabel: `${formatUtcDate(monday)} 至 ${formatUtcDate(sunday)}`,
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days) return `${days} 天 ${hours} 小时`
  if (hours) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知'
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function readDigests(digestDir, days, timezone, now) {
  const today = formatDateParts(now, timezone).date
  const [year, month, day] = today.split('-').map(Number)
  const startDate = new Date(Date.UTC(year, month - 1, day))
  startDate.setUTCDate(startDate.getUTCDate() - Math.max(0, days - 1))
  const start = formatUtcDate(startDate)
  let files = []
  try {
    files = fs.readdirSync(digestDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { records: [], papers: [] }
  }
  const records = []
  for (const name of files) {
    const date = name.slice(0, 10)
    if (date < start || date > today) continue
    try {
      const record = loadJson(path.join(digestDir, name), null)
      if (record && Array.isArray(record.papers)) records.push(record)
    } catch (error) {
      console.warn(`[weekly] 读取 ${name} 失败: ${error.message}`)
    }
  }
  records.sort((left, right) => String(right.date).localeCompare(String(left.date)))
  const byId = new Map()
  for (const record of records) {
    for (const paper of record.papers) {
      if (!paper || !paper.id || byId.has(paper.id)) continue
      byId.set(paper.id, {
        ...paper,
        summaryText: paper.summary || paper.summaryText || '',
        matchedGroups: paper.matchedGroups || paper.groups || [],
        score: Number(paper.score) || 0,
      })
    }
  }
  return { records, papers: [...byId.values()] }
}

async function fetchWeather(weatherCfg) {
  const city = weatherCfg.city || '成都'
  let latitude = Number(weatherCfg.latitude)
  let longitude = Number(weatherCfg.longitude)
  let timezone = weatherCfg.timezone || 'Asia/Shanghai'
  let placeName = city
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const geoUrl =
      'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(city) +
      '&count=1&language=zh&format=json'
    const geoResponse = await fetchWithRetry(geoUrl, {
      headers: { 'User-Agent': 'arxiv-digest-qq/1.0' },
      timeout: 30000,
      retries: 1,
    })
    const geo = await geoResponse.json()
    const place = geo.results && geo.results[0]
    if (!place) throw new Error(`找不到城市：${city}`)
    latitude = place.latitude
    longitude = place.longitude
    timezone = weatherCfg.timezone || place.timezone || timezone
    placeName = place.name || city
  }
  const days = weatherCfg.forecastDays || 7
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' +
    encodeURIComponent(latitude) +
    '&longitude=' +
    encodeURIComponent(longitude) +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
    `&timezone=${encodeURIComponent(timezone)}&forecast_days=${days}`
  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'arxiv-digest-qq/1.0' },
    timeout: 30000,
    retries: 1,
  })
  const data = await response.json()
  const daily = data.daily
  if (!daily || !Array.isArray(daily.time)) throw new Error('天气数据格式异常')
  const lines = [`🌤 ${placeName} 未来 ${daily.time.length} 天天气`]
  for (let index = 0; index < daily.time.length; index += 1) {
    const date = daily.time[index]
    const weekday = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      weekday: 'short',
    }).format(new Date(`${date}T12:00:00Z`))
    const code = daily.weather_code && daily.weather_code[index]
    const high = daily.temperature_2m_max && daily.temperature_2m_max[index]
    const low = daily.temperature_2m_min && daily.temperature_2m_min[index]
    const rain = daily.precipitation_probability_max && daily.precipitation_probability_max[index]
    const wind = daily.wind_speed_10m_max && daily.wind_speed_10m_max[index]
    const label = WMO[code] || '未知'
    const temp = Number.isFinite(high) && Number.isFinite(low) ? `${Math.round(low)}~${Math.round(high)}°C` : '温度未知'
    const rainText = Number.isFinite(rain) ? `降水 ${rain}%` : '降水未知'
    const windText = Number.isFinite(wind) ? `风 ${Math.round(wind)} km/h` : '风未知'
    lines.push(`· ${date.slice(5)} ${weekday}：${label}，${temp}，${rainText}，${windText}`)
  }
  lines.push('数据：Open-Meteo')
  return lines.join('\n')
}

async function buildWeeklyArxiv(weeklyCfg, arxivCfg, state, now, digestDir) {
  const options = weeklyCfg.arxiv || {}
  const days = options.days || 7
  const cached = readDigests(digestDir, days, weeklyCfg.timezone, now)
  let papers = cached.papers
  if (papers.length < 3 && options.liveFallback !== false && arxivCfg) {
    try {
      const liveCfg = {
        ...arxivCfg,
        lookbackHours: 24 * 7,
        fallbackLookbackDays: 14,
        maxPapers: 30,
      }
      const fetched = await fetchArxivPapers(liveCfg)
      const selected = selectPapers(fetched, liveCfg).slice(0, 15)
      const live = await mapLimit(selected, 3, async (paper) => ({
        ...paper,
        summaryText: await summarizePaper(paper, arxivCfg, state),
        matchedGroups: paper.groups || [],
      }))
      const byId = new Map(papers.map((paper) => [paper.id, paper]))
      for (const paper of live) if (!byId.has(paper.id)) byId.set(paper.id, paper)
      papers = [...byId.values()]
    } catch (error) {
      console.warn(`[weekly] 实时补充 arXiv 失败: ${error.message}`)
    }
  }

  const maxPapers = options.maxPapers || 8
  const maxKeywords = options.maxKeywords || 8
  const sorted = papers
    .filter((paper) => paper && paper.title)
    .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
  const keywordCounts = new Map()
  for (const paper of sorted) {
    for (const group of paper.matchedGroups || []) {
      keywordCounts.set(group, (keywordCounts.get(group) || 0) + 1)
    }
  }
  const keywords = [...keywordCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxKeywords)
    .map(([label, count]) => `${label} ${count}`)
    .join('、')
  if (!sorted.length) {
    return {
      chunks: ['📚 近 7 天研究精选（arXiv）\n近 7 天暂无每日精选缓存，等每日推送积累后再看。'],
      papers: [],
      keywords: '',
    }
  }

  const header = [
    '📚 近 7 天研究精选（arXiv）',
    `近 7 天候选 ${sorted.length} 篇 · 精选 ${Math.min(maxPapers, sorted.length)} 篇`,
  ]
  if (keywords) header.push(`关键词热度：${keywords}`)
  const blocks = sorted.slice(0, maxPapers).map((paper, index) => {
    const tags = (paper.matchedGroups || []).length ? ` · ${paper.matchedGroups.join('、')}` : ''
    return [
      `${index + 1}. ${cleanText(paper.title)}${tags}`,
      cleanText(paper.summaryText || paper.summary),
      paper.url || `https://arxiv.org/abs/${paper.id}`,
    ].join('\n')
  })
  const chunkSize = weeklyCfg.chunkSize || 3
  const chunks = []
  for (let index = 0; index < blocks.length; index += chunkSize) {
    const part = blocks.slice(index, index + chunkSize)
    const prefix = index === 0 ? `${header.join('\n')}\n\n` : '近 7 天论文（续）\n\n'
    chunks.push(prefix + part.join('\n\n'))
  }
  if (chunks.length) chunks[chunks.length - 1] += '\n\n来源：arXiv'
  return { chunks, papers: sorted.slice(0, maxPapers), keywords }
}

function buildReminderSection(weeklyCfg, now) {
  const options = weeklyCfg.reminders || {}
  const target = weeklyCfg.target || {}
  if (target.type !== 'private' || !target.userId) return []
  let reminders = []
  try {
    reminders = loadJson(weeklyCfg.remindersFile || path.join(PROJECT_ROOT, 'data', 'reminders.json'), [])
  } catch (error) {
    console.warn(`[weekly] 读取提醒失败: ${error.message}`)
    return ['🔔 待办提醒\n提醒数据读取失败。']
  }
  const mine = (Array.isArray(reminders) ? reminders : [])
    .filter((reminder) => String(reminder.userId) === String(target.userId))
    .sort((left, right) => Number(left.due) - Number(right.due))
  if (!mine.length) return ['🔔 待办提醒\n本周没有待办提醒。']
  const lines = ['🔔 待办提醒']
  for (const reminder of mine.slice(0, options.maxItems || 10)) {
    const due = formatDateParts(new Date(Number(reminder.due)), weeklyCfg.timezone)
    const remaining = Number(reminder.due) - now.getTime()
    let suffix
    if (remaining <= 0) suffix = '已到期'
    else {
      const days = Math.ceil(remaining / 86400000)
      suffix = days <= 1 ? '今天' : `还剩 ${days} 天`
    }
    lines.push(`· #${reminder.id} ${due.date.slice(5)} ${due.time} — ${clean(reminder.content, 80)}（${suffix}）`)
  }
  return [lines.join('\n')]
}

function buildSystemSection(weeklyCfg, deps, week) {
  const lines = ['🛠 系统状态']
  const botCount = Number(deps.botCount) || 0
  lines.push(`· 机器人：${botCount ? `在线（${botCount} 个）` : '未连接'}`)
  lines.push(`· 运行：${formatDuration(process.uptime())}`)
  const memory = process.memoryUsage()
  lines.push(`· 内存：${(memory.rss / 1024 / 1024).toFixed(0)} MB`)
  try {
    const stat = fs.statfsSync(PROJECT_ROOT)
    const total = stat.blocks * stat.bsize
    const free = stat.bavail * stat.bsize
    lines.push(`· 磁盘：剩余 ${formatBytes(free)} / ${formatBytes(total)}`)
  } catch (error) {
    lines.push('· 磁盘：读取失败')
  }
  lines.push(`· 每日 arXiv：${(deps.arxivState && deps.arxivState.lastRunDate) || '无记录'}`)
  lines.push(`· 周报编号：${week.weekKey}`)
  return [lines.join('\n')]
}

async function buildWeeklyReport(weeklyCfg, deps = {}) {
  const now = deps.now || new Date()
  const week = getWeekInfo(now, weeklyCfg.timezone)
  const chunks = []
  chunks.push(
    [
      `🗓 第 ${week.weekNumber} 周周报 · ${week.rangeLabel}`,
      `今天：${week.date} ${week.weekdayLabel} · ${week.time} ${weeklyCfg.timezone}`,
    ].join('\n'),
  )

  let weatherText = ''
  const weatherCfg = weeklyCfg.weather || {}
  if (weatherCfg.enabled !== false) {
    try {
      weatherText = await fetchWeather(weatherCfg)
      chunks.push(weatherText)
    } catch (error) {
      console.warn(`[weekly] 天气获取失败: ${error.message}`)
      chunks.push(`🌤 天气\n获取失败：${error.message}`)
    }
  }

  let arxivResult = { chunks: [], papers: [], keywords: '' }
  const arxivCfg = weeklyCfg.arxiv || {}
  if (arxivCfg.enabled !== false && deps.arxivCfg) {
    try {
      const digestDir = path.join(deps.dataDir || path.join(PROJECT_ROOT, 'data', 'arxiv-digest'), 'digests')
      arxivResult = await buildWeeklyArxiv(weeklyCfg, deps.arxivCfg, deps.arxivState || {}, now, digestDir)
      chunks.push(...arxivResult.chunks)
    } catch (error) {
      console.warn(`[weekly] arXiv 周报失败: ${error.message}`)
      chunks.push('📚 近 7 天研究精选（arXiv）\n近 7 天论文汇总失败。')
    }
  }

  let ccfItems = []
  const ccfCfg = deps.ccfCfg
  const ccfOptions = weeklyCfg.ccf || {}
  if (ccfOptions.enabled !== false && ccfCfg) {
    try {
      const lookaheadDays = ccfOptions.lookaheadDays || 60
      const ccf = await buildCcfSection({ ...ccfCfg, enabled: true }, now, {
        lookaheadDays,
        maxItems: ccfOptions.maxItems || 8,
        header: `📅 未来 ${lookaheadDays} 天会议截稿`,
        intro: '按领域优先级和截止时间排序 · 数据：ccfddl.com',
        emptyText: `📅 未来 ${lookaheadDays} 天会议截稿\n暂无符合领域的会议截稿。`,
      })
      ccfItems = ccf.items
      chunks.push(...ccf.chunks)
    } catch (error) {
      console.warn(`[weekly] CCFDDL 周报失败: ${error.message}`)
      chunks.push('📅 会议截稿\nCCFDDL 数据获取失败。')
    }
  }

  if (weeklyCfg.reminders && weeklyCfg.reminders.enabled !== false) {
    chunks.push(...buildReminderSection(weeklyCfg, now))
  }
  if (weeklyCfg.system && weeklyCfg.system.enabled !== false) {
    chunks.push(...buildSystemSection(weeklyCfg, deps, week))
  }
  const bodyChunks = chunks.slice(1)
  const markdown = [
    `# 第 ${week.weekNumber} 周周报 · ${week.rangeLabel}`,
    '',
    `> ${week.date} ${week.weekdayLabel} · ${week.time} ${weeklyCfg.timezone}`,
    '',
    bodyChunks.join('\n\n---\n\n'),
    '',
    '---',
    '数据来源：arXiv、CCFDDL、OpenAlex、Open-Meteo；摘要由 DeepSeek 生成。',
  ].join('\n')
  const briefData = {
    week,
    weatherText,
    weatherCity: weatherCfg.city || '成都',
    ccfItems,
    papers: arxivResult.papers || [],
    keywords: arxivResult.keywords || '',
  }
  return { week, chunks, markdown, briefData }
}

module.exports = {
  getWeekInfo,
  isoWeekOf,
  fetchWeather,
  readDigests,
  buildWeeklyArxiv,
  buildReminderSection,
  buildSystemSection,
  buildWeeklyReport,
  formatDuration,
  formatBytes,
  WMO,
}
