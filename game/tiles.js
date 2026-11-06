// Tile codes:
//   m1-m9 characters (萬), p1-p9 dots (筒), s1-s9 bamboo (索)
//   z1-z4 winds E S W N, z5 red dragon, z6 green dragon, z7 white dragon
//   f1-f4 flowers (plum, orchid, chrysanthemum, bamboo), f5-f8 seasons (spring..winter)
const crypto = require('crypto');

const SUIT_ORDER = { m: 0, p: 1, s: 2, z: 3, f: 4 };

function buildWall() {
  const tiles = [];
  for (const s of ['m', 'p', 's']) {
    for (let n = 1; n <= 9; n++) for (let k = 0; k < 4; k++) tiles.push(s + n);
  }
  for (let n = 1; n <= 7; n++) for (let k = 0; k < 4; k++) tiles.push('z' + n);
  for (let n = 1; n <= 8; n++) tiles.push('f' + n);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

const isFlower = (t) => t[0] === 'f';
const isHonor = (t) => t[0] === 'z';
const isSuited = (t) => t[0] === 'm' || t[0] === 'p' || t[0] === 's';

function sortTiles(tiles) {
  return tiles.slice().sort((a, b) => SUIT_ORDER[a[0]] - SUIT_ORDER[b[0]] || a[1] - b[1]);
}

// 0-8 m, 9-17 p, 18-26 s, 27-33 z. Flowers have no index.
function tileIndex(t) {
  const n = +t[1];
  switch (t[0]) {
    case 'm': return n - 1;
    case 'p': return 8 + n;
    case 's': return 17 + n;
    case 'z': return 26 + n;
    default: return -1;
  }
}

function toCounts(tiles) {
  const c = new Array(34).fill(0);
  for (const t of tiles) {
    const i = tileIndex(t);
    if (i >= 0) c[i]++;
  }
  return c;
}

module.exports = { buildWall, isFlower, isHonor, isSuited, sortTiles, tileIndex, toCounts };
