/* global io */
const $ = (id) => document.getElementById(id);

// Invite key from the link (?key=...), remembered so a reload without it still works.
const inviteKey = (() => {
  const k = new URLSearchParams(location.search).get('key');
  try {
    if (k) localStorage.setItem('mj_key', k);
    return k || localStorage.getItem('mj_key') || '';
  } catch (e) { return k || ''; }
})();
const socket = io({ auth: { key: inviteKey } });
socket.on('connect_error', (err) => {
  if (err.message !== 'invite-only') return;
  try { localStorage.removeItem('mj_key'); } catch (e) { /* storage blocked */ }
  $('lobby').classList.remove('hidden');
  $('table').classList.add('hidden');
  $('lobby').querySelector('.card').innerHTML = `<h1>🀄 Mahjong</h1>
    <p>This game is invite-only. Ask whoever runs it to send you the full invite link.</p>`;
});

const WIND_CH = '東南西北';
const WIND_EN = ['East', 'South', 'West', 'North'];
const NUM_CH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SUIT_EN = { m: 'Characters', p: 'Dots', s: 'Bamboo' };
const HONOR = {
  z1: ['東', 'East wind', ''], z2: ['南', 'South wind', ''], z3: ['西', 'West wind', ''], z4: ['北', 'North wind', ''],
  z5: ['中', 'Red dragon', 'c-red'], z6: ['發', 'Green dragon', 'c-green'], z7: ['', 'White dragon', ''],
};
const FLOWER_CH = { f1: '梅', f2: '蘭', f3: '菊', f4: '竹', f5: '春', f6: '夏', f7: '秋', f8: '冬' };

let flowers = {};
let state = null;
let selected = null;
let seenEvent = 0;
let cameFromLobby = false;
let photo = null;
let handOrder = []; // my tiles in the order I've arranged them (new tiles go on the right)
let shuffleNext = false;
let deal = null; // while the deal animation runs: { id, shown: tiles shown per seat }
let lastAnimKey = null;
let celebrating = false; // the result window waits until the win/draw animation finishes
let drawnSettled = false; // true once I've dragged this turn's drawn tile into my hand
let clockEnd = null; // local time the current decision runs out (real players only)
let hoverOpt = null; // the claim option under the pointer, so its tiles light up in my hand

fetch('flowers/flowers.json').then((r) => r.json()).then((j) => { flowers = j; if (state) render(); }).catch(() => {});

// ---------- identity & joining ----------

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return v; }
let token = store('mj_token');
if (!token) token = store('mj_token', Math.random().toString(36).slice(2) + Date.now().toString(36));

const params = new URLSearchParams(location.search);
$('name').value = store('mj_name') || '';
$('room').value = params.get('room') || store('mj_room') || '';
let joined = false;

function join() {
  const name = $('name').value.trim();
  const room = $('room').value.trim().toUpperCase();
  if (!name || !room) return alert('Enter your name and a room code.');
  store('mj_name', name);
  store('mj_room', room);
  joined = true;
  socket.emit('join', { room, name, token });
}
$('joinBtn').onclick = join;
$('room').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

socket.on('connect', () => { if (joined) socket.emit('join', { room: store('mj_room'), name: store('mj_name'), token }); });
socket.on('errorMsg', (m) => { joined = false; alert(m); });

// "localhost" only works on this computer, so share the network address instead.
let shareOrigin = location.origin;
if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname)) {
  fetch('/lan').then((r) => r.json()).then((d) => { if (d.url) shareOrigin = d.url; }).catch(() => {});
}

socket.on('lobby', (l) => {
  cameFromLobby = true;
  const link = `${shareOrigin}${location.pathname}?room=${encodeURIComponent(l.code)}${inviteKey ? `&key=${encodeURIComponent(inviteKey)}` : ''}`;
  $('lobbyInfo').innerHTML = `
    <p><b>Room ${esc(l.code)}</b> — share this link:<br><span class="muted">${esc(link)}</span></p>
    <ul>${l.members.map((m) => `<li>${esc(m.name)}${m.connected ? '' : ' (offline)'}</li>`).join('')}</ul>
    <p class="muted">Empty seats will be filled with bots.</p>
    <button class="primary" id="startBtn">Start game (${l.members.length} human${l.members.length > 1 ? 's' : ''} + ${4 - l.members.length} bots)</button>`;
  $('startBtn').onclick = () => socket.emit('start');
});

socket.on('state', (s) => {
  const prev = state;
  const first = !state;
  state = s;
  clockEnd = s.timeLeft == null ? null : Date.now() + s.timeLeft;
  hoverOpt = null;
  if (first && !cameFromLobby) seenEvent = Math.max(0, ...s.events.map((e) => e.id));
  selected = null;
  const eventSound = showEvents();
  if (!prev || prev.wallCount !== s.wallCount) drawnSettled = false;
  syncHand();
  if (prev) playStateSounds(prev, s, eventSound);
  render();
});

