'use strict';

/* ================================================================
 * 湖南跑胡子 · 前端逻辑
 * 通过 SSE 接收个性化视图，通过 POST 提交动作。
 * ================================================================ */

const SMALL_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const BIG_CHARS = ['壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];

const $ = (id) => document.getElementById(id);

const S = {
  code: null,
  pid: null,
  name: '',
  view: null,
  mySeat: 0,
  selected: null,
  picked: [],      // 组合/吃/煨 选牌
  pickMode: null,  // null | 'wei' | 'zuhe' | 'chi'
  overShownKey: null,
  stream: null,
};

/* ---------------- 工具 ---------------- */

function cardChar(c) { return c.t ? BIG_CHARS[c.n - 1] : SMALL_CHARS[c.n - 1]; }
function isRed(c) { return c.n === 2 || c.n === 7 || c.n === 10; }
function isRedN(n) { return n === 2 || n === 7 || n === 10; }
function sortHand(hand) { return [...hand].sort((a, b) => a.t - b.t || a.n - b.n); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- 胡数（与服务器规则一致的估算值） ---------------- */

function trioValueN(t, n) {
  // 碰：小字 1 胡（红黑同），大字 3 胡（红黑同）
  return t === 1 ? 3 : 1;
}

function meldValueOf(m) {
  // 一句话：仅一二三/二七十（小 1）与壹贰叁/贰柒拾（大 3）有胡息，其余无；煨：小 3 / 大 6；跑/提：小 6 / 大 12；对子 0
  if (m.kind === 'seq') {
    const ns = m.cards.map((c) => c.n).sort((a, b) => a - b);
    const special = (ns[0] === 1 && ns[1] === 2 && ns[2] === 3) || (ns[0] === 2 && ns[1] === 7 && ns[2] === 10);
    if (!special) return 0;
    const small = m.cards.every((c) => c.t === 0);
    const big = m.cards.every((c) => c.t === 1);
    if (small) return 1;
    if (big) return 3;
    return 0;
  }
  if (m.kind === 'peng') return trioValueN(m.cards[0].t, m.cards[0].n);
  if (m.kind === 'wei') return m.cards[0].t === 1 ? 6 : 3;
  return m.cards[0].t === 1 ? 12 : 6; // 跑 / 提
}

/**
 * 当前胡数：桌上面子的胡数 + 手牌按「先坎后句」贪心拆出的面子胡数。
 * 仅作参考显示，不提示能否胡牌（能否胡由服务器点「胡」时判定）。
 */
function currentHuValue(hand, melds) {
  let v = 0;
  for (const m of melds) v += meldValueOf(m);
  const cnt = new Map();
  for (const c of hand) {
    const k = (c.t ? 'B' : 'S') + c.n;
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 10; n++) {
      const k = (t ? 'B' : 'S') + n;
      while ((cnt.get(k) || 0) >= 3) {
        cnt.set(k, cnt.get(k) - 3);
        v += trioValueN(t, n);
      }
    }
  }
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 8; n++) {
      const a = (t ? 'B' : 'S') + n;
      const b = (t ? 'B' : 'S') + (n + 1);
      const c = (t ? 'B' : 'S') + (n + 2);
      while ((cnt.get(a) || 0) > 0 && (cnt.get(b) || 0) > 0 && (cnt.get(c) || 0) > 0) {
        cnt.set(a, cnt.get(a) - 1);
        cnt.set(b, cnt.get(b) - 1);
        cnt.set(c, cnt.get(c) - 1);
        // 仅一二三（n=1）有胡息
        if (n === 1) v += t === 1 ? 3 : 1;
      }
    }
    // 二七十（贰柒拾）与一二三同规则（1 / 3 胡）
    const a = (t ? 'B' : 'S') + 2;
    const b = (t ? 'B' : 'S') + 7;
    const c = (t ? 'B' : 'S') + 10;
    while ((cnt.get(a) || 0) > 0 && (cnt.get(b) || 0) > 0 && (cnt.get(c) || 0) > 0) {
      cnt.set(a, cnt.get(a) - 1);
      cnt.set(b, cnt.get(b) - 1);
      cnt.set(c, cnt.get(c) - 1);
      v += t === 1 ? 3 : 1;
    }
  }
  // 同数混搭一句话：无胡息
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 10; n++) {
      const ks = (t ? 'B' : 'S') + n;
      const ko = (1 - t ? 'B' : 'S') + n;
      while ((cnt.get(ks) || 0) >= 2 && (cnt.get(ko) || 0) >= 1) {
        cnt.set(ks, cnt.get(ks) - 2);
        cnt.set(ko, cnt.get(ko) - 1);
        // 无胡息
      }
      while ((cnt.get(ks) || 0) >= 1 && (cnt.get(ko) || 0) >= 2) {
        cnt.set(ks, cnt.get(ks) - 1);
        cnt.set(ko, cnt.get(ko) - 2);
        // 无胡息
      }
    }
  }
  return v;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(path, body) {
  const res = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function sendAction(action) {
  const { status, json } = await api('action', { code: S.code, pid: S.pid, action });
  if (status !== 200) {
    toast(json.error || '操作失败');
    await refreshView();
    return false;
  }
  return true;
}

async function refreshView() {
  const { status, json } = await api('view', { code: S.code, pid: S.pid });
  if (status === 200) handleView(json);
}

/* ---------------- 屏幕切换 ---------------- */

function showScreen(name) {
  for (const id of ['screen-lobby', 'screen-room', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== name);
  }
}

/* ---------------- 大厅 ---------------- */

function initLobby() {
  $('name-input').value = localStorage.getItem('pzh-name') || '';
  $('btn-create').onclick = async () => {
    const name = $('name-input').value.trim() || '玩家';
    localStorage.setItem('pzh-name', name);
    const modeEl = document.querySelector('input[name="mode"]:checked');
    const mode = modeEl ? parseInt(modeEl.value, 10) : 3;
    const { status, json } = await api('create', { name, mode });
    if (status !== 200) { toast(json.error || '创建失败'); return; }
    enterRoom(json.code, json.pid, name);
  };
  $('btn-join').onclick = async () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length < 4) { toast('请输入房间码'); return; }
    const name = $('name-input').value.trim() || '玩家';
    localStorage.setItem('pzh-name', name);
    const { status, json } = await api('join', { code, name });
    if (status !== 200) { toast(json.error || '加入失败'); return; }
    enterRoom(json.code, json.pid, name);
  };
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });
  $('btn-rules').onclick = () => $('rules-modal').classList.remove('hidden');
}

