'use strict'

const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../../..')
const { XMLParser } = require('fast-xml-parser')

const ARXIV_API = 'https://export.arxiv.org/api/query'
const OPENALEX_API = 'https://api.openalex.org'
const OPENCODE_DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/v1'

function opencodeChatUrl() {
  const base = (process.env.OPENCODE_BASE_URL || OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, '')
  return `${base}/chat/completions`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeRegex(source) {
  return String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
}

function clean(value, limit = 200) {
  return cleanText(value).slice(0, limit)
}

function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') return textOf(node['#text'])
  return ''
}

function formatDateParts(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type) => (parts.find((item) => item.type === type) || {}).value || '00'
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  }
}

function parseTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return fallback
  }
}

function saveJson(file, data) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.chmodSync(temp, 0o600)
  fs.renameSync(temp, file)
}

function matchTerm(text, term) {
  const needle = String(term || '').toLowerCase().trim()
  if (!needle) return false
  if (/^[a-z0-9]+$/.test(needle) && needle.length <= 4) {
    return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(text)
  }
  return text.includes(needle)
}

function parseArxivFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
  })
  const document = parser.parse(xml)
  const feed = document.feed || {}
  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : []
  return entries
    .map((entry) => {
      const idUrl = textOf(entry.id)
      const id = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')
      const authorNodes = Array.isArray(entry.author)
        ? entry.author
        : entry.author
          ? [entry.author]
          : []
      const authors = authorNodes.map((author) => cleanText(textOf(author.name))).filter(Boolean)
      const categoryNodes = Array.isArray(entry.category)
        ? entry.category
        : entry.category
          ? [entry.category]
          : []
      const categories = categoryNodes
        .map((category) => category && category['@_term'])
        .filter(Boolean)
      const published = new Date(textOf(entry.published))
      const updated = new Date(textOf(entry.updated))
      return {
        id,
        title: cleanText(textOf(entry.title)),
        summary: cleanText(textOf(entry.summary)),
        authors,
        categories,
        primaryCategory: categories[0] || '',
        published,
        updated,
        url: `https://arxiv.org/abs/${id}`,
      }
    })
    .filter((paper) => paper.id && paper.title && !Number.isNaN(paper.published.getTime()))
}

async function fetchWithRetry(url, options = {}) {
  const retries = options.retries == null ? 2 : options.retries
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeout || 45000)
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`)
        lastError.status = response.status
        if (attempt < retries) {
          await sleep(3500 * (attempt + 1))
          continue
        }
        throw lastError
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const error = new Error(`HTTP ${response.status} ${body.slice(0, 200)}`)
        error.status = response.status
        throw error
      }
      return response
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      if (error.name === 'AbortError') {
        lastError = new Error('请求超时')
      }
      if (attempt < retries && (error.name === 'AbortError' || error.status === 429 || error.status >= 500)) {
        await sleep(2500 * (attempt + 1))
        continue
      }
      throw lastError
    }
  }
  throw lastError || new Error('请求失败')
}

function parseArxivRss(xml, categoryHint) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
    removeNSPrefix: true,
  })
  const document = parser.parse(xml)
  const channel = (document.rss && document.rss.channel) || {}
  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : []
  return items
    .map((item) => {
      const link = cleanText(textOf(item.link))
      const guid = cleanText(textOf(item.guid))
      const idMatch = (link || guid).match(/arxiv\.org\/(?:abs|oai:arXiv\.org:)\/?([0-9]{4}\.[0-9]{4,5})/i)
      const id = idMatch ? idMatch[1] : ''
      const rawDescription = cleanText(textOf(item.description))
      const abstractIndex = rawDescription.indexOf('Abstract:')
      const summary = cleanText(
        (abstractIndex >= 0 ? rawDescription.slice(abstractIndex + 9) : rawDescription).replace(/<[^>]+>/g, ' '),
      )
      const categoryNodes = Array.isArray(item.category)
        ? item.category
        : item.category
          ? [item.category]
          : []
      const categories = categoryNodes.map((category) => cleanText(textOf(category))).filter(Boolean)
      const authors = cleanText(textOf(item.creator))
        .split(/,\s*/)
        .map((name) => cleanText(name))
        .filter(Boolean)
      const published = new Date(textOf(item.pubDate))
      const announceType = cleanText(textOf(item.announce_type))
      return {
        id,
        title: cleanText(textOf(item.title)),
        summary,
        authors,
        categories,
        primaryCategory: categories[0] || categoryHint || '',
        published,
        updated: published,
        url: link || (id ? `https://arxiv.org/abs/${id}` : ''),
        announceType,
      }
    })
    .filter(
      (paper) =>
        paper.id &&
        paper.title &&
        paper.url &&
        !Number.isNaN(paper.published.getTime()) &&
        paper.announceType !== 'replace',
    )
}

