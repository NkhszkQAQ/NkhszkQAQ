#!/usr/bin/env node
/**
 * Renders the GitHub profile (README.md + every SVG it shows) from live data.
 *
 *   node scripts/build.mjs                 # uses GH_TOKEN, or falls back to `gh api`
 *
 * No dependencies: Node 20+, GitHub GraphQL only. Every block is drawn twice,
 * once per color scheme, and README.md pairs them with <picture>.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets');
const CFG = JSON.parse(readFileSync(path.join(ROOT, 'config', 'profile.json'), 'utf8'));
const QUOTES = JSON.parse(readFileSync(path.join(ROOT, 'config', 'quotes.json'), 'utf8'));

const W = 828;

/* ------------------------------------------------------------------ theme */
// Paper and ink, with one vermilion accent — the colour of a hanko seal.

const THEMES = {
  light: {
    card: '#fbfaf7',
    edge: '#ebe6dc',
    ink: '#1b1a17',
    soft: '#4a4640',
    muted: '#857f75',
    faint: '#b3ac9f',
    well: '#efebe3',
    accent: '#d9481c',
  },
  dark: {
    card: '#151412',
    edge: '#2a2722',
    ink: '#f1ede5',
    soft: '#c9c2b6',
    muted: '#8c857a',
    faint: '#5a554c',
    well: '#211f1b',
    accent: '#ff6b3d',
  },
};

/* ------------------------------------------------------------------ utils */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');

const WIDE = /[⺀-鿿豈-﫿＀-￯　-〿]/;
/** Approximate advance width; mono is exact at 0.6em, sans averages ~0.56em. */
const sansEm = (ch) =>
  /[ilj.,:;'|!()\[\] ]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z0-9%]/.test(ch) ? 0.66 : 0.54;
const textW = (str, size, mono = false) =>
  [...str].reduce((a, ch) => a + (WIDE.test(ch) ? size : size * (mono ? 0.6 : sansEm(ch))), 0);

function fit(text, maxW, size) {
  if (textW(text, size) <= maxW) return text;
  let out = '';
  for (const ch of text) {
    if (textW(out + ch + '…', size) > maxW) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}

/** Greedy wrap: breaks on spaces for Latin, anywhere between CJK characters. */
function wrap(text, maxW, size, maxLines) {
  const tokens = text.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g) || [];
  const lines = [''];
  for (const t of tokens) {
    const cur = lines[lines.length - 1];
    if (/^\s+$/.test(t)) {
      if (cur) lines[lines.length - 1] = cur + ' ';
      continue;
    }
    const closing = /^[)）】」』，。、；：！？,.;:!?]/.test(t);
    if (closing || textW(cur + t, size) <= maxW || !cur.trim()) lines[lines.length - 1] = cur + t;
    else lines.push(t);
  }
  const out = lines.map((l) => l.trim()).filter(Boolean);
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  kept[maxLines - 1] = fit(kept[maxLines - 1] + ' ' + out.slice(maxLines).join(' '), maxW, size);
  return kept;
}

/* ------------------------------------------------------------------- svg */

