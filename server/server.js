'use strict';

/**
 * 湖南跑胡子 多人联机服务器（零依赖）
 *
 * 通信方式：
 *   - 客户端动作：POST /api/*（JSON）
 *   - 实时推送：GET /api/stream（Server-Sent Events），每个座位收到个性化视图
 *
 * 房间：6 位房间码；3 个座位；可加机器人；断线自动托管；60 秒超时自动出牌。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const E = require('./engine.js');
const B = require('./bot.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT_START = parseInt(process.env.PORT || '3456', 10);
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const HUMAN_TIMEOUT_MS = parseInt(process.env.HUMAN_TIMEOUT_MS || '60000', 10);
const BOT_DELAY_MIN = parseInt(process.env.BOT_DELAY_MIN || '700', 10);
const BOT_DELAY_MAX = parseInt(process.env.BOT_DELAY_MAX || '1400', 10);
const HU_BOT_DELAY = parseInt(process.env.HU_BOT_DELAY || '120', 10);
const DRAW_REVEAL_MS = parseInt(process.env.DRAW_REVEAL_MS || '5000', 10); // 摸牌展示后的思考时间（5 秒）
const ARRANGE_MS = parseInt(process.env.ARRANGE_MS || '20000', 10); // 开局理牌时间（20 秒）

/* ---------------------------------------------------------------- 房间管理 */

/** @type {Map<string, object>} */
const rooms = new Map();

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function makePid() {
  return crypto.randomBytes(12).toString('hex');
}

function newSeat(seat, pid, name, isBot) {
  return { seat, pid, name, isBot, connected: true, auto: false, lastSeen: Date.now(), order: [] };
}

function createRoom(name, mode = 3) {
  const code = makeCode();
  const seatCount = mode === 4 ? 4 : 3;
  const room = {
    code,
    mode: seatCount,
    status: 'waiting', // waiting | playing
    seats: new Array(seatCount).fill(null),
    state: null,      // 引擎状态（playing 期间）
    chat: [],
    clients: new Map(), // seat -> Set<res>
    createdAt: Date.now(),
    startTimer: null,
  };
  room.seats[0] = newSeat(0, makePid(), name, false);
  rooms.set(code, room);
  return room;
}

function findRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function seatOf(room, pid) {
  return room.seats.findIndex((s) => s && s.pid === pid);
}

function destroyRoom(room) {
  clearTimeout(room.startTimer);
  for (const set of room.clients.values()) {
    for (const res of set) { try { res.end(); } catch { /* noop */ } }
  }
  rooms.delete(room.code);
}

/* ---------------------------------------------------------------- 视图构建 */

function enginePlayer(room, seat) {
  if (room.state && room.state.players[seat]) return room.state.players[seat];
  const s = room.seats[seat];
  return { name: s ? s.name : '', score: 0, melds: [], hand: [] };
}

/**
 * 给某个座位构建个性化视图（隐藏他人手牌）。
 */
