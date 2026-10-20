'use strict'

const path = require('path')
const { cleanText, truncate } = require('./text')
const { scoreBand } = require('./profile')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../../../..')

function displayPath(file) {
  if (!file) return ''
  const relative = path.relative(PROJECT_ROOT, file)
  return relative.startsWith('..') ? file : relative
}

function directionLabel(paper) {
  return (paper.direction_label || paper.primary_direction || '未分类')
}

function scoreText(paper) {
  const score = paper.score_total == null ? null : Number(paper.score_total)
  if (!Number.isFinite(score)) return '未评分'
  if (paper.analysis_status && paper.analysis_status !== 'completed') {
    return `粗排 ${score.toFixed(1)}（未完成结构化分析）`
  }
  return `${score.toFixed(1)}（${scoreBand(score)}）`
}

function scoreBreakdown(scores) {
  if (!scores) return ''
  return [
    `R ${scores.relevance == null ? '—' : Number(scores.relevance).toFixed(0)}`,
    `N ${scores.novelty == null ? '—' : Number(scores.novelty).toFixed(0)}`,
    `E ${scores.evidence == null ? '—' : Number(scores.evidence).toFixed(0)}`,
    `P ${scores.reproducibility == null ? '—' : Number(scores.reproducibility).toFixed(0)}`,
    `T ${scores.timeliness == null ? '—' : Number(scores.timeliness).toFixed(0)}`,
  ].join(' · ')
}

function authorsText(paper, limit = 3) {
  const authors = paper.authors || []
  if (!authors.length) return '作者未知'
  return `${authors.slice(0, limit).join('、')}${authors.length > limit ? ' 等' : ''}`
}

function paperLink(paper) {
  return paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : paper.url || ''
}

function renderTop3Item(item, index) {
  const paper = item.paper || item
  const analysis = item.analysis || {}
  const lines = [
    `${index + 1}. ${paper.title}`,
    `${directionLabel(paper)} · ${scoreText(paper)} · ${scoreBreakdown(paper.scores)}`,
    `为什么读：${cleanText(analysis.recommendation) || '摘要层面相关，建议先核验方法与实验。'}`,
  ]
  if (analysis.core_contribution) lines.push(`核心贡献：${truncate(analysis.core_contribution, 320)}`)
  if (analysis.difference_from_prior) {
    lines.push(`相对已有工作：${truncate(analysis.difference_from_prior, 300)}`)
  }
  if (analysis.evidence_boundary) lines.push(`证据边界：${truncate(analysis.evidence_boundary, 300)}`)
  if (analysis.limitations) lines.push(`局限：${truncate(analysis.limitations, 240)}`)
  if ((analysis.related_projects || []).length) {
    lines.push(`与你相关：${analysis.related_projects.join('；')}`)
  }
  lines.push(`下一步：${nextStep(paper, analysis)}`)
  if (paperLink(paper)) lines.push(`链接：${paperLink(paper)}`)
  return lines.join('\n')
}

function nextStep(paper, analysis) {
  const text = `${analysis.recommendation || ''} ${analysis.evidence_boundary || ''} ${analysis.limitations || ''}`
  if (/复现|代码|数据|实验/.test(text)) return '检查代码/数据是否公开，确认 baseline 与训练预算后再决定是否复现。'
  if (/全文|证据|统计/.test(text)) return '先读实验与消融部分，核对作者主张是否有统计和基线支持。'
  return '先读方法部分，判断机制是否独立于提示词、模型规模和评估协议。'
}

function renderPaperLine(paper) {
  const summary = paper.summary || paper.abstract || ''
  const lines = [
    `- ${paper.title}`,
    `  ${directionLabel(paper)} · ${scoreText(paper)}${paper.pushed_at ? ' · 已推送过' : ''}`,
    `  ${truncate(summary, 180) || '暂无摘要'}`,
  ]
  if (paper.arxiv_id) lines.push(`  https://arxiv.org/abs/${paper.arxiv_id}`)
  return lines.join('\n')
}

