'use strict'

const fs = require('fs')
const path = require('path')
const { cleanText, safeFilename, truncate } = require('./text')

const MANAGED_START = '<!-- research-agent:managed:start -->'
const MANAGED_END = '<!-- research-agent:managed:end -->'
const USER_START = '<!-- research-agent:user:start -->'
const USER_END = '<!-- research-agent:user:end -->'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch (error) {
    // Existing directories may be managed by the user.
  }
}

function yamlQuote(value) {
  return JSON.stringify(cleanText(value))
}

function formatFrontmatter(paper) {
  const tags = paper.directionTags || []
  return [
    '---',
    `title: ${yamlQuote(paper.title)}`,
    `arxiv: ${yamlQuote(paper.arxiv_id || '')}`,
    `authors: [${(paper.authors || []).map(yamlQuote).join(', ')}]`,
    `url: ${yamlQuote(paper.url || (paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : ''))}`,
    `doi: ${yamlQuote(paper.doi || '')}`,
    `published: ${yamlQuote(paper.published_at || '')}`,
    `source: ${yamlQuote(paper.source || 'arxiv')}`,
    `direction: ${yamlQuote(paper.primary_direction || 'uncategorized')}`,
    `tags: [${tags.map(yamlQuote).join(', ')}]`,
    `read_status: ${yamlQuote(paper.read_status || 'unread')}`,
    '---',
    '',
  ].join('\n')
}

function formatScores(scores) {
  if (!scores) return '尚未评分'
  const labels = {
    relevance: '相关性',
    novelty: '创新性',
    evidence: '证据',
    reproducibility: '复现',
    timeliness: '时效',
  }
  return Object.entries(labels)
    .map(([key, label]) => `${label} ${scores[key] == null ? '—' : Number(scores[key]).toFixed(0)}`)
    .join(' · ')
}

function analysisSection(paper, analysis) {
  const lines = []
  lines.push('## 自动分析')
  lines.push('')
  if (paper.score_total != null) {
    lines.push(`**综合分：${Number(paper.score_total).toFixed(1)} / 100** · ${formatScores(paper.scores)}`)
  } else {
    lines.push('**综合分：尚未评分（仅有关键词粗排）**')
  }
  lines.push(`阅读状态：${paper.read_status || 'unread'}${paper.feedback ? ` · 反馈：${paper.feedback}` : ''}`)
  lines.push('')
  if (!analysis) {
    lines.push(`摘要：${cleanText(paper.summary) || cleanText(paper.abstract) || '暂无'}`)
    lines.push('')
    lines.push('> 尚未完成结构化分析。发送 `研究.总结 ' + (paper.arxiv_id || paper.id) + '` 可请求分析。')
    return lines.join('\n')
  }
  const rows = [
    ['摘要', analysis.summary],
    ['核心贡献', analysis.core_contribution],
    ['相对已有工作', analysis.difference_from_prior],
    ['证据边界', analysis.evidence_boundary],
    ['局限', analysis.limitations],
    ['与我的研究关系', (analysis.related_projects || []).join('；')],
    ['推荐理由', analysis.recommendation],
    ['创新性判断', analysis.novelty_judgment],
  ]
  for (const [label, value] of rows) {
    if (!cleanText(value)) continue
    lines.push(`### ${label}`)
    lines.push('')
    lines.push(cleanText(value))
    lines.push('')
  }
  if (analysis.novelty_preliminary) {
    lines.push('> 创新性判断仅基于摘要，属于初步判断，尚未用全文实验核验。')
    lines.push('')
  }
  lines.push('### 链接')
  lines.push('')
  if (paper.arxiv_id) lines.push(`- arXiv：https://arxiv.org/abs/${paper.arxiv_id}`)
  if (paper.url && paper.url !== `https://arxiv.org/abs/${paper.arxiv_id}`) {
    lines.push(`- 原文：${paper.url}`)
  }
  lines.push(`- 最后自动更新：${new Date().toISOString().slice(0, 10)}`)
  return lines.join('\n')
}

function managedBlock(paper, analysis) {
  return [MANAGED_START, analysisSection(paper, analysis), MANAGED_END].join('\n')
}

function defaultUserBlock() {
  return [USER_START, '## 我的笔记', '', USER_END].join('\n')
}

function createPaperNote(paper, analysis) {
  const frontmatter = formatFrontmatter(paper)
  return `${frontmatter}\n${managedBlock(paper, analysis)}\n\n${defaultUserBlock()}\n`
}

function addMissingFrontmatter(existing, paper) {
  const match = existing.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return existing
  const body = match[1]
  const additions = []
  if (!/^authors:/m.test(body)) {
    additions.push(`authors: [${(paper.authors || []).map(yamlQuote).join(', ')}]`)
  }
  if (!/^url:/m.test(body)) {
    additions.push(`url: ${yamlQuote(paper.url || (paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : ''))}`)
  }
  if (!additions.length) return existing
  return `---\n${body}\n${additions.join('\n')}\n---\n${existing.slice(match[0].length)}`
}