function buildView(room, seat) {
  const st = room.state;
  const me = room.seats[seat];
  const view = {
    kind: 'view',
    code: room.code,
    mode: room.mode,
    status: room.status,
    round: st ? st.round : 1,
    dealer: st ? st.dealer : 0,
    turn: st ? st.turn : -1,
    phase: st ? st.phase : 'idle',
    wallCount: st ? st.wall.length : 0,
    discardsCount: st ? st.discards.length : 0,
    discards: st ? st.discards : [], // 打出的牌全部下发（前端全部展示）
    lastDiscard: st ? st.lastDiscard : null,
    lastDiscarder: st ? st.lastDiscarder : null,
    lastDraw: st ? st.lastDraw : null,
    opening: st ? st.opening : false,
    deadline: null,
    players: [],
    you: null,
    over: st ? st.over : null,
    log: st ? st.log.slice(-40) : [],
    chat: room.chat.slice(-40),
    hostSeat: 0,
  };

  for (let s = 0; s < room.seats.length; s++) {
    const seatInfo = room.seats[s];
    if (!seatInfo) {
      view.players.push({ seat: s, empty: true });
      continue;
    }
    const ep = enginePlayer(room, s);
    view.players.push({
      seat: s,
      name: seatInfo.name,
      isBot: seatInfo.isBot,
      connected: seatInfo.connected,
      auto: seatInfo.auto,
      ready: st ? !!st.players[s].ready : !!seatInfo.ready,
      score: ep.score || 0,
      handCount: st ? (s === seat ? ep.hand.length : ep.hand.length) : 0,
      melds: st ? ep.melds : [],
      handBacks: st && s !== seat ? ep.hand.length : 0,
    });
  }

  if (me && st) {
    const ep = st.players[seat];
    const seatInfo = room.seats[seat];
    // 自定义手牌顺序：过滤掉已打出的牌，新摸到的牌追加在末尾
    const hadOrder = Array.isArray(seatInfo.order) && seatInfo.order.length > 0;
    let order = hadOrder ? seatInfo.order.filter((id) => ep.hand.some((c) => c.i === id)) : null;
    let hand;
    if (order) {
      const byId = new Map(ep.hand.map((c) => [c.i, c]));
      for (const c of ep.hand) if (!order.includes(c.i)) order.push(c.i);
      hand = order.map((id) => byId.get(id)).filter(Boolean);
      if (hand.length !== ep.hand.length) order = null;
    }
    if (!order) {
      // 未自定义时默认按字号排序（小字在前、按点数）
      hand = [...ep.hand].sort((a, b) => a.t - b.t || a.n - b.n);
      order = hand.map((c) => c.i);
    }
    seatInfo.order = order;
    view.you = {
      seat,
      hand,
      order,
      melds: ep.melds,
      score: ep.score,
      options: buildOptions(room, seat),
    };
    // 轮到真人操作时给出截止时间；展示期/理牌期/摸牌前显示倒计时
    if (st.phase === 'reveal') {
      if (!me.isBot && !me.auto) view.deadline = Date.now() + DRAW_REVEAL_MS;
    } else if (st.phase === 'arrange') {
      if (!me.isBot && !me.auto) view.deadline = Date.now() + ARRANGE_MS;
    } else if (st.phase === 'pre') {
      if (st.turn === seat && !me.isBot && !me.auto) view.deadline = Date.now() + HUMAN_TIMEOUT_MS;
    } else if (st.phase !== 'over') {
      const acting = st.phase === 'decide'
        ? st.turn === seat
        : (st.window && st.window.eligible.includes(seat));
      if (acting && !me.isBot && !me.auto) {
        view.deadline = Date.now() + HUMAN_TIMEOUT_MS;
      }
    }
  }
  return view;
}

function buildOptions(room, seat) {
  const st = room.state;
  if (!st || st.phase === 'over') return null;
  // 注意：不向客户端下发 canHu / hu 提示——胡牌结果只在点「胡」时由服务器判定，
  // 不符合条件一律按诈胡处理。
  // 不下发任何牌型提示（canWei / canZuhe / 吃碰跑组合一律不提示）：
  // 玩家使用通用按钮自行选牌，由服务器验证，失败即拒绝。
  const o = { canDiscard: [], mustDiscard: false, pass: false };
  if (st.phase === 'decide' && st.turn === seat) {
    o.canDiscard = st.players[seat].hand.map((c) => c.i);
    o.mustDiscard = st.mustDiscard;
  } else if ((st.phase === 'draw' || st.phase === 'react') && st.window) {
    const isDrawer = st.window.kind === 'draw' && seat === st.window.sourceSeat;
    // 摸牌者不提供「保留此牌」按钮：无人要牌时自动留牌继续
    if (!isDrawer && st.window.eligible.includes(seat)) o.pass = true;
  }
  return o;
}

/* ---------------------------------------------------------------- SSE 广播 */

function sendToSeat(room, seat, payload) {
  const set = room.clients.get(seat);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { /* noop */ }
  }
}

function broadcast(room) {
  for (let s = 0; s < room.seats.length; s++) {
    if (room.seats[s]) sendToSeat(room, s, buildView(room, s));
  }
}