async function fetchArxivRss(category) {
  const url = `https://rss.arxiv.org/rss/${encodeURIComponent(category)}`
  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'arxiv-digest-qq/1.0' },
    timeout: 45000,
    retries: 1,
  })
  return parseArxivRss(await response.text(), category)
}

async function fetchArxivCategoryApi(category, maxResults) {
  const url =
    `${ARXIV_API}?search_query=cat:${encodeURIComponent(category)}` +
    `&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`
  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'arxiv-digest-qq/1.0' },
    timeout: 45000,
  })
  return parseArxivFeed(await response.text())
}

async function fetchArxivCategory(category, maxResults) {
  try {
    const rss = await fetchArxivRss(category)
    if (rss.length) return rss
  } catch (error) {
    console.warn(`[arxiv] RSS ${category} failed: ${error.message}`)
  }
  return fetchArxivCategoryApi(category, maxResults)
}

async function fetchArxivPapers(cfg) {
  const categories = cfg.categories || []
  const maxResults = cfg.maxResultsPerCategory || 100
  const all = []
  for (let index = 0; index < categories.length; index += 1) {
    try {
      const papers = await fetchArxivCategory(categories[index], maxResults)
      all.push(...papers)
    } catch (error) {
      console.warn(`[arxiv] category ${categories[index]} failed: ${error.message}`)
    }
    if (index < categories.length - 1) await sleep(3500)
  }
  const byId = new Map()
  for (const paper of all) if (!byId.has(paper.id)) byId.set(paper.id, paper)
  const now = Date.now()
  const cutoff = now - (cfg.lookbackHours || 48) * 3600000
  const fallbackCutoff = now - (cfg.fallbackLookbackDays || 7) * 86400000
  let papers = [...byId.values()].filter((paper) => paper.published.getTime() >= cutoff)
  if (papers.length < (cfg.maxPapers || 20)) {
    const selected = new Set(papers.map((paper) => paper.id))
    const extra = [...byId.values()].filter(
      (paper) => paper.published.getTime() >= fallbackCutoff && !selected.has(paper.id),
    )
    papers = papers.concat(extra)
  }
  return papers
}

function scorePaper(paper, cfg) {
  const title = paper.title.toLowerCase()
  const abstract = paper.summary.toLowerCase()
  const text = `${title} ${abstract}`
  if ((cfg.excludeTerms || []).some((term) => matchTerm(text, term))) {
    return { score: -1, groups: [] }
  }
  const audioCategories = cfg.audioCategories || ['eess.AS', 'cs.SD', 'cs.MM']
  const hasAudio =
    (cfg.audioTerms || []).some((term) => matchTerm(text, term)) ||
    audioCategories.includes(paper.primaryCategory)
  if (!hasAudio) return { score: -1, groups: [] }

  let score = 1
  if (audioCategories.includes(paper.primaryCategory)) score += 1
  const groups = []
  for (const group of cfg.keywordGroups || []) {
    let hit = false
    let titleHit = false
    for (const term of group.terms || []) {
      if (matchTerm(title, term)) {
        score += (group.weight || 1) * 2
        hit = true
        titleHit = true
        break
      }
    }
    if (!titleHit) {
      for (const term of group.terms || []) {
        if (matchTerm(abstract, term)) {
          score += group.weight || 1
          hit = true
          break
        }
      }
    }
    if (hit) groups.push(group.label)
  }
  const ageHours = (Date.now() - paper.published.getTime()) / 3600000
  if (ageHours <= 24) score += 2
  else if (ageHours <= 48) score += 1
  return { score, groups }
}

function selectPapers(papers, cfg) {
  const scored = papers
    .map((paper) => ({ ...paper, ...scorePaper(paper, cfg) }))
    .filter((paper) => paper.score > 0)
  scored.sort((a, b) => b.score - a.score || b.published - a.published)
  return scored.slice(0, cfg.maxPapers || 20)
}

