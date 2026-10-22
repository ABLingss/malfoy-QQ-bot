'use strict'

const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../../../..')
const {
  fetchArxivPapers,
  fetchWithRetry,
  parseArxivFeed,
  formatDateParts,
  saveJson,
} = require('../arxiv')
const { fetchWeather, getWeekInfo, buildWeeklyReport } = require('../weekly')
const { buildCcfReminder } = require('../ccfddl')
const { makeDailyBrief, makeWeeklyBrief, saveMarkdownReport } = require('../report')
const { ResearchDatabase } = require('./db')
const {
  createProfileLoader,
  directionById,
  matchDirections,
  preliminaryScores,
  scoreAnalysis,
} = require('./profile')
const {
  cleanText,
  canonicalArxivId,
  sha256,
  truncate,
  nowIso,
  parseDate,
  estimateTokens,
} = require('./text')
const {
  PROMPT_VERSION,
  DeepSeekResearchClient,
  BudgetError,
  LlmError,
  startOfZonedDay,
  startOfZonedWeek,
  parsePricePeriod,
  calculateCost,
} = require('./llm')
const { GitHubMonitor } = require('./github')
const {
  writePaperNote,
  writeReproductionNote,
  writeResearchQuestionsNote,
  ensureKnowledgeDirs,
} = require('./knowledge')
const render = require('./render')

const DEFAULT_ROOT = PROJECT_ROOT

function makeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function atomicWrite(file, content) {
  makeDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.chmodSync(temp, 0o600)
  fs.renameSync(temp, file)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return fallback
  }
}

function localDate(now, timezone) {
  return formatDateParts(now, timezone || 'Asia/Shanghai').date
}

function uniqueById(items) {
  const map = new Map()
  for (const item of items || []) {
    if (item && item.id != null) map.set(item.id, item)
  }
  return [...map.values()]
}

function isSubstantive(paper) {
  return Boolean(
    paper &&
    paper.substantive_update_at &&
    (!paper.pushed_at || paper.substantive_update_at > paper.pushed_at),
  )
}

function sortByScore(items) {
  return [...items].sort((left, right) => {
    const a = Number(left.score_total == null ? 0 : left.score_total)
    const b = Number(right.score_total == null ? 0 : right.score_total)
    if (b !== a) return b - a
    return String(right.published_at || right.last_seen_at || '').localeCompare(
      String(left.published_at || left.last_seen_at || ''),
    )
  })
}

function nextRetryIso(attempts) {
  const delays = [60000, 300000, 1800000]
  return new Date(Date.now() + (delays[Math.min(attempts, delays.length - 1)] || 1800000)).toISOString()
}

function taskErrorMessage(error) {
  return cleanText(error && error.message ? error.message : error).slice(0, 1500)
}

class ResearchService {
  constructor(options = {}) {
    this.root = options.root || DEFAULT_ROOT
    this.logger = options.logger || console
    this.profileFile =
      options.profileFile || path.join(this.root, 'config', 'research-profile.json')
    this.dataDir = options.dataDir || path.join(this.root, 'data', 'research-agent')
    this.dbFile = options.dbFile || path.join(this.dataDir, 'research.db')
    this.loadProfile = createProfileLoader(this.profileFile)
    this.profile = this.loadProfile()
    makeDir(this.dataDir)
    this.db = options.db || new ResearchDatabase(this.dbFile)
    this.knowledgeRoot =
      options.knowledgeRoot ||
      (this.profile.knowledge && this.profile.knowledge.root) ||
      path.join(this.root, 'knowledge')
    ensureKnowledgeDirs(this.knowledgeRoot)
    this.arxivFetch = options.arxivFetch || ((cfg) => fetchArxivPapers(cfg))
    this.arxivMetadataFetch = options.arxivMetadataFetch || ((url, opts) => fetchWithRetry(url, opts))
    this.llm =
      options.llm ||
      new DeepSeekResearchClient({
        profile: this.profile,
        db: this.db,
        logger: this.logger,
        fetchImpl: options.fetchImpl,
        apiKey: options.apiKey,
      })
    this.github =
      options.github ||
      new GitHubMonitor({
        profile: this.profile,
        db: this.db,
        logger: this.logger,
        fetchImpl: options.githubFetchImpl || options.fetchImpl,
        token: options.githubToken,
      })
    this.notifier = null
    this.fileNotifier = null
    this.workerTimer = null
    this.workerBusy = false
    this.started = false
    this.recoveredTasks = this.db.recoverTasks()
    for (const repo of (this.profile.github && this.profile.github.repositories) || []) {
      this.db.upsertRepository(repo)
    }
    this.recomputeDirections()
    this.recomputeScores()
  }

  recomputeDirections() {
    const rows = this.db.db
      .prepare('SELECT id, title, abstract, published_at, raw_json, analysis_status FROM papers')
      .all()
    const update = this.db.db.prepare(
      'UPDATE papers SET direction_tags_json = ?, primary_direction = ? WHERE id = ?',
    )
    let changed = 0
    this.db.transaction(() => {
      for (const row of rows) {
        try {
          let raw = {}
          try {
            raw = JSON.parse(row.raw_json || '{}')
          } catch (error) {
            raw = {}
          }
          const matches = matchDirections(
            {
              title: row.title,
              abstract: row.abstract,
              primaryCategory: raw.primaryCategory || '',
              categories: raw.categories || [],
            },
            this.profile,
          )
          const tags = JSON.stringify(matches.map((match) => match.id))
          const primary = matches[0] ? matches[0].id : null
          if (row.analysis_status === 'completed' || row.analysis_status === 'legacy') {
            update.run(tags, primary, row.id)
          } else {
            this.db.setPreliminaryScores(
              row.id,
              preliminaryScores(
                { title: row.title, abstract: row.abstract, publishedAt: row.published_at },
                this.profile,
              ),
            )
            // setPreliminaryScores 使用 COALESCE 保留旧方向，这里强制写入最新匹配结果（包括清空）。
            update.run(tags, primary, row.id)
          }
          changed += 1
        } catch (error) {
          this.logger.warn && this.logger.warn('重算论文方向失败 %s: %s', row.id, error.message)
        }
      }
    })
    return changed
  }

  recomputeScores() {
    const rows = this.db.db
      .prepare("SELECT id, score_json FROM papers WHERE analysis_status = 'completed' AND score_json IS NOT NULL")
      .all()
    const update = this.db.db.prepare('UPDATE papers SET score_json = ?, score_total = ? WHERE id = ?')
    let changed = 0
    this.db.transaction(() => {
      for (const row of rows) {
        try {
          const scores = JSON.parse(row.score_json)
          const recomputed = scoreAnalysis(scores, this.profile)
          update.run(JSON.stringify(recomputed), recomputed.total, row.id)
          changed += 1
        } catch (error) {
          this.logger.warn && this.logger.warn('重算论文分数失败 %s: %s', row.id, error.message)
        }
      }
    })
    return changed
  }

  refreshProfile() {
    const previousVersion = this.profile && this.profile.version
    this.profile = this.loadProfile()
    this.llm.profile = this.profile
    this.github.profile = this.profile
    this.github.config = this.profile.github || {}
    if (previousVersion !== this.profile.version) this.recomputeDirections()
    this.recomputeScores()
    return this.profile
  }