// ---------- sounds ----------

const discardCount = (s) => s.players.reduce((n, p) => n + p.discards.length, 0);
const myTurn = (s) => (s.phase === 'draw' || s.phase === 'discard') && s.turn === s.mySeat;

// Sounds that come from comparing the old and new state (events are handled in showEvents).
function playStateSounds(prev, s, eventSound) {
  const discarded = discardCount(s) > discardCount(prev);
  if (discarded) Sound.play('discard');
  if (s.claim && s.claim.options && !(prev.claim && prev.claim.options)) setTimeout(() => Sound.play('claimable'), discarded ? 200 : 0);
  else if (!eventSound && myTurn(s) && !myTurn(prev)) setTimeout(() => Sound.play('turn'), discarded ? 250 : 0);
}

function renderMute() {
  $('muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
}
$('muteBtn').onclick = () => { Sound.toggle(); renderMute(); };
renderMute();

// ---------- tiles ----------

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }

function tileName(t) {
  if (!t) return 'Hidden tile';
  if (t[0] === 'z') return HONOR[t][1];
  if (t[0] === 'f') return (flowers[t] && flowers[t].label) || FLOWER_CH[t];
  return `${t[1]} ${SUIT_EN[t[0]]}`;
}

// Text rendering, used if a tile image fails to load.
function tileText(t) {
  const s = t[0];
  const n = t[1];
  if (s === 'm') return `<span class="idx">${n}</span><span class="num">${NUM_CH[n]}</span><span class="suit c-red">萬</span>`;
  if (s === 'p') return `<span class="idx">${n}</span><span class="num c-blue">${n}</span><span class="suit c-blue">筒</span>`;
  if (s === 's') return `<span class="idx">${n}</span><span class="num c-green">${n}</span><span class="suit c-green">索</span>`;
  if (s === 'z') {
    const [ch, , cls] = HONOR[t];
    return t === 'z7' ? '<span class="white"></span>' : `<span class="honor ${cls}">${ch}</span>`;
  }
  return `<span class="honor">${FLOWER_CH[t]}</span><span class="flabel">${esc(tileName(t))}</span>`;
}

// Tile images live in tiles/<code>.png (see tiles/CREDITS.txt).
function tileSrc(t) { return `tiles/${t || 'back'}.png`; }

// Flowers can still use a custom photo from flowers.json; otherwise the tile image.
function photoSrc(t) {
  const f = flowers[t];
  return f && f.image ? `flowers/${f.image}` : tileSrc(t);
}

function tileEl(t, size = '') {
  const el = document.createElement('div');
  el.className = `tile img ${size}`;
  const img = new Image();
  img.src = tileSrc(t);
  img.alt = t ? tileName(t) : '';
  img.draggable = false;
  img.onerror = () => {
    el.classList.remove('img');
    if (t) el.innerHTML = tileText(t); else { el.innerHTML = ''; el.classList.add('back'); }
  };
  el.appendChild(img);
  if (!t) return el;
  el.title = tileName(t);
  // The white dragon image is blank; draw the traditional blue frame on it.
  if (t === 'z7') el.insertAdjacentHTML('beforeend', '<span class="frame"></span>');
  // A flower with its own photo (flowers.json "image") shows it on a blank tile, with its number in the corner.
  const custom = t[0] === 'f' && flowers[t] && flowers[t].image;
  if (custom) {
    img.src = tileSrc('z7');
    const ph = new Image();
    ph.className = 'photo';
    ph.src = photoSrc(t);
    ph.alt = '';
    ph.draggable = false;
    const num = document.createElement('span');
    num.className = 'fnum';
    num.textContent = ((+t[1] - 1) % 4) + 1;
    ph.onerror = () => { ph.remove(); num.remove(); img.src = tileSrc(t); };
    el.append(ph, num);
  }
  // Face-up tiles on the table are solid blocks: the face is raised and four sides fill the gap.
  if (size === 'bt' || size === 'bm') {
    el.classList.add('box');
    el.insertAdjacentHTML('beforeend', '<i class="sd sd-t"></i><i class="sd sd-b"></i><i class="sd sd-l"></i><i class="sd sd-r"></i>');
  }
  if (t[0] === 'f') {
    el.classList.add('flower');
    el.style.cursor = 'zoom-in';
    el.onclick = (e) => { e.stopPropagation(); photo = t; renderModal(); };
  }
  return el;
}

function row(tiles, size, cls = 'row') {
  const d = document.createElement('div');
  d.className = cls;
  for (const t of tiles) d.appendChild(t instanceof Element ? t : tileEl(t, size));
  return d;
}

function meldsEl(melds, size) {
  const d = document.createElement('div');
  d.className = 'row';
  for (const m of melds) d.appendChild(row(m.tiles, size, 'meld'));
  return d;
}