function enterRoom(code, pid, name) {
  S.code = code;
  S.pid = pid;
  S.name = name;
  S.overShownKey = null;
  sessionStorage.setItem('pzh-session', JSON.stringify({ code, pid, name }));
  connectStream();
  showScreen('screen-room');
}

/* ---------------- SSE 连接 ---------------- */

function connectStream() {
  if (S.stream) S.stream.close();
  S.stream = new EventSource(`/api/stream?code=${encodeURIComponent(S.code)}&pid=${encodeURIComponent(S.pid)}`);
  S.stream.onopen = () => $('conn-lost').classList.add('hidden');
  S.stream.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.kind === 'view') handleView(msg);
      else if (msg.kind === 'chat') appendChat(msg);
    } catch { /* 忽略坏帧 */ }
  };
  S.stream.onerror = () => $('conn-lost').classList.remove('hidden');
}

function appendChat(msg) {
  const list = $('chat-list');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const b = document.createElement('b');
  b.textContent = msg.from + '：';
  div.appendChild(b);
  div.appendChild(document.createTextNode(msg.text));
  const t = document.createElement('span');
  t.className = 't';
  const d = new Date(msg.t);
  t.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  div.appendChild(t);
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

/* ---------------- 视图处理 ---------------- */

function handleView(v) {
  const wasOver = S.view && S.view.over;
  S.view = v;

  if (v.status === 'playing' && v.you) {
    showScreen('screen-game');
    renderGame(v);
  } else {
    showScreen('screen-room');
    renderRoom(v);
    if (v.over && !wasOver) maybeShowResult(v);
  }
}

/* ---------------- 房间渲染 ---------------- */

function renderRoom(v) {
  $('room-code').textContent = v.code;
  $('room-mode').textContent = v.mode + ' 人局';
  const me = v.players.find((p) => p.seat === (S.view.you ? S.view.you.seat : S.mySeat)) || v.players[0];
  if (me && me.seat !== undefined) S.mySeat = me.seat;
  const isHost = S.mySeat === 0;

  const slots = $('room-slots');
  slots.innerHTML = '';
  for (let s = 0; s < v.players.length; s++) {
    const p = v.players[s];
    const div = document.createElement('div');
    if (p && p.empty) {
      div.className = 'slot empty';
      div.textContent = '等待加入…';
      if (isHost && v.status === 'waiting') {
        const btn = document.createElement('button');
        btn.className = 'mini';
        btn.textContent = '🤖 加机器人';
        btn.onclick = async () => {
          const r = await api('addbot', { code: S.code, pid: S.pid });
          if (r.status !== 200) toast(r.json.error || '添加失败');
        };
        div.appendChild(document.createElement('br'));
        div.appendChild(btn);
      }
      slots.appendChild(div);
      continue;
    }
    div.className = 'slot';
    const head = document.createElement('div');
    head.className = 's-name';
    head.appendChild(document.createTextNode(p.name));
    if (s === 0) {
      const b = document.createElement('span');
      b.className = 'badge host';
      b.textContent = '房主';
      head.appendChild(b);
    }
    if (p.isBot) {
      const b = document.createElement('span');
      b.className = 'badge bot';
      b.textContent = '机器人';
      head.appendChild(b);
    }
    if (!p.connected) {
      const b = document.createElement('span');
      b.className = 'badge offline';
      b.textContent = '离线';
      head.appendChild(b);
    }
    if (p.auto) {
      const b = document.createElement('span');
      b.className = 'badge auto';
      b.textContent = '托管中';
      head.appendChild(b);
    }
    if (s === S.mySeat) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.style.background = '#d5f0dd';
      b.style.color = '#1e6b3a';
      b.textContent = '我';
      head.appendChild(b);
    }
    const score = document.createElement('span');
    score.className = 's-score';
    score.textContent = `分数 ${p.score}`;
    div.appendChild(score);
    div.appendChild(head);

    const st = document.createElement('div');
    st.className = 's-status';
    if (v.status === 'waiting') st.textContent = p.ready ? '✅ 已准备' : '⏳ 未准备';
    div.appendChild(st);

    const actions = document.createElement('div');
    actions.className = 's-actions';
    if (s === S.mySeat && v.status === 'waiting') {
      const btn = document.createElement('button');
      btn.className = p.ready ? 'ghost' : 'primary';
      btn.textContent = p.ready ? '取消准备' : '准备';
      btn.onclick = () => api('ready', { code: S.code, pid: S.pid, ready: !p.ready });
      actions.appendChild(btn);
    }
    if (isHost && s !== 0 && v.status === 'waiting') {
      const removable = !p.connected || p.isBot;
      const btn = document.createElement('button');
      btn.className = 'ghost mini';
      btn.textContent = '移除';
      btn.disabled = !removable;
      btn.title = removable ? '' : '在线玩家无法移除';
      btn.onclick = async () => {
        const r = await api('remove', { code: S.code, pid: S.pid, seat: s });
        if (r.status !== 200) toast(r.json.error || '移除失败');
      };
      actions.appendChild(btn);
    }
    div.appendChild(actions);
    slots.appendChild(div);
  }

  const filled = v.players.filter((p) => !p.empty).length;
  const readyCount = v.players.filter((p) => !p.empty && p.ready).length;
  const tip = $('room-tip');
  if (filled < v.players.length) tip.textContent = `等待玩家加入（${filled}/${v.players.length}），房主可添加机器人`;
  else if (readyCount < v.players.length) tip.textContent = `等待准备（${readyCount}/${v.players.length}），全部准备后自动开局`;
  else tip.textContent = '即将自动开局…';

  const isBot = v.players[S.mySeat] && v.players[S.mySeat].isBot;
  $('btn-addbot').style.display = isHost ? '' : 'none';
}

