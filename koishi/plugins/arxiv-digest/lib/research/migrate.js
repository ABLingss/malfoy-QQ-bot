'use strict'

const fs = require('fs')
const path = require('path')
const {
  cleanText,
  cjkRatio,
  canonicalArxivId,
  abstractHash,
  sha256,
  normalizeForHash,
} = require('./text')
const { matchDirections } = require('./profile')

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return fallback
  }
}

function classifySummary(summary, abstract) {
  const text = cleanText(summary)
  const source = cleanText(abstract)
  if (!text) return 'none'
  if (source) {
    const normalizedSummary = normalizeForHash(text)
    const normalizedSource = normalizeForHash(source)
    if (
      normalizedSummary.length >= 40 &&
      (normalizedSource.startsWith(normalizedSummary.slice(0, Math.min(120, normalizedSummary.length))) ||
        (normalizedSummary.length >= 80 &&
          normalizedSummary.slice(0, 80) === normalizedSource.slice(0, 80)))
    ) {
      return 'fallback'
    }
  }
  if (text.length >= 30 && cjkRatio(text) >= 0.15) return 'generated'
  return 'unverified'
}

function paperFromDigest(paper, digest, profile) {
  const arxivId = canonicalArxivId(paper.id || paper.arxivId || '')
  if (!arxivId) return null
  const canonicalKey = `arxiv:${arxivId}`
  const matches = matchDirections(
    {
      title: paper.title,
      abstract: paper.summaryText || paper.summary || '',
      primaryCategory: paper.primaryCategory || '',
      categories: paper.categories || [],
    },
    profile,
  )
  return {
    canonicalKey,
    arxivId,
    title: cleanText(paper.title) || `arXiv ${arxivId}`,
    abstract: cleanText(paper.abstract || ''),
    authors: Array.isArray(paper.authors) ? paper.authors : [],
    publishedAt: paper.published || paper.publishedAt || null,
    updatedAt: paper.updated || paper.updatedAt || null,
    url: paper.url || `https://arxiv.org/abs/${arxivId}`,
    source: 'legacy-digest',
    directionTags: matches.map((match) => match.id),
    primaryDirection: matches[0] ? matches[0].id : null,
    raw: {
      migratedFrom: `digests/${digest.date}.json`,
      legacyScore: paper.score,
      matchedGroups: paper.matchedGroups || paper.groups || [],
      lineage: paper.lineage || [],
    },
  }
}

function parseReportMarkdown(file, profile) {
  const text = fs.readFileSync(file, 'utf8')
  const blocks = text.split(/\n(?=\d+\.\s)/)
  const results = []
  for (const block of blocks) {
    const titleMatch = block.match(/^(\d+)\.\s+(.+)$/m)
    const urlMatch = block.match(/arXiv:\s*(https:\/\/arxiv\.org\/abs\/([^\s)]+))/)
    if (!titleMatch || !urlMatch) continue
    const arxivId = canonicalArxivId(urlMatch[2])
    if (!arxivId) continue
    const abstractMatch = block.match(/摘要：([^\n]+)/)
    const summary = abstractMatch ? cleanText(abstractMatch[1]) : ''
    const matches = matchDirections(
      { title: titleMatch[2], abstract: summary, categories: [] },
      profile,
    )
    results.push({
      canonicalKey: `arxiv:${arxivId}`,
      arxivId,
      title: cleanText(titleMatch[2]),
      abstract: '',
      authors: [],
      publishedAt: null,
      source: 'legacy-report',
      directionTags: matches.map((match) => match.id),
      primaryDirection: matches[0] ? matches[0].id : null,
      summaryHint: summary,
      raw: { migratedFrom: path.basename(file) },
    })
  }
  return results
}

function listDigestFiles(dataDir) {
  const dir = path.join(dataDir, 'digests')
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .map((name) => ({ name, file: path.join(dir, name), date: name.slice(0, 10) }))
  } catch (error) {
    return []
  }
}

function listReportFiles(dataDir) {
  const dir = path.join(dataDir, 'reports', 'daily')
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .map((name) => ({ name, file: path.join(dir, name), date: name.slice(0, 10) }))
  } catch (error) {
    return []
  }
}