function broadcastChat(room, from, text) {
  const payload = { kind: 'chat', from, text, t: Date.now() };
  for (let s = 0; s < room.seats.length; s++) {
    if (room.seats[s]) sendToSeat(room, s, payload);
  }
}

/* ---------------------------------------------------------------- 对局流程 */

function enginePlayersOf(room) {
  const players = [];
  for (let s = 0; s < room.seats.length; s++) {
    const seatInfo = room.seats[s];
    const prev = room.state && room.state.players[s];
    players.push({
      id: seatInfo.pid,
      name: seatInfo.name,
      isBot: seatInfo.isBot,
      score: prev && prev.id === seatInfo.pid ? prev.score : 0,
    });
  }
  return players;
}

function startRound(room) {
  if (room.status === 'playing') return;
  const seatsFilled = room.seats.every(Boolean);
  if (!seatsFilled) return;
  if (room.state && room.state.phase !== 'over') return;
  if (room.state === null) {
    room.state = E.createGame(enginePlayersOf(room));
  } else {
    E.startNextRound(room.state);
  }
  // 新一局重置自定义手牌顺序
  for (const s of room.seats) if (s) s.order = [];
  room.status = 'playing';
  broadcast(room);
  scheduleActors(room);
}

function applyAndBroadcast(room, seat, action) {
  const r = E.applyAction(room.state, seat, action);
  if (!r.ok) return r;
  if (r.zhaHu) {
    // 诈胡：只广播（分数与日志变化），不改变对局节奏，也不重新调度超时
    broadcast(room);
    return r;
  }
  if (room.state.phase === 'over') {
    room.status = 'waiting';
  }
  broadcast(room);
  scheduleActors(room);
  return r;
}

/* ---------------------------------------------------------------- 机器人 / 超时 */

function roomTickGuard(room) {
  const tick = room.state ? room.state.tick : 0;
  return () => room.state && room.state.tick === tick && room.status === 'playing';
}