/* ---------------- 牌桌渲染 ---------------- */

function meldGroupEl(m, size) {
  const g = document.createElement('div');
  g.className = 'meld-group';
  const badge = document.createElement('span');
  badge.className = 'meld-badge';
  badge.textContent = ({ peng: '碰', wei: '煨', pao: '跑', ti: '提', seq: '吃' })[m.kind] || '';
  g.appendChild(badge);
  const sorted = [...m.cards].sort((a, b) => a.t - b.t || a.n - b.n);
  for (const c of sorted) g.appendChild(cardEl(c, { size }));
  return g;
}

function cardEl(c, opts = {}) {
  const size = opts.size === 'mini' ? 'mini' : opts.size === 'tiny' ? 'tiny' : '';
  const div = document.createElement('div');
  div.className = `card ${c.t ? 'big' : 'small'} ${isRed(c) ? 'red' : 'black'} ${size}${opts.back ? ' back' : ''}`;
  div.dataset.i = c.i;
  if (!opts.back) div.textContent = cardChar(c);
  return div;
}

function renderOpponent(el, p, v, active, dealer) {
  el.innerHTML = '';
  el.className = 'opponent' + (active ? ' active' : '');
  const head = document.createElement('div');
  head.className = 'opp-head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = p.name;
  head.appendChild(name);
  if (dealer) {
    const d = document.createElement('span');
    d.className = 'dealer-dot';
    d.textContent = '庄';
    head.appendChild(d);
  }
  if (p.isBot) {
    const b = document.createElement('span');
    b.className = 'badge bot';
    b.textContent = '🤖';
    head.appendChild(b);
  }
  if (!p.connected) {
    const b = document.createElement('span');
    b.className = 'badge offline';
    b.textContent = '离线';
    head.appendChild(b);
  }
  if (p.auto && p.connected) {
    const b = document.createElement('span');
    b.className = 'badge auto';
    b.textContent = '托管';
    head.appendChild(b);
  }
  const score = document.createElement('span');
  score.className = 'score';
  score.textContent = `${p.score} 分`;
  head.appendChild(score);
  el.appendChild(head);

  const melds = document.createElement('div');
  melds.className = 'opp-melds';
  for (const m of p.melds) melds.appendChild(meldGroupEl(m, 'tiny'));
  el.appendChild(melds);

  const backs = document.createElement('div');
  backs.className = 'opp-backs';
  const show = Math.min(p.handBacks, 14);
  for (let i = 0; i < show; i++) {
    backs.appendChild(cardEl({ t: 0, n: 1 }, { size: 'tiny', back: true }));
  }
  if (p.handBacks > show) {
    const more = document.createElement('span');
    more.textContent = `+${p.handBacks - show}`;
    backs.appendChild(more);
  }
  el.appendChild(backs);
}

