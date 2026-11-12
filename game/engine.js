// Game state machine for one table of four seats.
// Turn order is seat 0 -> 1 -> 2 -> 3 (counter-clockwise; seat+1 sits to your right).
const { buildWall, isFlower, isSuited, sortTiles, toCounts } = require('./tiles');
const { scoreHand } = require('./scoring');
const bot = require('./bot');
const config = require('../config');

const WIND_NAMES = ['East', 'South', 'West', 'North'];

// Bots pause a varying amount so they feel like they're thinking.
const thinkTime = () => config.BOT_DELAY_MS * (0.7 + Math.random() * 0.6);

class Game {
  constructor(players, { onChange } = {}) {
    // players: [{ name, isBot, connected }]
    this.players = players.map((p) => ({ ...p, hand: [], melds: [], flowers: [], discards: [], score: 0 }));
    this.onChange = onChange || (() => {});
    this.dealer = 0;
    this.prevailing = 0;
    this.handNo = 0;
    this.events = [];
    this.eventId = 0;
    this.version = 0;
    this.phase = 'idle';
    this.result = null;
  }

  seatWind(seat) {
    return (seat - this.dealer + 4) % 4;
  }

  event(type, data) {
    this.events.push({ id: ++this.eventId, type, ...data });
    if (this.events.length > 30) this.events.shift();
  }

  changed() {
    this.version++;
    this.onChange();
    this.scheduleBots();
    this.scheduleClock();
  }

  // Starts the countdown for a real player's decision (bots ignore it).
  startClock() {
    this.deadline = Math.max(Date.now(), this.dealUntil || 0) + config.TURN_SECONDS * 1000;
  }

  // ---------- hand lifecycle ----------

  startHand() {
    this.handNo++;
    this.wall = buildWall();
    for (const p of this.players) Object.assign(p, { hand: [], melds: [], flowers: [], discards: [] });
    for (let r = 0; r < 13; r++) {
      for (let k = 0; k < 4; k++) this.players[(this.dealer + k) % 4].hand.push(this.wall.shift());
    }
    this.players[this.dealer].hand.push(this.wall.shift());
    // Dealt flowers stay in hand; each player plays them on their own turn.
    this.event('newHand', { handNo: this.handNo, dealer: this.dealer, prevailing: this.prevailing });

    Object.assign(this, {
      turn: this.dealer, phase: 'discard', drawnTile: null, canTsumo: true, kongDraw: false,
      claim: null, lastDiscard: null, result: null,
    });
    // Players watch the deal animation before anyone moves.
    this.dealUntil = Date.now() + config.DEAL_MS;
    this.startClock();
    this.changed();
  }

  nextHand() {
    if (this.phase !== 'ended') return;
    const r = this.result;
    if (r && r.type === 'win' && r.seat !== this.dealer) {
      this.dealer = (this.dealer + 1) % 4;
      if (this.dealer === 0) this.prevailing = (this.prevailing + 1) % 4;
    }
    this.startHand();
  }

  // Draws a tile; replacement draws (after a kong or flower) come from the back of the wall.
  // Flowers go into the hand like any tile; the player plays them with the 'flower' action.
  // Returns false if the wall ran out and the hand ended.
  draw(seat, fromBack = false) {
    if (this.wall.length === 0) { this.endDraw(); return false; }
    const t = fromBack ? this.wall.pop() : this.wall.shift();
    this.players[seat].hand.push(t);
    this.drawnTile = t;
    this.canTsumo = true;
    this.kongDraw = fromBack;
    return true;
  }

  // Bots draw straight away; real players tap to draw their tile.
  nextTurn(from) {
    this.claim = null;
    this.turn = (from + 1) % 4;
    this.drawnTile = null;
    if (this.wall.length === 0) return this.endDraw();
    if (this.isAuto(this.turn)) {
      this.phase = 'discard';
      if (this.draw(this.turn)) this.changed();
      return;
    }
    this.phase = 'draw';
    this.startClock();
    this.changed();
  }