function doc({ h, theme, title, defs = '', body, card = true }) {
  const c = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="ttl">
<title id="ttl">${esc(title)}</title>
<defs>${defs}</defs>
<style>
.sans{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans","PingFang SC","Hiragino Sans","Helvetica Neue",Arial,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
.serif{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif}
.fade{animation:fade .9s ease-out both}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  .fade{animation:none}
  .typed{clip-path:none!important}
  .typed:not(.p0){display:none!important}
  .caret,.pulse{display:none!important}
}
</style>
${card ? `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="18" fill="${c.card}" stroke="${c.edge}"/>` : ''}
<g fill="none">
${body}
</g>
</svg>
`;
}

function tx(x, y, str, o = {}) {
  const { size = 12, fill, cls = 'sans', weight = 400, ls = 0, anchor = 'start', italic = false, opacity, extra = '' } = o;
  return `<text x="${+x.toFixed(2)}" y="${+y.toFixed(2)}" class="${cls}" font-size="${size}" fill="${fill}"${
    weight !== 400 ? ` font-weight="${weight}"` : ''
  }${ls ? ` letter-spacing="${ls}"` : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${
    italic ? ' font-style="italic"' : ''
  }${opacity !== undefined ? ` opacity="${opacity}"` : ''}${extra}>${esc(str)}</text>`;
}

const label = (x, y, str, c, anchor = 'start') =>
  tx(x, y, str, { size: 9.5, fill: c.muted, cls: 'mono', ls: 1.8, anchor });

/* ------------------------------------------------------- typed banner */

/**
 * Self-contained typewriter: SMIL steps a clip rect's width so each phrase
 * appears one character at a time, holds, erases, and hands over.
 */
function typedBanner(phrases, { x, baseline, size, fill, caretFill }) {
  const CYCLE = 6600, TYPE = 1500, GAP = 600, ERASE = 500;
  const total = phrases.length * CYCLE;
  const build = (frames) => {
    const clean = [];
    for (const f of frames.sort((a, b) => a.time - b.time)) {
      const last = clean[clean.length - 1];
      if (last && Math.abs(last.time - f.time) < 1e-6) clean[clean.length - 1] = f;
      else clean.push(f);
    }
    if (clean[0].time !== 0) clean.unshift({ time: 0, value: clean[0].value });
    if (clean[clean.length - 1].time !== total) clean.push({ time: total, value: clean[clean.length - 1].value });
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
    for (const ch of chars) prefix.push(prefix[prefix.length - 1] + textW(ch, size, true));
    const Wd = +prefix[n].toFixed(2);
    const si = i * CYCLE;
    const eraseStart = si + CYCLE - GAP - ERASE;
    const eraseEnd = si + CYCLE - GAP;

    const widths = [];
    if (si > 0) widths.push({ time: 0, value: 0 });
    widths.push({ time: si, value: 0 });
    for (let j = 1; j <= n; j++) widths.push({ time: si + (TYPE / n) * j, value: +prefix[j].toFixed(2) });
    widths.push({ time: eraseStart, value: Wd });
    for (let j = n; j >= 1; j--)
      widths.push({ time: eraseStart + ((n - j + 1) / n) * ERASE, value: +prefix[j - 1].toFixed(2) });
    widths.push({ time: eraseEnd, value: 0 });
    const wA = build(widths);

    const caret = [];
    if (si > 0) caret.push({ time: 0, value: '0 0' });
    caret.push({ time: si, value: '0 0' });
    for (let j = 1; j <= n; j++) caret.push({ time: si + (TYPE / n) * j, value: `${+prefix[j].toFixed(2)} 0` });
    caret.push({ time: eraseStart, value: `${Wd} 0` });
    for (let j = n; j >= 1; j--)
      caret.push({ time: eraseStart + ((n - j + 1) / n) * ERASE, value: `${+prefix[j - 1].toFixed(2)} 0` });
    const cA = build(caret);

    const vis = [];
    if (si > 0) vis.push({ time: 0, value: 0 });
    vis.push({ time: si, value: 1 });
    vis.push({ time: eraseEnd, value: 0 });
    const vA = build(vis);

    defs += `<clipPath id="clip-${i}"><rect x="${x}" y="${baseline - size - 4}" width="0" height="${size + 10}">
<animate attributeName="width" calcMode="discrete" dur="${total}ms" repeatCount="indefinite" keyTimes="${wA.keyTimes}" values="${wA.values}"/>
</rect></clipPath>`;
    body += `<text x="${x}" y="${baseline}" class="mono typed p${i}" font-size="${size}" fill="${fill}" textLength="${Wd}" lengthAdjust="spacing" clip-path="url(#clip-${i})">${esc(phrase)}</text>
<rect class="caret" x="${x + 1}" y="${baseline - size + 1}" width="7" height="${size + 2}" rx="1" fill="${caretFill}" opacity="0">
<animateTransform attributeName="transform" type="translate" calcMode="discrete" dur="${total}ms" repeatCount="indefinite" keyTimes="${cA.keyTimes}" values="${cA.values}"/>
<animate attributeName="opacity" calcMode="discrete" dur="${total}ms" repeatCount="indefinite" keyTimes="${vA.keyTimes}" values="${vA.values}"/>
</rect>`;
  });
  return { defs, body };
}

/* ------------------------------------------------------------- the sky */

function phaseOf(h) {
  if (h >= 5 && h < 7) return 'DAWN';
  if (h >= 7 && h < 11) return 'MORNING';
  if (h >= 11 && h < 14) return 'MIDDAY';
  if (h >= 14 && h < 17) return 'AFTERNOON';
  if (h >= 17 && h < 19) return 'DUSK';
  if (h >= 19 && h < 23) return 'EVENING';
  return 'NIGHT';
}

/** A half-dial from 06:00 to 18:00; the sun rides it by day, the moon by night. */
function sky(m, c, { cx, horizon, r }) {
  const { hour, minute } = m.clock;
  const t = hour + minute / 60;
  const day = t >= 6 && t < 18;
  const f = day ? (t - 6) / 12 : ((t - 18 + 24) % 24) / 12;
  const a = Math.PI * (1 - f);
  const sx = cx + r * Math.cos(a);
  const sy = horizon - r * Math.sin(a);
  const x0 = cx - r;
  const x1 = cx + r;

  let s = '';
  // the full dial, dotted
  s += `<path d="M ${x0} ${horizon} A ${r} ${r} 0 0 1 ${x1} ${horizon}" stroke="${c.edge}" stroke-width="1.5" stroke-dasharray="1.5 5" stroke-linecap="round"/>`;
  // the part already travelled
  s += `<path d="M ${x0} ${horizon} A ${r} ${r} 0 0 1 ${sx.toFixed(2)} ${sy.toFixed(2)}" stroke="${
    day ? c.accent : c.muted
  }" stroke-width="1.5" stroke-linecap="round" opacity="${day ? 0.85 : 0.6}"/>`;
  // horizon + ticks
  s += `<rect x="${x0 - 14}" y="${horizon}" width="${2 * r + 28}" height="1" fill="${c.edge}"/>`;
  for (const [x, l] of [[x0, day ? '06' : '18'], [cx, day ? '12' : '00'], [x1, day ? '18' : '06']])
    s += tx(x, horizon + 16, l, { size: 8.5, fill: c.faint, cls: 'mono', anchor: 'middle', ls: 1 });

  if (day) {
    s += `<circle class="pulse" cx="${sx.toFixed(2)}" cy="${sy.toFixed(2)}" r="12" fill="${c.accent}" opacity="0.16">
<animate attributeName="r" values="9;15;9" dur="3.2s" repeatCount="indefinite"/>
<animate attributeName="opacity" values="0.22;0.06;0.22" dur="3.2s" repeatCount="indefinite"/>
</circle>`;
    s += `<circle cx="${sx.toFixed(2)}" cy="${sy.toFixed(2)}" r="6" fill="${c.accent}"/>`;
  } else {
    s += `<circle cx="${sx.toFixed(2)}" cy="${sy.toFixed(2)}" r="6.5" fill="${c.soft}"/>`;
    s += `<circle cx="${(sx + 3.2).toFixed(2)}" cy="${(sy - 2.4).toFixed(2)}" r="5.6" fill="${c.card}"/>`;
    for (const [dx, dy, rr] of [[-0.62, 0.55, 1], [0.35, 0.78, 0.8], [0.7, 0.35, 1.1], [-0.2, 0.25, 0.7]])
      s += `<circle cx="${(cx + dx * r).toFixed(1)}" cy="${(horizon - dy * r).toFixed(1)}" r="${rr}" fill="${c.faint}"/>`;
  }
  return s;
}