function scheduleActors(room) {
  const st = room.state;
  if (!st || st.phase === 'over') return;
  const guard = roomTickGuard(room);

  if (st.phase === 'pre') {
    // 摸牌前阶段：可煨（跳过摸牌）或摸牌
    const seat = st.turn;
    const info = room.seats[seat];
    if (!info) return;
    if (info.isBot || info.auto) {
      const delay = BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN);
      setTimeout(() => {
        if (!guard() || st.phase !== 'pre' || st.turn !== seat) return;
        const act = B.preAction(st, seat);
        const r = E.applyAction(st, seat, act);
        if (!r.ok) return;
        if (st.phase === 'over') room.status = 'waiting';
        broadcast(room);
        scheduleActors(room);
      }, delay);
    } else {
      // 真人：超时自动处理（能煨则煨，否则摸牌）
      setTimeout(() => {
        if (!guard() || st.phase !== 'pre' || st.turn !== seat) return;
        const act = B.preAction(st, seat);
        const r = E.applyAction(st, seat, act);
        if (!r.ok) return;
        if (st.phase === 'over') room.status = 'waiting';
        broadcast(room);
        scheduleActors(room);
      }, HUMAN_TIMEOUT_MS + 2000);
    }
    return;
  }

  if (st.phase === 'arrange') {
    // 开局理牌时间（全机器人/托管时立即跳过）
    const anyHuman = room.seats.some((s) => s && !s.isBot && s.connected && !s.auto);
    const delay = anyHuman ? ARRANGE_MS : 0;
    setTimeout(() => {
      if (!guard() || st.phase !== 'arrange') return;
      E.beginRound(st);
      if (st.phase === 'over') room.status = 'waiting';
      broadcast(room);
      scheduleActors(room);
    }, delay);
    return;
  }

  if (st.phase === 'reveal') {
    // 摸牌展示期：留思考时间（全机器人/托管时立即跳过）
    const anyHuman = room.seats.some((s) => s && !s.isBot && s.connected && !s.auto);
    const delay = anyHuman ? DRAW_REVEAL_MS : 0;
    setTimeout(() => {
      if (!guard() || st.phase !== 'reveal') return;
      E.openDrawWindow(st);
      if (st.phase === 'over') room.status = 'waiting';
      broadcast(room);
      scheduleActors(room);
    }, delay);
    return;
  }

  if (st.phase === 'decide') {
    const seat = st.turn;
    const info = room.seats[seat];
    if (!info) return;
    if (info.isBot || info.auto) {
      const delay = BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN);
      setTimeout(() => {
        if (!guard() || st.phase !== 'decide' || st.turn !== seat) return;
        const act = B.decideAction(st, seat);
        const r = E.applyAction(st, seat, act);
        if (!r.ok) return;
        if (st.phase === 'over') room.status = 'waiting';
        broadcast(room);
        scheduleActors(room);
      }, delay);
    } else {
      // 真人：60 秒超时自动操作（严格校验仍是该座位回合，避免过期定时器乱动）
      setTimeout(() => {
        if (!guard() || st.phase !== 'decide' || st.turn !== seat) return;
        const act = B.decideAction(st, seat);
        const r = E.applyAction(st, seat, act);
        if (!r.ok) return;
        if (st.phase === 'over') room.status = 'waiting';
        broadcast(room);
        scheduleActors(room);
      }, HUMAN_TIMEOUT_MS + 2000);
    }
  } else if ((st.phase === 'react' || st.phase === 'draw') && st.window) {
    const w = st.window;
    const eligible = [...w.eligible];
    for (const seat of eligible) {
      const info = room.seats[seat];
      if (!info) continue;
      if (info.isBot || info.auto) {
        const ro = E.windowOptions(st, seat);
        const delay = ro && ro.hu ? HU_BOT_DELAY : BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN);
        setTimeout(() => {
          if (!guard() || st.window !== w) return;
          if ((st.phase !== 'react' && st.phase !== 'draw') || !w.eligible.includes(seat)) return;
          const act = B.reactAction(st, seat);
          const r = E.applyAction(st, seat, act);
          if (!r.ok) return;
          if (st.phase === 'over') room.status = 'waiting';
          broadcast(room);
          scheduleActors(room);
        }, delay);
      } else {
        setTimeout(() => {
          if (!guard() || st.window !== w) return;
          if ((st.phase !== 'react' && st.phase !== 'draw') || !w.eligible.includes(seat)) return;
          const r = E.applyAction(st, seat, { type: 'pass' });
          if (!r.ok) return;
          if (st.phase === 'over') room.status = 'waiting';
          broadcast(room);
          scheduleActors(room);
        }, HUMAN_TIMEOUT_MS + 2000);
      }
    }
  }
}

