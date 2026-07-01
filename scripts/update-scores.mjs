#!/usr/bin/env node
// Fetches finished World Cup 2026 group-stage results from ESPN's free,
// no-key public scoreboard API and patches index.html in place:
// match scores/state + derived standings (pts/pj/pg/pe/pp/gf/gc).
// Narrative text (hotDato, projections, csProb) is left untouched —
// those are analytical/manual content, not raw results.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'index.html');

// ESPN uses English display names; map them to our internal team ids.
const ESPN_NAME_TO_ID = {
  mexico:'mex', 'south korea':'kor', 'korea republic':'kor',
  'czech republic':'cze', czechia:'cze',
  'south africa':'rsa', canada:'can', switzerland:'sui',
  'bosnia and herzegovina':'bih', 'bosnia-herzegovina':'bih', 'bosnia herzegovina':'bih', bosnia:'bih',
  qatar:'qat', brazil:'bra', morocco:'mar', scotland:'sco', haiti:'hai',
  'united states':'usa', usa:'usa', australia:'aus', paraguay:'par',
  turkey:'tur', turkiye:'tur', germany:'ger',
  'ivory coast':'civ', "cote d'ivoire":'civ', 'cote divoire':'civ',
  ecuador:'ecu', curacao:'cur', spain:'esp', uruguay:'uru',
  'cape verde':'cpv', 'saudi arabia':'ksa', argentina:'arg', austria:'aut',
  algeria:'alg', jordan:'jor', colombia:'col', portugal:'por',
  'dr congo':'cod', 'congo dr':'cod', 'democratic republic of the congo':'cod', drc:'cod',
  uzbekistan:'uzb', netherlands:'ned', japan:'jpn', sweden:'swe',
  tunisia:'tun', iran:'iri', 'ir iran':'iri', belgium:'bel', 'new zealand':'nzl',
  egypt:'egy', france:'fra', norway:'nor', senegal:'sen', iraq:'irq',
  england:'eng', croatia:'cro', ghana:'gha', panama:'pan',
};

function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// Pre-normalize all keys so espnNameToId works even when ESPN uses
// hyphens, ampersands, or accents in display names (e.g. "Bosnia & Herzegovina").
const ESPN_NORM = Object.fromEntries(
  Object.entries(ESPN_NAME_TO_ID).map(([k, v]) => [normalize(k), v])
);

function espnNameToId(name) {
  return ESPN_NORM[normalize(name)] || null;
}