// ---------- rendering ----------

function seatAt(rel) { return (state.mySeat + rel) % 4; }

function badgesHtml(p, seat) {
  const turn = state.phase !== 'ended' && state.turn === seat;
  return `<span class="badge keep">${WIND_CH[p.seatWind]} ${WIND_EN[p.seatWind]}</span>
    ${seat === state.dealer ? '<span class="badge dealer keep">Dealer</span>' : ''}
    ${p.connected ? '' : '<span class="badge off keep">offline</span>'}
    <span class="badge">${p.score} pts</span>
    ${turn ? '<span class="badge" style="background:var(--gold);color:#222">turn</span>' : ''}`;
}

function headHtml(p, seat) {
  return `<span class="name">${p.isBot ? '🤖 ' : ''}${esc(p.name)}</span>${badgesHtml(p, seat)}`;
}

function plateHtml(p, seat) {
  const face = p.isBot ? '🤖' : esc((p.name[0] || '?').toUpperCase());
  return `<div class="avatar${p.isBot ? ' bot' : ''}">${face}</div>
    <div class="who"><div class="name">${esc(p.name)}</div><div class="badges">${badgesHtml(p, seat)}</div></div>`;
}

function render() {
  $('lobby').classList.add('hidden');
  $('table').classList.remove('hidden');
  const s = state;

  for (let rel = 0; rel < 4; rel++) {
    const seat = seatAt(rel);
    const p = s.players[seat];
    const pool = $(`pool${rel}`);
    pool.innerHTML = '';
    p.discards.forEach((t, i) => {
      const el = tileEl(t, 'bt');
      if (s.lastDiscard && s.lastDiscard.seat === seat && i === p.discards.length - 1) {
        el.classList.add('last');
        // The newest discard slides in from the player who threw it (only the first time it's drawn).
        const key = `${s.handNo}:${seat}:${i}`;
        if (key !== lastAnimKey) { lastAnimKey = key; el.classList.add('fresh'); }
      }
      pool.appendChild(el);
    });
    // Your own melds are shown beside your hand instead (renderMe).
    const laid = $(`laid${rel}`);
    laid.innerHTML = '';
    if (rel !== 0) for (const m of p.melds) laid.appendChild(row(m.tiles, 'bm', 'meld'));
    const box = $(`pos${rel}`);
    box.classList.toggle('active', s.phase !== 'ended' && s.turn === seat);
    if (rel === 0) continue;
    box.innerHTML = plateHtml(p, seat);
    if (p.flowers.length) box.appendChild(row(p.flowers, 'sm', 'row plate-fl'));
    const stand = $(`stand${rel}`);
    stand.innerHTML = '';
    const count = deal ? Math.min(p.handCount, deal.shown[seat]) : p.handCount;
    for (let i = 0; i < count; i++) stand.appendChild(tileEl(null, 'bt'));
  }

  renderMe();
  renderInfo();
  renderActions();
  renderModal();
  fit();
}