/* ---------------------------------------------------------------- 静态文件 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ---------------------------------------------------------------- HTTP 接口 */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) { reject(new Error('请求过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('无效 JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim();
  return (s || '玩家').slice(0, 12);
}

async function handleApi(req, res, url) {
  const seg = url.split('?')[0].split('/').filter(Boolean); // ['api', 'xxx']
  const endpoint = seg[1] || '';

  if (endpoint === 'stream') {
    const params = new URLSearchParams(url.split('?')[1] || '');
    const room = findRoom(params.get('code'));
    const pid = params.get('pid');
    if (!room || !pid) { sendJson(res, 400, { error: '房间不存在' }); return; }
    const seat = seatOf(room, pid);
    if (seat < 0) { sendJson(res, 400, { error: '座位不存在，请重新加入' }); return; }
    const info = room.seats[seat];
    info.connected = true;
    info.lastSeen = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(buildView(room, seat))}\n\n`);

    if (!room.clients.has(seat)) room.clients.set(seat, new Set());
    room.clients.get(seat).add(res);

    const heartbeat = setInterval(() => {
      try { res.write(':hb\n\n'); } catch { /* noop */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const set = room.clients.get(seat);
      if (set) set.delete(res);
      const stillConnected = set && set.size > 0;
      if (!stillConnected) {
        info.connected = false;
        if (room.status === 'playing' && !info.isBot) info.auto = true; // 掉线托管
        broadcast(room);
      }
    });
    return;
  }

  // 其余均为 POST JSON
  if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }); return; }
  let body;
  try { body = await readBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }

  switch (endpoint) {
    case 'create': {
      const name = cleanName(body.name);
      const mode = Number(body.mode) === 4 ? 4 : 3;
      const room = createRoom(name, mode);
      sendJson(res, 200, { code: room.code, pid: room.seats[0].pid, seat: 0, mode: room.mode });
      break;
    }
    case 'join': {
      const room = findRoom(body.code);
      if (!room) { sendJson(res, 400, { error: '房间不存在' }); return; }
      if (room.status === 'playing') { sendJson(res, 400, { error: '对局进行中，暂时无法加入' }); return; }
      const free = room.seats.findIndex((s) => !s);
      if (free < 0) { sendJson(res, 400, { error: `房间已满（${room.seats.length} 人）` }); return; }
      const pid = makePid();
      room.seats[free] = newSeat(free, pid, cleanName(body.name), false);
      broadcast(room);
      sendJson(res, 200, { code: room.code, pid, seat: free });
      break;
    }
    case 'resume': {
      const room = findRoom(body.code);
      if (!room) { sendJson(res, 400, { error: '房间不存在' }); return; }
      const seat = seatOf(room, body.pid);
      if (seat < 0) { sendJson(res, 400, { error: '座位不存在' }); return; }
      room.seats[seat].connected = true;
      room.seats[seat].lastSeen = Date.now();
      broadcast(room);
      sendJson(res, 200, { seat });
      break;
    }
    case 'ready': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0) { sendJson(res, 400, { error: '房间不存在' }); return; }
      if (room.status !== 'waiting') { sendJson(res, 400, { error: '当前不能准备' }); return; }
      room.seats[seat].ready = !!body.ready;
      if (room.state) room.state.players[seat].ready = !!body.ready;
      broadcast(room);
      maybeAutoStart(room);
      sendJson(res, 200, { ok: true });
      break;
    }
    case 'addbot': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0 || seat !== 0) { sendJson(res, 400, { error: '只有房主可以操作' }); return; }
      if (room.status !== 'waiting') { sendJson(res, 400, { error: '对局中不能添加机器人' }); return; }
      const free = room.seats.findIndex((s) => !s);
      if (free < 0) { sendJson(res, 400, { error: '房间已满' }); return; }
      room.seats[free] = newSeat(free, makePid(), `机器人${free + 1}`, true);
      room.seats[free].ready = true;
      if (room.state) room.state.players[free].ready = true;
      broadcast(room);
      maybeAutoStart(room);
      sendJson(res, 200, { ok: true });
      break;
    }
    case 'remove': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0 || seat !== 0) { sendJson(res, 400, { error: '只有房主可以操作' }); return; }
      if (room.status !== 'waiting') { sendJson(res, 400, { error: '对局中不能移除' }); return; }
      const target = Number(body.seat);
      if (!Number.isInteger(target) || target < 1 || target >= room.seats.length || !room.seats[target]) {
        sendJson(res, 400, { error: '无效座位' });
        return;
      }
      if (room.seats[target].connected) {
        sendJson(res, 400, { error: '该玩家在线，无法移除' });
        return;
      }
      room.seats[target] = null;
      broadcast(room);
      sendJson(res, 200, { ok: true });
      break;
    }
    case 'leave': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0) { sendJson(res, 200, { ok: true }); return; }
      if (room.status === 'waiting') {
        room.seats[seat] = null;
        broadcast(room);
      } else {
        room.seats[seat].connected = false;
        room.seats[seat].auto = true;
        broadcast(room);
        scheduleActors(room);
      }
      sendJson(res, 200, { ok: true });
      break;
    }
    case 'auto': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0) { sendJson(res, 400, { error: '房间不存在' }); return; }
      room.seats[seat].auto = !!body.on;
      broadcast(room);
      scheduleActors(room);
      sendJson(res, 200, { ok: true });
      break;
    }
    case 'chat': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0) { sendJson(res, 400, { error: '房间不存在' }); return; }
      const text = String(body.text || '').slice(0, 200).trim();
      if (!text) { sendJson(res, 400, { error: '内容为空' }); return; }
      room.chat.push({ from: room.seats[seat].name, text, t: Date.now() });
      if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
      broadcastChat(room, room.seats[seat].name, text);
      sendJson(res, 200, { ok: true });
      break;
    }
    case 'action': {
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0) { sendJson(res, 400, { error: '房间不存在' }); return; }
      if (!room.state || room.status !== 'playing') { sendJson(res, 400, { error: '对局未开始' }); return; }
      const info = room.seats[seat];
      if (info.isBot) { sendJson(res, 400, { error: '机器人由系统操作' }); return; }
      info.auto = false;
      info.lastSeen = Date.now();

      // 手牌排序：拖牌插位（纯展示顺序，任意时刻可用）
      const action = body.action || {};
      if (action.type === 'order') {
        const ep = room.state.players[seat];
        const ids = Array.isArray(action.ids) ? action.ids : null;
        const handSet = new Set(ep.hand.map((c) => c.i));
        const valid = ids
          && ids.length === ep.hand.length
          && new Set(ids).size === ids.length
          && ids.every((id) => handSet.has(id));
        if (!valid) { sendJson(res, 400, { error: '排序无效' }); return; }
        info.order = ids.slice();
        broadcast(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      const r = applyAndBroadcast(room, seat, action);
      if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
      sendJson(res, 200, { ok: true, ...(r.zhaHu ? { zhaHu: true, penalty: E.FAKE_HU_PENALTY } : {}) });
      break;
    }
    case 'view': {
      // 调试/测试用：返回快照
      const room = findRoom(body.code);
      const seat = room && seatOf(room, body.pid);
      if (!room || seat < 0) { sendJson(res, 400, { error: '房间不存在' }); return; }
      sendJson(res, 200, buildView(room, seat));
      break;
    }
    default:
      sendJson(res, 404, { error: '未知接口' });
  }
}

function maybeAutoStart(room) {
  if (room.status !== 'waiting') return;
  if (!room.seats.every(Boolean)) return;
  const allReady = room.seats.every((s) => s.ready);
  if (!allReady) return;
  if (room.state && room.state.phase !== 'over') return;
  if (room.startTimer) return;
  room.startTimer = setTimeout(() => {
    room.startTimer = null;
    if (room.status !== 'waiting') return;
    if (!room.seats.every(Boolean) || !room.seats.every((s) => s.ready)) return;
    startRound(room);
  }, 1200);
}

/* ---------------------------------------------------------------- 服务器入口 */

const requestHandler = (req, res) => {
  const url = req.url || '/';
  try {
    if (url.startsWith('/api/')) {
      handleApi(req, res, url).catch(() => {
        try { sendJson(res, 500, { error: '服务器错误' }); } catch { /* noop */ }
      });
    } else {
      serveStatic(req, res);
    }
  } catch {
    try { sendJson(res, 500, { error: '服务器错误' }); } catch { /* noop */ }
  }
};

// 清理：无人连接 30 分钟以上的房间
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyConnected = room.seats.some((s) => s && s.connected);
    if (!anyConnected && now - room.createdAt > 30 * 60 * 1000) destroyRoom(room);
  }
}, 60 * 1000).unref();

function printInfo(port) {
  const lan = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │        湖南跑胡子 · 多人联机版               │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  本机访问:  http://127.0.0.1:${port}`);
  for (const ip of lan) console.log(`  局域网访问: http://${ip}:${port}  （发给同网络的朋友）`);
  console.log('  按 Ctrl+C 停止服务器');
  console.log('');
}

let activeServer = null;

function listenOn(port, attemptsLeft, onReady) {
  const s = http.createServer(requestHandler);
  s.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} ...`);
      listenOn(port + 1, attemptsLeft - 1, onReady);
    } else {
      console.error('服务器启动失败：', err.message);
      process.exit(1);
    }
  });
  s.listen(port, '0.0.0.0', () => {
    activeServer = s;
    printInfo(port);
    if (onReady) onReady(port, s);
  });
}

if (require.main === module) {
  listenOn(PORT_START, 20);
}

module.exports = { rooms, buildView, applyAndBroadcast, startRound, listenOn, requestHandler };
