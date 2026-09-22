#!/usr/bin/env node
// 目录 CI 闸门（传输完整性与结构）：每条目 download[0] 下载 → sha256 比对 + 必填字段断言。
// Ed25519 验签不在本脚本手写（避免与官方校验器形成第二份实现漂移），待共用校验器
// 以 GitHub Action 形式发布后在 workflow 中接入。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const index = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1 }

if (index.format !== 'daydream' || index.kind !== 'market_index') fail('index 头不合法')
if (!Array.isArray(index.entries) || index.entries.length === 0) fail('entries 为空')

for (const e of index.entries ?? []) {
  const tag = e.title ?? e.storyId
  if (!/^[0-9a-f]{64}$/.test(e.sha256 ?? '')) fail(tag + '：sha256 非 64 hex')
  if (!/^\d+\.\d+\.\d+$/.test(e.version ?? '')) fail(tag + '：version 非 semver')
  for (const f of ['storyId', 'title', 'synopsis', 'cover', 'metaUrl', 'repo']) {
    if (typeof e[f] !== 'string' || e[f] === '') fail(tag + '：缺字段 ' + f)
  }
  if (!Array.isArray(e.keys) || e.keys.length === 0) fail(tag + '：keys 为空')
  if (!Array.isArray(e.download) || e.download.length === 0) fail(tag + '：download 为空')
}

for (const e of index.entries ?? []) {
  const url = e.download?.[0]?.url
  if (url == null) continue
  try {
    const res = await fetch(url)
    if (!res.ok) { fail(e.title + '：下载失败 HTTP ' + res.status); continue }
    const buf = Buffer.from(await res.arrayBuffer())
    const got = createHash('sha256').update(buf).digest('hex')
    if (got !== e.sha256) fail(e.title + '：sha256 不符（镜像或包被篡改？）')
    else console.log('✓ ' + e.title + ' (' + buf.length + ' B)')
  } catch (err) {
    fail(e.title + '：下载异常 ' + err)
  }
}