function renderGame(v) {
  const me = v.you;
  S.mySeat = me.seat;
  S.selected = null;

  $('g-round').textContent = v.round;
  $('g-wall').textContent = v.wallCount;
  $('g-huval').textContent = currentHuValue(me.hand, me.melds);

  const dealerName = v.players[v.dealer] ? v.players[v.dealer].name : '';
  const info = $('g-turn-info');
  if (v.phase === 'over') {
    info.textContent = v.over && v.over.reason === 'hu' ? '🎉 本局结束' : '荒庄流局';
  } else if (v.phase === 'arrange') {
    info.textContent = '🃏 理牌时间：可拖动整理手牌，倒计时结束后庄家开局';
  } else if (v.phase === 'pre') {
    const cur = v.players[v.turn];
    info.textContent = myTurn ? '轮到你：可煨牌或摸牌' : `轮到 ${cur.name}（可煨牌或摸牌）…`;
  } else if (v.phase === 'decide') {
    const name = v.players[v.turn].name;
    info.textContent = v.turn === me.seat ? '⭐ 轮到你出牌' : `轮到 ${name} 出牌`;
  } else if (v.phase === 'draw' || v.phase === 'reveal') {
    const name = v.players[v.lastDraw.seat].name;
    info.textContent = v.lastDraw.seat === me.seat
      ? `你摸到「${cardChar(v.lastDraw.card)}」，思考中…`
      : `${name} 摸到「${cardChar(v.lastDraw.card)}」，思考中…`;
  } else if (v.phase === 'react') {
    const name = v.players[v.lastDiscarder].name;
    info.textContent = `${name} 打出「${cardChar(v.lastDiscard)}」，等待响应…`;
  }

  // 对手布局：左 = 下家；4 人局时上方 = 对家，右 = 上家；3 人局右 = 上家
  const n = v.players.length;
  const oppTopRow = $('opp-top-row');
  if (n === 4) {
    oppTopRow.classList.remove('hidden');
    const topSeat = (me.seat + 2) % 4;
    renderOpponent(
      $('opp-top'), v.players[topSeat], v,
      v.turn === topSeat && v.phase !== 'over',
      v.dealer === topSeat
    );
  } else {
    oppTopRow.classList.add('hidden');
  }
  const leftSeat = (me.seat + 1) % n;
  const rightSeat = (me.seat + n - 1) % n;
  renderOpponent(
    $('opp-left'), v.players[leftSeat], v,
    v.turn === leftSeat && v.phase !== 'over',
    v.dealer === leftSeat
  );
  renderOpponent(
    $('opp-right'), v.players[rightSeat], v,
    v.turn === rightSeat && v.phase !== 'over',
    v.dealer === rightSeat
  );

  // 中央：弃牌（也是拖拽出牌的落点）
  const discardArea = $('discard-area');
  discardArea.innerHTML = '';
  if (v.lastDraw && (v.phase === 'draw' || v.phase === 'reveal' || v.phase === 'arrange' || (v.phase === 'decide' && v.turn === v.lastDraw.seat))) {
    // 亮牌：展示刚摸到的牌（公开可见；被提/跑消耗的摸牌也在此展示）
    const top = document.createElement('div');
    top.className = 'discard-top draw-card';
    top.appendChild(cardEl(v.lastDraw.card, {}));
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = v.players[v.lastDraw.seat].name + ' 摸到';
    top.appendChild(who);
    discardArea.appendChild(top);
  } else if (v.lastDiscard) {
    const top = document.createElement('div');
    top.className = 'discard-top';
    top.appendChild(cardEl(v.lastDiscard, {}));
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = v.players[v.lastDiscarder].name + ' 打出';
    top.appendChild(who);
    discardArea.appendChild(top);
  } else {
    const wall = document.createElement('div');
    wall.className = 'wall-back';
    wall.textContent = `剩牌\n${v.wallCount} 张`;
    discardArea.appendChild(wall);
  }

  // 打出的牌（弃牌堆）：全部显示，缩小尺寸
  if (v.discards && v.discards.length) {
    const pile = document.createElement('div');
    pile.className = 'discard-pile';
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = '打出的牌';
    pile.appendChild(label);
    for (const c of v.discards) pile.appendChild(cardEl(c, { size: 'tiny' }));
    discardArea.appendChild(pile);
  }

  // 拖拽出牌：轮到我把牌拖到这里即可打出
  const canDrop = v.phase === 'decide' && v.turn === S.mySeat;
  discardArea.classList.toggle('drop-target', canDrop);
  discardArea.ondragover = canDrop ? (e) => { e.preventDefault(); discardArea.classList.add('drop-hover'); } : null;
  discardArea.ondragleave = canDrop ? () => discardArea.classList.remove('drop-hover') : null;
  discardArea.ondrop = canDrop
    ? (e) => {
        e.preventDefault();
        discardArea.classList.remove('drop-hover');
        const id = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const options = v.you.options || {};
        if (id && (options.canDiscard || []).includes(id)) {
          S.selected = null;
          sendAction({ type: 'discard', card: id });
        }
      }
    : null;

  // 日志
  const log = $('game-log');
  log.innerHTML = '';
  for (const entry of v.log.slice(-9)) {
    const div = document.createElement('div');
    div.textContent = entry.msg;
    if (entry.msg.includes('胡')) div.className = 'hl';
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;

  // 我的面子
  const myMelds = $('my-melds');
  myMelds.innerHTML = '';
  for (const m of me.melds) myMelds.appendChild(meldGroupEl(m, 'mini'));

  // 手牌
  renderHand(v);

  // 动作栏
  renderActionBar(v);
}

/* ---------------- 手牌（3×5 网格 + 拖拽插位排序） ---------------- */

function clearInsertMarks() {
  for (const el of document.querySelectorAll('#my-hand .card.ins-before, #my-hand .card.ins-after, #my-hand .card.swap-target')) {
    el.classList.remove('ins-before', 'ins-after', 'swap-target');
  }
}

async function sendOrder(ids) {
  const r = await api('action', { code: S.code, pid: S.pid, action: { type: 'order', ids } });
  if (r.status !== 200) {
    toast(r.json.error || '排序失败');
    await refreshView();
  }
}

/**
 * 由指针坐标计算插入点（网格阅读顺序、行感知）：
 * - 纵轴：与横轴相同的「中心线」判定——行边界取相邻两行间隙的中点
 *   （指针高于某行中心计入该行，低于下一行中心计入下一行）；
 * - 横轴：插入点 = 该行内中心在指针左侧的牌数；
 * - 指针低于最后一整行（越过间隙中点）视为插到末尾。
 */
function insertionIndexOfPointer(box, cards, handLen, x, y) {
  if (!cards.length) return 0;
  const first = cards[0].getBoundingClientRect();
  const rowHeight = cards.length > 5
    ? cards[5].getBoundingClientRect().top - first.top
    : first.height + 10;
  const gapHalf = (rowHeight - first.height) / 2;
  const rowCount = Math.ceil(handLen / 5);
  const bottom = first.top + (rowCount - 1) * rowHeight + first.height;
  if (y > bottom + gapHalf) return handLen; // 低于最后一整行间隙中点 → 末尾
  // 纵轴：中心线判定（与横轴一致）
  let row = Math.floor((y - first.top + gapHalf) / rowHeight);
  row = Math.max(0, Math.min(row, rowCount - 1));
  let idx = row * 5;
  for (let k = row * 5; k < Math.min((row + 1) * 5, handLen); k++) {
    const rect = cards[k].getBoundingClientRect();
    if (rect.left + rect.width / 2 < x) idx = k + 1;
  }
  return Math.min(idx, handLen);
}

// 标记插入位置：在目标牌前显示金色竖条（插到末尾标在最后一张之后）
function markInsertPosition(box, cards, idx, draggedEl) {
  for (const el of cards) el.classList.remove('ins-before', 'ins-after');
  let markerIdx = idx;
  if (cards[markerIdx] === draggedEl) markerIdx += 1;
  if (markerIdx < cards.length) {
    cards[markerIdx].classList.add('ins-before');
  } else if (cards.length) {
    cards[cards.length - 1].classList.add('ins-after');
  }
}

// 指针是否落在某张牌上（用于「上下换位」判定）；返回牌的下标或 -1
function cardAtPointer(cards, x, y) {
  for (let k = 0; k < cards.length; k++) {
    const rect = cards[k].getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return k;
  }
  return -1;
}

function startPick(mode) {
  S.pickMode = mode;
  S.picked = [];
  renderHand(S.view);
  renderActionBar(S.view);
}

function cancelPick() {
  S.pickMode = null;
  S.picked = [];
  renderHand(S.view);
  renderActionBar(S.view);
}

// 选牌组合：点牌切换选中，选够张数自动提交
function togglePick(id) {
  const i = S.picked.indexOf(id);
  if (i >= 0) S.picked.splice(i, 1);
  else S.picked.push(id);
  const need = S.pickMode === 'wei' ? 1 : 2;
  if (S.picked.length > need) S.picked.shift();
  if (S.picked.length === need) {
    const mode = S.pickMode;
    const ids = S.picked.slice();
    S.pickMode = null;
    S.picked = [];
    if (mode === 'wei') sendAction({ type: 'wei', card: ids[0] });
    else if (mode === 'zuhe') sendAction({ type: 'zuhe', cardA: ids[0], cardB: ids[1] });
    else if (mode === 'chi') sendAction({ type: 'chi', cardA: ids[0], cardB: ids[1] });
    return;
  }
  renderHand(S.view);
  renderActionBar(S.view);
}

function renderHand(v) {
  const hand = v.you.hand; // 服务器已按自定义顺序下发
  const o = v.you.options || {};
  const canDiscard = v.phase === 'decide' && v.turn === S.mySeat && (o.canDiscard || []).length > 0;
  const box = $('my-hand');
  box.innerHTML = '';
  clearInsertMarks();

  // 手牌区域：接受拖放——跨行落在牌上 = 上下换位；行内/空隙 = 插入排序
  box.ondragover = (e) => {
    e.preventDefault();
    const id = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!id || !hand.some((c) => c.i === id)) return;
    const cards = [...box.querySelectorAll('.card')];
    const draggedIndex = hand.findIndex((c) => c.i === id);
    // 跨行悬停在某张牌上 → 显示换位标记
    const target = cardAtPointer(cards, e.clientX, e.clientY);
    clearInsertMarks();
    if (target >= 0 && target !== draggedIndex && Math.floor(target / 5) !== Math.floor(draggedIndex / 5)) {
      cards[target].classList.add('swap-target');
      return;
    }
    const draggedEl = cards.find((el) => el.dataset.i === String(id));
    const idx = insertionIndexOfPointer(box, cards, hand.length, e.clientX, e.clientY);
    markInsertPosition(box, cards, idx, draggedEl);
  };
  box.ondragleave = (e) => {
    if (!e.relatedTarget || !box.contains(e.relatedTarget)) clearInsertMarks();
  };
  box.ondrop = (e) => {
    e.preventDefault();
    const id = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!id || !hand.some((c) => c.i === id)) return;
    const cards = [...box.querySelectorAll('.card')];
    const draggedIndex = hand.findIndex((c) => c.i === id);
    // 跨行落在某张牌上 → 上下两张牌换位（不是斜着插）
    const target = cardAtPointer(cards, e.clientX, e.clientY);
    if (target >= 0 && target !== draggedIndex && Math.floor(target / 5) !== Math.floor(draggedIndex / 5)) {
      const ids = hand.map((c) => c.i);
      [ids[draggedIndex], ids[target]] = [ids[target], ids[draggedIndex]];
      clearInsertMarks();
      sendOrder(ids);
      return;
    }
    // 行内/空隙：落点按松手时的指针坐标实时计算
    const idx = insertionIndexOfPointer(box, cards, hand.length, e.clientX, e.clientY);
    const ids = hand.map((c) => c.i).filter((x) => x !== id);
    let pos = idx;
    if (pos > draggedIndex) pos -= 1; // 移除被拖牌后校正位置
    pos = Math.max(0, Math.min(pos, ids.length));
    ids.splice(pos, 0, id);
    clearInsertMarks();
    sendOrder(ids);
  };

  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    const el = cardEl(c, {});

    // 任何时候都能拖动：拖到牌之间 = 调整顺序；轮到自己时拖到中间 = 打出
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(c.i));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
      el._dragged = true; // 拖拽后抑制点击，避免误出牌
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearInsertMarks();
    });

    // 点击：选牌模式下切换选中；否则点选出牌（手机触屏可用；刚拖拽完的点击不生效）
    if (canDiscard || S.pickMode) {
      el.classList.add('selectable');
      if (S.picked.includes(c.i) || S.selected === c.i) el.classList.add('selected');
      el.onclick = () => {
        if (el._dragged) {
          el._dragged = false;
          return;
        }
        if (S.pickMode) {
          togglePick(c.i);
          return;
        }
        if (S.selected === c.i) {
          S.selected = null;
          sendAction({ type: 'discard', card: c.i });
        } else {
          S.selected = c.i;
          renderHand(v);
        }
      };
    }
    box.appendChild(el);
  }
}

