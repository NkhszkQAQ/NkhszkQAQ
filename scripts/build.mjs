#!/usr/bin/env node
/**
 * Renders every SVG shown on the GitHub profile from live GitHub data.
 *
 *   node scripts/build.mjs            # fetch + render into assets/
 *   GH_TOKEN=... node scripts/build.mjs
 *
 * No dependencies: Node 20+ (global fetch), GitHub GraphQL only.
 * Every block is rendered twice, once per color scheme, so README.md can
 * pair them with <picture> and prefers-color-scheme.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets');

const CFG = JSON.parse(readFileSync(path.join(ROOT, 'config', 'profile.json'), 'utf8'));
const QUOTES = JSON.parse(readFileSync(path.join(ROOT, 'config', 'quotes.json'), 'utf8'));

/* ------------------------------------------------------------------ theme */

const THEMES = {
  light: {
    ink: '#111111',
    soft: '#3d3d3d',
    muted: '#8b8b8b',
    faint: '#b4b4b4',
    rule: '#e8e8e8',
    accent: '#5f7183',
  },
  dark: {
    ink: '#ededed',
    soft: '#c8c8c8',
    muted: '#8a8a8a',
    faint: '#4a4a4a',
    rule: '#232323',
    accent: '#9aadc0',
  },
};

/* ------------------------------------------------------------------ utils */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');

const WIDE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;
const charW = (ch, size) => (WIDE.test(ch) ? size : size * 0.6);

