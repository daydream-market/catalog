#!/usr/bin/env node
// 目录 CI 闸门（传输完整性与结构；27 号批三 v2.0）：每条目逐语言 download[0] 下载 → sha256 比对
// + 必填字段断言 + 族约束（语言不重/storyId 不重/languages ≥1）。
// Ed25519 验签不在本脚本手写（避免与官方校验器形成第二份实现漂移），待共用校验器
// 以 GitHub Action 形式发布后在 workflow 中接入。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const index = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1 }

if (index.format !== 'daydream' || index.kind !== 'market_index') fail('index 头不合法')
if (index.version !== '2.0') fail('index 版本非 2.0（27 号 v2.0 多语言族结构）')
if (!Array.isArray(index.entries) || index.entries.length === 0) fail('entries 为空')

const seenStoryIds = new Set()
for (const e of index.entries ?? []) {
  const tag = e.title ?? e.storyId
  if (!Array.isArray(e.languages) || e.languages.length === 0) fail(tag + '：languages 为空')
  const langs = e.languages?.map((l) => l.contentLanguage) ?? []
  if (new Set(langs).size !== langs.length) fail(tag + '：语言标签重复')
  for (const l of e.languages ?? []) {
    if (!/^[0-9a-f]{64}$/.test(l.sha256 ?? '')) fail(tag + '/' + l.contentLanguage + '：sha256 非 64 hex')
    if (!/^\d+\.\d+\.\d+$/.test(l.version ?? '')) fail(tag + '/' + l.contentLanguage + '：version 非 semver')
    if (!/^(v|[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*-v)\d+\.\d+\.\d+$/.test(l.releaseTag ?? '')) fail(tag + '/' + l.contentLanguage + '：releaseTag 形状不合法')
    if (seenStoryIds.has(l.storyId)) fail(tag + '/' + l.contentLanguage + '：storyId 与其他语言条目重复')
    seenStoryIds.add(l.storyId)
    for (const f of ['storyId', 'contentLanguage', 'packageName', 'metaUrl']) {
      if (typeof l[f] !== 'string' || l[f] === '') fail(tag + '/' + l.contentLanguage + '：缺字段 ' + f)
    }
    if (!Array.isArray(l.download) || l.download.length === 0) fail(tag + '/' + l.contentLanguage + '：download 为空')
  }
  for (const f of ['storyId', 'title', 'synopsis', 'cover', 'repo']) {
    if (typeof e[f] !== 'string' || e[f] === '') fail(tag + '：缺字段 ' + f)
  }
  if (!Array.isArray(e.keys) || e.keys.length === 0) fail(tag + '：keys 为空')
}

for (const e of index.entries ?? []) {
  for (const l of e.languages ?? []) {
    const url = l.download?.[0]?.url
    if (url == null) continue
    try {
      const res = await fetch(url)
      if (!res.ok) { fail(e.title + '/' + l.contentLanguage + '：下载失败 HTTP ' + res.status); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      const got = createHash('sha256').update(buf).digest('hex')
      if (got !== l.sha256) fail(e.title + '/' + l.contentLanguage + '：sha256 不符（镜像或包被篡改？）')
      else console.log('✓ ' + e.title + '/' + l.contentLanguage + ' (' + buf.length + ' B)')
    } catch (err) {
      fail(e.title + '/' + l.contentLanguage + '：下载异常 ' + err)
    }
  }
}