/* --------------------------------------------------------------- blocks */

function renderHero(m, theme) {
  const c = THEMES[theme];
  const H = 292;
  const P = 36;
  let body = '';

  // left column
  body += `<g class="fade">`;
  body += `<rect x="${P}" y="${P + 1}" width="8" height="8" rx="2" fill="${c.accent}"/>`;
  body += tx(P + 18, P + 9, [m.handle, ...CFG.meta].join('   /   '), { size: 9.5, fill: c.muted, cls: 'mono', ls: 1.8 });
  body += tx(P - 2, P + 66, m.name, { size: 40, fill: c.ink, weight: 600, ls: -0.6 });
  const intro = wrap(CFG.intro, 540, 15, 2);
  intro.forEach((line, i) => {
    body += tx(P, P + 104 + i * 22, line, { size: 15, fill: c.soft });
  });
  body += `</g>`;

  const typedY = P + 104 + (intro.length - 1) * 22 + 44;
  body += tx(P, typedY, '$', { size: 13, fill: c.accent, cls: 'mono' });
  const { defs, body: typed } = typedBanner(CFG.typed, {
    x: P + 18,
    baseline: typedY,
    size: 13,
    fill: c.ink,
    caretFill: c.accent,
  });
  body += typed;

  // stack chips
  let x = P;
  const top = H - P - 24;
  for (const s of CFG.stack) {
    const w = textW(s, 9.5, true) + s.length * 1.2 + 24;
    body += `<rect x="${x}" y="${top}" width="${w.toFixed(1)}" height="24" rx="12" fill="${c.well}"/>`;
    body += tx(x + w / 2, top + 15.5, s, { size: 9.5, fill: c.soft, cls: 'mono', ls: 1.2, anchor: 'middle' });
    x += w + 8;
  }

  // right column: the sky over Tokyo
  const divX = 596;
  body += `<rect x="${divX}" y="${P}" width="1" height="${H - 2 * P}" fill="${c.edge}"/>`;
  const cx = (divX + W) / 2;
  body += label(cx, P + 9, `${CFG.timezoneLabel} · ${phaseOf(m.clock.hour)}`, c, 'middle');
  body += sky(m, c, { cx, horizon: 150, r: 76 });
  body += tx(cx, 210, m.clock.time, { size: 30, fill: c.ink, cls: 'mono', anchor: 'middle', ls: 1 });
  body += tx(cx, 232, m.clock.date, { size: 9.5, fill: c.muted, cls: 'mono', anchor: 'middle', ls: 1.6 });

  return doc({ h: H, theme, title: `${m.name} — ${CFG.intro}`, defs, body });
}

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const HEAT = [0, 0.22, 0.45, 0.72, 1];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function renderActivity(m, theme) {
  const c = THEMES[theme];
  const P = 36;
  const inner = W - 2 * P;
  let body = '';

  // figures
  const cells = [
    ['CONTRIBUTIONS · 1Y', fmtNum(m.contributions.total)],
    ['CURRENT STREAK', m.contributions.currentStreak ? `${m.contributions.currentStreak}` : '—', 'days'],
    ['LONGEST STREAK', m.contributions.longestStreak ? `${m.contributions.longestStreak}` : '—', 'days'],
    ['STARS EARNED', fmtNum(m.stars)],
  ];
  const colW = inner / 4;
  cells.forEach(([l, v, unit], i) => {
    const x = P + i * colW;
    if (i) body += `<rect x="${x - 18}" y="${P - 2}" width="1" height="50" fill="${c.edge}"/>`;
    body += label(x, P + 8, l, c);
    body += tx(x, P + 44, v, { size: 28, fill: c.ink, ls: -0.4 });
    if (unit && v !== '—') body += tx(x + textW(v, 28) + 6, P + 44, unit, { size: 11, fill: c.muted });
  });

  // contribution grid
  const weeks = m.calendar.slice(-53);
  const step = inner / weeks.length;
  const cell = Math.min(11.5, step - 2.6);
  const gridTop = 138;
  let lastMonth = null;
  let grid = '';
  weeks.forEach((week, wi) => {
    const x = P + wi * step;
    const first = week.contributionDays[0];
    const month = +first.date.slice(5, 7);
    if (month !== lastMonth) {
      if (lastMonth !== null && wi < weeks.length - 2)
        grid += tx(x, gridTop - 10, MONTHS[month - 1], { size: 8.5, fill: c.faint, cls: 'mono', ls: 1.2 });
      lastMonth = month;
    }
    for (const day of week.contributionDays) {
      const lvl = LEVEL[day.contributionLevel] ?? 0;
      const y = gridTop + day.weekday * step;
      grid += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="2.6" fill="${
        lvl ? c.accent : c.well
      }"${lvl ? ` fill-opacity="${HEAT[lvl]}"` : ''}><title>${day.date}: ${day.contributionCount}</title></rect>`;
    }
  });
  body += `<g class="fade">${grid}</g>`;
  const gridBottom = gridTop + 6 * step + cell;

  // grid caption + legend
  const ly = gridBottom + 24;
  body += tx(P, ly, `${fmtNum(m.contributions.total)} contributions in the last year`, { size: 11.5, fill: c.muted });
  let lx = W - P - 5 * 15 - 30;
  body += tx(lx - 8, ly, 'less', { size: 10, fill: c.faint, anchor: 'end' });
  for (let l = 0; l <= 4; l++)
    body += `<rect x="${lx + l * 15}" y="${ly - 9.5}" width="11" height="11" rx="2.6" fill="${l ? c.accent : c.well}"${
      l ? ` fill-opacity="${HEAT[l]}"` : ''
    }/>`;
  body += tx(lx + 5 * 15 + 4, ly, 'more', { size: 10, fill: c.faint });

  // languages
  const top = ly + 30;
  body += `<rect x="${P}" y="${top - 2}" width="${inner}" height="1" fill="${c.edge}"/>`;
  body += label(P, top + 30, 'LANGUAGES', c);
  const rows = m.langs.slice(0, 4).map((l) => ({ ...l }));
  const rest = 100 - rows.reduce((a, l) => a + l.pct, 0);
  if (rest >= 0.5) rows.push({ name: 'Other', pct: rest });
  const shades = [1, 0.66, 0.42, 0.26, 0.14];
  const barX = P + 120;
  const barW = W - P - barX;
  const gap = 3;
  const usable = barW - gap * (rows.length - 1);
  let bx = barX;
  rows.forEach((lang, i) => {
    const w = Math.max(4, (usable * lang.pct) / 100);
    body += `<rect x="${bx.toFixed(2)}" y="${top + 22}" width="${w.toFixed(2)}" height="8" rx="4" fill="${c.accent}" fill-opacity="${shades[i]}"/>`;
    bx += w + gap;
  });
  let kx = barX;
  rows.forEach((lang, i) => {
    const y = top + 56;
    body += `<circle cx="${kx + 4}" cy="${y - 4}" r="4" fill="${c.accent}" fill-opacity="${shades[i]}"/>`;
    body += tx(kx + 14, y, lang.name, { size: 12, fill: c.soft });
    const pct = `${lang.pct.toFixed(lang.pct < 10 ? 1 : 0)}%`;
    const nx = kx + 14 + textW(lang.name, 12) + 6;
    body += tx(nx, y, pct, { size: 10, fill: c.faint, cls: 'mono' });
    kx = nx + textW(pct, 10, true) + 24;
  });

  const H = top + 56 + P - 8;
  return doc({ h: H, theme, title: `${fmtNum(m.contributions.total)} contributions in the last year`, body });
}