// Scales the tilted board to fill the scene, then places each opponent's
// name plate beside their edge of the table (or above it if there's no room).
function fit() {
  const scene = $('scene');
  const stage = $('stage');
  const board = $('board');
  stage.style.transform = 'translate(-50%, -50%)';
  const sc = scene.getBoundingClientRect();
  // Measure from the far player's standing tiles (which stick up above the board)
  // down to the #near marker; the strip of table below it may sit behind the hand panel.
  const bounds = () => {
    const a = board.getBoundingClientRect();
    const t = $('stand2').getBoundingClientRect();
    const y = Math.min(a.top, t.top);
    return { left: a.left, top: y, width: a.width, height: $('near').getBoundingClientRect().bottom - y };
  };
  const b = bounds();
  // Reserve room for the top plate without its flowers, so the table doesn't jump when one is drawn.
  // On narrow screens all three plates share the row above the table, so reserve the tallest.
  const narrow = sc.width < 700;
  const top = narrow
    ? Math.max(...[1, 2, 3].map((i) => $(`pos${i}`).offsetHeight)) + 10
    : $('pos2').querySelector('.avatar').offsetHeight + 28;
  const bottom = sc.height - $('pos0').offsetHeight - 6;
  const k = Math.min((sc.width - 8) / b.width, (bottom - top - 4) / b.height);
  const mid = sc.top + sc.height / 2;
  const target = sc.top + (top + bottom) / 2;
  const ty = target - mid - (b.top + b.height / 2 - mid) * k;
  stage.style.transform = `translate(-50%, -50%) translateY(${ty}px) scale(${k})`;

  const r = bounds();
  const x0 = r.left - sc.left;
  const y0 = r.top - sc.top;
  const place = (el, left, y) => {
    el.style.left = `${Math.max(4, Math.min(left, sc.width - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, y)}px`;
  };
  const p1 = $('pos1');
  const p2 = $('pos2');
  const p3 = $('pos3');
  const above = y0 - p2.offsetHeight - 6;
  place(p2, x0 + r.width / 2 - p2.offsetWidth / 2, above);
  const row = y0 - Math.max(p1.offsetHeight, p2.offsetHeight, p3.offsetHeight) - 6;
  // Side players sit just outside their standing tiles (the table is narrower there than at the near edge).
  const s3 = $('stand3').getBoundingClientRect();
  const s1 = $('stand1').getBoundingClientRect();
  const midY = (s3.top + s3.bottom) / 2 - sc.top;
  const w = Math.max(p1.offsetWidth, p3.offsetWidth) + 12;
  if (s3.left - sc.left >= w && sc.right - s1.right >= w) {
    place(p3, s3.left - sc.left - p3.offsetWidth - 8, midY - p3.offsetHeight / 2);
    place(p1, s1.right - sc.left + 8, midY - p1.offsetHeight / 2);
  } else if (!narrow && s3.right - sc.left - 34 >= w && sc.right - s1.left - 34 >= w) {
    // Not enough room mid-table: sit beside the far end of their tiles, where the table is narrower.
    place(p3, s3.right - sc.left - 34 - p3.offsetWidth, s3.top - sc.top - p3.offsetHeight / 2);
    place(p1, s1.left - sc.left + 34, s1.top - sc.top - p1.offsetHeight / 2);
  } else {
    // Narrow screen: all three plates share the row above the board.
    place(p2, x0 + r.width / 2 - p2.offsetWidth / 2, row);
    place(p3, 4, row);
    place(p1, sc.width - p1.offsetWidth - 4, row);
  }
}
window.addEventListener('resize', () => { if (state) fit(); });

// Keeps my own arrangement of the hand: tiles I still hold stay where they were, new ones go on the right.
function syncHand() {
  const me = state.players[state.mySeat];
  if (!me.hand) return;
  const left = me.hand.slice();
  const kept = [];
  for (const t of handOrder) {
    const i = left.indexOf(t);
    if (i >= 0) { kept.push(t); left.splice(i, 1); }
  }
  if (shuffleNext) {
    // A fresh deal arrives in random order, like picking tiles up off the wall.
    shuffleNext = false;
    for (let i = left.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [left[i], left[j]] = [left[j], left[i]];
    }
  }
  handOrder = kept.concat(left);
}

const SUIT_RANK = { m: 0, p: 1, s: 2, z: 3, f: 4 };
function organize() {
  handOrder.sort((a, b) => SUIT_RANK[a[0]] - SUIT_RANK[b[0]] || a[1] - b[1]);
  selected = null;
  Sound.play('draw');
  renderMe();
  renderActions();
}
$('sortBtn').onclick = organize;

// ---------- dragging tiles to rearrange the hand ----------

let drag = null;
function startDrag(e, el) {
  if (deal || e.button > 0) return;
  drag = { el, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
}
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved) {
    // A small wobble is still a tap (select / discard); past 8px it becomes a drag.
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    drag.moved = true;
    const r = drag.el.getBoundingClientRect();
    drag.dx = drag.x - r.left;
    drag.dy = drag.y - r.top;
    const f = drag.el.cloneNode(true);
    f.classList.add('drag-float');
    f.classList.remove('sel', 'drawn');
    f.style.width = `${r.width}px`;
    f.style.height = `${r.height}px`;
    document.body.appendChild(f);
    drag.float = f;
    drag.el.classList.add('ghost');
    drag.el.classList.remove('sel', 'drawn');
  }
  e.preventDefault();
  drag.float.style.left = `${e.clientX - drag.dx}px`;
  drag.float.style.top = `${e.clientY - drag.dy}px`;
  // Move the empty slot to wherever the tile would land.
  const hand = $('hand');
  const before = [...hand.children].filter((c) => c !== drag.el).find((c) => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
  });
  if (before) { if (drag.el.nextSibling !== before) hand.insertBefore(drag.el, before); }
  else if (hand.lastChild !== drag.el) hand.appendChild(drag.el);
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moved) return;
  d.float.remove();
  handOrder = [...$('hand').children].map((c) => c.dataset.tile);
  drawnSettled = true;
  selected = null;
  syncHand(); // in case the hand changed on the server mid-drag
  Sound.play('draw');
  renderMe();
  renderActions();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

function myHandTiles() {
  const hand = handOrder.slice();
  let drawn = null;
  if (state.drawnTile && state.self && !drawnSettled) {
    const i = hand.lastIndexOf(state.drawnTile);
    if (i >= 0) { hand.splice(i, 1); drawn = state.drawnTile; }
  }
  return drawn ? [...hand, drawn] : hand;
}