function migrateLegacyData({ db, profile, dataDir, stateFile, logger }) {
  const report = {
    startedAt: new Date().toISOString(),
    sources: {},
    papers: { discovered: 0, created: 0, existing: 0, withDigest: 0, titleOnly: 0 },
    summaries: { generated: 0, fallback: 0, unverified: 0, none: 0 },
    analysisRows: 0,
    errors: [],
  }
  const loggerSafe = logger || console
  const seen = new Set()

  for (const digestFile of listDigestFiles(dataDir)) {
    const digest = readJson(digestFile.file, null)
    if (!digest || !Array.isArray(digest.papers)) {
      report.errors.push(`无法读取 ${digestFile.name}`)
      continue
    }
    report.sources[digestFile.name] = digest.papers.length
    for (const legacyPaper of digest.papers) {
      try {
        const paper = paperFromDigest(legacyPaper, digest, profile)
        if (!paper) continue
        report.papers.discovered += 1
        const upserted = db.upsertPaper(paper)
        if (upserted.isNew) report.papers.created += 1
        else report.papers.existing += 1
        seen.add(paper.canonicalKey)
        const summary = cleanText(legacyPaper.summary || legacyPaper.summaryText)
        const abstract = paper.abstract || ''
        const kind = classifySummary(summary, abstract)
        report.summaries[kind] = (report.summaries[kind] || 0) + 1
        if (kind === 'generated') {
          const inputHash = sha256(`legacy-summary-v1:${abstractHash(abstract || summary)}`)
          const existing = db.getAnalysisByInputHash(upserted.id, inputHash, 'legacy_summary')
          db.saveAnalysis(
            upserted.id,
            {
              summary,
              coreContribution: '',
              differenceFromPrior: '',
              evidenceBoundary: '历史摘要迁移，未保留当时的完整分析与实验核验记录。',
              limitations: '',
              relatedProjects: [],
              recommendation: '',
              direction: paper.primaryDirection,
              scores: null,
              noveltyPreliminary: true,
              raw: { source: 'legacy-state-or-digest' },
            },
            {
              inputHash,
              analysisType: 'legacy_summary',
              promptVersion: 'legacy-v1',
              profileVersion: profile.version,
              model: 'legacy',
            },
          )
          if (!existing) report.analysisRows += 1
        } else if (summary) {
          db.markPaperSummary(
            upserted.id,
            summary,
            kind === 'fallback' ? 'abstract_excerpt' : 'legacy_unverified',
            'none',
          )
        }
        db.markPushed([upserted.id], digest.date)
        report.papers.withDigest += 1
      } catch (error) {
        report.errors.push(`${digestFile.name}/${legacyPaper.id}: ${error.message}`)
      }
    }
  }

  for (const reportFile of listReportFiles(dataDir)) {
    if (report.sources[`${reportFile.date}.json`]) continue
    try {
      const papers = parseReportMarkdown(reportFile.file, profile)
      report.sources[`${reportFile.name} (md-only)`] = papers.length
      for (const paper of papers) {
        if (seen.has(paper.canonicalKey)) continue
        const summaryHint = paper.summaryHint
        delete paper.summaryHint
        const upserted = db.upsertPaper(paper)
        if (upserted.isNew) report.papers.created += 1
        else report.papers.existing += 1
        seen.add(paper.canonicalKey)
        if (summaryHint) {
          const kind = classifySummary(summaryHint, '')
          report.summaries[kind] = (report.summaries[kind] || 0) + 1
          db.markPaperSummary(upserted.id, summaryHint, 'legacy_unverified', 'none')
        }
        db.markPushed([upserted.id], reportFile.date)
        report.papers.titleOnly += 1
      }
    } catch (error) {
      report.errors.push(`${reportFile.name}: ${error.message}`)
    }
  }

  const state = readJson(stateFile, null)
  if (state && state.summaries && typeof state.summaries === 'object') {
    report.sources['state.json'] = Object.keys(state.summaries).length
    for (const [rawId, summary] of Object.entries(state.summaries)) {
      const arxivId = canonicalArxivId(rawId)
      if (!arxivId) continue
      const key = `arxiv:${arxivId}`
      if (seen.has(key)) continue
      try {
        const upserted = db.upsertPaper({
          canonicalKey: key,
          arxivId,
          title: `arXiv ${arxivId}`,
          abstract: '',
          authors: [],
          source: 'legacy-state',
          directionTags: [],
          primaryDirection: null,
          raw: { migratedFrom: 'state.json', titleMissing: true },
        })
        if (upserted.isNew) report.papers.created += 1
        else report.papers.existing += 1
        seen.add(key)
        const kind = classifySummary(summary, '')
        report.summaries[kind] = (report.summaries[kind] || 0) + 1
        if (kind === 'generated') {
          const inputHash = sha256(`legacy-summary-state-v1:${abstractHash(summary)}`)
          const existing = db.getAnalysisByInputHash(upserted.id, inputHash, 'legacy_summary')
          db.saveAnalysis(
            upserted.id,
            {
              summary,
              coreContribution: '',
              differenceFromPrior: '',
              evidenceBoundary: '仅从 state.json 迁移摘要；缺少标题与摘要原文，无法复核。',
              limitations: '',
              relatedProjects: [],
              recommendation: '',
              direction: null,
              scores: null,
              noveltyPreliminary: true,
              raw: { source: 'state.json' },
            },
            {
              inputHash,
              analysisType: 'legacy_summary',
              promptVersion: 'legacy-state-v1',
              profileVersion: profile.version,
              model: 'legacy',
            },
          )
          if (!existing) report.analysisRows += 1
        } else {
          db.markPaperSummary(upserted.id, summary, 'legacy_unverified', 'none')
        }
      } catch (error) {
        report.errors.push(`state.json/${rawId}: ${error.message}`)
      }
    }
  }

  report.finishedAt = new Date().toISOString()
  report.database = {
    papers: db.stats().papers,
    path: db.file,
  }
  if (report.errors.length) {
    loggerSafe.warn && loggerSafe.warn('历史迁移有 %d 条错误', report.errors.length)
  }
  return report
}

module.exports = {
  migrateLegacyData,
  classifySummary,
  parseReportMarkdown,
  listDigestFiles,
  listReportFiles,
}