function renderAnalysisDetail(paper, analysis) {
  const lines = [
    `📄 ${paper.title}`,
    `${directionLabel(paper)} · ${scoreText(paper)} · ${scoreBreakdown(paper.scores)}`,
    `arXiv：${paperLink(paper) || '无'}`,
    `作者：${authorsText(paper)}`,
    '',
    `摘要：${analysis.summary || paper.summary || '暂无'}`,
  ]
  const sections = [
    ['核心贡献', analysis.core_contribution],
    ['相对已有工作', analysis.difference_from_prior],
    ['证据边界', analysis.evidence_boundary],
    ['局限', analysis.limitations],
    ['与你的研究关系', (analysis.related_projects || []).join('；')],
    ['推荐', analysis.recommendation],
    ['创新性判断', analysis.novelty_judgment],
  ]
  for (const [label, value] of sections) {
    if (value) lines.push(`${label}：${value}`)
  }
  if (analysis.novelty_preliminary) lines.push('注意：创新性判断仅基于摘要，属于初步判断。')
  return lines.join('\n')
}

function renderCompare(left, right) {
  const a = left.paper
  const b = right.paper
  const aa = left.analysis || {}
  const ab = right.analysis || {}
  const lines = [
    '⚖️ 论文对比',
    '',
    `A. ${a.title}`,
    `   ${directionLabel(a)} · ${scoreText(a)}`,
    `B. ${b.title}`,
    `   ${directionLabel(b)} · ${scoreText(b)}`,
    '',
    '核心贡献：',
    `A: ${truncate(aa.core_contribution || aa.summary || '无分析', 300)}`,
    `B: ${truncate(ab.core_contribution || ab.summary || '无分析', 300)}`,
    '',
    '证据边界：',
    `A: ${truncate(aa.evidence_boundary || '无', 260)}`,
    `B: ${truncate(ab.evidence_boundary || '无', 260)}`,
    '',
    '局限：',
    `A: ${truncate(aa.limitations || '无', 240)}`,
    `B: ${truncate(ab.limitations || '无', 240)}`,
    '',
    '与你的研究：',
    `A: ${(aa.related_projects || []).join('；') || '未分析'}`,
    `B: ${(ab.related_projects || []).join('；') || '未分析'}`,
  ]
  if (a.score_total != null && b.score_total != null) {
    const diff = Number(a.score_total) - Number(b.score_total)
    lines.push('', `综合分差：${diff > 0 ? 'A' : 'B'} 高 ${Math.abs(diff).toFixed(1)} 分。分数是启发式，不代替全文判断。`)
  }
  return lines.join('\n')
}

function renderQuestions(result, directionLabelText) {
  const lines = [`🧭 ${directionLabelText} 的可验证候选问题`]
  if (!result.questions || !result.questions.length) {
    lines.push('当前证据不足以提出合格候选问题。')
    return lines.join('\n')
  }
  for (const [index, item] of result.questions.entries()) {
    lines.push('')
    lines.push(`${index + 1}. ${item.question}`)
    lines.push(`   为什么重要：${item.whyItMatters}`)
    lines.push(`   证据：${(item.evidence || []).join('、') || '无'}`)
    lines.push(`   反例：${item.counterexample || '未说明'}`)
    lines.push(`   最小实验：${item.experiment || '未说明'}`)
    lines.push(`   不确定性：${item.uncertainty || '未说明'}`)
  }
  lines.push('')
  lines.push('这些是根据已存论文摘要和分析生成的候选问题，不是已验证的研究空白。')
  return lines.join('\n')
}

function buildDailyMarkdown({
  date,
  week,
  weatherText,
  ccfChunks,
  top3,
  fullPapers,
  githubText,
  analysisStats,
  generatedAt,
}) {
  const lines = [
    `# 研究日报 · ${date}`,
    '',
    `> ${week.date} ${week.weekdayLabel} · 第 ${week.weekNumber} 周 · ${week.rangeLabel}`,
    '',
  ]
  if (weatherText) lines.push('## 天气', '', weatherText, '')
  lines.push('## 今日最值得读', '')
  if (top3 && top3.length) {
    top3.forEach((item, index) => {
      lines.push(renderTop3Item(item, index), '')
    })
  } else {
    lines.push('今天没有达到推荐标准的新论文。没有为了凑满三篇而降低标准。', '')
  }
  if (ccfChunks && ccfChunks.length) {
    lines.push('## 会议截稿', '', ccfChunks.join('\n\n'), '')
  }
  if (githubText) {
    lines.push('## GitHub 科研工具', '', githubText, '')
  }
  lines.push('## 今日完整候选', '')
  if (fullPapers.length) {
    fullPapers.forEach((paper) => lines.push(renderPaperLine(paper)))
    lines.push('')
  } else {
    lines.push('今日没有通过研究方向筛选的候选。', '')
  }
  lines.push('## 方法与证据说明', '')
  lines.push('- 推荐分数：S = 0.40R + 0.25N + 0.15E + 0.10P + 0.10T，各分项 0–100。')
  lines.push('- 新论文的 N/E/P 由 DeepSeek 基于标题和摘要做初步判断；没有全文证据时明确标为初步。')
  lines.push('- 已分析过的论文优先复用 SQLite 缓存；摘要哈希变化才进入增量分析。')
  lines.push(`- 本次分析：新调用 ${analysisStats.newCalls} 批，缓存复用 ${analysisStats.cacheHits} 篇，失败/推迟 ${analysisStats.failed} 篇。`)
  lines.push('')
  lines.push('---')
  lines.push(`生成时间：${generatedAt}`)
  lines.push('数据来源：arXiv、CCFDDL、Open-Meteo、GitHub、DeepSeek。')
  return lines.join('\n')
}