function renderMe() {
  const s = state;
  const me = s.players[s.mySeat];
  $('meHead').innerHTML = headHtml(me, s.mySeat);
  if (me.flowers.length) $('meHead').appendChild(row(me.flowers, 'sm'));
  const melds = $('meMelds');
  melds.innerHTML = '';
  for (const m of me.melds) melds.appendChild(row(m.tiles, '', 'meld'));

  const hand = $('hand');
  if (drag && drag.moved) return; // redrawn when the drag ends
  hand.innerHTML = '';
  const canDiscard = !!s.self && !deal;
  hand.classList.toggle('inactive', !canDiscard);
  let tiles = myHandTiles();
  if (deal) tiles = tiles.slice(0, deal.shown[s.mySeat]);
  $('sortBtn').classList.toggle('hidden', !!deal || tiles.length < 2);
  tiles.forEach((t, i) => {
    const el = tileEl(t);
    if (deal && i >= deal.meBefore) el.classList.add('dealt');
    el.dataset.tile = t;
    if (i === tiles.length - 1 && s.drawnTile && s.self && !drawnSettled) el.classList.add('drawn');
    el.onpointerdown = (e) => startDrag(e, el);
    if (i === selected) el.classList.add('sel');
    if (t[0] === 'f') el.classList.add('unplayed');
    el.onclick = () => {
      if (!canDiscard) return;
      if (selected === i) discard(t);
      else { selected = i; renderMe(); renderActions(); }
    };
    hand.appendChild(el);
  });
  if (deal) deal.meBefore = tiles.length;
  highlightHand();
}

// Lights up the tiles in my hand that a claim, kong or win would use.
function highlightHand() {
  const s = state;
  const need = {};
  const add = (tiles) => {
    const n = {};
    for (const t of tiles) n[t] = (n[t] || 0) + 1;
    for (const t in n) need[t] = Math.max(need[t] || 0, n[t]);
  };
  const c = s.claim;
  if (c && c.options) {
    for (const o of hoverOpt ? [hoverOpt] : c.options) {
      if (o.type === 'chow') add(o.tiles);
      else if (o.type === 'pung') add([c.tile, c.tile]);
      else if (o.type === 'kong') add([c.tile, c.tile, c.tile]);
      else if (o.type === 'win') add(s.players[s.mySeat].hand || []);
    }
  } else if (s.self) {
    for (const k of s.self.kongs) add([k, k, k, k]);
    if (s.self.tsumo) add(s.players[s.mySeat].hand || []);
  }
  for (const el of $('hand').children) {
    const t = el.dataset.tile;
    el.classList.toggle('match', need[t] > 0);
    if (need[t] > 0) need[t]--;
  }
}

// Tapping a flower twice plays it (flowers can't be discarded).
function discard(t) {
  selected = null;
  socket.emit('action', t[0] === 'f' ? { type: 'flower', tile: t } : { type: 'discard', tile: t });
}

function playFlowerButton(t) {
  const sp = document.createElement('span');
  sp.className = 'chow';
  sp.append('Play flower ', tileEl(t, 'xs'));
  return button(sp, 'flower-btn', () => discard(t));
}

function nameOf(seat) { return seat === state.mySeat ? 'You' : state.players[seat].name; }

function renderInfo() {
  const s = state;
  let status;
  if (s.phase === 'ended') status = 'Hand over';
  else if (s.claim) {
    if (s.claim.options) status = 'Claim or pass?';
    else {
      const deciding = s.claim.waitingOn.filter((x) => !s.players[x].isBot && x !== s.mySeat).map((x) => esc(nameOf(x)));
      status = deciding.length ? `${deciding.join(', ')} ${deciding.length > 1 ? 'are' : 'is'} deciding` : 'Bots are thinking…';
    }
  } else if (s.turn === s.mySeat) status = s.canDraw ? 'Your turn: draw a tile' : 'Your turn: discard to end it';
  else {
    const p = s.players[s.turn];
    status = `${esc(p.name)}'s turn${p.connected ? '' : ' (offline)'}`;
  }
  $('info').innerHTML = `
    <div class="big">${WIND_CH[s.prevailing]} ${s.prevailingName} round</div>
    <div>Hand ${s.handNo} · Wall ${s.wallCount}</div>
    <div style="margin-top:6px;font-weight:700">${status}</div>`;
  if (clockEnd) $('info').appendChild(clockEl());
}

// ---------- the 60-second decision clock ----------