async function deepseekChat(messages, cfg, options = {}) {
  const key = process.env.OPENCODE_API_KEY
  if (!key) throw new Error('OPENCODE_API_KEY 未配置')
  const payload = {
    model: options.model || cfg.model || 'deepseek-flash',
    messages,
    max_tokens: options.maxTokens || 300,
    temperature: options.temperature == null ? 0.2 : options.temperature,
    thinking: { type: 'disabled' },
  }
  const started = Date.now()
  const response = await fetchWithRetry(opencodeChatUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'x-opencode-session': `${process.env.OPENCODE_SESSION || 'qq-bot'}:arxiv`,
      'User-Agent': 'qq-bot/1.0',
    },
    body: JSON.stringify(payload),
    timeout: 60000,
    retries: 1,
  })
  const data = await response.json()
  if (typeof options.onUsage === 'function') {
    try {
      options.onUsage({
        model: payload.model,
        usage: data.usage || {},
        latencyMs: Date.now() - started,
        requestType: options.requestType || 'legacy_chat',
      })
    } catch (error) {
      console.warn(`[arxiv] usage callback failed: ${error.message}`)
    }
  }
  const message = data.choices && data.choices[0] && data.choices[0].message
  const content = message && (message.content || message.reasoning_content)
  if (!content) throw new Error('模型没有返回内容')
  return String(content).trim()
}

async function summarizePaper(paper, cfg, state) {
  state.summaries = state.summaries || {}
  if (state.summaries[paper.id]) return state.summaries[paper.id]
  const abstract = cleanText(paper.summary).slice(0, 3000)
  let summary
  try {
    summary = await deepseekChat(
      [
        {
          role: 'system',
          content:
            '你是论文摘要助手。用中文写 2-3 句，总字数控制在 80-150 字，说明研究问题、方法、主要结果或亮点。不要编造，不要写套话，不要列局限清单，只输出摘要正文。',
        },
        {
          role: 'user',
          content: `标题：${paper.title}\n分类：${paper.primaryCategory}\n摘要：${abstract}`,
        },
      ],
      cfg,
      { maxTokens: cfg.maxSummaryTokens || 180, temperature: 0.2 },
    )
  } catch (error) {
    console.warn(`[arxiv] summary failed for ${paper.id}: ${error.message}`)
    summary = cleanText(paper.summary).slice(0, 220)
  }
  state.summaries[paper.id] = summary
  return summary
}