function buildDailyChunks({ date, week, top3, fullPapers, weatherText, ccfChunks, githubText }) {
  const chunks = []
  const header = [
    `📚 研究日报 · ${date}`,
    `🗓 ${week.date} ${week.weekdayLabel} · 第 ${week.weekNumber} 周`,
  ].join('\n')
  const topText = top3.length
    ? top3.map((item, index) => renderTop3Item(item, index)).join('\n\n')
    : '今天没有达到推荐标准的新论文。'
  chunks.push(`${header}\n\n🎯 今日 Top ${top3.length || 0}\n\n${topText}`)
  if (weatherText) chunks.push(`🌤 天气\n\n${weatherText}`)
  if (ccfChunks && ccfChunks.length) chunks.push(...ccfChunks)
  if (githubText) chunks.push(githubText)
  const blocks = fullPapers.map((paper) => renderPaperLine(paper))
  for (let index = 0; index < blocks.length; index += 4) {
    const part = blocks.slice(index, index + 4)
    chunks.push(`${index === 0 ? '📄 今日完整候选（摘要见详细文件）' : '今日候选（续）'}\n\n${part.join('\n')}`)
  }
  if (chunks.length) chunks[chunks.length - 1] += '\n\n发送「研究.今日」查看缓存，详细分析见 Markdown 文件。'
  return chunks
}

function formatCost({ summary, budget, sinceLabel, untilLabel }) {
  const totals = summary.totals || {}
  const lines = [
    `💸 研究 API 成本（${sinceLabel}${untilLabel ? ` 至 ${untilLabel}` : ''}）`,
    `请求：${totals.requests || 0} · 错误：${totals.errors || 0}`,
    `输入 token：${Number(totals.input_tokens || 0).toLocaleString('en-US')}`,
    `缓存命中：${Number(totals.cache_hit_tokens || 0).toLocaleString('en-US')}（命中率 ${
      Number(totals.input_tokens || 0) > 0
        ? ((Number(totals.cache_hit_tokens || 0) / Number(totals.input_tokens || 1)) * 100).toFixed(1)
        : '0.0'
    }%）`,
    `输出 token：${Number(totals.output_tokens || 0).toLocaleString('en-US')}`,
    `估算费用：$${Number(totals.estimated_cost_usd || 0).toFixed(6)}（按配置价格估算，不是平台账单）`,
  ]
  if (budget) {
    lines.push(
      `今日预算：$${budget.daily.spent.toFixed(6)} / $${budget.daily.limit.toFixed(2)} · 本周：$${budget.weekly.spent.toFixed(6)} / $${budget.weekly.limit.toFixed(2)}`,
    )
  }
  const byType = summary.byType || []
  if (byType.length) {
    lines.push('', '按任务：')
    for (const row of byType.slice(0, 8)) {
      lines.push(
        `· ${row.request_type} / ${row.model}: ${row.requests} 次，输入 ${Number(row.input_tokens || 0).toLocaleString('en-US')}，缓存命中 ${Number(row.cache_hit_tokens || 0).toLocaleString('en-US')}，估计 $${Number(row.estimated_cost_usd || 0).toFixed(6)}`,
      )
    }
  }
  return lines.join('\n')
}

module.exports = {
  displayPath,
  directionLabel,
  scoreText,
  scoreBreakdown,
  renderTop3Item,
  renderPaperLine,
  renderAnalysisDetail,
  renderCompare,
  renderQuestions,
  buildDailyMarkdown,
  buildDailyChunks,
  formatCost,
}
