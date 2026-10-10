#!/usr/bin/env node
/**
 * 目录收录机器人（27§4.4，蓝本 daydream refresh-catalog.mjs 裁剪改造）：
 * ① 下架失联：仓库 404 / 最新 Release 404 → 摘整条。单次 404 即出下架动作（机器人跑在 GitHub 侧
 *    无网络墙，404 可信度高）；403/5xx/网络错一律保守跳过，防误下架。
 * ② 版本刷新：已收录作品拉最新 Release 的 .mistpack 附件 → verify-bundle 结构校验（C-1~C-8）
 *    → 解包读 script.json 机器提取元数据 → 版本高于条目 → 直推更新。
 * ③ 新收录：扫 topic `jubensha-script` 发现新仓库 → 同链校验 → **开 PR 待官方人工合并（信任锚，
 *    27§九）**；已收录作品的更新/下架才直推 main。
 * 铁律（28§一/27§4.2，P5）：`language` 必填且 ∈ 四语枚举——缺失/越界 = 拒收该次变更；
 * 目录条目独立（每语言版本独立 script_id 独立仓库），不做族聚合。
 * script_id 冲突不自动收（人工裁决防冒名）。cover 域白名单（机器人自拼 raw 直链天然合规）+ 体积上限 512KB。
 * 用法：node refresh-catalog.mjs [--dry-run] [--index <index.json>]
 *   部署态默认读 ../index.json（本脚本在目录仓库 scripts/ 下）；GITHUB_TOKEN 提升 API 限额并启用
 *   扫 topic 与开 PR；JUBENSHA_VERIFY_BUNDLE 覆盖 verify-bundle.mjs 路径（缺省 = index 同级）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const idxArgAt = args.indexOf('--index');
const indexFile = (idxArgAt >= 0 ? args[idxArgAt + 1] : undefined)
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'index.json');
const TOKEN = process.env.GITHUB_TOKEN;
const API_H = { 'User-Agent': 'jubensha-catalog-bot', Accept: 'application/vnd.github+json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
const PUB_H = { 'User-Agent': 'jubensha-catalog-bot' };

// ── 网络小件（daydream 同款口径：404 与未知错误分流，未知保守跳过） ──

/** API JSON：404 → null；403/5xx/网络错 → throw（调用方保守跳过） */
async function getJson(url, headers = API_H) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fetchBuf(url) {
  const res = await fetch(url, { headers: PUB_H });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const semverCmp = (a, b) => {
  const [x, y] = [a, b].map((s) => s.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
};

// ── 包体校验与元数据提取（27§4.4.1/4.4.2：verify-bundle + fflate 解包读 script.json） ──

/** 四语枚举（28§二 ALL_LOCALES 同源快照；schema 侧 C-1 已拦，机器人侧双保险——P5 铁律） */
const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];

/** verify-bundle 路径（部署态 = index 同级；env 覆盖供本仓库测试） */
function bundlePathOf() {
  return process.env.JUBENSHA_VERIFY_BUNDLE ?? join(dirname(indexFile), 'verify-bundle.mjs');
}

/** verify-bundle 结构校验（C-1~C-8 含变体种子）：true = 过闸；false = 拒收（exit 1） */
function bundleVerify(pkgBuf, bundlePath) {
  const dir = mkdtempSync(join(tmpdir(), 'jubensha-verify-'));
  const file = join(dir, 'pkg.mistpack');
  try {
    writeFileSync(file, pkgBuf);
    const r = spawnSync(process.execPath, [bundlePath, file], { encoding: 'utf8' });
    return r.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 包体 → 目录条目素材（纯函数，可离线测试）：
 * 下载的 .mistpack 字节 → verify-bundle → 解包读 script.json → 元数据提取。
 * 拒收返回 { err }；通过返回 { meta }（title/author/synopsis/genres/player_range/language/version/id）。
 */
function extractEntryFromPack(pkgBuf, bundlePath) {
  if (!existsSync(bundlePath)) return { err: `verify-bundle.mjs 不存在（${bundlePath}）——部署要求先构建提交，本次拒收` };
  if (!bundleVerify(pkgBuf, bundlePath)) return { err: 'verify-bundle 结构校验不过（C-1~C-8）' };
  let files;
  try {
    files = unzipSync(new Uint8Array(pkgBuf));
  } catch {
    return { err: '附件不是合法 zip（.mistpack 应由打包工具产出——裸 script.json 附件拒收）' };
  }
  const entry = files['script.json'] ?? files[Object.keys(files).find((k) => k.endsWith('script.json')) ?? ''];
  if (entry === undefined) return { err: 'zip 内无 script.json' };
  let script;
  try {
    script = JSON.parse(new TextDecoder().decode(entry));
  } catch {
    return { err: 'script.json 非法 JSON' };
  }
  // P5 铁律：language 必填且 ∈ 四语枚举（28§一：目录按语言筛选，缺语言字段无从筛起）
  if (!LOCALES.includes(script?.language)) {
    return { err: `language 字段缺失或越界（实际 ${JSON.stringify(script?.language ?? null)}；四语枚举 zh-CN/en-US/ja-JP/ko-KR）——补 language 后重新发版` };
  }
  if (!/^\d+\.\d+\.\d+$/.test(script?.version ?? '')) return { err: 'version 非 semver' };
  return {
    meta: {
      id: script.id, title: script.title, language: script.language, version: script.version,
      author: script.meta?.author ?? '', synopsis: script.meta?.spoiler_free_summary ?? '',
      genres: script.genres ?? [], player_range: script.player_range ?? [0, 0],
    },
  };
}

/** cover 直链（作者仓库根 cover.png；HEAD 404 → null；>512KB → null 并警示——27§九体积上限） */
async function coverOf(owner, name) {
  const url = `https://raw.githubusercontent.com/${owner}/${name}/main/cover.png`;
  try {
    const res = await fetch(url, { method: 'HEAD', headers: PUB_H });
    if (res.status === 404) return { url: null };
    if (!res.ok) return { url: null, warn: `cover 探测 HTTP ${res.status}，置空` };
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > 512 * 1024) return { url: null, warn: `cover ${Math.round(len / 1024)}KB 超 512KB 上限，置空` };
    return { url };
  } catch {
    return { url: null, warn: 'cover 探测网络异常，置空' };
  }
}

/** 仓库最新 Release 的 .mistpack 附件：{ tag, url, published_at } / null（无 Release 或无附件） */
async function latestPack(owner, name) {
  const rel = await getJson(`https://api.github.com/repos/${owner}/${name}/releases/latest`);
  if (rel == null) return null;
  const asset = (rel.assets ?? []).find((a) => a.name?.endsWith('.mistpack'));
  if (asset == null) return { noAsset: true, tag: rel.tag_name ?? '' };
  return { url: asset.browser_download_url, tag: rel.tag_name ?? '', published_at: rel.published_at ?? '' };
}

/** meta → 目录条目（27§4.2 v1.0 字段全集；rating v1 固定 all_ages 占位） */
function entryOf(meta, owner, name, pkgUrl, pkgBuf, cover, releasedAt) {
  return {
    id: meta.id, title: meta.title, author: meta.author, synopsis: meta.synopsis,
    genres: meta.genres, player_range: meta.player_range, language: meta.language,
    rating: 'all_ages', cover,
    repo: `github.com/${owner}/${name}`,
    released_at: releasedAt, updated_at: new Date().toISOString(),
    version: meta.version,
    package: { url: pkgUrl, mirrors: [], sha256: sha256(pkgBuf), size_bytes: pkgBuf.length },
  };
}

/** 提交条目到目录仓库（27§4.4.3 新收录分流：开 PR = 信任锚；失败只警示不中断其余候选） */
async function openPullRequest(candidateIndex, ownerId, owner, name) {
  const repo = process.env.JUBENSHA_CATALOG_REPO ?? process.env.GITHUB_REPOSITORY;
  if (repo == null) return { warn: '未配置 JUBENSHA_CATALOG_REPO/GITHUB_REPOSITORY——无法开 PR，仅输出候选条目' };
  const branch = `bot/market-${ownerId}-${Date.now().toString(36)}`;
  const api = (p) => `https://api.github.com/repos/${repo}${p}`;
  const head = await getJson(api('/git/ref/heads/main'));
  if (head == null) return { warn: `目录仓库 ${repo} main 分支不可读，开 PR 失败` };
  const pr = await fetch(api('/git/refs'), {
    method: 'POST', headers: API_H,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }),
  });
  if (!pr.ok) return { warn: `建分支失败（HTTP ${pr.status}）：${await pr.text()}` };
  const put = await fetch(api('/contents/index.json'), {
    method: 'PUT', headers: API_H,
    body: JSON.stringify({
      message: `market: 收录 ${meta0(candidateIndex)}（${owner}/${name}，待人工复核）`,
      content: Buffer.from(JSON.stringify(candidateIndex, null, 2) + '\n').toString('base64'),
      branch,
    }),
  });
  if (!put.ok) return { warn: `写候选 index 失败（HTTP ${put.status}）：${await put.text()}` };
  const open = await fetch(api('/pulls'), {
    method: 'POST', headers: API_H,
    body: JSON.stringify({
      title: `market: 收录《${meta0(candidateIndex)}》（${owner}/${name}）`,
      head: branch, base: 'main',
      body: [
        '机器人候选收录（27§4.4：新作品 PR 首收 = 信任锚）。已过：verify-bundle 结构校验（C-1~C-8）、',
        'language 必填四语枚举、semver、sha256/size 复核。**官方复核清单**：',
        '① 拉包试玩一轮（内容过目：题材/分级/侵权素材）；② script_id 无冒名（作者主页对照）；',
        '③ cover 无违规内容；④ 简介与实际内容相符。合并即上架。',
      ].join('\n'),
    }),
  });
  if (!open.ok) return { warn: `开 PR 失败（HTTP ${open.status}）：${await open.text()}` };
  const data = await open.json();
  return { pr: data.html_url };
}