function clockEl() {
  const el = document.createElement('span');
  el.className = 'clock';
  tickClock(el);
  return el;
}
function tickClock(el) {
  const secs = clockEnd ? Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000)) : 0;
  el.textContent = `⏱ ${secs}s`;
  el.classList.toggle('low', secs <= 10);
}
// The server only sends state when something changes, so count down locally.
// In the last five seconds of my own decision, a short tick each second.
let lastTick = null;
setInterval(() => {
  document.querySelectorAll('.clock').forEach(tickClock);
  if (!clockEnd || !state) return;
  const secs = Math.ceil((clockEnd - Date.now()) / 1000);
  const mine = myTurn(state) || (state.claim && state.claim.options);
  if (mine && secs > 0 && secs <= 5 && secs !== lastTick) { lastTick = secs; Sound.play('draw'); }
}, 250);

function button(label, cls, onclick) {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  if (label instanceof Element) b.appendChild(label); else b.textContent = label;
  b.onclick = onclick;
  return b;
}

function renderActions() {
  const s = state;
  const a = $('actions');
  a.innerHTML = '';
  renderClaimCard();
  if (deal) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = 'Dealing…';
    a.appendChild(h);
    return;
  }
  if (s.claim && s.claim.options) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = 'Claim the discard above, or pass.';
    a.append(h, clockEl());
    return;
  }

  if (s.canDraw) {
    const sp = document.createElement('span');
    sp.append('Draw a tile', kbd('D'));
    a.append(keyed('draw', button(sp, 'primary draw-btn', () => socket.emit('action', { type: 'draw' }))), clockEl());
    return;
  }

  if (s.self) {
    a.appendChild(clockEl());
    if (s.self.tsumo) a.appendChild(button(`Mahjong! Self-drawn (${s.self.tsumoFaan} faan)`, 'win', () => socket.emit('action', { type: 'tsumo' })));
    for (const k of s.self.kongs) {
      const sp = document.createElement('span');
      sp.className = 'chow';
      sp.append('Kong ', tileEl(k, 'xs'), kbd('K'));
      a.appendChild(keyed('kong', button(sp, 'primary', () => socket.emit('action', { type: 'kong', tile: k }))));
    }
    for (const f of s.self.flowers) a.appendChild(playFlowerButton(f));
    const tiles = myHandTiles();
    const sel = selected !== null ? tiles[selected] : null;
    if (sel && sel[0] !== 'f') {
      a.appendChild(button(`End turn: discard ${tileName(sel)}`, 'primary', () => discard(sel)));
    } else if (!sel) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = s.self.flowers.length
        ? 'Play your flowers to draw replacement tiles.'
        : 'Tap a tile to pick your discard, then End turn.';
      a.appendChild(h);
    }
  }
}

// A claimable discard pops up large above your hand, with each option showing the set it makes.
function renderClaimCard() {
  const card = $('claimCard');
  const c = state.claim;
  if (!c || !c.options) { card.classList.add('hidden'); card.innerHTML = ''; return; }
  const claim = (o) => () => socket.emit('action', { type: 'claim', claim: o });
  const setTiles = (tiles) => {
    const sp = document.createElement('span');
    sp.className = 'opt-tiles';
    let marked = false;
    for (const t of tiles) {
      const el = tileEl(t);
      if (!marked && t === c.tile) { el.classList.add('claimed'); marked = true; }
      sp.appendChild(el);
    }
    return sp;
  };
  const opt = (label, tiles, cls, o) => {
    const sp = document.createElement('span');
    sp.className = 'opt';
    sp.append(label);
    if (KEY_FOR[o.type]) sp.append(kbd(KEY_FOR[o.type]));
    if (tiles) sp.appendChild(setTiles(tiles));
    const b = keyed(o.type, button(sp, cls, claim(o)));
    b.onpointerenter = b.onfocus = () => { hoverOpt = o; highlightHand(); };
    b.onpointerleave = b.onblur = () => { if (hoverOpt === o) { hoverOpt = null; highlightHand(); } };
    return b;
  };

  card.innerHTML = `<div class="cc-head">${esc(nameOf(c.from))} discarded</div>`;
  card.firstChild.append(' ', clockEl());
  card.appendChild(tileEl(c.tile, 'big'));
  const opts = document.createElement('div');
  opts.className = 'opts';
  for (const o of c.options) {
    if (o.type === 'win') opts.appendChild(opt(`Mahjong! (${o.faan} faan)`, null, 'win', o));
    else if (o.type === 'chow') opts.appendChild(opt('Chow', [...o.tiles, c.tile].sort(), 'primary', o));
    else if (o.type === 'pung') opts.appendChild(opt('Pung', [c.tile, c.tile, c.tile], 'primary', o));
    else if (o.type === 'kong') opts.appendChild(opt('Kong', [c.tile, c.tile, c.tile, c.tile], 'primary', o));
  }
  const pass = document.createElement('span');
  pass.className = 'opt';
  pass.append('Pass', kbd('Space'));
  opts.appendChild(keyed('pass', button(pass, 'pass', claim({ type: 'pass' }))));
  card.appendChild(opts);
  card.classList.remove('hidden');
}

// ---------- keyboard: P pung, C chow, K kong, D draw, Space pass (or draw) ----------