function renderActionBar(v) {
  const bar = $('action-bar');
  bar.innerHTML = '';
  const me = v.you;
  const o = me.options || {};

  const autoBtn = $('btn-auto');
  autoBtn.textContent = v.players[S.mySeat].auto ? '取消托管' : '托管';
  autoBtn.classList.toggle('ghost', !v.players[S.mySeat].auto);

  // 「胡」按钮永远显示：任何时候都能点，是否符合条件由服务器判定（不符 = 诈胡）
  const huBtn = document.createElement('button');
  huBtn.className = 'btn-hu';
  huBtn.textContent = '胡';
  huBtn.disabled = v.phase === 'over';
  huBtn.onclick = async () => {
    const r = await api('action', { code: S.code, pid: S.pid, action: { type: 'hu' } });
    if (r.status !== 200) {
      toast(r.json.error || '操作失败');
      await refreshView();
    } else if (r.json.zhaHu) {
      toast(`💥 诈胡！各赔 ${r.json.penalty} 分`);
    }
  };
  bar.appendChild(huBtn);

  if (v.phase === 'over') {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = v.over && v.over.reason === 'hu' ? '本局结束，可返回房间再来一局' : '荒庄流局，可返回房间再来一局';
    bar.appendChild(hint);
    return;
  }

  const myTurn = v.turn === S.mySeat;

  if (v.phase === 'pre' && myTurn) {
    // 摸牌前阶段：可煨（跳过摸牌阶段）或摸牌
    const weiBtn = document.createElement('button');
    weiBtn.className = 'btn-act';
    weiBtn.textContent = '煨';
    weiBtn.onclick = () => (S.pickMode === 'wei' ? cancelPick() : startPick('wei'));
    bar.appendChild(weiBtn);

    if (S.pickMode === 'wei') {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '请点选 1 张要煨的牌（再点「煨」取消）';
      bar.appendChild(hint);
    } else {
      const drawBtn = document.createElement('button');
      drawBtn.className = 'primary';
      drawBtn.textContent = '摸牌';
      drawBtn.onclick = () => sendAction({ type: 'draw' });
      bar.appendChild(drawBtn);
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '可煨牌（跳过摸牌）或直接摸牌';
      bar.appendChild(hint);
    }
  } else if (v.phase === 'decide' && myTurn) {
    // 通用动作按钮（不提示具体牌型）：组合自行选牌，服务器验证
    const zuheBtn = document.createElement('button');
    zuheBtn.className = 'btn-act';
    zuheBtn.textContent = '组合';
    zuheBtn.onclick = () => (S.pickMode === 'zuhe' ? cancelPick() : startPick('zuhe'));
    bar.appendChild(zuheBtn);

    if (S.pickMode) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = S.pickMode === 'wei' ? '请点选 1 张要煨的牌（再点按钮取消）' : '请点选 2 张牌与摸到的牌组合（再点按钮取消）';
      bar.appendChild(hint);
    } else if (o.mustDiscard) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '请打出一张牌（拖到中间牌区，或点击选牌再点「出牌」）';
      bar.appendChild(hint);
    } else {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '可拖动牌调整顺序；把牌拖到中间牌区打出，或点击选牌再点「出牌」';
      bar.appendChild(hint);
    }
    if (o.canDiscard.length && !S.pickMode) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = '出牌';
      b.disabled = S.selected === null;
      b.onclick = () => {
        const card = S.selected;
        S.selected = null;
        sendAction({ type: 'discard', card });
      };
      bar.appendChild(b);
    }
  } else if ((v.phase === 'react' || v.phase === 'draw') && o.pass) {
    // 通用响应按钮（不提示具体牌型）：跑/碰直接点，吃自行选牌
    const paoBtn = document.createElement('button');
    paoBtn.className = 'btn-act';
    paoBtn.textContent = '跑';
    paoBtn.onclick = () => sendAction({ type: 'pao' });
    bar.appendChild(paoBtn);

    const pengBtn = document.createElement('button');
    pengBtn.className = 'btn-act';
    pengBtn.textContent = '碰';
    pengBtn.onclick = () => sendAction({ type: 'peng' });
    bar.appendChild(pengBtn);

    const chiBtn = document.createElement('button');
    chiBtn.className = 'btn-act';
    chiBtn.textContent = '吃';
    chiBtn.onclick = () => (S.pickMode === 'chi' ? cancelPick() : startPick('chi'));
    bar.appendChild(chiBtn);

    if (S.pickMode === 'chi') {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '请点选 2 张牌吃成一句话（再点「吃」取消）';
      bar.appendChild(hint);
    }

    const pass = document.createElement('button');
    pass.className = 'btn-pass';
    pass.textContent = '过';
    pass.onclick = () => sendAction({ type: 'pass' });
    bar.appendChild(pass);
  } else {
    const hint = document.createElement('span');
    hint.className = 'hint';
    if (v.phase === 'arrange') {
      hint.textContent = '理牌时间：可拖动整理手牌，倒计时结束后庄家开局…';
    } else if (v.phase === 'reveal') {
      hint.textContent = '摸牌展示中，稍后开启抢牌…';
    } else if (v.phase === 'draw') {
      const name = v.players[v.lastDraw.seat].name;
      hint.textContent = `等待响应 ${name} 摸到的「${cardChar(v.lastDraw.card)}」…`;
    } else if (v.phase === 'react') {
      const name = v.players[v.turn].name;
      hint.textContent = `等待 ${name} 处理「${cardChar(v.lastDiscard)}」…`;
    } else {
      hint.textContent = `等待 ${v.players[v.turn].name} 出牌…`;
    }
    bar.appendChild(hint);
  }
}