function renderWork(m, theme) {
  const c = THEMES[theme];
  const rows = m.projects.slice(0, 6);
  const cols = rows.length % 3 === 0 ? 3 : 2;
  const gap = 12;
  const tileW = (W - gap * (cols - 1)) / cols;
  const tileH = 176;
  const top = 0;
  const H = top + Math.ceil(rows.length / cols) * (tileH + gap) - gap;
  const P = 22;
  let body = '';

  rows.forEach((repo, i) => {
    const x = (i % cols) * (tileW + gap);
    const y = top + Math.floor(i / cols) * (tileH + gap);
    body += `<rect x="${(x + 0.5).toFixed(2)}" y="${y + 0.5}" width="${(tileW - 1).toFixed(2)}" height="${tileH - 1}" rx="16" fill="${c.card}" stroke="${c.edge}"/>`;
    body += tx(x + P, y + P + 9, String(i + 1).padStart(2, '0'), { size: 9.5, fill: c.accent, cls: 'mono', ls: 1.6 });
    body += tx(x + tileW - P, y + P + 9, '↗', { size: 12, fill: c.faint, anchor: 'end' });
    body += tx(x + P, y + P + 40, fit(repo.name, tileW - 2 * P, 14.5), { size: 14.5, fill: c.ink, cls: 'mono', weight: 600 });
    wrap(repo.description || '—', tileW - 2 * P, 12, 3).forEach((line, li) => {
      body += tx(x + P, y + P + 64 + li * 18, line, { size: 12, fill: c.muted });
    });
    const meta = [repo.language || 'Text', repo.pushedAt.slice(0, 7).replace('-', '.')];
    if (repo.stars) meta.push(`★ ${repo.stars}`);
    body += tx(x + P, y + tileH - P + 2, meta.join('  ·  ').toUpperCase(), { size: 9, fill: c.faint, cls: 'mono', ls: 1.3 });
  });
  return doc({ h: H, theme, title: `Selected work: ${rows.map((r) => r.name).join(', ')}`, body, card: false });
}

