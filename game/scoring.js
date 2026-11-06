// Hand validation and Hong Kong style faan scoring (simplified).
const { isFlower, tileIndex, toCounts } = require('./tiles');

const DRAGONS = [31, 32, 33];
const ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

function decomposeSets(c, sets, out) {
  let i = 0;
  while (i < 34 && c[i] === 0) i++;
  if (i === 34) { out.push(sets.slice()); return; }
  if (c[i] >= 3) {
    c[i] -= 3; sets.push({ type: 'pung', idx: i });
    decomposeSets(c, sets, out);
    sets.pop(); c[i] += 3;
  }
  if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--; sets.push({ type: 'chow', idx: i });
    decomposeSets(c, sets, out);
    sets.pop(); c[i]++; c[i + 1]++; c[i + 2]++;
  }
}


function standardArrangements(tiles) {
  const c = toCounts(tiles);
  const res = [];
  for (let p = 0; p < 34; p++) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    const out = [];
    decomposeSets(c, [], out);
    for (const sets of out) res.push({ pair: p, sets });
    c[p] += 2;
  }
  return res;
}

function isSevenPairs(tiles) {
  return tiles.length === 14 && toCounts(tiles).every((n) => n % 2 === 0);
}

function isThirteenOrphans(tiles) {
  if (tiles.length !== 14) return false;
  const c = toCounts(tiles);
  return ORPHANS.every((i) => c[i] >= 1) && ORPHANS.reduce((s, i) => s + c[i], 0) === 14;
}

function commonItems(ctx, allTiles) {
  const { melds, flowers, seatWind, selfDrawn, replacement, lastTile } = ctx;
  const items = [];
  if (selfDrawn) items.push(['Self-drawn', 1]);
  if (melds.every((m) => m.concealed)) items.push(['Concealed hand', 1]);
  if (flowers.length === 0) items.push(['No flowers', 1]);
  for (const f of ['f' + (seatWind + 1), 'f' + (seatWind + 5)]) {
    if (flowers.includes(f)) items.push(['Own flower', 1]);
  }
  if (['f1', 'f2', 'f3', 'f4'].every((f) => flowers.includes(f))) items.push(['All four flowers', 2]);
  if (['f5', 'f6', 'f7', 'f8'].every((f) => flowers.includes(f))) items.push(['All four seasons', 2]);
  if (selfDrawn && replacement) items.push(['Win on replacement tile', 1]);
  if (lastTile) items.push(['Last tile of the wall', 1]);

  const suits = new Set(allTiles.filter((t) => t[0] !== 'z').map((t) => t[0]));
  const honors = allTiles.some((t) => t[0] === 'z');
  if (suits.size === 0) items.push(['All honors', 10]);
  else if (suits.size === 1 && !honors) items.push(['Pure one suit', 7]);
  else if (suits.size === 1) items.push(['Mixed one suit', 3]);
  return items;
}

function patternItems(sets, pair, ctx) {
  const items = [];
  const pungs = sets.filter((s) => s.type === 'pung').map((s) => s.idx);
  if (sets.every((s) => s.type === 'chow')) items.push(['All chows', 1]);
  if (sets.every((s) => s.type === 'pung')) items.push(['All pungs', 3]);

  const dragonPungs = pungs.filter((i) => DRAGONS.includes(i)).length;
  if (dragonPungs === 3) items.push(['Great three dragons', 8]);
  else if (dragonPungs === 2 && DRAGONS.includes(pair)) items.push(['Small three dragons', 5]);
  else for (let k = 0; k < dragonPungs; k++) items.push(['Dragon pung', 1]);

  const windPungs = pungs.filter((i) => i >= 27 && i <= 30).length;
  if (windPungs === 4) items.push(['Great four winds', 13]);
  else if (windPungs === 3 && pair >= 27 && pair <= 30) items.push(['Small four winds', 6]);
  else {
    if (pungs.includes(27 + ctx.seatWind)) items.push(['Seat wind pung', 1]);
    if (pungs.includes(27 + ctx.prevailing)) items.push(['Prevailing wind pung', 1]);
  }
  return items;
}

// ctx: { concealed, melds, flowers, seatWind, prevailing, selfDrawn, replacement, lastTile }
// concealed must include the winning tile. Returns { faan, items } or null if not a winning hand.
function scoreHand(ctx) {
  const { concealed, melds } = ctx;
  if (concealed.length + melds.length * 3 !== 14 || concealed.some(isFlower)) return null;
  const allTiles = [...concealed, ...melds.flatMap((m) => m.tiles)];
  const common = commonItems(ctx, allTiles);
  const candidates = [];

  if (melds.length === 0 && isThirteenOrphans(concealed)) candidates.push([['Thirteen orphans', 13]]);
  if (melds.length === 0 && isSevenPairs(concealed)) candidates.push([['Seven pairs', 4], ...common]);

  const meldSets = melds.map((m) => ({ type: m.type === 'chow' ? 'chow' : 'pung', idx: tileIndex(m.tiles[0]) }));
  for (const arr of standardArrangements(concealed)) {
    if (arr.sets.length + melds.length !== 4) continue;
    candidates.push([...patternItems([...arr.sets, ...meldSets], arr.pair, ctx), ...common]);
  }
  if (!candidates.length) return null;

  let best = null;
  for (const items of candidates) {
    const faan = Math.min(13, items.reduce((s, [, f]) => s + f, 0));
    if (!best || faan > best.faan) best = { faan, items };
  }
  return best;
}

module.exports = { scoreHand };