/** Truncate to a display budget where CJK counts double. */
function fit(text, budget) {
  let used = 0;
  let out = '';
  for (const ch of text) {
    used += WIDE.test(ch) ? 2 : 1;
    if (used > budget) return out.trimEnd() + '…';
    out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------- svg */

function doc({ w, h, theme, title, defs = '', body }) {
  const c = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="ttl">
<title id="ttl">${esc(title)}</title>
<defs>${defs}</defs>
<style>
.sans{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans","PingFang SC","Hiragino Sans","Helvetica Neue",Arial,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-reduced-motion:reduce){
  .typed{clip-path:none!important}
  .typed:not(.p0){display:none!important}
  .caret{display:none!important}
}
</style>
<g fill="none">
${body}
</g>
</svg>
`;
}

function tx(x, y, str, o = {}) {
  const {
    size = 12,
    fill,
    cls = 'sans',
    weight = 400,
    ls = 0,
    anchor = 'start',
    italic = false,
    opacity,
  } = o;
  return `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" fill="${fill}"${
    weight !== 400 ? ` font-weight="${weight}"` : ''
  }${ls ? ` letter-spacing="${ls}"` : ''}${
    anchor !== 'start' ? ` text-anchor="${anchor}"` : ''
  }${italic ? ' font-style="italic"' : ''}${
    opacity !== undefined ? ` opacity="${opacity}"` : ''
  }>${esc(str)}</text>`;
}

const rule = (x, y, w, fill) => `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${fill}"/>`;

/* ------------------------------------------------------- typed banner */

/**
 * A self-contained typewriter: SMIL animates a clip rect's width in discrete
 * steps so the line appears one character at a time, then erases and hands
 * over to the next phrase. No external service, no JavaScript.
 */
function typedBanner(phrases, { x, baseline, theme }) {
  const c = THEMES[theme];
  const SIZE = 13.5;
  const CYCLE = 6600;
  const TYPE = 1500;
  const GAP = 600;
  const ERASE = 500;
  const total = phrases.length * CYCLE;
  const caretTop = baseline - 15;
  const caretH = 19;

  const build = (frames) => {
    const clean = [];
    for (const f of frames.sort((a, b) => a.time - b.time)) {
      const last = clean[clean.length - 1];
      if (last && Math.abs(last.time - f.time) < 1e-6) clean[clean.length - 1] = f;
      else clean.push(f);
    }
    if (clean[0].time !== 0) clean.unshift({ time: 0, value: clean[0].value });
    if (clean[clean.length - 1].time !== total)
      clean.push({ time: total, value: clean[clean.length - 1].value });
    return {
      keyTimes: clean.map((f) => +(f.time / total).toFixed(6)).join(';'),
      values: clean.map((f) => f.value).join(';'),
    };
  };

  let defs = '';
  let body = '';

  phrases.forEach((phrase, i) => {
    const chars = [...phrase];
    const n = chars.length;
    const prefix = [0];
    for (const ch of chars) prefix.push(prefix[prefix.length - 1] + charW(ch, SIZE));
    const W = prefix[n];
    const si = i * CYCLE;
    const typeEnd = si + TYPE;
    const eraseStart = si + CYCLE - GAP - ERASE;
    const eraseEnd = si + CYCLE - GAP;

    const widths = [];
    if (si > 0) widths.push({ time: 0, value: 0 });
    widths.push({ time: si, value: 0 });
    for (let j = 1; j <= n; j++)
      widths.push({ time: si + (TYPE / n) * j, value: +prefix[j].toFixed(2) });
    widths.push({ time: eraseStart, value: +W.toFixed(2) });
    for (let j = n; j >= 1; j--)
      widths.push({
        time: eraseStart + ((n - j + 1) / n) * ERASE,
        value: +prefix[j - 1].toFixed(2),
      });
    widths.push({ time: eraseEnd, value: 0 });

    const wAnim = build(widths);

    const caret = [];
    if (si > 0) caret.push({ time: 0, value: '0 0' });
    caret.push({ time: si, value: '0 0' });
    caret.push({ time: typeEnd, value: `${+W.toFixed(2)} 0` });
    caret.push({ time: eraseStart, value: `${+W.toFixed(2)} 0` });
    caret.push({ time: eraseEnd, value: '0 0' });
    const cAnim = build(caret);

    const vis = [];
    if (si > 0) vis.push({ time: 0, value: 0 });
    vis.push({ time: si, value: 1 });
    vis.push({ time: eraseEnd, value: 0 });
    const vAnim = build(vis);

    defs += `<clipPath id="clip-${i}"><rect x="${x}" y="${baseline - 17}" width="0" height="26">
<animate attributeName="width" calcMode="discrete" dur="${total}ms" repeatCount="indefinite" keyTimes="${wAnim.keyTimes}" values="${wAnim.values}"/>
</rect></clipPath>`;

    body += `<text x="${x}" y="${baseline}" class="mono typed p${i}" font-size="${SIZE}" fill="${c.accent}" textLength="${+W.toFixed(2)}" lengthAdjust="spacing" clip-path="url(#clip-${i})">${esc(phrase)}</text>
<rect class="caret" x="${x}" y="${caretTop}" width="1.5" height="${caretH}" fill="${c.accent}" opacity="0">
<animateTransform attributeName="transform" type="translate" dur="${total}ms" repeatCount="indefinite" keyTimes="${cAnim.keyTimes}" values="${cAnim.values}"/>
<animate attributeName="opacity" calcMode="discrete" dur="${total}ms" repeatCount="indefinite" keyTimes="${vAnim.keyTimes}" values="${vAnim.values}"/>
</rect>`;
  });

  return { defs, body };
}

/* --------------------------------------------------------------- blocks */

function renderHero(m, theme) {
  const c = THEMES[theme];
  const W = 828;
  const H = 250;
  const { defs, body: typed } = typedBanner(CFG.typed, { x: 0, baseline: 187, theme });

  let body = '';
  body += tx(0, 55, m.name, { size: 30, fill: c.ink, weight: 500, ls: 0.2 });
  body += tx(
    1,
    83,
    [m.handle, ...CFG.meta].join('  ·  '),
    { size: 10, fill: c.faint, cls: 'mono', ls: 1.8 }
  );
  body += rule(0, 107, W, c.rule);
  body += tx(0, 149, CFG.intro, { size: 15, fill: c.soft });
  body += typed;

  // stack chips
  let x = 0;
  const top = 207;
  for (const label of CFG.stack) {
    const width = [...label].length * 7 + 22;
    body += `<rect x="${x + 0.5}" y="${top + 0.5}" width="${width - 1}" height="21" rx="10.5" stroke="${c.rule}"/>`;
    body += tx(x + width / 2, top + 14.5, label, {
      size: 9.5,
      fill: c.muted,
      cls: 'mono',
      ls: 1.2,
      anchor: 'middle',
    });
    x += width + 9;
  }

  return doc({ w: W, h: H, theme, title: m.name, defs, body });
}

function renderFigures(m, theme) {
  const c = THEMES[theme];
  const W = 400;
  const H = 200;
  const cells = [
    ['CONTRIBUTIONS · 1Y', fmtNum(m.contributions.total)],
    ['DAY STREAK', m.contributions.currentStreak ? String(m.contributions.currentStreak) : '—'],
    ['PUBLIC REPOS', String(m.repos.length)],
    ['FOLLOWERS', String(m.followers)],
  ];
  let body = '';
  cells.forEach(([label, value], i) => {
    const x = (i % 2) * 208;
    const y = Math.floor(i / 2) * 92;
    body += tx(x, 26 + y, label, { size: 9.5, fill: c.faint, cls: 'mono', ls: 1.6 });
    body += tx(x, 64 + y, value, { size: 27, fill: c.ink, weight: 400 });
  });
  return doc({ w: W, h: H, theme, title: 'GitHub figures', body });
}

function renderLanguages(m, theme) {
  const c = THEMES[theme];
  const W = 400;
  const H = 200;
  let body = tx(0, 26, 'LANGUAGES', { size: 9.5, fill: c.faint, cls: 'mono', ls: 1.6 });
  const rows = m.langs.slice(0, 4);
  rows.forEach((lang, i) => {
    const y = 64 + i * 38;
    body += tx(0, y, lang.name, { size: 12.5, fill: c.ink });
    body += `<rect x="132" y="${y - 4}" width="220" height="1.5" fill="${c.rule}"/>`;
    body += `<rect x="132" y="${y - 4}" width="${Math.max(2, (220 * lang.pct) / 100).toFixed(
      1
    )}" height="1.5" fill="${i === 0 ? c.accent : c.muted}"/>`;
    body += tx(W, y, `${lang.pct.toFixed(lang.pct < 10 ? 1 : 0)}%`, {
      size: 9.5,
      fill: c.muted,
      cls: 'mono',
      anchor: 'end',
    });
  });
  return doc({ w: W, h: H, theme, title: 'Languages', body });
}

function renderWork(m, theme) {
  const c = THEMES[theme];
  const W = 828;
  const rows = m.projects.slice(0, 3);
  const rowH = 84;
  const H = 44 + rows.length * rowH + 4;

  let body = tx(0, 20, 'SELECTED WORK', { size: 9.5, fill: c.faint, cls: 'mono', ls: 1.6 });
  rows.forEach((repo, i) => {
    const y = 46 + i * rowH;
    body += tx(0, y + 18, repo.name, { size: 13, fill: c.ink, cls: 'mono' });
    body += tx(0, y + 40, fit(repo.description || '', 112), {
      size: 12,
      fill: c.muted,
    });
    const meta = `${(repo.language || 'text').toUpperCase()}  ·  ${repo.pushedAt.slice(0, 7).replace('-', '.')}`;
    body += tx(W, y + 18, meta, {
      size: 9.5,
      fill: c.faint,
      cls: 'mono',
      ls: 1.2,
      anchor: 'end',
    });
    if (i < rows.length - 1) body += rule(0, y + 62, W, c.rule);
  });
  return doc({ w: W, h: H, theme, title: 'Selected work', body });
}

function renderNow(m, theme) {
  const c = THEMES[theme];
  const W = 828;
  const H = 112;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: CFG.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(m.now);
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: CFG.timezone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
    .format(m.now)
    .toUpperCase();

  let body = rule(0, 0, W, c.rule);
  body += tx(0, 32, `${CFG.timezoneLabel} · LOCAL TIME`, {
    size: 9,
    fill: c.faint,
    cls: 'mono',
    ls: 1.6,
  });
  body += tx(0, 74, time, { size: 26, fill: c.ink, cls: 'mono' });
  body += tx(0, 96, date, { size: 9.5, fill: c.faint, cls: 'mono', ls: 1.2 });

  const q = m.quote;
  body += tx(W, 58, `“${fit(q.text, 74)}”`, { size: 14, fill: c.soft, italic: true, anchor: 'end' });
  body += tx(W, 82, `— ${q.from}`, { size: 9, fill: c.faint, cls: 'mono', ls: 1.2, anchor: 'end' });

  return doc({ w: W, h: H, theme, title: 'Local time and a quote', body });
}

/* ------------------------------------------------------------------ data */

const TOKEN =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  (() => {
    try {
      return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

if (!TOKEN) {
  console.error('No GitHub token: set GH_TOKEN or run `gh auth login`.');
  process.exit(1);
}

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    name
    login
    followers { totalCount }
    following { totalCount }
    repositories(privacy: PUBLIC, first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        name
        description
        stargazerCount
        pushedAt
        primaryLanguage { name }
        languages(first: 10) { edges { size node { name } } }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    authorization: `bearer ${TOKEN}`,
    'content-type': 'application/json',
    'user-agent': 'NkhszkQAQ-profile-build',
  },
  body: JSON.stringify({ query: QUERY, variables: { login: CFG.login } }),
});
const payload = await res.json();
if (payload.errors) {
  console.error(JSON.stringify(payload.errors, null, 2));
  process.exit(1);
}
const u = payload.data.user;

/* streaks ------------------------------------------------------------- */

const todayISO = new Date().toISOString().slice(0, 10);
const dayLog = new Map();
for (const week of u.contributionsCollection.contributionCalendar.weeks)
  for (const day of week.contributionDays) if (day.date <= todayISO) dayLog.set(day.date, day.contributionCount);

const sortedDays = [...dayLog.keys()].sort();
const shift = (iso, delta) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

let currentStreak = 0;
let cursor = (dayLog.get(todayISO) || 0) > 0 ? todayISO : shift(todayISO, -1);
while ((dayLog.get(cursor) || 0) > 0) {
  currentStreak += 1;
  cursor = shift(cursor, -1);
}

let longestStreak = 0;
let run = 0;
let prev = null;
for (const date of sortedDays) {
  if (dayLog.get(date) === 0) {
    run = 0;
    prev = date;
    continue;
  }
  run = prev && shift(prev, 1) === date ? run + 1 : 1;
  longestStreak = Math.max(longestStreak, run);
  prev = date;
}

/* languages ----------------------------------------------------------- */

const langBytes = new Map();
for (const repo of u.repositories.nodes || []) {
  // The profile repo itself would otherwise count its own renderer as a language.
  if (repo.name.toLowerCase() === CFG.login.toLowerCase()) continue;
  for (const edge of repo.languages?.edges || [])
    langBytes.set(edge.node.name, (langBytes.get(edge.node.name) || 0) + edge.size);
}
const langTotal = [...langBytes.values()].reduce((a, b) => a + b, 0) || 1;
const langs = [...langBytes.entries()]
  .map(([name, bytes]) => ({ name, bytes, pct: (bytes / langTotal) * 100 }))
  .sort((a, b) => b.bytes - a.bytes);

/* projects ------------------------------------------------------------ */

const byName = new Map((u.repositories.nodes || []).map((r) => [r.name, r]));
const projects = CFG.projects
  .map((name) => byName.get(name))
  .filter(Boolean)
  .map((r) => ({
    name: r.name,
    description: r.description || '',
    stars: r.stargazerCount,
    language: r.primaryLanguage?.name || null,
    pushedAt: r.pushedAt,
  }));

/* quote --------------------------------------------------------------- */

const now = new Date();
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).formatToParts(now);
const Y = +parts.find((p) => p.type === 'year').value;
const M = +parts.find((p) => p.type === 'month').value;
const D = +parts.find((p) => p.type === 'day').value;
const dayOfYear = Math.floor((Date.UTC(Y, M - 1, D) - Date.UTC(Y, 0, 1)) / 86400000);

const model = {
  login: u.login,
  name: u.name || u.login,
  handle: CFG.handle,
  followers: u.followers.totalCount,
  following: u.following.totalCount,
  repos: u.repositories.nodes || [],
  projects,
  langs,
  contributions: {
    total: u.contributionsCollection.contributionCalendar.totalContributions,
    currentStreak,
    longestStreak,
  },
  quote: QUOTES[dayOfYear % QUOTES.length],
  now,
};

/* ----------------------------------------------------------------- output */

mkdirSync(OUT_DIR, { recursive: true });

const blocks = {
  hero: renderHero,
  figures: renderFigures,
  languages: renderLanguages,
  work: renderWork,
  now: renderNow,
};

for (const [name, render] of Object.entries(blocks)) {
  for (const theme of ['light', 'dark']) {
    const file = path.join(OUT_DIR, `${name}-${theme}.svg`);
    writeFileSync(file, render(model, theme));
  }
}

console.log(
  [
    `login        ${model.login}`,
    `contribs     ${model.contributions.total} (streak ${currentStreak}d / best ${longestStreak}d)`,
    `repos        ${model.repos.length}`,
    `languages    ${langs
      .slice(0, 4)
      .map((l) => `${l.name} ${l.pct.toFixed(0)}%`)
      .join(', ')}`,
    `projects     ${projects.map((p) => p.name).join(', ')}`,
    `quote        ${model.quote.text}`,
    `written      ${Object.keys(blocks).length * 2} svg files -> assets/`,
  ].join('\n')
);