/* ---------------- 结算弹窗 ---------------- */

function maybeShowResult(v) {
  if (!v.over) return;
  const key = `${v.round}-${v.over.winner === null ? 'wall' : v.over.winner}`;
  if (S.overShownKey === key) return;
  S.overShownKey = key;
  showResult(v);
}

function showResult(v) {
  const over = v.over;
  const title = $('result-title');
  const body = $('result-body');
  body.innerHTML = '';

  if (over.reason === 'wall') {
    title.textContent = '荒庄流局';
    const p = document.createElement('p');
    p.style.textAlign = 'center';
    p.textContent = '牌墙摸完，本局无人胡牌，分数不变。';
    body.appendChild(p);
  } else {
    const hu = over.hu;
    const winnerName = v.players[over.winner].name;
    title.textContent = `${winnerName} ${hu.self ? '自摸' : '接炮'}胡牌！`;

    if (hu.special.length) {
      const badges = document.createElement('div');
      badges.className = 'special-badges';
      for (const s of hu.special) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = s;
        badges.appendChild(b);
      }
      body.appendChild(badges);
    }

    const bd = document.createElement('div');
    bd.className = 'hu-breakdown';
    for (const item of hu.breakdown) {
      const d = document.createElement('div');
      d.className = 'hb-item';
      d.innerHTML = `${item.label}<br/><span class="v">${item.value} 胡</span>`;
      bd.appendChild(d);
    }
    body.appendChild(bd);

    const total = document.createElement('div');
    total.className = 'hu-total';
    let multText = hu.mults.map((m) => `${m.name}×${m.x}`).join(' × ');
    total.innerHTML = `胡数 <b>${hu.huVal}</b>${multText ? ` × ${multText}` : ''} ＝ <b>${hu.total}</b> 分`;
    body.appendChild(total);

    const deltas = document.createElement('div');
    deltas.className = 'deltas';
    for (let s = 0; s < 3; s++) {
      const d = document.createElement('div');
      d.className = 'd-item';
      const delta = over.deltas[s];
      const sign = delta > 0 ? '+' : '';
      d.innerHTML = `${v.players[s].name}<br/><span class="${delta >= 0 ? 'plus' : 'minus'}">${sign}${delta}</span>`;
      deltas.appendChild(d);
    }
    body.appendChild(deltas);
  }

  $('btn-ready-again').onclick = async () => {
    $('result-modal').classList.add('hidden');
    await api('ready', { code: S.code, pid: S.pid, ready: true });
    S.overShownKey = null;
  };
  $('btn-back-room').onclick = () => {
    $('result-modal').classList.add('hidden');
    S.overShownKey = null;
  };
  $('result-modal').classList.remove('hidden');
}

