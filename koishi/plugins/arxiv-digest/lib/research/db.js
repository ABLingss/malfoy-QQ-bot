'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')
const { cleanText, abstractHash, nowIso } = require('./text')

const SCHEMA_VERSION = 1

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL UNIQUE,
  arxiv_id TEXT UNIQUE,
  doi TEXT,
  openalex_id TEXT,
  title TEXT NOT NULL,
  authors_json TEXT NOT NULL DEFAULT '[]',
  abstract TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'arxiv',
  published_at TEXT,
  updated_at TEXT,
  version TEXT,
  abstract_hash TEXT NOT NULL,
  summary TEXT,
  summary_source TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'none',
  analysis_attempts INTEGER NOT NULL DEFAULT 0,
  last_analysis_error TEXT,
  direction_tags_json TEXT NOT NULL DEFAULT '[]',
  primary_direction TEXT,
  novelty_judgment TEXT,
  novelty_preliminary INTEGER NOT NULL DEFAULT 1,
  relevance REAL,
  reproducibility REAL,
  evidence_quality REAL,
  score_total REAL,
  score_json TEXT,
  read_status TEXT NOT NULL DEFAULT 'unread',
  feedback TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_analyzed_at TEXT,
  analysis_version TEXT,
  model TEXT,
  pushed_at TEXT,
  substantive_update_at TEXT,
  url TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_papers_last_seen ON papers(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_direction ON papers(primary_direction);
CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(analysis_status, read_status);

CREATE TABLE IF NOT EXISTS paper_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  version TEXT,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  abstract_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'none',
  UNIQUE(paper_id, abstract_hash)
);

CREATE TABLE IF NOT EXISTS paper_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  prompt_version TEXT,
  profile_version TEXT,
  model TEXT,
  summary TEXT,
  core_contribution TEXT,
  difference_from_prior TEXT,
  evidence_boundary TEXT,
  limitations TEXT,
  related_projects_json TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT,
  direction TEXT,
  scores_json TEXT,
  total_score REAL,
  novelty_preliminary INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(paper_id, input_hash, analysis_type)
);