function renderQuote(m, theme) {
  const c = THEMES[theme];
  const H = 132;
  const q = m.quote;
  let body = '';
  body += tx(W / 2, 56, '“', { size: 40, fill: c.accent, cls: 'serif', anchor: 'middle', opacity: 0.9 });
  body += tx(W / 2, 76, fit(q.text, W - 120, 17), { size: 17, fill: c.ink, cls: 'serif', italic: !WIDE.test(q.text), anchor: 'middle' });
  body += tx(W / 2, 104, `— ${q.from}`, { size: 9.5, fill: c.muted, cls: 'mono', ls: 1.6, anchor: 'middle' });
  return doc({ h: H, theme, title: `${q.text} — ${q.from}`, body });
}

/* ------------------------------------------------------------------ data */

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    name
    login
    followers { totalCount }
    repositories(privacy: PUBLIC, first: 100, ownerAffiliations: OWNER, isFork: false) {
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
        weeks { contributionDays { date weekday contributionCount contributionLevel } }
      }
    }
  }
}`;

async function fetchUser() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': `${CFG.login}-profile-build`,
      },
      body: JSON.stringify({ query: QUERY, variables: { login: CFG.login } }),
    });
    return res.json();
  }
  // Local runs: let the gh CLI make the call so no token passes through here.
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `login=${CFG.login}`], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const payload = await fetchUser();
if (payload.errors || !payload.data) {
  console.error(JSON.stringify(payload.errors || payload, null, 2));
  process.exit(1);
}
const u = payload.data.user;

/* streaks ------------------------------------------------------------- */

const todayISO = new Date().toISOString().slice(0, 10);
const dayLog = new Map();
for (const week of u.contributionsCollection.contributionCalendar.weeks)
  for (const day of week.contributionDays) if (day.date <= todayISO) dayLog.set(day.date, day.contributionCount);

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
for (const date of [...dayLog.keys()].sort()) {
  if (dayLog.get(date) === 0) {
    run = 0;
  } else {
    run = prev && shift(prev, 1) === date ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }
  prev = date;
}

/* languages ----------------------------------------------------------- */

const repos = (u.repositories.nodes || []).filter((r) => r.name.toLowerCase() !== CFG.login.toLowerCase());
const langBytes = new Map();
for (const repo of repos)
  for (const edge of repo.languages?.edges || [])
    langBytes.set(edge.node.name, (langBytes.get(edge.node.name) || 0) + edge.size);
const langTotal = [...langBytes.values()].reduce((a, b) => a + b, 0) || 1;
const langs = [...langBytes.entries()]
  .map(([name, bytes]) => ({ name, bytes, pct: (bytes / langTotal) * 100 }))
  .sort((a, b) => b.bytes - a.bytes);

/* projects ------------------------------------------------------------ */

const byName = new Map(repos.map((r) => [r.name, r]));
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

/* clock + quote ------------------------------------------------------- */

const now = new Date();
const zp = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: CFG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
    .formatToParts(now)
    .map((p) => [p.type, p.value])
);
const Y = +zp.year, Mo = +zp.month, D = +zp.day;
const dayOfYear = Math.floor((Date.UTC(Y, Mo - 1, D) - Date.UTC(Y, 0, 1)) / 86400000);

const model = {
  login: u.login,
  name: CFG.name || u.name || u.login,
  handle: CFG.handle,
  followers: u.followers.totalCount,
  repos,
  stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
  projects,
  langs,
  calendar: u.contributionsCollection.contributionCalendar.weeks,
  contributions: {
    total: u.contributionsCollection.contributionCalendar.totalContributions,
    currentStreak,
    longestStreak,
  },
  clock: {
    hour: +zp.hour,
    minute: +zp.minute,
    time: `${zp.hour}:${zp.minute}`,
    date: `${zp.weekday} ${zp.day} ${MONTHS[Mo - 1]} ${Y}`.toUpperCase(),
  },
  quote: QUOTES[dayOfYear % QUOTES.length],
};

/* ----------------------------------------------------------------- output */

mkdirSync(OUT_DIR, { recursive: true });

const blocks = { hero: renderHero, activity: renderActivity, work: renderWork, quote: renderQuote };
const alts = {};
for (const [name, render] of Object.entries(blocks)) {
  for (const theme of ['light', 'dark']) {
    const svg = render(model, theme);
    writeFileSync(path.join(OUT_DIR, `${name}-${theme}.svg`), svg);
    alts[name] = svg.match(/<title id="ttl">([^<]*)<\/title>/)[1];
  }
}

const picture = (name, href) => {
  const img = `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg">
  <img src="assets/${name}-light.svg" alt="${alts[name]}" width="${W}">