/* ---------------- 房间操作 ---------------- */

function initRoom() {
  $('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(S.code);
      toast('房间码已复制');
    } catch {
      toast('房间码：' + S.code);
    }
  };
  $('btn-leave-room').onclick = async () => {
    await api('leave', { code: S.code, pid: S.pid });
    if (S.stream) S.stream.close();
    sessionStorage.removeItem('pzh-session');
    S.code = S.pid = null;
    showScreen('screen-lobby');
  };
  $('btn-addbot').onclick = async () => {
    const r = await api('addbot', { code: S.code, pid: S.pid });
    if (r.status !== 200) toast(r.json.error || '添加失败');
  };
  $('btn-ready').onclick = () => {
    const p = S.view.players[S.mySeat];
    api('ready', { code: S.code, pid: S.pid, ready: !p.ready });
  };
  $('btn-send-chat').onclick = sendChat;
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('btn-rules2').onclick = () => $('rules-modal').classList.remove('hidden');
}

async function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const r = await api('chat', { code: S.code, pid: S.pid, text });
  if (r.status !== 200) toast(r.json.error || '发送失败');
}

function initGame() {
  $('btn-exit-game').onclick = async () => {
    if (!confirm('退出后本局将由系统托管继续。确定退出吗？')) return;
    await api('leave', { code: S.code, pid: S.pid });
    if (S.stream) S.stream.close();
    sessionStorage.removeItem('pzh-session');
    S.code = S.pid = null;
    showScreen('screen-lobby');
  };
  $('btn-auto').onclick = async () => {
    const p = S.view.players[S.mySeat];
    const r = await api('auto', { code: S.code, pid: S.pid, on: !p.auto });
    if (r.status !== 200) toast(r.json.error || '操作失败');
  };
}