// Reuse the Spanish name→id map already defined inside index.html
// instead of duplicating 48 team names by hand.
function extractNameToId(src) {
  const m = src.match(/const NAME_TO_ID = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error('No se encontró NAME_TO_ID en index.html');
  return new Function('return ' + m[1])();
}

function teamIdFromLabel(label, nameToId) {
  const name = label.replace(/^\S+\s+/, '').trim();
  return nameToId[name] || null;
}

async function fetchWithRetry(url, retries = 4) {
  let delay = 2000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ESPN respondió HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`Intento ${attempt} fallido (${err.message}), reintentando en ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function fetchFinishedMatches(startDate) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=300&dates=${fmt(startDate)}-${fmt(today)}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();

  const finished = [];
  for (const event of data.events || []) {
    const comp = event.competitions?.[0];
    if (!comp || !comp.status?.type?.completed) continue;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const idHome = espnNameToId(home.team?.displayName || home.team?.name || '');
    const idAway = espnNameToId(away.team?.displayName || away.team?.name || '');
    if (!idHome || !idAway) continue;
    finished.push({
      idHome, idAway,
      scoreHome: Number(home.score),
      scoreAway: Number(away.score),
    });
  }
  return finished;
}

function updateMatches(src, finished, nameToId) {
  const pattern = /\{d:'([^']+)',t1:'([^']+)',t2:'([^']+)',sc:'vs',state:'future',pw:(-?\d+),pd:(-?\d+),pl:(-?\d+),venue:'([^']*)'\}/g;
  const edits = [];
  let match;
  while ((match = pattern.exec(src))) {
    const [full, d, t1, t2, , , , venue] = match;
    const idT1 = teamIdFromLabel(t1, nameToId);
    const idT2 = teamIdFromLabel(t2, nameToId);
    if (!idT1 || !idT2) continue;
    const found = finished.find(f =>
      (f.idHome === idT1 && f.idAway === idT2) ||
      (f.idHome === idT2 && f.idAway === idT1)
    );
    if (!found) continue;
    const scT1 = found.idHome === idT1 ? found.scoreHome : found.scoreAway;
    const scT2 = found.idHome === idT1 ? found.scoreAway : found.scoreHome;
    const replacement = `{d:'${d}',t1:'${t1}',t2:'${t2}',sc:'${scT1} - ${scT2}',state:'played',pw:0,pd:0,pl:0,venue:'${venue}'}`;
    edits.push({ start: match.index, end: match.index + full.length, replacement });
  }
  let result = src;
  for (const e of edits.reverse()) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return { result, updatedCount: edits.length };
}

function recomputeStandings(src, nameToId) {
  const pattern = /\{d:'[^']+',t1:'([^']+)',t2:'([^']+)',sc:'([^']*)',state:'played',pw:-?\d+,pd:-?\d+,pl:-?\d+,venue:'[^']*'\}/g;
  const stats = {};
  const ensure = id => stats[id] || (stats[id] = { pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0 });
  let m;
  while ((m = pattern.exec(src))) {
    const [, t1, t2, sc] = m;
    const id1 = teamIdFromLabel(t1, nameToId);
    const id2 = teamIdFromLabel(t2, nameToId);
    const scoreMatch = sc.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!id1 || !id2 || !scoreMatch) continue;
    const g1 = Number(scoreMatch[1]), g2 = Number(scoreMatch[2]);
    const s1 = ensure(id1), s2 = ensure(id2);
    s1.pj++; s2.pj++;
    s1.gf += g1; s1.gc += g2;
    s2.gf += g2; s2.gc += g1;
    if (g1 > g2) { s1.pg++; s2.pp++; }
    else if (g1 < g2) { s2.pg++; s1.pp++; }
    else { s1.pe++; s2.pe++; }
  }
  return stats;
}

function applyStandings(src, stats) {
  let result = src;
  for (const [id, s] of Object.entries(stats)) {
    const pts = s.pg * 3 + s.pe;
    const re = new RegExp(`(\\{id:'${id}',flag:'[^']*',name:'[^']*',fifa:\\d+,)pts:\\d+,pj:\\d+,pg:\\d+,pe:\\d+,pp:\\d+,gf:\\d+,gc:\\d+,(elo:)`);
    result = result.replace(re, `$1pts:${pts},pj:${s.pj},pg:${s.pg},pe:${s.pe},pp:${s.pp},gf:${s.gf},gc:${s.gc},$2`);
  }
  return result;
}

function updateHeaderDate(src) {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const now = new Date();
  const label = `${now.getUTCDate()} ${months[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  return src.replace(/Actualizado: <b>[^<]*<\/b>/, `Actualizado: <b>${label}</b>`);
}

async function main() {
  const src0 = readFileSync(INDEX_PATH, 'utf8');
  const nameToId = extractNameToId(src0);

  // El Mundial 2026 arrancó el 11 de junio — ventana de búsqueda fija desde ahí.
  const finished = await fetchFinishedMatches(new Date('2026-06-11'));
  console.log(`ESPN devolvió ${finished.length} partido(s) finalizado(s) con equipos reconocidos.`);

  const { result: withMatches, updatedCount } = updateMatches(src0, finished, nameToId);
  if (updatedCount === 0) {
    console.log('No hay partidos nuevos que actualizar.');
    return;
  }
  console.log(`Actualizando ${updatedCount} partido(s) en index.html.`);

  const stats = recomputeStandings(withMatches, nameToId);
  const withStandings = applyStandings(withMatches, stats);
  const withDate = updateHeaderDate(withStandings);

  writeFileSync(INDEX_PATH, withDate);
  console.log('index.html actualizado.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { extractNameToId, teamIdFromLabel, updateMatches, recomputeStandings, applyStandings, espnNameToId };