  endDraw() {
    this.phase = 'ended';
    this.claim = null;
    this.result = { type: 'draw' };
    this.event('draw', {});
    this.changed();
  }

  finishWin(seat, from, tile) {
    const selfDrawn = from === null;
    const score = selfDrawn ? this.evaluate(seat, null, true) : this.evaluate(seat, tile, false);
    if (tile) this.players[seat].hand.push(tile);
    const base = Math.pow(2, Math.min(score.faan, config.FAAN_CAP));
    const points = [0, 0, 0, 0];
    if (selfDrawn) {
      for (let s = 0; s < 4; s++) if (s !== seat) { points[s] -= base; points[seat] += base; }
    } else {
      points[from] -= 2 * base;
      points[seat] += 2 * base;
    }
    points.forEach((d, s) => { this.players[s].score += d; });
    this.phase = 'ended';
    this.claim = null;
    this.result = { type: 'win', seat, from, tile, selfDrawn, faan: score.faan, items: score.items, points };
    this.event('win', { seat, selfDrawn });
    this.changed();
  }

  // ---------- rules helpers ----------

  evaluate(seat, extraTile, selfDrawn) {
    const p = this.players[seat];
    return scoreHand({
      concealed: extraTile ? [...p.hand, extraTile] : p.hand.slice(),
      melds: p.melds,
      flowers: p.flowers,
      seatWind: this.seatWind(seat),
      prevailing: this.prevailing,
      selfDrawn,
      replacement: selfDrawn && this.kongDraw,
      lastTile: this.wall.length === 0,
    });
  }

  selfOptions(seat) {
    if (this.phase !== 'discard' || this.turn !== seat) return null;
    const p = this.players[seat];
    const kongs = [];
    if (this.wall.length > 0) {
      for (const t of new Set(p.hand)) {
        const n = p.hand.filter((x) => x === t).length;
        if (n === 4 || p.melds.some((m) => m.type === 'pung' && m.tiles[0] === t)) kongs.push(t);
      }
    }
    const flowers = this.wall.length > 0 ? [...new Set(p.hand.filter(isFlower))] : [];
    const win = this.canTsumo ? this.evaluate(seat, null, true) : null;
    const tsumo = !!(win && win.faan >= config.MIN_FAAN);
    return { kongs, flowers, tsumo, tsumoFaan: tsumo ? win.faan : null };
  }

  claimOptionsFor(seat, from, tile) {
    const p = this.players[seat];
    const o = [];
    const win = this.evaluate(seat, tile, false);
    if (win && win.faan >= config.MIN_FAAN) o.push({ type: 'win', faan: win.faan });
    if (this.wall.length === 0) return o; // only a win may claim the very last discard
    const n = p.hand.filter((t) => t === tile).length;
    if (n >= 3) o.push({ type: 'kong' });
    if (n >= 2) o.push({ type: 'pung' });
    if (seat === (from + 1) % 4 && isSuited(tile)) {
      const s = tile[0];
      const v = +tile[1];
      for (const [a, b] of [[v - 2, v - 1], [v - 1, v + 1], [v + 1, v + 2]]) {
        if (a < 1 || b > 9) continue;
        if (p.hand.includes(s + a) && p.hand.includes(s + b)) o.push({ type: 'chow', tiles: [s + a, s + b] });
      }
    }
    return o;
  }

  removeFromHand(seat, tile, count) {
    const h = this.players[seat].hand;
    for (let k = 0; k < count; k++) h.splice(h.indexOf(tile), 1);
  }

  // ---------- actions ----------