const KEY_FOR = { pung: 'P', chow: 'C', kong: 'K' };
function kbd(k) {
  const el = document.createElement('kbd');
  el.textContent = k;
  return el;
}
function keyed(kind, btn) {
  btn.dataset.key = kind;
  return btn;
}
document.addEventListener('keydown', (e) => {
  if (!state || e.metaKey || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('input, textarea'))) return;
  let kind = { p: 'pung', c: 'chow', k: 'kong', d: 'draw', ' ': 'pass' }[e.key.toLowerCase()];
  if (!kind) return;
  if (kind === 'pass' && state.canDraw) kind = 'draw';
  const btns = [...document.querySelectorAll(`#pos0 button[data-key="${kind}"]`)];
  if (!btns.length) return;
  e.preventDefault();
  if (btns.length === 1) return btns[0].click();
  // Several choices (e.g. two different chows): each press moves to the next one, Enter picks it.
  btns[(btns.indexOf(document.activeElement) + 1) % btns.length].focus();
});

// ---------- deal animation ----------

const DEAL_STEP = 140;
function startDeal() {
  const s = state;
  const id = Math.random();
  deal = { id, shown: [0, 0, 0, 0], meBefore: 0 };
  shuffleNext = true;
  handOrder = [];
  // Three rounds of four tiles each, then one each, then the dealer's 14th.
  const steps = [];
  for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) steps.push([(s.dealer + k) % 4, 4]);
  for (let k = 0; k < 4; k++) steps.push([(s.dealer + k) % 4, 1]);
  steps.push([s.dealer, 1]);
  steps.forEach(([seat, n], i) => setTimeout(() => {
    if (!deal || deal.id !== id) return;
    flyTiles(seat, n);
    setTimeout(() => {
      if (!deal || deal.id !== id) return;
      deal.shown[seat] += n;
      if (seat === state.mySeat) Sound.play('draw');
      render();
    }, 260);
  }, 250 + i * DEAL_STEP));
  setTimeout(() => {
    if (!deal || deal.id !== id) return;
    deal = null;
    if (state) render();
  }, 250 + steps.length * DEAL_STEP + 350);
}

// A small stack of face-down tiles slides from the middle of the table to a player.
function flyTiles(seat, n) {
  const rel = (seat - state.mySeat + 4) % 4;
  const seatEl = document.querySelector(`.seat[data-rel="${rel}"]`);
  const f = document.createElement('div');
  f.className = 'fly';
  for (let i = 0; i < n; i++) f.appendChild(tileEl(null, 'bt'));
  seatEl.appendChild(f);
  setTimeout(() => f.remove(), 400);
}