/* ---------------- 计时器 ---------------- */

setInterval(() => {
  if (!S.view || !S.view.deadline) {
    $('g-timer').classList.add('hidden');
    return;
  }
  const remain = S.view.deadline - Date.now();
  if (remain <= 0) {
    $('g-timer').classList.add('hidden');
    return;
  }
  const sec = Math.ceil(remain / 1000);
  $('g-timer').textContent = `⏱ ${sec}s`;
  $('g-timer').classList.remove('hidden');
  $('g-timer').classList.toggle('urgent', sec <= 10);
}, 400);

/* ---------------- 启动 ---------------- */

(async function boot() {
  $('rules-modal').querySelector('.modal-close').onclick = () => $('rules-modal').classList.add('hidden');
  $('result-modal').querySelector('.modal-close') && null;
  initLobby();
  initRoom();
  initGame();

  // 尝试恢复会话（刷新页面后回到房间）
  const saved = sessionStorage.getItem('pzh-session');
  if (saved) {
    try {
      const { code, pid, name } = JSON.parse(saved);
      const { status } = await api('resume', { code, pid });
      if (status === 200) {
        S.code = code;
        S.pid = pid;
        S.name = name || '';
        connectStream();
        showScreen('screen-room');
        return;
      }
    } catch { /* 会话失效 */ }
    sessionStorage.removeItem('pzh-session');
  }
  showScreen('screen-lobby');
})();