  act(seat, a) {
    if (!a || typeof a.type !== 'string') return;
    if (a.type === 'claim') return this.respond(seat, a.claim || { type: 'pass' });
    if (a.type === 'draw') {
      if (this.phase !== 'draw' || this.turn !== seat) return;
      this.phase = 'discard';
      if (this.draw(seat)) this.changed();
      return;
    }
    if (this.phase !== 'discard' || this.turn !== seat) return;
    const p = this.players[seat];

    if (a.type === 'discard') {
      const idx = p.hand.indexOf(a.tile);
      if (idx < 0 || isFlower(a.tile)) return; // flowers must be played, not discarded
      p.hand.splice(idx, 1);
      p.discards.push(a.tile);
      this.lastDiscard = { seat, tile: a.tile };
      this.drawnTile = null;
      this.canTsumo = false;
      return this.openClaims(seat, a.tile);
    }

    if (a.type === 'kong') {
      const opts = this.selfOptions(seat);
      if (!opts.kongs.includes(a.tile)) return;
      const n = p.hand.filter((x) => x === a.tile).length;
      if (n === 4) {
        this.removeFromHand(seat, a.tile, 4);
        p.melds.push({ type: 'kong', tiles: [a.tile, a.tile, a.tile, a.tile], concealed: true });
      } else {
        this.removeFromHand(seat, a.tile, 1);
        const m = p.melds.find((x) => x.type === 'pung' && x.tiles[0] === a.tile);
        m.type = 'kong';
        m.tiles.push(a.tile);
      }
      // A concealed kong stays hidden from the other players.
      this.event('claim', { seat, kind: 'kong', tiles: n === 4 ? null : [a.tile, a.tile, a.tile, a.tile] });
      this.drawnTile = null;
      if (this.draw(seat, true)) this.changed();
      return;
    }

    if (a.type === 'flower') {
      if (!this.selfOptions(seat).flowers.includes(a.tile)) return;
      this.removeFromHand(seat, a.tile, 1);
      p.flowers.push(a.tile);
      this.event('flower', { seat, tile: a.tile });
      this.drawnTile = null;
      if (this.draw(seat, true)) this.changed();
      return;
    }

    if (a.type === 'tsumo') {
      if (this.selfOptions(seat).tsumo) this.finishWin(seat, null, null);
    }
  }

  // Every connected real player is shown every discard (even with nothing to claim, just Pass),
  // so how long someone takes never gives away what's in their hand. Bots only join if they can claim.
  openClaims(from, tile) {
    const options = {};
    for (let k = 1; k < 4; k++) {
      const s = (from + k) % 4;
      const o = this.claimOptionsFor(s, from, tile);
      if (o.length || (!this.isAuto(s) && this.players[s].connected)) options[s] = o;
    }
    if (!Object.keys(options).length) return this.nextTurn(from);
    this.phase = 'claim';
    this.claim = { from, tile, options, responses: {} };
    this.startClock();
    this.changed();
  }

  respond(seat, resp) {
    if (this.phase !== 'claim') return;
    const c = this.claim;
    const opts = c.options[seat];
    if (!opts || seat in c.responses) return;
    let chosen = { type: 'pass' };
    if (resp.type !== 'pass') {
      const match = opts.find((o) => o.type === resp.type
        && (o.type !== 'chow' || (resp.tiles && o.tiles.join() === resp.tiles.join())));
      if (!match) return;
      chosen = match;
    }
    c.responses[seat] = chosen;
    if (Object.keys(c.options).every((s) => s in c.responses)) this.resolveClaims();
    else this.changed();
  }

