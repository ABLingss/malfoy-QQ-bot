'use strict'

const crypto = require('crypto')

function cleanText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeForHash(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s*([,.;:!?()[\]{}])\s*/g, '$1')
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function abstractHash(abstract) {
  return sha256(normalizeForHash(abstract))
}

function canonicalArxivId(value) {
  const text = cleanText(value)
  if (!text) return ''
  const fromUrl = text.match(/arxiv\.org\/(?:abs|pdf)\/([a-z.-]+\/[0-9]{7}|\d{4}\.\d{4,5})(?:v\d+)?/i)
  const bare = text.match(/^(?:arxiv:)?\s*([a-z.-]+\/[0-9]{7}|\d{4}\.\d{4,5})(?:v\d+)?$/i)
  const matched = (fromUrl && fromUrl[1]) || (bare && bare[1]) || ''
  return matched.toLowerCase()
}

function canonicalKey(input) {
  const data = typeof input === 'string' ? { arxivId: input } : input || {}
  const arxivId = canonicalArxivId(data.arxivId || data.arxiv_id || '')
  if (arxivId) return `arxiv:${arxivId}`
  const doi = cleanText(data.doi || data.DOI || '').toLowerCase()
  if (doi) return `doi:${doi.replace(/^https?:\/\/doi\.org\//, '')}`
  const openalex = cleanText(data.openalexId || data.openalex_id || '').toLowerCase()
  if (openalex) return `openalex:${openalex.split('/').pop()}`
  const title = cleanText(data.title || '').toLowerCase()
  if (title) return `title:${sha256(title).slice(0, 32)}`
  return ''
}

function truncate(value, limit) {
  const text = cleanText(value)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

function safeFilename(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'untitled'
}

function stripCodeFence(value) {
  const text = String(value || '').trim()
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : text
}

function parseJsonLoose(value) {
  const text = stripCodeFence(value)
  try {
    return JSON.parse(text)
  } catch (error) {
    const firstObject = text.indexOf('{')
    const firstArray = text.indexOf('[')
    const starts = [firstObject, firstArray].filter((index) => index >= 0)
    if (!starts.length) throw error
    const start = Math.min(...starts)
    const lastObject = text.lastIndexOf('}')
    const lastArray = text.lastIndexOf(']')
    const end = Math.max(lastObject, lastArray)
    if (end <= start) throw error
    return JSON.parse(text.slice(start, end + 1))
  }
}

function cjkRatio(value) {
  const text = cleanText(value)
  if (!text) return 0
  const cjk = (text.match(/[㐀-鿿]/g) || []).length
  return cjk / text.length
}

function stripVersion(value) {
  return cleanText(value).replace(/v\d+$/i, '')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termMatches(text, term) {
  const haystack = cleanText(text).toLowerCase()
  const needle = cleanText(term).toLowerCase()
  if (!haystack || !needle) return false
  if (/^[a-z0-9+.#-]+$/.test(needle) && needle.length <= 5) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}($|[^a-z0-9])`, 'i').test(haystack)
  }
  return haystack.includes(needle)
}

function utcDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10)
}

function addDays(date, days) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + Number(days || 0))
  return next
}

function nowIso() {
  return new Date().toISOString()
}

function parseDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function estimateTokens(text) {
  const value = String(text || '')
  if (!value) return 0
  const cjk = (value.match(/[㐀-鿿]/g) || []).length
  const other = value.length - cjk
  return Math.ceil(cjk * 0.75 + other / 4)
}

function parseVersionNumber(value) {
  const match = String(value || '').match(/v?(\d+)\.(\d+)\.(\d+)/i)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

module.exports = {
  cleanText,
  normalizeForHash,
  sha256,
  abstractHash,
  canonicalArxivId,
  canonicalKey,
  truncate,
  safeFilename,
  parseJsonLoose,
  cjkRatio,
  stripVersion,
  termMatches,
  utcDate,
  addDays,
  nowIso,
  parseDate,
  estimateTokens,
  parseVersionNumber,
}