  startWorker(intervalMs = 4000) {
    if (this.workerTimer) return
    this.started = true
    this.workerTimer = setInterval(() => this.tick().catch(() => {}), intervalMs)
    if (this.workerTimer.unref) this.workerTimer.unref()
    setTimeout(() => this.tick().catch(() => {}), 1200).unref?.()
  }

  stopWorker() {
    if (this.workerTimer) clearInterval(this.workerTimer)
    this.workerTimer = null
    this.started = false
  }

  setNotifier(fn) {
    this.notifier = fn
  }

  setFileNotifier(fn) {
    this.fileNotifier = fn
  }

  close() {
    this.stopWorker()
    if (this.db) this.db.close()
  }

  get enabled() {
    return Boolean(this.profile && this.profile.researchDirections && this.profile.researchDirections.length)
  }

  directionMap() {
    const map = new Map()
    for (const direction of this.profile.researchDirections || []) map.set(direction.id, direction)
    return map
  }

  directionLabel(id) {
    const direction = this.directionMap().get(id)
    return direction ? direction.label : id || '未分类'
  }

  userRankScore(paper) {
    const base = Number(paper && paper.score_total)
    if (!Number.isFinite(base)) return 0
    const directions = this.profile.researchDirections || []
    const maxWeight = Math.max(0.0001, ...directions.map((direction) => Number(direction.weight) || 0))
    const direction = this.directionMap().get(paper.primary_direction)
    const weight = direction ? Number(direction.weight) || 0 : 0
    const boost = Number(this.profile.scoring.directionBoost) || 10
    return base + (weight / maxWeight) * boost
  }

  sortForUser(items) {
    return [...items].sort((left, right) => {
      const diff = this.userRankScore(right) - this.userRankScore(left)
      if (diff) return diff
      return String(right.published_at || right.last_seen_at || '').localeCompare(
        String(left.published_at || left.last_seen_at || ''),
      )
    })
  }

  inputHash(paper, forceNonce) {
    return sha256(
      [
        paper.abstract_hash || '',
        PROMPT_VERSION,
        this.profile.version || '',
        this.profile.model || 'deepseek-flash',
        'full-v1',
        forceNonce || '',
      ].join('|'),
    )
  }

  async ingestArxiv(arxivCfg, { now = new Date() } = {}) {
    const fetched = await this.arxivFetch(arxivCfg)
    const byKey = new Map()
    for (const raw of fetched || []) {
      const arxivId = canonicalArxivId(raw.id || raw.arxivId || raw.url || '')
      if (!arxivId) continue
      byKey.set(`arxiv:${arxivId}`, raw)
    }
    const results = []
    for (const [canonicalKey, raw] of byKey.entries()) {
      const arxivId = canonicalArxivId(raw.id || raw.arxivId || raw.url || '')
      const abstract = cleanText(raw.summary || raw.abstract || '')
      const published = raw.published instanceof Date ? raw.published : parseDate(raw.published)
      const matches = matchDirections(
        {
          title: raw.title,
          abstract,
          primaryCategory: raw.primaryCategory || '',
          categories: raw.categories || [],
        },
        this.profile,
      )
      const preliminary = preliminaryScores(
        {
          title: raw.title,
          abstract,
          publishedAt: published ? published.toISOString() : null,
        },
        this.profile,
        now,
      )
      const upserted = this.db.upsertPaper({
        canonicalKey,
        arxivId,
        title: raw.title,
        abstract,
        authors: raw.authors || [],
        publishedAt: published ? published.toISOString() : null,
        updatedAt: raw.updated ? new Date(raw.updated).toISOString() : null,
        version: raw.version || null,
        url: raw.url || `https://arxiv.org/abs/${arxivId}`,
        source: 'arxiv',
        categories: raw.categories || [],
        primaryCategory: raw.primaryCategory || '',
        directionTags: matches.map((match) => match.id),
        primaryDirection: matches[0] ? matches[0].id : null,
        raw: {
          primaryCategory: raw.primaryCategory || '',
          categories: raw.categories || [],
          announceType: raw.announceType || null,
        },
      })
      if (upserted.abstractChanged) this.db.markAnalysisStale(upserted.id, '摘要内容发生变化，等待增量分析')
      this.db.setPreliminaryScores(upserted.id, preliminary)
      results.push({
        row: this.db.getPaperById(upserted.id),
        isNew: upserted.isNew,
        abstractChanged: upserted.abstractChanged,
        matches,
        preliminary,
      })
    }
    return results
  }

  async analyzeRows(rows, { taskId = null, now = new Date() } = {}) {
    const stats = { cacheHits: 0, newCalls: 0, failed: 0, deferred: 0, valid: 0, errors: [] }
    const candidates = []
    for (const row of rows) {
      if (!row || !row.abstract || row.abstract.length < 80) continue
      if (row.analysis_status === 'completed' || row.analysis_status === 'legacy') continue
      const hash = this.inputHash(row)
      const cached = this.db.getAnalysisByInputHash(row.id, hash, 'full')
      if (cached) {
        stats.cacheHits += 1
        this.db.setAnalysisStatus(row.id, 'completed')
        continue
      }
      candidates.push(row)
    }
    const batchSize = this.profile.scoring.analysisBatchSize
    for (let index = 0; index < candidates.length; index += batchSize) {
      const batch = candidates.slice(index, index + batchSize)
      let response
      try {
        response = await this.llm.analyzeBatch(batch, { taskId, now })
        stats.newCalls += 1
      } catch (error) {
        const category = error.category || 'analysis'
        for (const paper of batch) {
          if (error instanceof BudgetError || category === 'budget' || category === 'balance') {
            this.db.setAnalysisDeferred(paper.id, taskErrorMessage(error))
            stats.deferred += 1
          } else {
            this.db.setAnalysisFailure(paper.id, taskErrorMessage(error), category)
            stats.failed += 1
          }
        }
        stats.errors.push(`${category}: ${taskErrorMessage(error)}`)
        this.logger.warn && this.logger.warn('批量论文分析失败: %s', taskErrorMessage(error))
        if (category === 'invalid_json' && batch.length > 1 && !(error instanceof BudgetError)) {
          const repairPaper = batch[0]
          try {
            const repaired = await this.llm.repairAnalysis(repairPaper, { taskId, now })
            stats.newCalls += 1
            if (repaired.valid[0]) {
              this.persistAnalysis(repairPaper, repaired.valid[0].analysis, repaired.api)
              stats.valid += 1
              stats.failed = Math.max(0, stats.failed - 1)
            }
          } catch (repairError) {
            stats.errors.push(`repair batch-first: ${taskErrorMessage(repairError)}`)
          }
        }
        continue
      }
      const byId = new Map(batch.map((paper) => [paper.arxiv_id, paper]))
      for (const item of response.valid) {
        const paper = byId.get(item.id)
        if (!paper) continue
        try {
          this.persistAnalysis(paper, item.analysis, response.api)
          stats.valid += 1
        } catch (error) {
          this.db.setAnalysisFailure(paper.id, taskErrorMessage(error), 'persist')
          stats.failed += 1
          stats.errors.push(`persist ${item.id}: ${taskErrorMessage(error)}`)
        }
      }
      const invalid = response.invalid.slice(0, 2)
      for (const item of response.invalid.slice(2)) {
        const paper = byId.get(item.id)
        if (!paper) continue
        this.db.setAnalysisFailure(paper.id, `结果校验失败: ${item.reason}`, 'invalid_json')
        stats.failed += 1
      }
      for (const item of invalid) {
        const paper = byId.get(item.id)
        if (!paper) continue
        try {
          const repaired = await this.llm.repairAnalysis(paper, { taskId, now })
          stats.newCalls += 1
          const valid = repaired.valid[0]
          if (valid) {
            this.persistAnalysis(paper, valid.analysis, repaired.api)
            stats.valid += 1
          } else {
            this.db.setAnalysisFailure(paper.id, `结果校验失败: ${item.reason}`, 'invalid_json')
            stats.failed += 1
          }
        } catch (error) {
          this.db.setAnalysisFailure(paper.id, taskErrorMessage(error), error.category || 'repair')
          stats.failed += 1
          stats.errors.push(`repair ${item.id}: ${taskErrorMessage(error)}`)
        }
      }
    }
    return stats
  }