  resolveClaims() {
    const { from, tile, responses } = this.claim;
    // Real players beat bots: between equal claims a real player wins, and any pung, kong or chow
    // from a real player beats a bot's (only a bot's Mahjong still wins). Otherwise turn order breaks ties.
    const turnOrder = [1, 2, 3].map((k) => (from + k) % 4);
    const humans = turnOrder.filter((s) => !this.isAuto(s));
    const bots = turnOrder.filter((s) => this.isAuto(s));
    const pick = (seats, types) => seats.find((s) => responses[s] && types.includes(responses[s].type));
    const setFrom = (seats) => pick(seats, ['pung', 'kong']) ?? pick(seats, ['chow']);
    const winner = pick(humans, ['win']) ?? pick(bots, ['win']);
    const setSeat = winner !== undefined ? undefined : setFrom(humans) ?? setFrom(bots);
    const takeDiscard = () => { this.players[from].discards.pop(); this.lastDiscard = null; };

    // Everyone decided at once; if more than one player wanted the tile, show the contest.
    const claims = turnOrder.filter((s) => responses[s] && responses[s].type !== 'pass')
      .map((s) => ({ seat: s, kind: responses[s].type }));
    if (claims.length > 1) this.event('contest', { tile, claims, winner: winner ?? setSeat });

    if (winner !== undefined) {
      takeDiscard();
      return this.finishWin(winner, from, tile);
    }

    const seat = setSeat;
    if (seat === undefined) return this.nextTurn(from);

    takeDiscard();
    const p = this.players[seat];
    const kind = responses[seat].type;
    if (kind === 'chow') {
      const [a, b] = responses[seat].tiles;
      this.removeFromHand(seat, a, 1);
      this.removeFromHand(seat, b, 1);
      p.melds.push({ type: 'chow', tiles: sortTiles([a, b, tile]), from });
    } else {
      const n = kind === 'kong' ? 3 : 2;
      this.removeFromHand(seat, tile, n);
      p.melds.push({ type: kind, tiles: new Array(n + 1).fill(tile), from });
    }
    this.event('claim', { seat, kind, tiles: p.melds[p.melds.length - 1].tiles.slice() });
    Object.assign(this, { claim: null, turn: seat, phase: 'discard', drawnTile: null, canTsumo: false });
    this.startClock();
    if (kind === 'kong' && !this.draw(seat, true)) return;
    this.changed();
  }

  setConnected(seat, connected) {
    this.players[seat].connected = connected;
    this.changed();
  }

  // ---------- bots ----------

  isAuto(seat) {
    return this.players[seat].isBot;
  }

  botContext(seat) {
    const seen = [...this.players[seat].hand];
    for (const p of this.players) {
      seen.push(...p.discards);
      for (const m of p.melds) if (!m.concealed || p === this.players[seat]) seen.push(...m.tiles);
    }
    // Someone with three sets on the table, or anyone late in the hand, may be one tile from winning.
    const threats = this.players
      .filter((p, i) => i !== seat && (p.melds.length >= 3 || (p.melds.length >= 2 && this.wall.length < 40)))
      .map((p) => p.discards);
    return { seatWind: this.seatWind(seat), prevailing: this.prevailing, visible: toCounts(seen), threats };
  }

  scheduleBots() {
    clearTimeout(this.botTimer);
    const v = this.version;
    if (this.phase === 'discard' && this.isAuto(this.turn)) {
      const wait = Math.max(0, (this.dealUntil || 0) - Date.now()) + thinkTime() + config.BOT_EXTRA_MS;
      this.botTimer = setTimeout(() => { if (v === this.version) this.botTurn(this.turn); }, wait);
    } else if (this.phase === 'claim') {
      const c = this.claim;
      const pending = Object.keys(c.options).map(Number).filter((s) => !(s in c.responses));
      // Disconnected humans automatically pass so the table never freezes on a claim.
      for (const s of pending) {
        if (!this.isAuto(s) && !this.players[s].connected) return this.respond(s, { type: 'pass' });
      }
      const bots = pending.filter((s) => this.isAuto(s));
      if (!bots.length) return;
      this.botTimer = setTimeout(() => {
        for (const s of bots) {
          if (this.phase !== 'claim' || this.claim !== c) return;
          this.respond(s, bot.chooseClaim(this.players[s], c.options[s], c.tile, this.botContext(s)));
        }
      }, thinkTime() * 0.7);
    }
  }