async function fetchOpenAlex(url, cfg) {
  let target = url
  if (cfg.openAlexEmail) {
    const parsed = new URL(url)
    parsed.searchParams.set('mailto', cfg.openAlexEmail)
    target = parsed.toString()
  }
  try {
    const response = await fetchWithRetry(target, {
      headers: { 'User-Agent': 'arxiv-digest-qq/1.0' },
      timeout: 30000,
      retries: 1,
    })
    return response
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

async function getLineage(paper, cfg, state) {
  state.lineage = state.lineage || {}
  if (state.lineage[paper.id]) return state.lineage[paper.id]
  const result = []
  try {
    const doi = `10.48550/arXiv.${paper.id}`
    const response = await fetchOpenAlex(`${OPENALEX_API}/works/https://doi.org/${doi}`, cfg)
    if (!response) return []
    const work = await response.json()
    const refs = work.referenced_works && work.referenced_works.length
      ? work.referenced_works
      : work.related_works || []
    const ids = refs
      .map((item) => String(item).split('/').pop())
      .filter(Boolean)
      .slice(0, 6)
    if (!ids.length) return []
    const batchUrl =
      `${OPENALEX_API}/works?filter=ids.openalex:${ids.join('|')}` +
      '&per-page=25&select=id,title,publication_year,cited_by_count,doi'
    const batchResponse = await fetchOpenAlex(batchUrl, cfg)
    if (!batchResponse) return []
    const batch = await batchResponse.json()
    const paperYear = paper.published.getFullYear()
    const related = (batch.results || [])
      .filter((item) => item && item.title)
      .map((item) => ({
        title: cleanText(item.title),
        year: item.publication_year || null,
        doi: item.doi || '',
        citations: item.cited_by_count || 0,
      }))
    const prior = related.filter((item) => item.year && item.year <= paperYear)
    const chosen = (prior.length ? prior : related)
      .sort((left, right) => (right.citations || 0) - (left.citations || 0) || (left.year || 0) - (right.year || 0))
      .slice(0, cfg.lineageRefs || 2)
    result.push(...chosen)
  } catch (error) {
    console.warn(`[arxiv] lineage failed for ${paper.id}: ${error.message}`)
  }
  if (result.length) state.lineage[paper.id] = result
  return result
}

async function openAlexSearch(topic, cfg) {
  const url =
    `${OPENALEX_API}/works?search=${encodeURIComponent(topic)}` +
    '&filter=from_publication_date:2018-01-01' +
    '&sort=relevance_score:desc&per-page=15' +
    '&select=id,title,publication_year,cited_by_count,doi'
  const response = await fetchOpenAlex(url, cfg)
  if (!response) return []
  const data = await response.json()
  return data.results || []
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run)
  await Promise.all(workers)
  return results
}

function formatPaperBlock(paper, index) {
  const authors = paper.authors && paper.authors.length
    ? `${paper.authors.slice(0, 3).join('、')}${paper.authors.length > 3 ? ' 等' : ''}`
    : '未知作者'
  const lineage = (paper.lineage || [])
    .map((item) => `${clean(item.title, 70)} · ${item.year || '?'} · 引用 ${item.citations || 0}`)
    .join('；')
  return [
    `${index + 1}. ${clean(paper.title, 180)}`,
    authors,
    `arXiv: ${paper.url}`,
    `摘要：${clean(paper.summaryText || paper.summary, 300)}`,
    `脉络：${lineage || '暂无'}`,
  ].join('\n')
}

async function buildDigest(cfg, state) {
  const papers = await fetchArxivPapers(cfg)
  if (!papers.length) throw new Error('没有抓到符合条件的 arXiv 论文')
  const selected = selectPapers(papers, cfg)
  if (!selected.length) throw new Error('没有论文通过 audio 相关性筛选')

  const withSummaries = await mapLimit(
    selected,
    cfg.maxConcurrentSummaries || 3,
    async (paper) => ({ ...paper, summaryText: await summarizePaper(paper, cfg, state) }),
  )
  for (const paper of withSummaries) {
    paper.lineage = cfg.lineageEnabled ? await getLineage(paper, cfg, state) : []
    await sleep(350)
  }

  const { date } = formatDateParts(new Date(), cfg.timezone)
  const labels = (cfg.keywordGroups || []).map((group) => group.label).join(' / ')
  const header = [
    `📚 arXiv 泛 Audio 每日精选 · ${date}`,
    `今天 ${withSummaries.length} 篇 · 关键词：${labels}`,
  ].join('\n')
  const blocks = withSummaries.map((paper, index) => formatPaperBlock(paper, index))
  const chunkSize = cfg.chunkSize || 4
  const chunks = []
  for (let index = 0; index < blocks.length; index += chunkSize) {
    const part = blocks.slice(index, index + chunkSize)
    const prefix = index === 0 ? `${header}\n\n` : 'arXiv 精选（续）\n\n'
    chunks.push(prefix + part.join('\n\n'))
  }
  if (chunks.length) {
    chunks[chunks.length - 1] += '\n\n回复「脉络 <主题>」可查研究方向演进。'
  }

  const dataDir = cfg.dataDir || path.join(PROJECT_ROOT, 'data', 'arxiv-digest')
  ensureDir(path.join(dataDir, 'digests'))
  const record = {
    date,
    generatedAt: new Date().toISOString(),
    categories: cfg.categories,
    keywords: labels,
    papers: withSummaries.map((paper) => ({
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      url: paper.url,
      published: paper.published.toISOString(),
      score: paper.score,
      matchedGroups: paper.groups,
      summary: paper.summaryText,
      lineage: paper.lineage,
    })),
  }
  saveJson(path.join(dataDir, 'digests', `${date}.json`), record)
  fs.writeFileSync(path.join(dataDir, 'digests', `${date}.md`), chunks.join('\n\n---\n\n'), {
    mode: 0o600,
  })
  return { date, papers: withSummaries, chunks, record }
}

module.exports = {
  parseArxivFeed,
  parseArxivRss,
  fetchWithRetry,
  fetchArxivRss,
  fetchArxivCategory,
  fetchArxivCategoryApi,
  fetchArxivPapers,
  scorePaper,
  selectPapers,
  deepseekChat,
  summarizePaper,
  getLineage,
  openAlexSearch,
  buildDigest,
  mapLimit,
  formatPaperBlock,
  formatDateParts,
  parseTime,
  loadJson,
  saveJson,
  clean,
  cleanText,
  sleep,
}