/** 候选 index 的首条标题（PR 文案用——候选 index 只含当条新条目） */
function meta0(idx) {
  return idx?.entries?.[0]?.title ?? '?';
}

// ── 主流程 ──

async function main() {
  const bundlePath = bundlePathOf();
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  if (index.format !== 'jubensha' || index.kind !== 'market_index' || index.version !== '1.0') {
    console.error(`index.json 头字段不符（期望 jubensha/market_index/1.0）——只维护 v1.0 结构`);
    process.exit(1);
  }

  const actions = { removed: [], updated: [], candidates: [], warned: [] };
  const kept = [];

  // ①② 既有条目：健康检查 + 版本刷新（直推口径）
  for (const entry of index.entries ?? []) {
    const tag = `${entry.title}（${entry.id}）`;
    if (!/^github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.repo ?? '')) {
      kept.push(entry);
      continue;
    }
    const [, owner, name] = entry.repo.split('/');
    try {
      const repo = await getJson(`https://api.github.com/repos/${owner}/${name}`);
      if (repo == null) { actions.removed.push(`${tag}：仓库不存在或已转私有`); continue }
      const pkg = await latestPack(owner, name);
      if (pkg == null) { actions.removed.push(`${tag}：最新 Release 不可达（撤回发布？）`); continue }
      if (pkg.noAsset) {
        actions.warned.push(`${tag}：最新 Release ${pkg.tag} 无 .mistpack 附件，跳过刷新（保留现版）`);
        kept.push(entry);
        continue;
      }
      const buf = await fetchBuf(pkg.url);
      if (buf == null) { actions.warned.push(`${tag}：包体下载失败，本次跳过`); kept.push(entry); continue }
      const r = extractEntryFromPack(buf, bundlePath);
      if (r.err != null) {
        actions.warned.push(`${tag}：新版包拒收——${r.err}`);
        kept.push(entry);
        continue;
      }
      if (semverCmp(r.meta.version, entry.version) <= 0) { kept.push(entry); continue }
      const cov = await coverOf(owner, name);
      if (cov.warn != null) actions.warned.push(`${tag}：${cov.warn}`);
      kept.push(entryOf(r.meta, owner, name, pkg.url, buf, cov.url, entry.released_at));
      actions.updated.push(`${tag}：v${entry.version} → v${r.meta.version}`);
    } catch (e) {
      // API 限额/网络故障：保守保留，本次不动
      actions.warned.push(`${tag}：检查异常（${e.message}），本次跳过`);
      kept.push(entry);
    }
  }

  // ③ 新收录：扫 topic → 同链校验 → 开 PR（无 token 不扫——匿名 search 限额过低易误跳）
  if (TOKEN != null && TOKEN !== '') {
    try {
      const res = await getJson('https://api.github.com/search/repositories?q=topic%3Ajubensha-script&sort=updated&per_page=100');
      for (const r of res?.items ?? []) {
        const [owner, name] = r.full_name.split('/');
        if (kept.some((e) => e.repo === `github.com/${r.full_name}`)) continue;
        try {
          const pkg = await latestPack(owner, name);
          if (pkg == null || pkg.noAsset) continue;
          const buf = await fetchBuf(pkg.url);
          if (buf == null) continue;
          const x = extractEntryFromPack(buf, bundlePath);
          if (x.err != null) {
            actions.warned.push(`新仓库 ${r.full_name}：拒收——${x.err}`);
            continue;
          }
          // script_id 冲突不自动收（防冒名转发，人工裁决）
          if (kept.some((e) => e.id === x.meta.id)) {
            actions.warned.push(`新仓库 ${r.full_name}：script_id ${x.meta.id} 与现有条目冲突（转发/冒名？），人工裁决`);
            continue;
          }
          const cov = await coverOf(owner, name);
          if (cov.warn != null) actions.warned.push(`新仓库 ${r.full_name}：${cov.warn}`);
          const now = new Date().toISOString();
          const candidateEntry = entryOf(x.meta, owner, name, pkg.url, buf, cov.url, now);
          const pr = await openPullRequest({ ...index, entries: [candidateEntry] }, x.meta.id, owner, name);
          if (pr.pr != null) actions.candidates.push(`《${x.meta.title}》（${r.full_name} · ${x.meta.language} v${x.meta.version}）→ ${pr.pr}`);
          else if (pr.warn != null) actions.warned.push(`新仓库 ${r.full_name}：${pr.warn}`);
        } catch (e) {
          actions.warned.push(`新仓库 ${r.full_name}：收录检查异常（${e.message}），本次跳过`);
        }
      }
    } catch (e) {
      actions.warned.push(`扫 topic 新收录失败（${e.message}），本次跳过`);
    }
  } else if (!dryRun) {
    console.log('（未配置 GITHUB_TOKEN：跳过扫 topic 新收录，仅健康检查与版本刷新）');
  }

  const changed = actions.removed.length + actions.updated.length > 0;
  const lines = [
    `## 目录机器人动作摘要（${new Date().toISOString()}）`, '',
    `下架 ${actions.removed.length} · 更新 ${actions.updated.length} · 候选 PR ${actions.candidates.length} · 警示 ${actions.warned.length}`, '',
    ...actions.removed.map((x) => `- 🗑 下架：${x}`),
    ...actions.updated.map((x) => `- ⬆ 更新：${x}`),
    ...actions.candidates.map((x) => `- ✚ 候选：${x}`),
    ...actions.warned.map((x) => `- ⚠ ${x}`),
  ];
  console.log(lines.slice(2).join('\n'));

  if (!dryRun) {
    // summary 无条件落盘供日志查阅（不提交入库）
    writeFileSync(join(dirname(indexFile), 'refresh-summary.md'), lines.join('\n') + '\n');
  }
  if (!dryRun && changed) {
    index.entries = kept;
    index.updated_at = new Date().toISOString();
    writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
    console.log(`\n已写回 ${indexFile}（${kept.length} 条目）+ refresh-summary.md`);
  } else {
    console.log(dryRun ? '\n[dry-run] 未写任何文件' : '\n无直推变更（候选 PR 等人工合并）');
  }
}

// 直跑守卫：被测试 import 时不执行主流程（纯函数 extractEntryFromPack 可离线复用）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { extractEntryFromPack, semverCmp, LOCALES };
