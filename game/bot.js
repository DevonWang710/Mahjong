// Heuristic bot: keeps tiles that are part of pairs or near-sequences, throws away isolated
// honors and edge tiles first, counts visible tiles, and plays safe against a player who looks ready.
const { tileIndex, toCounts } = require('./tiles');

function isValuableHonor(i, ctx) {
  return i >= 31 || i === 27 + ctx.seatWind || i === 27 + ctx.prevailing;
}

// ctx.visible: counts (by tile index) of every tile this bot can see: its hand, all discards, all melds.
// ctx.threats: discard piles of opponents who look close to winning.
function chooseDiscard(player, ctx) {
  const hand = player.hand;
  const counts = toCounts(hand);
  const visible = ctx.visible || counts;
  const unseen = (i) => Math.max(0, 4 - visible[i]);
  const threats = ctx.threats || [];
  const suitCount = { m: 0, p: 0, s: 0 };
  for (const t of hand) if (suitCount[t[0]] !== undefined) suitCount[t[0]]++;
  for (const m of player.melds) if (m.tiles[0] && suitCount[m.tiles[0][0]] !== undefined) suitCount[m.tiles[0][0]] += 3;
  const dom = Object.keys(suitCount).sort((a, b) => suitCount[b] - suitCount[a])[0];
  const flushy = suitCount[dom] >= 8;

  let best = null;
  let bestV = Infinity;
  for (const t of new Set(hand)) {
    if (t[0] === 'f') continue; // flowers can't be discarded
    const i = tileIndex(t);
    const c = counts[i];
    let v;
    if (t[0] === 'z') {
      const valuable = isValuableHonor(i, ctx);
      v = c >= 3 ? 10 : c === 2 ? (valuable ? 6 : 4.5) : (valuable ? 0.8 : 0);
      // A pair whose other copies are all gone can never become a pung.
      if (c === 2 && unseen(i) === 0) v -= 2;
      if (c === 1 && unseen(i) === 0) v -= 0.5;
    } else {
      const n = +t[1];
      // A neighbour only helps if copies of the tile that would complete the run are still out there.
      const has = (d) => (n + d >= 1 && n + d <= 9 ? counts[i + d] : 0);
      const live = (d) => (n + d >= 1 && n + d <= 9 ? unseen(i + d) : 0);
      v = c >= 3 ? 9 : c === 2 ? (unseen(i) ? 4 : 2.5) : 0;
      if (has(-1)) v += live(-2) || live(1) ? 2 : 0.5;
      if (has(1)) v += live(-1) || live(2) ? 2 : 0.5;
      if (has(-2)) v += live(-1) ? 1 : 0.2;
      if (has(2)) v += live(1) ? 1 : 0.2;
      if (n === 1 || n === 9) v -= 0.4;
      else if (n >= 3 && n <= 7) v += 0.3;
      if (flushy) v += t[0] === dom ? 2 : -2;
    }
    // Defence: avoid feeding a player who looks ready. Their own discards are safe;
    // honours that are mostly visible are fairly safe; middle suit tiles are the riskiest.
    for (const pile of threats) {
      if (pile.includes(t)) continue;
      let risk = t[0] === 'z' ? (unseen(i) <= 1 ? 0.3 : 1) : 1.5;
      if (t[0] !== 'z' && +t[1] >= 3 && +t[1] <= 7) risk += 0.6;
      v += risk;
    }
    v += Math.random() * 0.2;
    if (v < bestV) { bestV = v; best = t; }
  }
  return best;
}

function chooseClaim(player, options, tile, ctx) {
  if (options.some((o) => o.type === 'win')) return { type: 'win' };
  const i = tileIndex(tile);
  const honor = tile[0] === 'z';
  const valuable = honor && isValuableHonor(i, ctx);
  const open = player.melds.some((m) => !m.concealed);
  // Which suit is this hand going for? Claims that pull the hand away from it are skipped.
  const suitCount = { m: 0, p: 0, s: 0 };
  for (const t of player.hand) if (suitCount[t[0]] !== undefined) suitCount[t[0]]++;
  const dom = Object.keys(suitCount).sort((a, b) => suitCount[b] - suitCount[a])[0];
  const flushy = suitCount[dom] >= 8;
  const offSuit = flushy && !honor && tile[0] !== dom;

  if (options.some((o) => o.type === 'kong') && !offSuit && (honor || open || Math.random() < 0.5)) return { type: 'kong' };
  if (options.some((o) => o.type === 'pung') && !offSuit
    && (valuable || open || (flushy && honor) || Math.random() < (honor ? 0.45 : 0.35))) {
    return { type: 'pung' };
  }
  const chows = options.filter((o) => o.type === 'chow');
  if (chows.length && !offSuit && Math.random() < (open ? 0.7 : flushy ? 0.4 : 0.2)) {
    // Prefer the chow that keeps the most useful tiles: avoid breaking up pairs.
    const counts = toCounts(player.hand);
    const cost = (o) => o.tiles.reduce((n, t) => n + (counts[tileIndex(t)] >= 2 ? 1 : 0), 0);
    return chows.slice().sort((a, b) => cost(a) - cost(b))[0];
  }
  return { type: 'pass' };
}

function chooseKong(kongs) {
  return kongs[0] || null;
}

module.exports = { chooseDiscard, chooseClaim, chooseKong };