function renderModal() {
  const m = $('modal');
  const s = state;
  if (photo) {
    m.innerHTML = `<div class="box photo-view">
      <img src="${esc(photoSrc(photo))}" alt="" onerror="this.remove()">
      <h2 style="text-align:center;margin:12px 0 0">${FLOWER_CH[photo]} ${esc(tileName(photo))}</h2></div>`;
    m.classList.remove('hidden');
    m.onclick = () => { photo = null; renderModal(); };
    return;
  }
  if (!s || s.phase !== 'ended' || !s.result || celebrating) { m.classList.add('hidden'); return; }
  const r = s.result;
  m.onclick = null;
  let html = '<div class="box">';
  if (r.type === 'draw') html += '<h2>Draw game</h2><p>The wall ran out. The dealer stays.</p>';
  else {
    html += `<h2>🎉 ${esc(nameOf(r.seat))} ${r.seat === s.mySeat ? 'win' : 'wins'}!</h2>
      <p>${r.selfDrawn ? 'Self-drawn' : `On ${esc(nameOf(r.from))}'s discard`} · <b>${r.faan} faan</b></p>
      <div id="winHand"></div>
      <table>${r.items.map(([n, f]) => `<tr><td>${esc(n)}</td><td style="text-align:right">${f}</td></tr>`).join('')}</table>`;
  }
  html += `<h3>Scores</h3><table>${s.players.map((p, i) => {
    const d = r.points ? r.points[i] : 0;
    return `<tr><td>${esc(p.name)}</td><td style="text-align:right">${d > 0 ? '+' : ''}${d || ''}</td><td style="text-align:right"><b>${p.score}</b></td></tr>`;
  }).join('')}</table>
    <button class="primary" id="nextBtn">Next hand</button></div>`;
  m.innerHTML = html;
  if (r.type === 'win') {
    const w = s.players[r.seat];
    const box = m.querySelector('#winHand');
    box.appendChild(row(w.hand, 'sm'));
    if (w.melds.length) box.appendChild(meldsEl(w.melds, 'sm'));
    if (w.flowers.length) box.appendChild(row(w.flowers, 'sm'));
  }
  m.querySelector('#nextBtn').onclick = () => socket.emit('nextHand');
  m.classList.remove('hidden');
}

// ---------- event toasts ----------

function toast(html, ms = 2200) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.innerHTML = html;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

// Shows toasts and plays sounds for new events. Returns true if a sound was played.
function showEvents() {
  let played = false;
  const play = (name) => { Sound.play(name); played = true; };
  for (const e of state.events) {
    if (e.id <= seenEvent) continue;
    seenEvent = e.id;
    if (e.type === 'claim') {
      claimFx(e);
      play(e.kind);
    } else if (e.type === 'newHand') {
      toast(`Hand ${e.handNo} — ${esc(nameOf(e.dealer))} ${e.dealer === state.mySeat ? 'are' : 'is'} dealer`);
      play('shuffle');
      startDeal();
    } else if (e.type === 'flower') {
      play('flower');
    } else if (e.type === 'win') {
      play(e.seat === state.mySeat ? 'win' : 'lose');
      endFx(e);
    } else if (e.type === 'draw') {
      play('lose');
      endFx(e);
    }
  }
  return played;
}

// ---------- big animations: chow / pung / kong bursts and the win celebration ----------

const CLAIM_FX = { chow: ['吃', 'Chow'], pung: ['碰', 'Pung'], kong: ['槓', 'Kong'] };

// Where on screen a player sits: their name plate, or just above my hand for me.
// The burst is pulled a little toward the middle so it never hangs off the edge.
function fxPoint(seat) {
  const rel = (seat - state.mySeat + 4) % 4;
  const W = innerWidth;
  const H = innerHeight;
  let x;
  let y;
  if (rel === 0) {
    const r = $('pos0').getBoundingClientRect();
    x = W / 2;
    y = r.top - 110;
  } else {
    const r = $(`pos${rel}`).getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
    x += (W / 2 - x) * 0.35;
    y += (H / 2 - y) * 0.45;
  }
  return [Math.max(150, Math.min(W - 150, x)), Math.max(130, Math.min(H - 170, y))];
}

function claimFx(e) {
  const [ch, word] = CLAIM_FX[e.kind] || ['!', e.kind];
  const [x, y] = fxPoint(e.seat);
  const fx = document.createElement('div');
  fx.className = `fx-claim k-${e.kind}`;
  fx.style.left = `${x}px`;
  fx.style.top = `${y}px`;
  fx.innerHTML = `<div class="fx-rays"></div><div class="fx-who">${esc(nameOf(e.seat))}</div>
    <div class="fx-badge"><b>${ch}</b><span>${word}!</span></div><div class="fx-tiles"></div>`;
  const tiles = e.tiles || new Array(e.kind === 'kong' ? 4 : 3).fill(null);
  tiles.forEach((t, i) => {
    const el = tileEl(t);
    el.style.animationDelay = `${0.12 + i * 0.08}s`;
    fx.querySelector('.fx-tiles').appendChild(el);
  });
  $('fx').appendChild(fx);
  setTimeout(() => fx.remove(), 2200);
  if (e.kind === 'kong') {
    const sc = $('scene');
    sc.classList.remove('shake');
    void sc.offsetWidth; // restart the animation
    sc.classList.add('shake');
  }
}

// Win (or draw) celebration; the results window opens once it finishes.
function endFx(e) {
  const win = e.type === 'win';
  const mine = win && e.seat === state.mySeat;
  celebrating = true;
  const fx = document.createElement('div');
  fx.className = `fx-end${win ? '' : ' draw'}`;
  const who = win ? `${esc(nameOf(e.seat))} ${mine ? 'win' : 'wins'}` : 'The wall ran out';
  fx.innerHTML = `${win ? '<div class="fx-sun"></div>' : ''}
    <h1>${win ? (e.selfDrawn ? '自摸' : '食糊') : '流局'}</h1>
    <h2>${win ? 'Mahjong!' : 'Draw'}</h2>
    <p>${who}${win && e.selfDrawn ? ' · self-drawn' : ''}</p>`;
  if (mine) {
    const colors = ['#f5c542', '#e74c3c', '#2fa36b', '#2f7fd8', '#e58fc0', '#fff'];
    for (let i = 0; i < 120; i++) {
      const c = document.createElement('i');
      c.className = 'confetti';
      c.style.cssText = `--x:${Math.random() * 100}vw; --c:${colors[i % colors.length]}; --dx:${(Math.random() - 0.5) * 200}px;
        --r:${Math.random() * 1440 - 720}deg; --d:${2 + Math.random() * 1.6}s; --delay:${Math.random() * 0.8}s`;
      fx.appendChild(c);
    }
  }
  $('fx').appendChild(fx);
  const ms = win ? 3200 : 2000;
  setTimeout(() => {
    fx.remove();
    celebrating = false;
    renderModal();
  }, ms);
}