</picture>`;
  return href ? `<a href="${href}">\n${img}\n</a>` : img;
};

const links = CFG.footer.links.map((l) => `<a href="${l.href}">${l.label}</a>`).join(' &nbsp;·&nbsp; ');
const projectLinks = projects
  .map((p) => `<a href="https://github.com/${CFG.login}/${p.name}">${p.name}</a>`)
  .join(' &nbsp;·&nbsp; ');

const readme = `<!-- generated by scripts/build.mjs from config/ — edit those, not this file -->
<div align="center">

${picture('hero')}

${picture('activity', `https://github.com/${CFG.login}`)}

${picture('work', `https://github.com/${CFG.login}?tab=repositories`)}

<sub>${projectLinks}</sub>

${picture('quote')}

<sub>${links} &nbsp;·&nbsp; <img src="${CFG.footer.visits}" alt="views" height="14" align="absmiddle"></sub>

</div>
`;
writeFileSync(path.join(ROOT, 'README.md'), readme);

console.log(
  [
    `login        ${model.login}`,
    `contribs     ${model.contributions.total} (streak ${currentStreak}d / best ${longestStreak}d)`,
    `repos        ${repos.length}, stars ${model.stars}`,
    `languages    ${langs.slice(0, 4).map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(', ')}`,
    `projects     ${projects.map((p) => p.name).join(', ')}`,
    `clock        ${model.clock.time} ${model.clock.date}`,
    `quote        ${model.quote.text}`,
    `written      ${Object.keys(blocks).length * 2} svg + README.md`,
  ].join('\n')
);
