'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  _test: { parseIntent, cleanForSpeech, normalizeConfig, normalizeIncoming, sessionKey },
} = require('../koishi/plugins/tts-voice')

test('parseIntent: read mode', () => {
  assert.deepEqual(parseIntent('念一下 你好'), { mode: 'read', text: '你好' })
  assert.deepEqual(parseIntent('朗读：今天天气不错'), { mode: 'read', text: '今天天气不错' })
  assert.deepEqual(parseIntent('用语音念一遍 本小姐来了'), { mode: 'read', text: '本小姐来了' })
  assert.deepEqual(parseIntent('语音：你好'), { mode: 'read', text: '你好' })
})

test('parseIntent: answer mode', () => {
  assert.deepEqual(parseIntent('说一说今天天气'), { mode: 'answer', text: '今天天气' })
  assert.deepEqual(parseIntent('用语音说一下今天天气'), { mode: 'answer', text: '今天天气' })
  assert.deepEqual(parseIntent('你给我说一说今天天气'), { mode: 'answer', text: '今天天气' })
  assert.deepEqual(parseIntent('聊聊这篇论文'), { mode: 'answer', text: '这篇论文' })
  assert.deepEqual(parseIntent('说一说'), { mode: 'answer', text: '' })
})

test('parseIntent: ignores normal chat', () => {
  assert.equal(parseIntent('今天天气怎么样'), null)
  assert.equal(parseIntent('波特，你来了'), null)
  assert.equal(parseIntent(''), null)
})

test('sessionKey: keeps private-chat users apart', () => {
  const a = { fid: 'onebot:100:1', platform: 'onebot', channelId: '100', userId: '1' }
  const b = { fid: 'onebot:100:2', platform: 'onebot', channelId: '100', userId: '2' }
  assert.notEqual(sessionKey(a), sessionKey(b))
})

test('normalizeIncoming: strips quote and at segments', () => {
  assert.equal(normalizeIncoming('<quote id="1"/> <at id="2"/> 念一下 你好'), '念一下 你好')
})

test('cleanForSpeech: strips markdown, links and stage directions', () => {
  const text = cleanForSpeech('**你好**，[链接](https://example.com)（冷笑）本小姐来了。', 100)
  assert.equal(text, '你好，链接 本小姐来了。')
})

test('cleanForSpeech: truncates at a sentence boundary', () => {
  const text = cleanForSpeech('第一句话。第二句话。第三句话。', 8)
  assert.equal(text, '第一句话。')
})

test('normalizeConfig: rejects invalid prosody values', () => {
  const cfg = normalizeConfig({ rate: 'fast', pitch: 'high', volume: 'loud' })
  assert.equal(cfg.rate, '-3%')
  assert.equal(cfg.pitch, '-6Hz')
  assert.equal(cfg.volume, '+0%')
})