function updateManagedBlock(existing, paper, analysis) {
  const start = existing.indexOf(MANAGED_START)
  const end = existing.indexOf(MANAGED_END)
  if (start < 0 || end < start) return null
  return (
    existing.slice(0, start) +
    managedBlock(paper, analysis) +
    existing.slice(end + MANAGED_END.length)
  )
}

function writePaperNote({ root, paper, analysis, logger }) {
  const dir = path.join(root, 'papers')
  ensureDir(dir)
  const filename = `${safeFilename(paper.canonical_key || paper.arxiv_id || paper.id)}.md`
  const file = path.join(dir, filename)
  let content
  if (!fs.existsSync(file)) {
    content = createPaperNote(paper, analysis)
  } else {
    const existing = fs.readFileSync(file, 'utf8')
    if (existing.includes(MANAGED_START) && existing.includes(MANAGED_END)) {
      content = updateManagedBlock(existing, paper, analysis)
      if (content == null) {
        if (logger && logger.warn) logger.warn('知识库文件 managed 区块损坏，跳过自动更新: %s', file)
        return { file, changed: false, reason: 'broken-managed-block' }
      }
      content = addMissingFrontmatter(content, paper)
      content = content.replace(/^read_status:.*$/m, `read_status: ${yamlQuote(paper.read_status || 'unread')}`)
      if (content === existing) return { file, changed: false, reason: 'unchanged' }
    } else {
      if (logger && logger.debug) logger.debug('知识库文件无 managed 区块，保留用户内容: %s', file)
      return { file, changed: false, reason: 'user-owned' }
    }
  }
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
  return { file, changed: true, reason: 'written' }
}

function writeReproductionNote({ root, paper }) {
  const dir = path.join(root, 'reproduction-notes')
  ensureDir(dir)
  const filename = `${safeFilename(paper.canonical_key || paper.arxiv_id || paper.id)}.md`
  const file = path.join(dir, filename)
  if (fs.existsSync(file)) return { file, created: false }
  const content = [
    '---',
    `title: ${yamlQuote(`复现：${paper.title}`)}`,
    `arxiv: ${yamlQuote(paper.arxiv_id || '')}`,
    'status: planned',
    '---',
    '',
    `# ${paper.title}`,
    '',
    '## 复现目标',
    '',
    '- 要验证的论文主张：',
    '- 需要的最小实验：',
    '- 可复用的 baseline / 代码：',
    '',
    '## 环境与成本',
    '',
    '- GPU / 内存：',
    '- 数据：',
    '- 预计 API / 训练成本：',
    '',
    '## 结果',
    '',
    '| 指标 | 论文报告 | 本地结果 | 差异 |',
    '| --- | --- | --- | --- |',
    '|  |  |  |  |',
    '',
    '## 失败与不确定性',
    '',
    '- ',
    '',
    '## 相关论文',
    '',
    `- [[${safeFilename(paper.canonical_key || paper.arxiv_id || paper.id)}]]`,
    '',
  ].join('\n')
  fs.writeFileSync(file, content, { mode: 0o600 })
  return { file, created: true }
}

function ensureKnowledgeDirs(root) {
  for (const name of [
    'papers',
    'research-projects',
    'literature-reviews',
    'research-questions',
    'reproduction-notes',
    'daily-digests',
  ]) {
    ensureDir(path.join(root, name))
  }
}


function writeResearchQuestionsNote({ root, direction, text, evidenceIds, generatedAt }) {
  const dir = path.join(root, 'research-questions')
  ensureDir(dir)
  const file = path.join(dir, `${safeFilename(direction.id)}.md`)
  const block = [
    MANAGED_START,
    `## ${direction.label} · 自动生成候选问题`,
    '',
    `生成时间：${generatedAt || new Date().toISOString()}`,
    `证据论文：${(evidenceIds || []).join('、') || '无'}`,
    '',
    cleanText(text),
    MANAGED_END,
  ].join('\n')
  let content
  if (!fs.existsSync(file)) {
    content = [
      '---',
      `title: ${yamlQuote(`${direction.label} 候选研究问题`)}`,
      `direction: ${yamlQuote(direction.id)}`,
      '---',
      '',
      block,
      '',
      defaultUserBlock(),
      '',
    ].join('\n')
  } else {
    const existing = fs.readFileSync(file, 'utf8')
    const start = existing.indexOf(MANAGED_START)
    const end = existing.indexOf(MANAGED_END)
    if (start < 0 || end < start) return { file, changed: false, reason: 'user-owned' }
    content = existing.slice(0, start) + block + existing.slice(end + MANAGED_END.length)
    if (content === existing) return { file, changed: false, reason: 'unchanged' }
  }
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
  return { file, changed: true, reason: 'written' }
}

module.exports = {
  MANAGED_START,
  MANAGED_END,
  USER_START,
  USER_END,
  writePaperNote,
  writeReproductionNote,
  writeResearchQuestionsNote,
  ensureKnowledgeDirs,
  createPaperNote,
  updateManagedBlock,
  addMissingFrontmatter,
  formatFrontmatter,
  formatScores,
  truncate,
}