CREATE INDEX IF NOT EXISTS idx_analyses_paper ON paper_analyses(paper_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL UNIQUE,
  url TEXT,
  purpose TEXT,
  why_tracked TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  releases_etag TEXT,
  pulls_etag TEXT,
  issues_etag TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repository_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  published_at TEXT,
  summary TEXT,
  importance TEXT NOT NULL DEFAULT 'normal',
  action_needed INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  raw_json TEXT,
  first_seen_at TEXT NOT NULL,
  UNIQUE(repo_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_repo_events_unnotified
  ON repository_events(repo_id, notified_at, published_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  error_category TEXT,
  result_json TEXT,
  output_path TEXT,
  notify_channel TEXT,
  notify_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  next_run_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_dedupe
  ON tasks(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing', 'deferred');
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, next_run_at, priority DESC);

CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  task_id TEXT,
  request_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  latency_ms INTEGER,
  estimated_cost_usd REAL,
  pricing_period TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error_category TEXT,
  error_message TEXT,
  raw_usage_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_type ON api_usage(request_type, created_at);

CREATE TABLE IF NOT EXISTS user_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  feedback TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL,
  collect_ok INTEGER NOT NULL DEFAULT 0,
  analyze_ok INTEGER NOT NULL DEFAULT 0,
  report_ok INTEGER NOT NULL DEFAULT 0,
  message_ok INTEGER NOT NULL DEFAULT 0,
  file_ok INTEGER NOT NULL DEFAULT 0,
  report_path TEXT,
  error_category TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(kind, run_key)
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

function makeId(prefix) {
  const stamp = Date.now().toString(36)
  const random = crypto.randomBytes(4).toString('hex')
  return `${prefix || 'id'}_${stamp}_${random}`
}

function rowToPaper(row) {
  if (!row) return null
  const paper = { ...row }
  try {
    paper.authors = JSON.parse(row.authors_json || '[]')
  } catch (error) {
    paper.authors = []
  }
  try {
    paper.categories = JSON.parse(row.categories_json || '[]')
  } catch (error) {
    paper.categories = []
  }
  try {
    paper.directionTags = JSON.parse(row.direction_tags_json || '[]')
  } catch (error) {
    paper.directionTags = []
  }
  try {
    paper.scores = JSON.parse(row.score_json || 'null')
  } catch (error) {
    paper.scores = null
  }
  paper.noveltyPreliminary = Boolean(row.novelty_preliminary)
  return paper
}

function rowToAnalysis(row) {
  if (!row) return null
  const analysis = { ...row }
  try {
    analysis.relatedProjects = JSON.parse(row.related_projects_json || '[]')
  } catch (error) {
    analysis.relatedProjects = []
  }
  try {
    analysis.scores = JSON.parse(row.scores_json || 'null')
  } catch (error) {
    analysis.scores = null
  }
  analysis.noveltyPreliminary = Boolean(row.novelty_preliminary)
  return analysis
}

function rowToTask(row) {
  if (!row) return null
  const task = { ...row }
  try {
    task.payload = JSON.parse(row.payload_json || '{}')
  } catch (error) {
    task.payload = {}
  }
  try {
    task.result = JSON.parse(row.result_json || 'null')
  } catch (error) {
    task.result = null
  }
  return task
}

class ResearchDatabase {
  constructor(file) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(file), 0o700)
    this.db = new DatabaseSync(file)
    try {
      fs.chmodSync(file, 0o600)
    } catch (error) {
      // SQLite may create -wal/-shm separately; best effort only.
    }
    this.migrate()
  }

  migrate() {
    this.db.exec(SCHEMA)
    this.db
      .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, nowIso())
  }

  close() {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch (rollbackError) {
        // Preserve the original error.
      }
      throw error
    }
  }

  upsertPaper(paper) {
    const now = nowIso()
    const arxivId = cleanText(paper.arxivId || paper.arxiv_id || '') || null
    const doi = cleanText(paper.doi || '') || null
    const openalexId = cleanText(paper.openalexId || '') || null
    const canonicalKey = cleanText(paper.canonicalKey || paper.canonical_key || '')
    if (!canonicalKey) throw new Error('论文缺少 canonicalKey')
    const title = cleanText(paper.title)
    const abstract = cleanText(paper.abstract || paper.summary || '')
    const hash = abstractHash(abstract)
    const authors = JSON.stringify(paper.authors || [])
    const tags = JSON.stringify(paper.directionTags || [])
    const publishedAt = paper.publishedAt || paper.published || null
    const updatedAt = paper.updatedAt || paper.updated || publishedAt
    const url = cleanText(paper.url || (arxivId ? `https://arxiv.org/abs/${arxivId}` : ''))
    const raw = JSON.stringify(paper.raw || {
      primaryCategory: paper.primaryCategory || '',
      categories: paper.categories || [],
    })
    const existing = this.db
      .prepare('SELECT * FROM papers WHERE canonical_key = ? OR (arxiv_id IS NOT NULL AND arxiv_id = ?)')
      .get(canonicalKey, arxivId)
    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO papers(
            canonical_key, arxiv_id, doi, openalex_id, title, authors_json, abstract, source,
            published_at, updated_at, abstract_hash, direction_tags_json, primary_direction,
            first_seen_at, last_seen_at, url, raw_json, analysis_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none')`,
        )
        .run(
          canonicalKey,
          arxivId,
          doi,
          openalexId,
          title,
          authors,
          abstract,
          paper.source || 'arxiv',
          publishedAt,
          updatedAt,
          hash,
          tags,
          paper.primaryDirection || null,
          now,
          now,
          url,
          raw,
        )
      const id = Number(info.lastInsertRowid)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO paper_versions(
            paper_id, version, title, abstract, abstract_hash, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, paper.version || null, title, abstract, hash, now)
      return { ...this.getPaperById(id), isNew: true, abstractChanged: false }
    }

    const effectiveHash = abstract ? hash : existing.abstract_hash
    const abstractChanged = existing.abstract_hash !== effectiveHash
    this.db
      .prepare(
        `UPDATE papers SET
          arxiv_id = COALESCE(?, arxiv_id),
          doi = COALESCE(?, doi),
          openalex_id = COALESCE(?, openalex_id),
          title = ?,
          authors_json = ?,
          abstract = ?,
          source = ?,
          published_at = COALESCE(?, published_at),
          updated_at = ?,
          version = COALESCE(?, version),
          abstract_hash = ?,
          direction_tags_json = ?,
          primary_direction = COALESCE(?, primary_direction),
          last_seen_at = ?,
          url = COALESCE(?, url),
          raw_json = ?,
          substantive_update_at = CASE WHEN ? THEN ? ELSE substantive_update_at END
        WHERE id = ?`,
      )
      .run(
        arxivId,
        doi,
        openalexId,
        title || existing.title,
        authors,
        abstract || existing.abstract,
        paper.source || existing.source,
        publishedAt,
        updatedAt || existing.updated_at,
        paper.version || null,
        effectiveHash,
        tags,
        paper.primaryDirection || null,
        now,
        url || null,
        raw,
        abstractChanged ? 1 : 0,
        now,
        existing.id,
      )
      if (abstractChanged) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO paper_versions(
              paper_id, version, title, abstract, abstract_hash, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(existing.id, paper.version || null, title, abstract || existing.abstract, effectiveHash, now)
      }
    return { ...this.getPaperById(existing.id), isNew: false, abstractChanged }
  }

  getPaperById(id) {
    return rowToPaper(this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id))
  }

  getPaperByKey(key) {
    const value = cleanText(key)
    if (!value) return null
    return rowToPaper(
      this.db
        .prepare(
          `SELECT * FROM papers
           WHERE canonical_key = ? OR arxiv_id = ? OR id = ?
           LIMIT 1`,
        )
        .get(value, value.replace(/^arxiv:/i, '').replace(/v\d+$/i, ''), /^\d+$/.test(value) ? Number(value) : -1),
    )
  }

  getPapersByIds(ids) {
    const list = (ids || []).filter((id) => Number.isFinite(Number(id)))
    if (!list.length) return []
    const placeholders = list.map(() => '?').join(',')
    return this.db
      .prepare(`SELECT * FROM papers WHERE id IN (${placeholders})`)
      .all(...list.map(Number))
      .map(rowToPaper)
  }

  getLatestAnalysis(paperId, inputHash) {
    const row = inputHash
      ? this.db
          .prepare(
            `SELECT * FROM paper_analyses
             WHERE paper_id = ? AND input_hash = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(paperId, inputHash)
      : this.db
          .prepare(
            `SELECT * FROM paper_analyses
             WHERE paper_id = ?
             ORDER BY CASE analysis_type WHEN 'full' THEN 0 ELSE 1 END, created_at DESC
             LIMIT 1`,
          )
          .get(paperId)
    return rowToAnalysis(row)
  }

  getAnalysisByInputHash(paperId, inputHash, analysisType = 'full') {
    return rowToAnalysis(
      this.db
        .prepare(
          `SELECT * FROM paper_analyses
           WHERE paper_id = ? AND input_hash = ? AND analysis_type = ?
           LIMIT 1`,
        )
        .get(paperId, inputHash, analysisType),
    )
  }


  setPreliminaryScores(paperId, scores) {
    this.db
      .prepare(
        `UPDATE papers SET
          relevance = ?, score_total = ?, score_json = ?, novelty_preliminary = 1,
          direction_tags_json = ?, primary_direction = COALESCE(?, primary_direction)
         WHERE id = ? AND analysis_status != 'completed'`,
      )
      .run(
        scores.relevance,
        scores.total,
        JSON.stringify(scores),
        JSON.stringify((scores.directionMatches || []).map((item) => item.id)),
        scores.direction || null,
        paperId,
      )
  }

  markAnalysisStale(paperId, reason) {
    this.db
      .prepare(
        `UPDATE papers SET analysis_status = 'pending',
          last_analysis_error = COALESCE(?, last_analysis_error)
         WHERE id = ? AND analysis_status IN ('completed', 'legacy')`,
      )
      .run(cleanText(reason).slice(0, 500), paperId)
  }

  papersByDirection(direction, limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM papers
         WHERE primary_direction = ? AND analysis_status = 'completed'
         ORDER BY COALESCE(score_total, 0) DESC, COALESCE(published_at, last_seen_at) DESC
         LIMIT ?`,
      )
      .all(direction, Math.max(1, Math.min(50, limit)))
      .map(rowToPaper)
  }

  papersWithAnalysesByIds(ids) {
    const rows = this.getPapersByIds(ids)
    return rows.map((paper) => ({ paper, analysis: this.getLatestAnalysis(paper.id) }))
  }

  saveAnalysis(paperId, analysis, meta = {}) {
    const inputHash = cleanText(meta.inputHash)
    if (!inputHash) throw new Error('saveAnalysis 缺少 inputHash')
    const analysisType = cleanText(meta.analysisType || 'full')
    const now = nowIso()
    const existing = this.getAnalysisByInputHash(paperId, inputHash, analysisType)
    if (existing) return existing
    const scoresJson = JSON.stringify(analysis.scores || null)
    const total = Number(analysis.totalScore == null ? analysis.scores && analysis.scores.total : analysis.totalScore)
    const info = this.db
      .prepare(
        `INSERT INTO paper_analyses(
          paper_id, input_hash, analysis_type, prompt_version, profile_version, model,
          summary, core_contribution, difference_from_prior, evidence_boundary, limitations,
          related_projects_json, recommendation, direction, scores_json, total_score,
          novelty_preliminary, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        paperId,
        inputHash,
        analysisType,
        meta.promptVersion || null,
        meta.profileVersion || null,
        meta.model || null,
        cleanText(analysis.summary),
        cleanText(analysis.coreContribution),
        cleanText(analysis.differenceFromPrior),
        cleanText(analysis.evidenceBoundary),
        cleanText(analysis.limitations),
        JSON.stringify(analysis.relatedProjects || []),
        cleanText(analysis.recommendation),
        cleanText(analysis.direction),
        scoresJson,
        Number.isFinite(total) ? total : null,
        analysis.noveltyPreliminary === false ? 0 : 1,
        JSON.stringify(analysis.raw || analysis),
        now,
      )
    const id = Number(info.lastInsertRowid)
    if (analysisType === 'full') {
      const status = 'completed'
      this.db
        .prepare(
          `UPDATE papers SET
            summary = ?, summary_source = ?, analysis_status = ?,
            analysis_attempts = 0, last_analysis_error = NULL,
            direction_tags_json = ?, primary_direction = COALESCE(?, primary_direction),
            novelty_judgment = ?, novelty_preliminary = ?,
            relevance = ?, reproducibility = ?, evidence_quality = ?,
            score_total = ?, score_json = ?, last_analyzed_at = ?,
            analysis_version = ?, model = ?
          WHERE id = ?`,
        )
        .run(
          cleanText(analysis.summary) || null,
          'deepseek',
          status,
          JSON.stringify(analysis.directionTags || (analysis.direction ? [analysis.direction] : [])),
          analysis.direction || null,
          cleanText(analysis.noveltyJudgment) || null,
          analysis.noveltyPreliminary === false ? 0 : 1,
          analysis.scores ? analysis.scores.relevance : null,
          analysis.scores ? analysis.scores.reproducibility : null,
          analysis.scores ? analysis.scores.evidence : null,
          Number.isFinite(total) ? total : null,
          scoresJson,
          now,
          meta.promptVersion || null,
          meta.model || null,
          paperId,
        )
    } else if (analysisType === 'legacy_summary') {
      this.db
        .prepare(
          `UPDATE papers SET
            summary = COALESCE(summary, ?), summary_source = COALESCE(summary_source, 'legacy'),
            analysis_status = CASE WHEN analysis_status = 'none' THEN 'legacy' ELSE analysis_status END
          WHERE id = ?`,
        )
        .run(cleanText(analysis.summary) || null, paperId)
    }
    return this.getAnalysisByInputHash(paperId, inputHash, analysisType)
  }

  setAnalysisFailure(paperId, error, category) {
    this.db
      .prepare(
        `UPDATE papers SET
          analysis_status = CASE WHEN analysis_status = 'completed' THEN analysis_status ELSE 'failed' END,
          analysis_attempts = analysis_attempts + 1,
          last_analysis_error = ?
        WHERE id = ?`,
      )
      .run(`${category ? `[${category}] ` : ''}${cleanText(error).slice(0, 500)}`, paperId)
  }

  setAnalysisDeferred(paperId, reason) {
    this.db
      .prepare(
        `UPDATE papers SET
          analysis_status = CASE WHEN analysis_status = 'completed' THEN analysis_status ELSE 'deferred' END,
          last_analysis_error = ?
        WHERE id = ?`,
      )
      .run(cleanText(reason).slice(0, 500), paperId)
  }

  markPaperSummary(paperId, summary, source, status) {
    this.db
      .prepare(
        `UPDATE papers SET summary = ?, summary_source = ?, analysis_status = ? WHERE id = ?`,
      )
      .run(cleanText(summary) || null, source || 'legacy', status || 'none', paperId)
  }

  markPushed(ids, date) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))]
    if (!list.length) return 0
    const stmt = this.db.prepare(
      `UPDATE papers SET pushed_at = CASE
         WHEN substantive_update_at IS NOT NULL AND substantive_update_at > pushed_at THEN ?
         ELSE COALESCE(pushed_at, ?)
       END WHERE id = ?`,
    )
    let count = 0
    this.transaction(() => {
      for (const id of list) count += Number(stmt.run(date, date, id).changes || 0)
    })
    return count
  }

  markRead(paperId, status = 'read', note) {
    this.db
      .prepare(
        `UPDATE papers SET read_status = ?, feedback = COALESCE(?, feedback) WHERE id = ?`,
      )
      .run(status, note || null, paperId)
    this.db
      .prepare('INSERT INTO user_feedback(paper_id, feedback, note, created_at) VALUES (?, ?, ?, ?)')
      .run(paperId, status, note || null, nowIso())
  }

  addFeedback(paperId, feedback, note) {
    const value = cleanText(feedback).slice(0, 80)
    this.db
      .prepare('INSERT INTO user_feedback(paper_id, feedback, note, created_at) VALUES (?, ?, ?, ?)')
      .run(paperId, value, cleanText(note).slice(0, 1000) || null, nowIso())
    this.db.prepare('UPDATE papers SET feedback = ? WHERE id = ?').run(value, paperId)
  }

  listAllPapers(limit = 1000) {
    return this.db
      .prepare('SELECT * FROM papers ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?')
      .all(Math.max(1, Math.min(10000, limit)))
      .map(rowToPaper)
  }

  searchPapers(query, limit = 10) {
    const text = cleanText(query)
    if (!text) return []
    const like = `%${text.replace(/[%_]/g, '')}%`
    return this.db
      .prepare(
        `SELECT * FROM papers
         WHERE title LIKE ? OR abstract LIKE ? OR summary LIKE ?
            OR direction_tags_json LIKE ? OR arxiv_id = ?
         ORDER BY
           CASE WHEN title LIKE ? THEN 0 ELSE 1 END,
           COALESCE(score_total, 0) DESC,
           COALESCE(published_at, last_seen_at) DESC
         LIMIT ?`,
      )
      .all(like, like, like, like, text, `%${text}%`, Math.max(1, Math.min(50, limit)))
      .map(rowToPaper)
  }

  candidatesForDaily({ limit = 40, includePushed = false } = {}) {
    const where = includePushed ? '1=1' : "(pushed_at IS NULL OR substantive_update_at > pushed_at)"
    return this.db
      .prepare(
        `SELECT * FROM papers
         WHERE ${where}
           AND (
             read_status NOT IN ('read', 'reproduce', 'ignored')
             OR (read_status IN ('read', 'reproduce') AND substantive_update_at > pushed_at)
           )
         ORDER BY COALESCE(score_total, 0) DESC, COALESCE(published_at, last_seen_at) DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, limit)))
      .map(rowToPaper)
  }

  papersForAnalysis({ limit = 10, maxAttempts = 3 } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM papers
         WHERE (pushed_at IS NULL OR substantive_update_at > pushed_at)
           AND read_status NOT IN ('read', 'reproduce', 'ignored')
           AND analysis_status NOT IN ('completed', 'legacy')
           AND analysis_attempts < ?
           AND length(abstract) > 80
         ORDER BY COALESCE(relevance, 0) DESC, COALESCE(published_at, last_seen_at) DESC
         LIMIT ?`,
      )
      .all(maxAttempts, Math.max(1, Math.min(2000, limit)))
      .map(rowToPaper)
  }

  createTask({
    id,
    type,
    payload,
    priority = 0,
    dedupeKey = null,
    maxAttempts = 3,
    notifyChannel = null,
  }) {
    const now = nowIso()
    const taskId = id || makeId('task')
    try {
      this.db
        .prepare(
          `INSERT INTO tasks(
            id, type, status, priority, payload_json, dedupe_key, max_attempts,
            notify_channel, created_at, updated_at
          ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          type,
          priority,
          JSON.stringify(payload || {}),
          dedupeKey,
          maxAttempts,
          notifyChannel,
          now,
          now,
        )
      return { task: this.getTask(taskId), existing: false }
    } catch (error) {
      if (dedupeKey && /UNIQUE constraint failed/i.test(error.message)) {
        const existing = this.db
          .prepare(
            `SELECT * FROM tasks WHERE dedupe_key = ?
             AND status IN ('pending', 'processing', 'deferred') LIMIT 1`,
          )
          .get(dedupeKey)
        if (existing) return { task: rowToTask(existing), existing: true }
      }
      throw error
    }
  }

  getTask(id) {
    return rowToTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
  }

  listTasks(limit = 10, status) {
    const rows = status
      ? this.db
          .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(status, limit)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit)
    return rows.map(rowToTask)
  }

  claimNextTask() {
    const now = nowIso()
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE status IN ('pending', 'deferred')
             AND (next_run_at IS NULL OR next_run_at <= ?)
           ORDER BY priority DESC, created_at ASC LIMIT 1`,
        )
        .get(now)
      if (!row) return null
      const info = this.db
        .prepare(
          `UPDATE tasks SET status = 'processing', started_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'deferred')`,
        )
        .run(now, now, row.id)
      if (!Number(info.changes)) return null
      return this.getTask(row.id)
    })
  }

  completeTask(id, result, outputPath) {
    const now = nowIso()
    this.db
      .prepare(
        `UPDATE tasks SET status = 'completed', result_json = ?, output_path = ?,
         updated_at = ?, finished_at = ?, last_error = NULL, error_category = NULL
         WHERE id = ?`,
      )
      .run(JSON.stringify(result == null ? null : result), outputPath || null, now, now, id)
    return this.getTask(id)
  }

  failTask(id, error, category, retryAt) {
    const task = this.getTask(id)
    if (!task) return null
    const attempts = Number(task.attempts) + 1
    const retryable = Boolean(retryAt) && attempts < Number(task.max_attempts)
    const now = nowIso()
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, attempts = ?, last_error = ?, error_category = ?,
         next_run_at = ?, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        retryable ? 'pending' : 'failed',
        attempts,
        cleanText(error).slice(0, 2000),
        category || 'unknown',
        retryable ? new Date(retryAt).toISOString() : null,
        now,
        retryable ? null : now,
        id,
      )
    return this.getTask(id)
  }

  deferTask(id, error, category, nextRunAt) {
    const now = nowIso()
    this.db
      .prepare(
        `UPDATE tasks SET status = 'deferred', last_error = ?, error_category = ?,
         next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(cleanText(error).slice(0, 2000), category || 'deferred', nextRunAt || null, now, id)
    return this.getTask(id)
  }

  recoverTasks() {
    const now = nowIso()
    const info = this.db
      .prepare(
        `UPDATE tasks SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
          attempts = attempts + 1, next_run_at = ?, updated_at = ?,
          last_error = COALESCE(last_error, '服务重启时任务仍在执行')
         WHERE status = 'processing'`,
      )
      .run(now, now)
    return Number(info.changes || 0)
  }

  pendingTaskNotifications(limit = 3, since = null) {
    const rows = since
      ? this.db
          .prepare(
            `SELECT * FROM tasks
             WHERE status = 'completed' AND notify_status = 'pending'
               AND notify_channel IS NOT NULL AND finished_at >= ?
             ORDER BY finished_at ASC LIMIT ?`,
          )
          .all(since, limit)
      : this.db
          .prepare(
            `SELECT * FROM tasks
             WHERE status = 'completed' AND notify_status = 'pending'
               AND notify_channel IS NOT NULL
             ORDER BY finished_at ASC LIMIT ?`,
          )
          .all(limit)
    return rows.map(rowToTask)
  }

  markTaskNotified(id, status) {
    this.db
      .prepare('UPDATE tasks SET notify_status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id)
  }

  recordUsage(entry) {
    this.db
      .prepare(
        `INSERT INTO api_usage(
          request_id, task_id, request_type, model, input_tokens, output_tokens,
          cache_hit_tokens, cache_miss_tokens, latency_ms, estimated_cost_usd,
          pricing_period, status, error_category, error_message, raw_usage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.requestId,
        entry.taskId || null,
        entry.requestType,
        entry.model,
        entry.inputTokens == null ? null : Number(entry.inputTokens),
        entry.outputTokens == null ? null : Number(entry.outputTokens),
        entry.cacheHitTokens == null ? null : Number(entry.cacheHitTokens),
        entry.cacheMissTokens == null ? null : Number(entry.cacheMissTokens),
        entry.latencyMs == null ? null : Number(entry.latencyMs),
        entry.estimatedCostUsd == null ? null : Number(entry.estimatedCostUsd),
        entry.pricingPeriod || null,
        entry.status || 'ok',
        entry.errorCategory || null,
        entry.errorMessage ? cleanText(entry.errorMessage).slice(0, 1000) : null,
        entry.rawUsage ? JSON.stringify(entry.rawUsage) : null,
        nowIso(),
      )
  }

  usageSummary({ since = null, until = null } = {}) {
    const clauses = []
    const params = []
    if (since) {
      clauses.push('created_at >= ?')
      params.push(since)
    }
    if (until) {
      clauses.push('created_at < ?')
      params.push(until)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const totals = this.db
      .prepare(
        `SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
          COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens,
          COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
          SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors
        FROM api_usage ${where}`,
      )
      .get(...params)
    const byType = this.db
      .prepare(
        `SELECT request_type, model, COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
          COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
         FROM api_usage ${where}
         GROUP BY request_type, model ORDER BY estimated_cost_usd DESC`,
      )
      .all(...params)
    return { totals, byType }
  }

  usageCostSince(iso) {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost, COUNT(*) AS requests
         FROM api_usage WHERE created_at >= ? AND status = 'ok'`,
      )
      .get(iso)
    return { cost: Number(row.cost) || 0, requests: Number(row.requests) || 0 }
  }

  recordDelivery(kind, runKey, patch = {}) {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO delivery_runs(kind, run_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, run_key) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(kind, runKey, patch.status || 'running', now, now)
    this.updateDelivery(kind, runKey, patch)
    return this.getDelivery(kind, runKey)
  }

  updateDelivery(kind, runKey, patch = {}) {
    const allowed = [
      'status',
      'collect_ok',
      'analyze_ok',
      'report_ok',
      'message_ok',
      'file_ok',
      'report_path',
      'error_category',
      'last_error',
    ]
    const fields = []
    const values = []
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        fields.push(`${key} = ?`)
        values.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key])
      }
    }
    if (patch.finished) {
      fields.push('finished_at = ?')
      values.push(nowIso())
    }
    if (!fields.length) return this.getDelivery(kind, runKey)
    fields.push('updated_at = ?')
    values.push(nowIso(), kind, runKey)
    this.db
      .prepare(`UPDATE delivery_runs SET ${fields.join(', ')} WHERE kind = ? AND run_key = ?`)
      .run(...values)
    return this.getDelivery(kind, runKey)
  }

  getDelivery(kind, runKey) {
    return this.db
      .prepare('SELECT * FROM delivery_runs WHERE kind = ? AND run_key = ?')
      .get(kind, runKey)
  }


  setAnalysisStatus(paperId, status) {
    this.db.prepare('UPDATE papers SET analysis_status = ? WHERE id = ?').run(status, paperId)
  }

  latestSuccessfulDelivery(kind) {
    return this.db
      .prepare(
        `SELECT * FROM delivery_runs
         WHERE kind = ? AND message_ok = 1 AND report_ok = 1
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(kind)
  }

  latestDelivery(kind) {
    return this.db
      .prepare('SELECT * FROM delivery_runs WHERE kind = ? ORDER BY created_at DESC LIMIT 1')
      .get(kind)
  }

  upsertRepository(repo) {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO repositories(full_name, url, purpose, why_tracked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(full_name) DO UPDATE SET
           url = excluded.url, purpose = excluded.purpose,
           why_tracked = excluded.why_tracked, updated_at = excluded.updated_at`,
      )
      .run(
        repo.fullName,
        `https://github.com/${repo.fullName}`,
        repo.purpose || '',
        repo.whyTracked || '',
        now,
        now,
      )
    return this.db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(repo.fullName)
  }

  getRepositories() {
    return this.db.prepare('SELECT * FROM repositories ORDER BY full_name').all()
  }

  updateRepository(id, patch = {}) {
    const allowed = [
      'last_checked_at',
      'last_success_at',
      'releases_etag',
      'pulls_etag',
      'issues_etag',
      'last_error',
    ]
    const fields = []
    const values = []
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        fields.push(`${key} = ?`)
        values.push(patch[key])
      }
    }
    if (!fields.length) return
    fields.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.prepare(`UPDATE repositories SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  insertRepositoryEvent(repoId, event) {
    const now = nowIso()
    try {
      this.db
        .prepare(
          `INSERT INTO repository_events(
            repo_id, event_key, event_type, title, url, published_at, summary,
            importance, action_needed, notified_at, raw_json, first_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          repoId,
          event.eventKey,
          event.eventType,
          event.title,
          event.url || null,
          event.publishedAt || null,
          event.summary || null,
          event.importance || 'normal',
          event.actionNeeded ? 1 : 0,
          event.notifiedAt || null,
          JSON.stringify(event.raw || {}),
          now,
        )
      return true
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) return false
      throw error
    }
  }

  unnotifiedRepositoryEvents(limit = 10) {
    return this.db
      .prepare(
        `SELECT e.*, r.full_name, r.purpose
         FROM repository_events e JOIN repositories r ON r.id = e.repo_id
         WHERE e.notified_at IS NULL
         ORDER BY CASE e.importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                  COALESCE(e.published_at, e.first_seen_at) DESC
         LIMIT ?`,
      )
      .all(limit)
  }

  markRepositoryEventsNotified(ids) {
    const list = (ids || []).map(Number).filter(Number.isFinite)
    if (!list.length) return 0
    const stmt = this.db.prepare('UPDATE repository_events SET notified_at = ? WHERE id = ?')
    const now = nowIso()
    let count = 0
    this.transaction(() => {
      for (const id of list) count += Number(stmt.run(now, id).changes || 0)
    })
    return count
  }

  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM system_state WHERE key = ?').get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value_json)
    } catch (error) {
      return fallback
    }
  }

  setState(key, value) {
    this.db
      .prepare(
        `INSERT INTO system_state(key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso())
  }


  stats() {
    const papers = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN analysis_status = 'completed' THEN 1 ELSE 0 END) AS analyzed,
          SUM(CASE WHEN analysis_status = 'legacy' THEN 1 ELSE 0 END) AS legacy,
          SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN analysis_status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
          SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) AS read_count,
          SUM(CASE WHEN read_status = 'reproduce' THEN 1 ELSE 0 END) AS reproduce_count,
          SUM(CASE WHEN pushed_at IS NOT NULL THEN 1 ELSE 0 END) AS pushed
         FROM papers`,
      )
      .get()
    const tasks = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')
      .all()
    const repos = this.db
      .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS synced FROM repositories')
      .get()
    return { papers, tasks, repos }
  }
}

module.exports = {
  ResearchDatabase,
  SCHEMA_VERSION,
  makeId,
  rowToPaper,
  rowToAnalysis,
  rowToTask,
}
