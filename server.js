const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game/engine');
const config = require('./config');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// This computer's address on the local network, so the share link works from other devices.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
app.get('/lan', (req, res) => {
  const ip = lanAddress();
  res.json({ url: ip ? `http://${ip}:${config.PORT}` : null });
});
const server = http.createServer(app);
const io = new Server(server);

// Invite-only: when ACCESS_KEY is set, only links containing ?key=<ACCESS_KEY> can connect to games.
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
io.use((socket, next) => {
  if (!ACCESS_KEY || crypto.timingSafeEqual(digest(socket.handshake.auth.key || ''), digest(ACCESS_KEY))) return next();
  next(new Error('invite-only'));
});

// code -> { code, members: [{ token, name, socketId, connected, seat }], game, lastActive }
const rooms = new Map();

function cleanCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const m of room.members) {
    if (!m.socketId) continue;
    if (room.game) io.to(m.socketId).emit('state', room.game.viewFor(m.seat));
    else io.to(m.socketId).emit('lobby', { code: room.code, members: room.members.map((x) => ({ name: x.name, connected: x.connected })) });
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame(room) {
  if (room.game) return;
  const seats = shuffle([0, 1, 2, 3]);
  const botNames = shuffle(config.BOT_NAMES.slice());
  const players = new Array(4);
  room.members.forEach((m, i) => {
    m.seat = seats[i];
    players[m.seat] = { name: m.name, isBot: false, connected: m.connected };
  });
  for (let s = 0; s < 4; s++) if (!players[s]) players[s] = { name: botNames.pop(), isBot: true, connected: true };
  room.game = new Game(players, { onChange: () => broadcast(room) });
  room.game.startHand();
}

io.on('connection', (socket) => {
  const member = () => {
    const room = rooms.get(socket.data.code);
    return room && { room, m: room.members.find((x) => x.token === socket.data.token) };
  };

  socket.on('join', ({ room: code, name, token } = {}) => {
    code = cleanCode(code);
    name = String(name || '').trim().slice(0, 20);
    token = String(token || '').slice(0, 64);
    if (!code || !name || !token) return socket.emit('errorMsg', 'Please enter a name and a room code.');

    let room = rooms.get(code);
    if (!room) {
      room = { code, members: [], game: null, lastActive: Date.now() };
      rooms.set(code, room);
    }
    let m = room.members.find((x) => x.token === token);
    if (!m) {
      if (room.game) return socket.emit('errorMsg', 'That room already has a game in progress.');
      if (room.members.length >= 4) return socket.emit('errorMsg', 'That room is full.');
      m = { token, name, seat: null };
      room.members.push(m);
    }
    if (!room.game) m.name = name;
    m.socketId = socket.id;
    m.connected = true;
    socket.data = { code, token };
    if (room.game) room.game.setConnected(m.seat, true);
    else broadcast(room);
  });

  socket.on('start', () => {
    const x = member();
    if (x && !x.room.game) startGame(x.room);
  });

  socket.on('action', (action) => {
    const x = member();
    if (!x || !x.room.game || !x.m) return;
    try {
      x.room.game.act(x.m.seat, action);
    } catch (err) {
      console.error('action failed', err);
    }
  });

  socket.on('nextHand', () => {
    const x = member();
    if (x && x.room.game) x.room.game.nextHand();
  });

  socket.on('disconnect', () => {
    const x = member();
    if (!x || !x.m || x.m.socketId !== socket.id) return;
    x.m.connected = false;
    x.m.socketId = null;
    if (x.room.game) x.room.game.setConnected(x.m.seat, false);
    else broadcast(x.room);
  });
});

// Forget rooms nobody has touched for 12 hours.
setInterval(() => {
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActive < cutoff && room.members.every((m) => !m.connected)) rooms.delete(code);
  }
}, 3600 * 1000);

server.listen(config.PORT, () => {
  console.log(`Mahjong server running at http://localhost:${config.PORT}`);
  const ip = lanAddress();
  if (ACCESS_KEY) console.log('Invite-only: links need ?key=<your ACCESS_KEY>');
  if (ip) console.log(`Friends on the same Wi-Fi can join at http://${ip}:${config.PORT}`);
});