  // ---------- the decision clock ----------

  // Milliseconds left for the real player(s) the table is waiting on, or null if it's waiting on bots.
  timeLeft() {
    if (!this.deadline) return null;
    const c = this.claim;
    const human = this.phase === 'claim'
      ? Object.keys(c.options).some((s) => !this.isAuto(+s) && !(s in c.responses))
      : (this.phase === 'draw' || this.phase === 'discard') && !this.isAuto(this.turn);
    return human ? Math.max(0, this.deadline - Date.now()) : null;
  }

  scheduleClock() {
    clearTimeout(this.clockTimer);
    if (this.timeLeft() === null) return;
    const v = this.version;
    this.clockTimer = setTimeout(() => { if (v === this.version) this.timeUp(); }, this.timeLeft());
  }

  // Time ran out: pass on claims, or draw, play flowers and throw the newest tile.
  // Each step calls changed(), which reschedules the (already expired) clock for the next step.
  timeUp() {
    if (this.phase === 'claim') {
      for (const s of Object.keys(this.claim.options).map(Number)) {
        if (this.phase !== 'claim') return;
        if (!this.isAuto(s) && !(s in this.claim.responses)) this.respond(s, { type: 'pass' });
      }
      return;
    }
    const seat = this.turn;
    if (this.isAuto(seat)) return;
    if (this.phase === 'draw') return this.act(seat, { type: 'draw' });
    if (this.phase !== 'discard') return;
    const o = this.selfOptions(seat);
    if (o.flowers.length) return this.act(seat, { type: 'flower', tile: o.flowers[0] });
    const t = this.drawnTile && !isFlower(this.drawnTile)
      ? this.drawnTile
      : this.players[seat].hand.filter((x) => !isFlower(x)).pop();
    this.act(seat, { type: 'discard', tile: t });
  }

  botTurn(seat) {
    const o = this.selfOptions(seat);
    if (!o) return;
    if (o.flowers.length) return this.act(seat, { type: 'flower', tile: o.flowers[0] });
    if (o.tsumo) return this.act(seat, { type: 'tsumo' });
    const k = bot.chooseKong(o.kongs);
    if (k) return this.act(seat, { type: 'kong', tile: k });
    this.act(seat, { type: 'discard', tile: bot.chooseDiscard(this.players[seat], this.botContext(seat)) });
  }

  // ---------- per-player view (never leaks other hands) ----------

  viewFor(seat) {
    const ended = this.phase === 'ended';
    const c = this.claim;
    return {
      phase: this.phase,
      mySeat: seat,
      dealer: this.dealer,
      prevailing: this.prevailing,
      prevailingName: WIND_NAMES[this.prevailing],
      handNo: this.handNo,
      turn: this.turn,
      wallCount: this.wall ? this.wall.length : 0,
      minFaan: config.MIN_FAAN,
      players: this.players.map((p, i) => ({
        name: p.name,
        isBot: p.isBot,
        connected: p.isBot || p.connected,
        seatWind: this.seatWind(i),
        score: p.score,
        handCount: p.hand.length,
        hand: i === seat || ended ? sortTiles(p.hand) : null,
        melds: p.melds.map((m) => (m.concealed && i !== seat && !ended
          ? { type: 'kong', concealed: true, tiles: [null, null, null, null] }
          : m)),
        flowers: p.flowers,
        discards: p.discards,
      })),
      lastDiscard: this.lastDiscard,
      drawnTile: this.turn === seat ? this.drawnTile : null,
      canDraw: this.phase === 'draw' && this.turn === seat,
      timeLeft: this.timeLeft(),
      self: this.selfOptions(seat),
      claim: c ? {
        tile: c.tile,
        from: c.from,
        options: c.options[seat] && !(seat in c.responses) ? c.options[seat] : null,
      } : null,
      result: this.result,
      events: this.events,
    };
  }
}

module.exports = { Game };