  persistAnalysis(paper, analysis, api, options = {}) {
    const hash = this.inputHash(paper, options.forceNonce)
    const merged = {
      ...analysis,
      directionTags: (analysis.directionTags && analysis.directionTags.length)
        ? analysis.directionTags
        : (paper.directionTags || []),
    }
    const saved = this.db.saveAnalysis(paper.id, merged, {
      inputHash: hash,
      analysisType: 'full',
      promptVersion: PROMPT_VERSION,
      profileVersion: this.profile.version,
      model: this.profile.model || 'deepseek-flash',
    })
    const updated = this.db.getPaperById(paper.id)
    try {
      const note = writePaperNote({
        root: this.knowledgeRoot,
        paper: updated,
        analysis: saved || this.db.getLatestAnalysis(paper.id),
        logger: this.logger,
      })
      if (note.changed) {
        this.logger.debug && this.logger.debug('知识库论文页已更新: %s', note.file)
      }
    } catch (error) {
      this.logger.warn && this.logger.warn('写知识库失败 %s: %s', paper.arxiv_id, error.message)
    }
    return { saved, api }
  }

  async fetchArxivMetadata(arxivId) {
    const id = canonicalArxivId(arxivId)
    if (!id) return null
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`
    const response = await this.arxivMetadataFetch(url, {
      headers: { 'User-Agent': 'research-agent-qq/1.0' },
      timeout: 45000,
      retries: 1,
    })
    const papers = parseArxivFeed(await response.text())
    return papers[0] || null
  }

  async ensurePaperAnalysis(paper, { taskId = null, force = false, now = new Date() } = {}) {
    let current = this.db.getPaperById(paper.id)
    if (!force && current.analysis_status === 'completed') {
      return { cached: true, paper: current, analysis: this.db.getLatestAnalysis(current.id) }
    }
    if ((!current.abstract || current.abstract.length < 80) && current.arxiv_id) {
      try {
        const metadata = await this.fetchArxivMetadata(current.arxiv_id)
        if (metadata) {
          const matches = matchDirections(
            {
              title: metadata.title,
              abstract: metadata.summary,
              categories: metadata.categories || [],
            },
            this.profile,
          )
          this.db.upsertPaper({
            canonicalKey: current.canonical_key,
            arxivId: current.arxiv_id,
            title: metadata.title,
            abstract: metadata.summary,
            authors: metadata.authors || [],
            publishedAt: metadata.published.toISOString(),
            updatedAt: metadata.updated.toISOString(),
            url: metadata.url,
            source: 'arxiv',
            directionTags: matches.map((match) => match.id),
            primaryDirection: matches[0] ? matches[0].id : current.primary_direction,
            categories: metadata.categories || [],
          })
          current = this.db.getPaperById(current.id)
        }
      } catch (error) {
        this.logger.warn && this.logger.warn('补齐 arXiv 元数据失败 %s: %s', current.arxiv_id, error.message)
      }
    }
    if (!current.abstract || current.abstract.length < 80) {
      const error = new Error('这篇论文没有可用摘要，无法进行基于摘要的分析')
      error.category = 'no_abstract'
      throw error
    }
    if (!force) {
      const hash = this.inputHash(current)
      const cached = this.db.getAnalysisByInputHash(current.id, hash, 'full')
      if (cached) {
        this.db.setAnalysisStatus(current.id, 'completed')
        return { cached: true, paper: this.db.getPaperById(current.id), analysis: cached }
      }
    }
    const response = await this.llm.analyzeBatch([current], { taskId, now })
    const valid = response.valid[0]
    if (!valid) {
      const error = new Error('模型返回的分析没有通过校验')
      error.category = 'invalid_json'
      throw error
    }
    const result = this.persistAnalysis(current, valid.analysis, response.api, {
      forceNonce: force ? `force:${Date.now()}` : null,
    })
    return {
      cached: false,
      paper: this.db.getPaperById(current.id),
      analysis: result.saved,
      api: response.api,
    }
  }

  async buildDailyReport(arxivCfg, deps = {}) {
    try {
      this.refreshProfile()
    } catch (error) {
      this.logger.warn && this.logger.warn('研究画像热加载失败，继续使用内存版本: %s', error.message)
    }
    const now = deps.now || new Date()
    const timezone = arxivCfg.timezone || this.profile.timezone || 'Asia/Shanghai'
    const date = localDate(now, timezone)
    const deliveryKey = date
    this.db.recordDelivery('daily', deliveryKey, { status: 'running' })
    let ingestResults
    try {
      ingestResults = await this.ingestArxiv(arxivCfg, { now })
      this.db.updateDelivery('daily', deliveryKey, { collect_ok: true })
    } catch (error) {
      this.db.updateDelivery('daily', deliveryKey, {
        status: 'failed',
        collect_ok: false,
        error_category: error.category || 'collect',
        last_error: taskErrorMessage(error),
        finished: true,
      })
      throw error
    }
    if (!ingestResults.length) {
      const error = new Error('没有抓到符合条件的 arXiv 论文')
      error.category = 'empty_collect'
      this.db.updateDelivery('daily', deliveryKey, {
        status: 'failed',
        collect_ok: false,
        error_category: 'empty_collect',
        last_error: error.message,
        finished: true,
      })
      throw error
    }

    const poolIds = ingestResults.map((item) => item.row.id)
    let pool = this.db.getPapersByIds(poolIds)
    pool = pool.filter(
      (paper) =>
        !['ignored'].includes(paper.read_status) &&
        (!['read', 'reproduce'].includes(paper.read_status) || isSubstantive(paper)),
    )
    const pooledAnalysisCandidates = pool.filter(
      (paper) =>
        (!paper.pushed_at || paper.substantive_update_at > paper.pushed_at) &&
        paper.analysis_status !== 'completed' &&
        paper.analysis_status !== 'legacy' &&
        Number(paper.analysis_attempts || 0) < Number(this.profile.scoring.maxAnalysisAttempts || 3) &&
        paper.abstract &&
        paper.abstract.length >= 80,
    )
    // 先取全量待分析队列，再按“方向权重 + 初筛分”排序，避免高权重方向被历史低权重论文挤掉名额。
    const backlogCandidates = this.sortForUser(
      this.db.papersForAnalysis({
        limit: 2000,
        maxAttempts: this.profile.scoring.maxAnalysisAttempts || 3,
      }),
    ).slice(0, this.profile.scoring.dailyAnalysisLimit)
    const analysisCandidates = this.sortForUser(
      uniqueById([...pooledAnalysisCandidates, ...backlogCandidates]),
    ).slice(0, this.profile.scoring.dailyAnalysisLimit)
    let analysisStats = { cacheHits: 0, newCalls: 0, failed: 0, deferred: 0, valid: 0, errors: [] }
    if (analysisCandidates.length) {
      analysisStats = await this.analyzeRows(analysisCandidates, { now })
    }
    this.db.updateDelivery('daily', deliveryKey, {
      analyze_ok: analysisStats.failed === 0 && analysisStats.deferred === 0,
    })

    let githubResult = { enabled: false, events: [], repositories: [] }
    if (this.profile.github && this.profile.github.enabled) {
      try {
        githubResult = await this.github.syncAll()
      } catch (error) {
        this.logger.warn && this.logger.warn('GitHub 同步失败: %s', error.message)
        githubResult.error = taskErrorMessage(error)
      }
    }

    const latestRows = this.db.getPapersByIds(poolIds)
    const rankedPool = this.sortForUser(
      latestRows.filter(
        (paper) =>
          !['ignored'].includes(paper.read_status) &&
          (!['read', 'reproduce'].includes(paper.read_status) || isSubstantive(paper)) &&
          (!paper.pushed_at || paper.substantive_update_at > paper.pushed_at),
      ),
    )
    const maxPapers = Math.max(1, Number(arxivCfg.maxPapers) || 20)
    const fullPapers = this.selectDiverse(rankedPool, maxPapers, 8)
    const topCandidates = this.sortForUser(
      this.db
        .candidatesForDaily({ limit: 80, includePushed: false })
        .filter((paper) => paper.analysis_status === 'completed')
        .filter((paper) => Number(paper.score_total || 0) >= this.profile.scoring.minTopScore),
    )
    const top3 = []
    const directionCount = new Map()
    for (const paper of topCandidates) {
      if (top3.length >= this.profile.scoring.topN) break
      const direction = paper.primary_direction || 'other'
      const count = directionCount.get(direction) || 0
      if (count >= this.profile.scoring.maxPerDirectionInTop) continue
      const analysis = this.db.getLatestAnalysis(paper.id)
      if (!analysis || analysis.analysis_type !== 'full') continue
      if (!analysis.summary || !analysis.evidence_boundary) continue
      top3.push({ paper: this.attachDirectionLabel(paper), analysis })
      directionCount.set(direction, count + 1)
    }
    const mergedFull = uniqueById(
      this.sortForUser(
        [...top3.map((item) => item.paper), ...fullPapers].filter(Boolean),
      ),
    ).slice(0, maxPapers)
    for (const paper of mergedFull) {
      try {
        writePaperNote({
          root: this.knowledgeRoot,
          paper,
          analysis: this.db.getLatestAnalysis(paper.id),
          logger: this.logger,
        })
      } catch (error) {
        this.logger.warn && this.logger.warn('写知识库失败 %s: %s', paper.arxiv_id, error.message)
      }
    }
    const week = getWeekInfo(now, timezone)
    const dateText = `🗓 ${week.date} ${week.weekdayLabel} · 第 ${week.weekNumber} 周 · ${week.rangeLabel}`

    let weatherText = ''
    const weatherCfg = deps.weeklyCfg && deps.weeklyCfg.weather
    if (weatherCfg && weatherCfg.enabled !== false) {
      try {
        weatherText = await fetchWeather({
          ...weatherCfg,
          forecastDays: weatherCfg.dailyDays || 3,
        })
      } catch (error) {
        this.logger.warn && this.logger.warn('每日天气获取失败: %s', error.message)
      }
    }
    let ccfChunks = []
    let ccfItems = []
    const ccfCfg = deps.ccfCfg
    if (ccfCfg && ccfCfg.enabled) {
      try {
        const ccf = await buildCcfReminder(ccfCfg, now)
        ccfChunks = ccf.chunks
        ccfItems = ccf.items
      } catch (error) {
        this.logger.warn && this.logger.warn('会议提醒失败: %s', error.message)
      }
    }

    const githubEvents = (githubResult.events || []).slice(
      0,
      (this.profile.github && this.profile.github.maxInDaily) || 3,
    )
    const githubText = githubEvents.length ? this.github.formatEvents(githubEvents, githubEvents.length) : ''
    const generatedAt = now.toISOString()
    const top3ForRender = top3.map((item) => ({
      paper: item.paper,
      analysis: item.analysis,
    }))
    const markdown = render.buildDailyMarkdown({
      date,
      week,
      weatherText,
      ccfChunks,
      top3: top3ForRender,
      fullPapers: mergedFull,
      githubText,
      analysisStats,
      generatedAt,
    })
    const chunks = render.buildDailyChunks({
      date,
      week,
      top3: top3ForRender,
      fullPapers: mergedFull,
      weatherText,
      ccfChunks,
      githubText,
    })
    const digestDir = path.join(arxivCfg.dataDir || this.dataDir, 'digests')
    makeDir(digestDir)
    const record = {
      version: 2,
      date,
      generatedAt,
      profileVersion: this.profile.version,
      categories: arxivCfg.categories || [],
      keywords: this.profile.researchDirections.map((direction) => direction.label).join(' / '),
      top3: top3ForRender.map((item) => ({
        paper: item.paper,
        analysis: item.analysis,
      })),
      papers: mergedFull.map((paper) => ({
        id: paper.arxiv_id || paper.canonical_key,
        title: paper.title,
        authors: paper.authors || [],
        url: paper.url || (paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : ''),
        published: paper.published_at,
        score: paper.score_total,
        scores: paper.scores,
        matchedGroups: paper.directionTags || [],
        primaryDirection: paper.primary_direction,
        summary: paper.summary || paper.abstract,
        analysisStatus: paper.analysis_status,
        pushedAt: paper.pushed_at,
      })),
      conferenceItems: ccfItems.length,
      githubEvents: githubEvents.map((event) => ({
        eventKey: event.event_key,
        title: event.title,
        importance: event.importance,
        url: event.url,
      })),
      analysisStats,
      candidateCount: rankedPool.length,
      paperIds: mergedFull.map((paper) => paper.id),
      top3Ids: top3.map((item) => item.paper.id),
      githubEventIds: githubEvents.map((event) => event.id),
    }
    saveJson(path.join(digestDir, `${date}.json`), record)
    atomicWrite(path.join(digestDir, `${date}.md`), markdown)
    try {
      const knowledgeDigestDir = path.join(this.knowledgeRoot, 'daily-digests')
      atomicWrite(path.join(knowledgeDigestDir, `${date}.md`), markdown)
      atomicWrite(path.join(knowledgeDigestDir, 'latest.md'), markdown)
    } catch (error) {
      this.logger.warn && this.logger.warn('写知识库日报失败: %s', error.message)
    }
    this.db.updateDelivery('daily', deliveryKey, {
      report_ok: true,
      report_path: path.join(digestDir, `${date}.md`),
      status: 'report_ready',
    })
    return {
      result: {
        date,
        papers: mergedFull,
        stats: analysisStats,
        candidateCount: rankedPool.length,
      },
      week,
      dateText,
      weatherText,
      weatherCity: weatherCfg && weatherCfg.city ? weatherCfg.city : '成都',
      ccfItems,
      ccfChunks,
      top3: top3ForRender,
      fullPapers: mergedFull,
      githubEvents,
      githubText,
      chunks,
      markdown,
      record,
      deliveryKey,
      analysisStats,
      paperIds: mergedFull.map((paper) => paper.id),
      top3Ids: top3.map((item) => item.paper.id),
    }
  }

  selectDiverse(papers, max, perDirection) {
    const result = []
    const counts = new Map()
    const directions = this.profile.researchDirections || []
    const maxWeight = Math.max(0.0001, ...directions.map((item) => Number(item.weight) || 0))
    const capFor = (directionId) => {
      const direction = this.directionMap().get(directionId)
      const weight = direction ? Number(direction.weight) || 0 : 0
      if (weight <= 0) return 1
      return Math.max(1, Math.round((Number(perDirection) || 8) * Math.min(1, weight / maxWeight)))
    }
    for (const paper of papers) {
      const direction = paper.primary_direction || 'other'
      const count = counts.get(direction) || 0
      if (count >= capFor(direction)) continue
      result.push(paper)
      counts.set(direction, count + 1)
      if (result.length >= max) break
    }
    if (result.length < max) {
      const seen = new Set(result.map((paper) => paper.id))
      for (const paper of papers) {
        if (seen.has(paper.id)) continue
        result.push(paper)
        if (result.length >= max) break
      }
    }
    return result
  }

  attachDirectionLabel(paper) {
    return { ...paper, direction_label: this.directionLabel(paper.primary_direction) }
  }

  beginWeekly(weekKey) {
    return this.db.recordDelivery('weekly', weekKey, { status: 'running' })
  }

  commitWeekly(weekKey, { messageOk, fileOk, reportPath, error } = {}) {
    return this.db.updateDelivery('weekly', weekKey, {
      status: messageOk ? (fileOk ? 'sent' : 'sent_without_file') : 'failed',
      collect_ok: true,
      analyze_ok: true,
      report_ok: Boolean(reportPath),
      message_ok: Boolean(messageOk),
      file_ok: Boolean(fileOk),
      report_path: reportPath || null,
      error_category: error ? error.category || 'send' : null,
      last_error: error ? taskErrorMessage(error) : null,
      finished: true,
    })
  }

  commitDailyReport(report, { messageOk, fileOk, error } = {}) {
    const now = nowIso()
    if (messageOk) {
      this.db.markPushed(report.paperIds || [], nowIso())
      this.db.markRepositoryEventsNotified((report.githubEvents || []).map((event) => event.id))
    }
    const status = messageOk ? (fileOk ? 'sent' : 'sent_without_file') : 'failed'
    return this.db.updateDelivery('daily', report.deliveryKey, {
      status,
      message_ok: Boolean(messageOk),
      file_ok: Boolean(fileOk),
      error_category: error ? error.category || 'send' : null,
      last_error: error ? taskErrorMessage(error) : null,
      finished: true,
      updated_at: now,
    })
  }

  rejectDailyReport(report, error) {
    return this.db.updateDelivery('daily', report.deliveryKey, {
      status: 'failed',
      error_category: error ? error.category || 'send' : 'send',
      last_error: taskErrorMessage(error),
      finished: true,
    })
  }

  readDigest(date) {
    const digestDir = path.join(this.root, 'data', 'arxiv-digest', 'digests')
    if (date) {
      const record = readJson(path.join(digestDir, `${date}.json`), null)
      if (record) return record
    }
    let files = []
    try {
      files = fs
        .readdirSync(digestDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .sort()
    } catch (error) {
      return null
    }
    if (!files.length) return null
    return readJson(path.join(digestDir, files[files.length - 1]), null)
  }

  todayDigest() {
    return this.readDigest(localDate(new Date(), this.profile.timezone))
  }

  reportPathForDigest(digest) {
    if (!digest || !digest.date) return null
    const dataDir = path.join(this.root, 'data', 'arxiv-digest')
    const candidates = [
      path.join(dataDir, 'reports', 'daily', `${digest.date}.md`),
      path.join(dataDir, 'digests', `${digest.date}.md`),
      path.join(this.knowledgeRoot, 'daily-digests', `${digest.date}.md`),
      path.join(dataDir, 'reports', 'daily', 'latest.md'),
    ]
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) return file
      } catch (error) {
        // Keep looking for a usable report file.
      }
    }
    return null
  }

  todayReportPath() {
    return this.reportPathForDigest(this.todayDigest())
  }

  resolvePaper(ref) {
    const raw = cleanText(ref)
    if (!raw) return null
    const arxivId = canonicalArxivId(raw)
    if (arxivId) {
      const found = this.db.getPaperByKey(`arxiv:${arxivId}`)
      if (found) return found
    }
    return this.db.getPaperByKey(raw)
  }

  formatPaperSummary(paper) {
    const analysis = this.db.getLatestAnalysis(paper.id)
    if (analysis && analysis.analysis_type === 'full') {
      const merged = this.attachDirectionLabel(paper)
      merged.scores = merged.scores || (analysis.scores_json ? JSON.parse(analysis.scores_json) : null)
      return render.renderAnalysisDetail(merged, analysis)
    }
    const lines = [
      `📄 ${paper.title}`,
      `${this.directionLabel(paper.primary_direction)} · ${paper.analysis_status === 'legacy' ? '历史摘要' : '尚未深度分析'}`,
      `arXiv：${paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : paper.url || '无'}`,
      `作者：${(paper.authors || []).slice(0, 4).join('、') || '未知'}`,
    ]
    if (paper.summary) lines.push('', `已有摘要：${paper.summary}`)
    if (paper.abstract) lines.push('', `原文摘要：${cleanText(paper.abstract)}`)
    lines.push('', `发送「研究.总结 ${paper.arxiv_id || paper.id} 深度」可请求结构化深度分析（会调用 DeepSeek）。`)
    return lines.join('\n')
  }

  async summaryCommand(ref, options = {}) {
    const paper = this.resolvePaper(ref)
    if (!paper) return { type: 'error', text: `没找到论文：${ref}` }
    const analysis = this.db.getLatestAnalysis(paper.id)
    const wantDeep = Boolean(options.deep)
    if (!wantDeep) {
      return { type: 'text', text: this.formatPaperSummary(paper) }
    }
    const created = this.enqueueTask('analyze_paper', {
      paperId: paper.id,
      force: wantDeep && Boolean(analysis),
    }, {
      dedupeKey: `analyze:${paper.id}:${paper.abstract_hash || 'noabstract'}${wantDeep ? ':deep' : ''}`,
      notifyChannel: options.notifyChannel,
      priority: 10,
      maxAttempts: 2,
    })
    const prefix = paper.summary
      ? `${paper.title}\n已有历史摘要：${cleanText(paper.summary)}\n\n`
      : `${paper.title}\n\n`
    return {
      type: 'task',
      task: created.task,
      text: `${prefix}${created.existing ? '已有深度分析任务在队列中' : '已创建深度分析任务'}：${created.task.id}\n完成后会通知你；也可发送「研究.任务 ${created.task.id}」查询。`,
    }
  }

  compareCommand(refA, refB) {
    const a = this.resolvePaper(refA)
    const b = this.resolvePaper(refB)
    if (!a || !b) return `没找到：${!a ? refA : ''}${!a && !b ? '、' : ''}${!b ? refB : ''}`
    if (a.id === b.id) return '两篇是同一篇论文。'
    const left = { paper: this.attachDirectionLabel(a), analysis: this.db.getLatestAnalysis(a.id) }
    const right = { paper: this.attachDirectionLabel(b), analysis: this.db.getLatestAnalysis(b.id) }
    const text = render.renderCompare(left, right)
    if (!left.analysis || !right.analysis) {
      return `${text}\n\n注意：至少一篇缺少结构化分析。可先发送「研究.总结 <ID> 深度」。`
    }
    return text
  }

  markRead(ref, status, note) {
    const paper = this.resolvePaper(ref)
    if (!paper) return `没找到论文：${ref}`
    this.db.markRead(paper.id, status, note)
    try {
      writePaperNote({
        root: this.knowledgeRoot,
        paper: this.db.getPaperById(paper.id),
        analysis: this.db.getLatestAnalysis(paper.id),
        logger: this.logger,
      })
    } catch (error) {
      this.logger.warn && this.logger.warn('更新知识库阅读状态失败: %s', error.message)
    }
    if (status === 'reproduce') {
      try {
        writeReproductionNote({ root: this.knowledgeRoot, paper })
      } catch (error) {
        this.logger.warn && this.logger.warn('创建复现笔记失败: %s', error.message)
      }
    }
    const labels = { read: '已读', reproduce: '待复现', ignored: '已忽略', unread: '未读' }
    return `已标记：${paper.title} → ${labels[status] || status}`
  }

  addFeedback(ref, feedback, note) {
    const paper = this.resolvePaper(ref)
    if (!paper) return `没找到论文：${ref}`
    this.db.addFeedback(paper.id, feedback, note)
    try {
      writePaperNote({
        root: this.knowledgeRoot,
        paper: this.db.getPaperById(paper.id),
        analysis: this.db.getLatestAnalysis(paper.id),
        logger: this.logger,
      })
    } catch (error) {
      this.logger.warn && this.logger.warn('更新知识库反馈失败: %s', error.message)
    }
    return `已记录反馈：${paper.title} → ${feedback}`
  }

  findDirection(input) {
    const text = cleanText(input).toLowerCase()
    if (!text) return null
    return (
      this.profile.researchDirections.find(
        (direction) =>
          direction.id.toLowerCase() === text ||
          direction.label.toLowerCase().includes(text) ||
          text.includes(direction.label.toLowerCase()),
      ) || null
    )
  }

  async generateQuestions(direction, { taskId = null } = {}) {
    const papers = this.db.papersByDirection(direction.id, 12)
    if (papers.length < 2) {
      const error = new Error(`「${direction.label}」的已分析论文不足，无法基于证据提出问题`)
      error.category = 'insufficient_evidence'
      throw error
    }
    const evidence = papers.map((paper) => {
      const analysis = this.db.getLatestAnalysis(paper.id)
      return {
        arxiv_id: paper.arxiv_id,
        title: paper.title,
        summary: analysis ? analysis.summary : paper.summary,
        core_contribution: analysis ? analysis.core_contribution : '',
        limitations: analysis ? analysis.limitations : '',
        evidence_boundary: analysis ? analysis.evidence_boundary : '',
        scores: analysis ? analysis.scores : paper.scores,
      }
    })
    const result = await this.llm.synthesizeQuestions(direction, evidence, { taskId })
    const text = render.renderQuestions(result, direction.label)
    this.db.setState(`questions:${direction.id}`, {
      generatedAt: nowIso(),
      text,
      evidenceIds: papers.map((paper) => paper.arxiv_id),
      api: { latencyMs: result.api.latencyMs, cost: result.api.cost },
    })
    try {
      writeResearchQuestionsNote({
        root: this.knowledgeRoot,
        direction,
        text,
        evidenceIds: papers.map((paper) => paper.arxiv_id),
        generatedAt: nowIso(),
      })
    } catch (error) {
      this.logger.warn && this.logger.warn('写候选问题知识页失败: %s', error.message)
    }
    return { text, result: result.questions, api: result.api }
  }

  questionsCommand(directionInput, { notifyChannel } = {}) {
    const direction = this.findDirection(directionInput)
    if (!direction) {
      return {
        type: 'error',
        text: `未识别研究方向。可选：${this.profile.researchDirections.map((item) => `${item.id}（${item.label}）`).join('、')}`,
      }
    }
    const cached = this.db.getState(`questions:${direction.id}`, null)
    if (cached && Date.now() - Date.parse(cached.generatedAt) < 7 * 86400000) {
      return { type: 'text', text: cached.text }
    }
    const created = this.enqueueTask('research_questions', { directionId: direction.id }, {
      dedupeKey: `questions:${direction.id}:${localDate(new Date(), this.profile.timezone)}`,
      notifyChannel,
      priority: 5,
      maxAttempts: 2,
    })
    return {
      type: 'task',
      task: created.task,
      text: `${created.existing ? '已有任务在队列中' : '已创建研究问题任务'}：${created.task.id}\n它会基于已保存的论文证据生成候选问题，完成后通知你。`,
    }
  }

  recordExternalUsage({ model, usage, latencyMs, requestType }) {
    const period = parsePricePeriod(this.profile)
    const requestId = `ext_${sha256(`${Date.now()}:${Math.random()}`).slice(0, 24)}`
    this.db.recordUsage({
      requestId,
      requestType: requestType || 'external',
      model: model || this.profile.model || 'deepseek-flash',
      inputTokens: usage && usage.prompt_tokens,
      outputTokens: usage && usage.completion_tokens,
      cacheHitTokens: usage && usage.prompt_cache_hit_tokens,
      cacheMissTokens: usage && usage.prompt_cache_miss_tokens,
      latencyMs,
      estimatedCostUsd: usage
        ? calculateCost(usage, model || this.profile.model || 'deepseek-flash', this.profile, period)
        : null,
      pricingPeriod: period,
      status: 'ok',
      rawUsage: usage || null,
    })
  }

  async syncGithub() {
    return this.github.syncAll()
  }

  enqueueTask(type, payload, options = {}) {
    return this.db.createTask({
      type,
      payload,
      priority: options.priority || 0,
      dedupeKey: options.dedupeKey || null,
      maxAttempts: options.maxAttempts || 3,
      notifyChannel: options.notifyChannel || null,
    })
  }

  async flushNotifications() {
    if (!this.notifier) return 0
    const tasks = this.db.pendingTaskNotifications(
      3,
      new Date(Date.now() - 7 * 86400000).toISOString(),
    )
    let sent = 0
    for (const task of tasks) {
      try {
        const message = task.result && task.result.message
          ? task.result.message
          : `任务 ${task.id} 已完成`
        await this.notifier(task.notify_channel, message)
        this.db.markTaskNotified(task.id, 'sent')
        sent += 1
      } catch (error) {
        this.logger.warn && this.logger.warn('补发任务通知失败 %s: %s', task.id, error.message)
        this.db.markTaskNotified(task.id, 'failed')
      }
    }
    return sent
  }

  async tick() {
    if (this.workerBusy || !this.started) return
    this.workerBusy = true
    try {
      await this.flushNotifications()
      const task = this.db.claimNextTask()
      if (!task) return
      await this.executeTask(task)
    } finally {
      this.workerBusy = false
    }
  }

  async executeTask(task) {
    try {
      try {
        this.refreshProfile()
      } catch (profileError) {
        this.logger.warn && this.logger.warn('研究画像热加载失败: %s', profileError.message)
      }
      const result = await this.handleTask(task)
      const stored = result && result.data
        ? { message: result.message || null, data: result.data }
        : result
      const completed = this.db.completeTask(task.id, stored, task.output_path)
      if (completed.notify_channel) {
        if (!this.notifier) {
          this.db.markTaskNotified(task.id, 'pending')
        } else {
          try {
            await this.notifier(completed.notify_channel, result.message || '任务已完成')
            if (typeof result.afterNotify === 'function') await result.afterNotify()
            let filesOk = true
            for (const file of result.files || []) {
              if (!this.fileNotifier) {
                filesOk = false
                break
              }
              try {
                await this.fileNotifier(completed.notify_channel, file)
              } catch (fileError) {
                filesOk = false
                this.logger.warn && this.logger.warn('任务文件发送失败 %s: %s', task.id, fileError.message)
              }
            }
            this.db.markTaskNotified(task.id, filesOk ? 'sent' : 'failed')
          } catch (error) {
            this.logger.warn && this.logger.warn('任务通知发送失败 %s: %s', task.id, error.message)
            this.db.markTaskNotified(task.id, 'failed')
          }
        }
      } else {
        this.db.markTaskNotified(task.id, 'skipped')
      }
      return completed
    } catch (error) {
      const category = error.category || 'unknown'
      const retryable = ['timeout', 'network', 'rate_limit', 'server', 'invalid_json'].includes(category)
      let updated
      if (category === 'budget' || category === 'balance') {
        updated = this.db.deferTask(
          task.id,
          taskErrorMessage(error),
          category,
          new Date(Date.now() + 6 * 3600000).toISOString(),
        )
      } else {
        updated = this.db.failTask(
          task.id,
          taskErrorMessage(error),
          category,
          retryable ? nextRetryIso(Number(task.attempts || 0)) : null,
        )
      }
      if (task.notify_channel && this.notifier && updated && updated.status !== 'pending') {
        try {
          await this.notifier(
            task.notify_channel,
            `任务 ${task.id} ${updated.status === 'deferred' ? '已推迟' : '失败'}：${taskErrorMessage(error)}`,
          )
          this.db.markTaskNotified(task.id, 'sent')
        } catch (notifyError) {
          this.logger.warn && this.logger.warn('失败通知发送失败: %s', notifyError.message)
          this.db.markTaskNotified(task.id, 'failed')
        }
      }
      return null
    }
  }

  async handleTask(task) {
    if (task.type === 'analyze_paper') {
      const paper = this.db.getPaperById(Number(task.payload.paperId))
      if (!paper) {
        const error = new Error(`论文不存在: ${task.payload.paperId}`)
        error.category = 'not_found'
        throw error
      }
      const result = await this.ensurePaperAnalysis(paper, {
        taskId: task.id,
        force: Boolean(task.payload.force),
      })
      return {
        message: result.cached
          ? `论文已有可复用分析：${result.paper.title}`
          : `深度分析完成：${result.paper.title}\n\n${this.formatPaperSummary(result.paper)}`,
        data: {
          paperId: result.paper.id,
          cached: result.cached,
          analysisId: result.analysis && result.analysis.id,
        },
      }
    }
    if (task.type === 'research_questions') {
      const direction = directionById(this.profile, task.payload.directionId)
      if (!direction) {
        const error = new Error(`研究方向不存在: ${task.payload.directionId}`)
        error.category = 'not_found'
        throw error
      }
      const result = await this.generateQuestions(direction, { taskId: task.id })
      return { message: result.text, data: { directionId: direction.id, questions: result.result } }
    }
    if (task.type === 'deliver_test_reports') {
      return this.deliverTestReports({
        kinds: task.payload.kinds || ['daily', 'weekly'],
        now: new Date(),
      })
    }
    if (task.type === 'github_sync') {
      const result = await this.github.syncAll()
      const text = this.github.formatEvents(result.events, 8) || 'GitHub 仓库没有新的重要变更。'
      this.db.markRepositoryEventsNotified((result.events || []).map((event) => event.id))
      return {
        message: text,
        data: {
          repositories: result.repositories,
          events: result.events.length,
          eventIds: (result.events || []).map((event) => event.id),
        },
      }
    }
    const error = new Error(`未知任务类型: ${task.type}`)
    error.category = 'unsupported'
    throw error
  }


  async deliverTestReports({ kinds = ['daily', 'weekly'], now = new Date() } = {}) {
    const arxivCfg = readJson(path.join(this.root, 'config', 'arxiv.json'), null)
    const weeklyCfg = readJson(path.join(this.root, 'config', 'weekly.json'), null)
    const ccfCfg = readJson(path.join(this.root, 'config', 'ccfddl.json'), null)
    if (!arxivCfg || !weeklyCfg) throw new Error('日报/周报配置未加载')
    const dataDir = arxivCfg.dataDir || path.join(this.root, 'data', 'arxiv-digest')
    const legacyState = readJson(path.join(dataDir, 'state.json'), { summaries: {}, lineage: {} })
    const messages = ['🧪 日报 / 周报私信测试']
    const files = []
    let dailyReport = null
    let weeklyReport = null
    if (kinds.includes('daily')) {
      dailyReport = await this.buildDailyReport(arxivCfg, {
        state: legacyState,
        weeklyCfg,
        ccfCfg,
        now,
      })
      const dailyPath = saveMarkdownReport(dataDir, 'daily', dailyReport.result.date, dailyReport.markdown)
      files.push(dailyPath)
      messages.push(`【日报】\n${makeDailyBrief(dailyReport, { reportPath: null })}`)
    }
    if (kinds.includes('weekly')) {
      const botCount = 1
      weeklyReport = await buildWeeklyReport(weeklyCfg, {
        now,
        dataDir,
        arxivCfg,
        arxivState: legacyState,
        ccfCfg,
        botCount,
      })
      const weeklyPath = saveMarkdownReport(dataDir, 'weekly', weeklyReport.week.weekKey, weeklyReport.markdown)
      files.push(weeklyPath)
      messages.push(`【周报】\n${makeWeeklyBrief(weeklyReport, { reportPath: null })}`)
    }
    const service = this
    return {
      message: messages.join('\n\n'),
      files,
      data: {
        daily: dailyReport ? dailyReport.result.date : null,
        weekly: weeklyReport ? weeklyReport.week.weekKey : null,
        files,
      },
      afterNotify: async () => {
        if (dailyReport) {
          service.commitDailyReport(dailyReport, { messageOk: true, fileOk: files.length > 0 })
          const stateFile = path.join(dataDir, 'state.json')
          const state = readJson(stateFile, null)
          if (state) {
            state.lastRunDate = dailyReport.result.date
            state.dailyAttempts = null
            atomicWrite(stateFile, JSON.stringify(state, null, 2))
          }
        }
      },
    }
  }

  taskStatus(id) {
    const task = this.db.getTask(id)
    if (!task) return `没找到任务：${id}`
    const lines = [
      `任务 ${task.id}`,
      `类型：${task.type} · 状态：${task.status}`,
      `尝试：${task.attempts}/${task.max_attempts}`,
      `创建：${task.created_at}`,
      `更新：${task.updated_at}`,
      `通知：${task.notify_status}`,
    ]
    if (task.error_category) lines.push(`错误类型：${task.error_category}`)
    if (task.last_error) lines.push(`最后错误：${task.last_error}`)
    if (task.result_json) lines.push(`结果：${truncate(task.result_json, 1000)}`)
    return lines.join('\n')
  }

  tasksText(limit = 8) {
    const tasks = this.db.listTasks(limit)
    if (!tasks.length) return '任务队列为空。'
    const lines = ['🗂 最近任务']
    for (const task of tasks) {
      lines.push(`· ${task.id} · ${task.type} · ${task.status} · ${task.created_at}`)
    }
    lines.push('发送「研究.任务 <ID>」查看详情。')
    return lines.join('\n')
  }

  statusText() {
    const stats = this.db.stats()
    const budget = this.llm.budgetStatus()
    const daily = this.db.latestDelivery('daily')
    const success = this.db.latestSuccessfulDelivery('daily')
    const repos = stats.repos || {}
    const tasks = stats.tasks || []
    const legacyState = readJson(path.join(this.root, 'data', 'arxiv-digest', 'state.json'), null)
    const lines = [
      '🧪 Research Agent 状态',
      `数据库：${this.dbFile}`,
      `论文：${stats.papers.total} · 已分析 ${stats.papers.analyzed || 0} · 历史摘要 ${stats.papers.legacy || 0} · 已推送 ${stats.papers.pushed || 0}`,
      `阅读：已读 ${stats.papers.read_count || 0} · 待复现 ${stats.papers.reproduce_count || 0}`,
      `知识库：${this.knowledgeRoot}`,
      `今日预算：$${budget.daily.spent.toFixed(6)} / $${budget.daily.limit.toFixed(2)} · 本周 $${budget.weekly.spent.toFixed(6)} / $${budget.weekly.limit.toFixed(2)}`,
      `最近日报：${daily ? `${daily.run_key} · ${daily.status} · 消息 ${daily.message_ok ? '成功' : '未确认'} · 文件 ${daily.file_ok ? '成功' : '未确认'}` : '无记录'}`,
      `最近完整成功：${success ? success.run_key : '无'}`,
      `旧管线最后发送：${(legacyState && legacyState.lastRunDate) || '无'}`,
      `GitHub：${repos.total || 0} 个仓库，已同步 ${repos.synced || 0}`,
      `任务：${tasks.map((item) => `${item.status} ${item.count}`).join(' · ') || '无'}`,
      `队列：${this.started ? '运行中' : '未启动'}`,
    ]
    if (daily && daily.last_error) lines.push(`最近错误：${daily.last_error}`)
    return lines.join('\n')
  }

  costText() {
    const now = new Date()
    const dayStart = startOfZonedDay(now, this.profile.timezone)
    const weekStart = startOfZonedWeek(now, this.profile.timezone)
    const daily = this.db.usageSummary({ since: dayStart.toISOString() })
    const weekly = this.db.usageSummary({ since: weekStart.toISOString() })
    const budget = this.llm.budgetStatus(now)
    const label = (date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: this.profile.timezone || 'Asia/Shanghai' }).format(date)
    return [
      render.formatCost({
        summary: daily,
        budget,
        sinceLabel: `今日 ${label(dayStart)} 起`,
      }),
      '',
      render.formatCost({
        summary: weekly,
        sinceLabel: `本周 ${label(weekStart)} 起`,
      }),
    ].join('\n')
  }

  searchText(query, limit = 8) {
    const papers = this.db.searchPapers(query, limit)
    if (!papers.length) return `本地知识库没有找到「${query}」。`
    const lines = [`🔎 本地知识库：${query}`]
    for (const paper of papers) {
      const analysis = this.db.getLatestAnalysis(paper.id)
      lines.push(
        [
          `· ${paper.title}`,
          `  ${this.directionLabel(paper.primary_direction)} · ${paper.score_total == null ? '未评分' : Number(paper.score_total).toFixed(1)} · ${paper.analysis_status}`,
          `  ${cleanText(analysis && analysis.summary ? analysis.summary : paper.summary || paper.abstract)}`,
          `  ${paper.arxiv_id ? `arXiv:${paper.arxiv_id} → 研究.总结 ${paper.arxiv_id}` : `ID ${paper.id}`}`,
        ].join('\n'),
      )
    }
    return lines.join('\n')
  }

  todayText() {
    const digest = this.todayDigest()
    if (!digest) return '今天还没有日报缓存。'
    const localToday = localDate(new Date(), this.profile.timezone)
    const lines = [`📚 ${digest.date === localToday ? '今日' : '最近'}研究日报 · ${digest.date}`]
    if (digest.top3 && digest.top3.length) {
      digest.top3.forEach((item, index) => {
        lines.push('', render.renderTop3Item(item, index))
      })
    } else if (digest.papers && digest.papers.length) {
      lines.push('', '当前缓存是旧版日报，没有 Top 3 分项评分；先列出前 3 篇：')
      digest.papers.slice(0, 3).forEach((paper, index) => {
        const row = this.resolvePaper(paper.id)
        lines.push(
          `${index + 1}. ${paper.title}`,
          `   ${this.directionLabel(paper.primaryDirection || (row && row.primary_direction))} · 旧关键词分 ${paper.score == null ? '未知' : paper.score}`,
        )
      })
    } else {
      lines.push('', '今日没有达到推荐标准的新论文。')
    }
    lines.push('', `完整候选：${(digest.papers || []).length} 篇。发送「研究.清单」查看标题，或「研究.搜索 <关键词>」查本地知识库。`)
    return lines.join('\n')
  }

  listText(limit = 20) {
    const digest = this.todayDigest()
    if (!digest) return '还没有日报缓存。'
    const papers = (digest.papers || []).slice(0, limit)
    const lines = [`📋 ${digest.date} 完整候选 · ${papers.length}/${(digest.papers || []).length} 篇`]
    for (const [index, paper] of papers.entries()) {
      const row = this.resolvePaper(paper.id)
      lines.push(`${index + 1}. ${paper.title}${paper.score == null ? '' : ` · ${Number(paper.score).toFixed(1)}`}`)
      lines.push(
        `   ${this.directionLabel(paper.primaryDirection || (row && row.primary_direction))} · ${paper.id}${
          digest.version === 2
            ? paper.analysisStatus === 'completed' ? '' : ' · 粗排'
            : ' · 旧版关键词分'
        }`,
      )
    }
    lines.push('用「研究.总结 <ID>」查看详情。')
    return lines.join('\n')
  }

  latestDigestForDisplay() {
    return this.readDigest()
  }
}

module.exports = {
  ResearchService,
  atomicWrite,
  readJson,
  localDate,
  uniqueById,
  sortByScore,
  isSubstantive,
  nextRetryIso,
  taskErrorMessage,
  estimateTokens,
}
