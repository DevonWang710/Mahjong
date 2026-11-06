// Runs scoring checks, then simulates many all-bot hands and checks tiles are never lost.
const assert = require('assert');
const config = require('../config');
const { scoreHand } = require('../game/scoring');
const { Game } = require('../game/engine');

const base = { melds: [], flowers: ['f2'], seatWind: 0, prevailing: 0, selfDrawn: false, replacement: false, lastTile: false };
const hand = (s) => s.split(' ');
const score = (concealed, extra = {}) => scoreHand({ ...base, concealed: hand(concealed), ...extra });

assert.strictEqual(score('m1 m2 m3 m4 m5 m6 p2 p3 p4 s7 s8 s9 z5'), null, 'not 14 tiles');
assert.strictEqual(score('m1 m2 m3 m4 m5 m6 p2 p3 p4 s7 s8 s9 z5 z6'), null, 'no pair');
let r = score('m1 m2 m3 m4 m5 m6 p2 p3 p4 s7 s8 s9 z5 z5');
assert.ok(r && r.items.some(([n]) => n === 'All chows'), 'all chows');
r = score('m1 m1 m1 m9 m9 m9 z5 z5 z5 z1 z1 z1 m5 m5');
assert.ok(r.items.some(([n]) => n === 'All pungs') && r.items.some(([n]) => n === 'Mixed one suit'));
r = score('m1 m1 m2 m2 p3 p3 p4 p4 s5 s5 z1 z1 z7 z7');
assert.ok(r.items.some(([n]) => n === 'Seven pairs'));
r = score('m1 m9 p1 p9 s1 s9 z1 z2 z3 z4 z5 z6 z7 z7');
assert.strictEqual(r.faan, 13);
r = score('p1 p1 p1 p2 p3 p4 p5 p6 p7 p8 p9 p9 p9 p5');
assert.ok(r.items.some(([n]) => n === 'Pure one suit'));
r = scoreHand({ ...base, concealed: hand('m2 m3 m4 p5 p5'), melds: [
  { type: 'pung', tiles: hand('z5 z5 z5') }, { type: 'kong', tiles: hand('z6 z6 z6 z6') }, { type: 'chow', tiles: hand('s1 s2 s3') },
] });
assert.ok(r && r.items.filter(([n]) => n === 'Dragon pung').length === 2, 'melds counted');
console.log('scoring checks passed');

config.BOT_DELAY_MS = 0;
config.DEAL_MS = 0;
const HANDS = 300;
let done = 0;
let wins = 0;
const players = [0, 1, 2, 3].map((i) => ({ name: 'B' + i, isBot: true, connected: true }));
const game = new Game(players, {
  onChange() {
    const g = game;
    const total = g.wall.length + g.players.reduce((s, p) =>
      s + p.hand.length + p.flowers.length + p.discards.length + p.melds.reduce((a, m) => a + m.tiles.length, 0), 0);
    assert.strictEqual(total, 144, 'tile count');
    assert.ok(g.players.every((p) => p.discards.every((t) => t[0] !== 'f')), 'flowers are never discarded');
    assert.ok(g.players.every((p) => p.melds.every((m) => m.tiles.every((t) => !t || t[0] !== 'f'))), 'no flowers in melds');
    if (g.phase === 'discard') {
      const p = g.players[g.turn];
      const sets = p.melds.length;
      assert.strictEqual(p.hand.length + sets * 3, 14, 'hand size on turn');
    }
    if (g.phase === 'ended' && !g._counted) {
      g._counted = true;
      done++;
      if (g.result.type === 'win') wins++;
      const sum = g.players.reduce((s, p) => s + p.score, 0);
      assert.strictEqual(sum, 0, 'scores zero-sum');
      if (done >= HANDS) {
        console.log(`simulated ${done} hands, ${wins} wins, ${done - wins} draws — all checks passed`);
        process.exit(0);
      }
      setImmediate(() => { g._counted = false; g.nextHand(); });
    }
  },
});
game.startHand();
setTimeout(() => { console.error(`stalled after ${done} hands`); process.exit(1); }, 60000);
