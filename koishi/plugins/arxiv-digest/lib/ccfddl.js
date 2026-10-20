'use strict'

const path = require('path')
const { fetchWithRetry, loadJson, saveJson, clean } = require('./arxiv')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../../..')

const DEFAULT_SOURCE = 'https://ccfddl.com/conference/initial.json'
const DEFAULT_CACHE = path.join(PROJECT_ROOT, 'data', 'arxiv-digest', 'ccfddl-cache.json')

function parseTimezoneOffset(timezone) {
  const value = String(timezone || '').trim()
  if (!value) return 0
  if (/^aoe$/i.test(value)) return -12
  if (/^utc$/i.test(value)) return 0
  const match = value.match(/^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/i)
  if (match) {
    const sign = match[1] === '+' ? 1 : -1
    return sign * (Number(match[2]) + Number(match[3] || 0) / 60)
  }
  const zones = {
    PT: -8,
    PST: -8,
    PDT: -7,
    ET: -5,
    EST: -5,
    EDT: -4,
    CT: -6,
    CST: -6,
    CDT: -5,
    MT: -7,
    MDT: -6,
    CET: 1,
    CEST: 2,
    BST: 1,
    JST: 9,
    KST: 9,
    IST: 5.5,
  }
  return zones[value.toUpperCase()] == null ? null : zones[value.toUpperCase()]
}

function parseDeadline(raw, timezone) {
  if (!raw || /^tbd$/i.test(String(raw).trim())) return null
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return null
  const offset = parseTimezoneOffset(timezone)
  if (offset == null) return null
  const wall = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
  )
  const date = new Date(wall - offset * 3600000)
  return {
    date,
    raw: `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`,
    timezone: String(timezone || 'UTC'),
  }
}

function matchFields(conference, cfg) {
  const haystack = `${conference.title || ''} ${conference.description || ''} ${conference.sub || ''}`.toLowerCase()
  return (cfg.fields || []).filter((field) =>
    (field.terms || []).some((term) => haystack.includes(String(term).toLowerCase())),
  )
}

function rankAllowed(rank, fields, cfg) {
  const include = cfg.includeRanks || ['A', 'B', 'C']
  if (include.includes(rank)) return true
  if (rank === 'N' && cfg.includeUnrankedForCoreFields !== false) {
    return fields.some((field) => (field.priority || 0) >= 8)
  }
  return false
}

function selectUpcoming(data, cfg, now = Date.now()) {
  const lookaheadMs = (cfg.lookaheadDays || 120) * 86400000
  const excluded = new Set((cfg.excludeTitles || []).map((title) => String(title).toLowerCase()))
  const items = []
  for (const conference of data.conferences || []) {
    if (!conference || !conference.title) continue
    if (excluded.has(String(conference.title).toLowerCase())) continue
    const fields = matchFields(conference, cfg)
    if (!fields.length) continue
    const rank = (conference.rank && conference.rank.ccf) || 'N'
    if (!rankAllowed(rank, fields, cfg)) continue

    let best = null
    for (const conf of conference.confs || []) {
      for (const timeline of conf.timeline || []) {
        const abstract = parseDeadline(timeline.abstract_deadline, conf.timezone)
        const full = parseDeadline(timeline.deadline, conf.timezone)
        const future = [abstract, full].filter(
          (deadline) =>
            deadline &&
            deadline.date.getTime() > now &&
            deadline.date.getTime() <= now + lookaheadMs,
        )
        if (!future.length) continue
        const earliest = future.reduce((left, right) => (left.date < right.date ? left : right))
        if (!best || earliest.date < best.earliest.date) {
          best = { earliest, abstract, full, conf, timeline }
        }
      }
    }
    if (!best) continue

    items.push({
      title: conference.title,
      description: conference.description || '',
      rank,
      sub: conference.sub || '',
      fields,
      priority: Math.max(...fields.map((field) => field.priority || 0)),
      year: best.conf.year || '',
      conf: best.conf,
      timeline: best.timeline,
      abstract: best.abstract,
      full: best.full,
      earliest: best.earliest,
      date: best.conf.date || '',
      place: best.conf.place || '',
      link: best.conf.link || '',
    })
  }

  items.sort((left, right) => {
    if (cfg.preferFieldPriority !== false && right.priority !== left.priority) {
      return right.priority - left.priority
    }
    return left.earliest.date - right.earliest.date
  })
  return items.slice(0, cfg.maxItems || 10)
}

function formatBeijingTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

function formatDeadline(deadline, now = Date.now()) {
  if (!deadline) return '未公布'
  const raw = `${deadline.raw} ${deadline.timezone}`
  const remaining = deadline.date.getTime() - now
  if (remaining <= 0) return `${raw}（已截止）`
  const days = Math.ceil(remaining / 86400000)
  const countdown = days <= 1 ? '今天截止' : `还剩 ${days} 天`
  return `${raw}（北京时间 ${formatBeijingTime(deadline.date)}，${countdown}）`
}

function formatItem(item, now = Date.now()) {
  const fields = item.fields.map((field) => field.label).join('、')
  const lines = [
    `· ${item.title} ${item.year} · ${fields} · CCF ${item.rank === 'N' ? 'N' : item.rank}`,
    `  摘要：${formatDeadline(item.abstract, now)}`,
    `  全文：${formatDeadline(item.full, now)}`,
  ]
  if (item.date || item.place) {
    lines.push(`  会议：${[item.date, item.place].filter(Boolean).join(' · ')}`)
  }
  if (item.link) lines.push(`  官网：${item.link}`)
  return lines.join('\n')
}

async function fetchCcfData(cfg) {
  const source = cfg.source || DEFAULT_SOURCE
  const cacheFile = cfg.cacheFile || DEFAULT_CACHE
  let cached = null
  try {
    cached = loadJson(cacheFile, null)
  } catch (error) {
    cached = null
  }
  try {
    const response = await fetchWithRetry(source, {
      headers: { 'User-Agent': 'arxiv-digest-qq/1.0' },
      timeout: 45000,
      retries: 1,
    })
    const data = await response.json()
    if (!data || !Array.isArray(data.conferences)) throw new Error('CCFDDL 数据格式异常')
    saveJson(cacheFile, { fetchedAt: new Date().toISOString(), data })
    return data
  } catch (error) {
    if (cached && cached.data && Array.isArray(cached.data.conferences)) {
      const age = Date.now() - Date.parse(cached.fetchedAt || 0)
      if (Number.isFinite(age) && age <= 7 * 86400000) {
        console.warn(`[ccfddl] 在线获取失败，使用本地缓存: ${error.message}`)
        return cached.data
      }
    }
    throw error
  }
}

async function buildCcfSection(cfg, now = new Date(), options = {}) {
  if (!cfg || !cfg.enabled) return { chunks: [], items: [] }
  const effective = {
    ...cfg,
    lookaheadDays: options.lookaheadDays == null ? cfg.lookaheadDays : options.lookaheadDays,
    maxItems: options.maxItems == null ? cfg.maxItems : options.maxItems,
    chunkSize: options.chunkSize == null ? cfg.chunkSize : options.chunkSize,
  }
  const data = await fetchCcfData(effective)
  const items = selectUpcoming(data, effective, now.getTime())
  if (!items.length) {
    return { chunks: options.emptyText ? [options.emptyText] : [], items: [] }
  }
  const header = options.header || `📅 CCFDDL 会议截稿提醒 · 未来 ${effective.lookaheadDays || 120} 天`
  const intro = options.intro === undefined ? '按领域优先级和截止时间排序 · 数据：ccfddl.com' : options.intro
  const headerText = intro ? `${header}\n${intro}` : header
  const blocks = items.map((item) => formatItem(item, now.getTime()))
  const chunkSize = effective.chunkSize || 4
  const chunks = []
  for (let index = 0; index < blocks.length; index += chunkSize) {
    const part = blocks.slice(index, index + chunkSize)
    const prefix = index === 0 ? `${headerText}\n\n` : '会议提醒（续）\n\n'
    chunks.push(prefix + part.join('\n\n'))
  }
  const footer = options.footer === undefined
    ? '\n\n数据来源：CCFDDL（ccfddl.com），截止时间以官网为准。'
    : options.footer
  if (chunks.length && footer) chunks[chunks.length - 1] += footer
  return { chunks, items }
}

async function buildCcfReminder(cfg, now = new Date()) {
  return buildCcfSection(cfg, now)
}

module.exports = {
  fetchCcfData,
  selectUpcoming,
  buildCcfSection,
  buildCcfReminder,
  parseDeadline,
  parseTimezoneOffset,
  formatDeadline,
  formatItem,
  formatBeijingTime,
  matchFields,
  clean,
  path,
}
