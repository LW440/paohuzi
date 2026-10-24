'use strict';

/**
 * 湖南跑胡子（字牌）规则引擎 —— 纯逻辑、无副作用、服务器权威
 *
 * 牌：80 张。小写 一二三四五六七八九十 ×4，大写 壹贰叁肆伍陆柒捌玖拾 ×4
 * 红牌：二、七、十（小写）与 贰、柒、拾（大写）
 *
 * 玩法（3 人或 4 人）：
 *   - 3 人：每人发 20 张，剩 20 张为牌墙；庄家先摸后出（摸牌后 21 张）；
 *     胡牌 = 手中 21 张（含刚摸/炮牌）全部组成三张组，共 7 组，无需对子；
 *   - 4 人：每人发 14 张，剩 24 张为牌墙；庄家先摸后出（摸牌后 15 张）；
 *     胡牌 = 手中 15 张（含刚摸/炮牌）全部组成三张组，共 5 组，无需对子；
 *   桌上有 m 组面子时，手中牌组成 (总组数 - m) 组即可胡。
 * 每回合摸 1 张、出 1 张，或通过 吃/碰/煨/跑/提 组成面子。
 * 补牌规则（保证结构一致）：
 *   - 提：手中有 4 张相同，必须提，补摸 1 张；
 *   - 跑：自己摸到桌上 碰/煨 的第四张，必须跑，补摸 1 张；
 *         别人打出你桌上 碰/煨 的第四张，可跑，补摸 1 张后继续（可胡）；
 *   - 煨：手中有 3 张相同，可煨，不补牌（占用了本回合摸的牌）；
 *   - 吃/碰：拿牌后必须打出一张。
 * 起胡线：6 胡（天胡、地胡、手牌全部成组不受限制）。
 */

const SMALL_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const BIG_CHARS = ['壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];
const RED_NUMS = new Set([2, 7, 10]);

const HU_MIN = 6;

// 诈胡惩罚：各赔另外两家每人 10 分
const FAKE_HU_PENALTY = 10;

/* ---------------------------------------------------------------- 工具函数 */

function keyOf(t, n) { return (t ? 'B' : 'S') + n; }
function parseKey(k) { return { t: k[0] === 'B' ? 1 : 0, n: parseInt(k.slice(1), 10) }; }

function cardChar(c) { return c.t ? BIG_CHARS[c.n - 1] : SMALL_CHARS[c.n - 1]; }
function cardLabel(c) { return cardChar(c); }
function isRed(c) { return RED_NUMS.has(c.n); }
function cardKey(c) { return keyOf(c.t, c.n); }

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDeck(rng = Math.random) {
  const cards = [];
  let id = 1;
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 10; n++) {
      for (let k = 0; k < 4; k++) cards.push({ i: id++, t, n });
    }
  }
  return shuffle(cards, rng);
}

/* ---------------------------------------------------------------- 胡数计算 */

// 碰：小字 1 胡（红黑同），大字 3 胡（红黑同）
function trioValue(c) {
  return c.t === 1 ? 3 : 1;
}

// 对子（将）无胡息
function pairValue() { return 0; }

// 一句话：仅 一二三 / 二七十（小字 1 胡）与 壹贰叁 / 贰柒拾（大字 3 胡）有胡息，其余无胡息
function seqValue(cards) {
  const ns = cards.map((c) => c.n).sort((a, b) => a - b);
  const special = (ns[0] === 1 && ns[1] === 2 && ns[2] === 3) || (ns[0] === 2 && ns[1] === 7 && ns[2] === 10);
  if (!special) return 0;
  const small = cards.every((c) => c.t === 0);
  const big = cards.every((c) => c.t === 1);
  if (small) return 1;
  if (big) return 3;
  return 0;
}

/**
 * 面子胡数：
 * - 一句话：小字句 1 / 大字句 3 / 混搭 0；
 * - 碰：小字红 1 / 大字红 3 / 黑 0；
 * - 煨：小字 3 / 大字 6；
 * - 跑、提：小字 6 / 大字 12。
 */
function meldValue(m) {
  if (m.kind === 'seq') return seqValue(m.cards);
  if (m.kind === 'peng') return trioValue(m.cards[0]);
  if (m.kind === 'wei') return m.cards[0].t === 1 ? 6 : 3;
  if (m.kind === 'pao' || m.kind === 'ti') return m.cards[0].t === 1 ? 12 : 6;
  return 0;
}

const KIND_NAME = { peng: '碰', wei: '煨', pao: '跑', ti: '提', seq: '吃' };
function meldLabel(m) {
  return (KIND_NAME[m.kind] || '') + m.cards.map(cardChar).join('');
}

/* ---------------------------------------------------------------- 拆牌（胡牌判定） */

function groupByKey(cards) {
  const map = new Map();
  for (const c of cards) {
    const k = cardKey(c);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return map;
}

// 回溯求解：把 counts 全部拆成三张组（返回 key 数组组成的组，失败返回 null）
function solveMelds(counts) {
  let firstKey = null;
  for (const [k, c] of counts) {
    if (c > 0) { firstKey = k; break; }
  }
  if (firstKey === null) return [];
  const { t, n } = parseKey(firstKey);

  // 尝试一坎（三张相同）
  if (counts.get(firstKey) >= 3) {
    counts.set(firstKey, counts.get(firstKey) - 3);
    const rest = solveMelds(counts);
    if (rest) return [[firstKey, firstKey, firstKey], ...rest];
    counts.set(firstKey, counts.get(firstKey) + 3);
  }
  // 尝试一句话（同数混搭）：如 叁三三 / 三三叁（一坎同字 + 一张异字，或两张异字）
  {
    const oppT = t === 1 ? 0 : 1;
    const kOpp = keyOf(oppT, n);
    // 模式一：两张同字（含 firstKey）+ 一张异字
    if ((counts.get(firstKey) || 0) >= 2 && (counts.get(kOpp) || 0) >= 1) {
      counts.set(firstKey, counts.get(firstKey) - 2);
      counts.set(kOpp, counts.get(kOpp) - 1);
      const rest = solveMelds(counts);
      if (rest) return [[firstKey, firstKey, kOpp], ...rest];
      counts.set(firstKey, counts.get(firstKey) + 2);
      counts.set(kOpp, counts.get(kOpp) + 1);
    }
    // 模式二：一张同字（firstKey）+ 两张异字
    if ((counts.get(firstKey) || 0) >= 1 && (counts.get(kOpp) || 0) >= 2) {
      counts.set(firstKey, counts.get(firstKey) - 1);
      counts.set(kOpp, counts.get(kOpp) - 2);
      const rest = solveMelds(counts);
      if (rest) return [[firstKey, kOpp, kOpp], ...rest];
      counts.set(firstKey, counts.get(firstKey) + 1);
      counts.set(kOpp, counts.get(kOpp) + 2);
    }
  }
  // 尝试一句话（同字号三连）：firstKey 可以是三连的开头、中间或结尾
  for (const start of [n - 2, n - 1, n]) {
    if (start < 1 || start > 8) continue;
    const k1 = keyOf(t, start);
    const k2 = keyOf(t, start + 1);
    const k3 = keyOf(t, start + 2);
    if (k1 !== firstKey && k2 !== firstKey && k3 !== firstKey) continue;
    if ((counts.get(k1) || 0) > 0 && (counts.get(k2) || 0) > 0 && (counts.get(k3) || 0) > 0) {
      counts.set(k1, counts.get(k1) - 1);
      counts.set(k2, counts.get(k2) - 1);
      counts.set(k3, counts.get(k3) - 1);
      const rest = solveMelds(counts);
      if (rest) return [[k1, k2, k3], ...rest];
      counts.set(k1, counts.get(k1) + 1);
      counts.set(k2, counts.get(k2) + 1);
      counts.set(k3, counts.get(k3) + 1);
    }
  }
  // 尝试二七十（贰柒拾）：与一二三同规则的一句话
  if (n === 2 || n === 7 || n === 10) {
    const a = keyOf(t, 2);
    const b = keyOf(t, 7);
    const c = keyOf(t, 10);
    if ((counts.get(a) || 0) > 0 && (counts.get(b) || 0) > 0 && (counts.get(c) || 0) > 0) {
      counts.set(a, counts.get(a) - 1);
      counts.set(b, counts.get(b) - 1);
      counts.set(c, counts.get(c) - 1);
      const rest = solveMelds(counts);
      if (rest) return [[a, b, c], ...rest];
      counts.set(a, counts.get(a) + 1);
      counts.set(b, counts.get(b) + 1);
      counts.set(c, counts.get(c) + 1);
    }
  }
  return null;
}

// 带对子的拆牌：先枚举 pairCount 个对子，其余拆成三张组
function solveWithPairs(counts, keyList, need, startIdx) {
  if (need === 0) {
    const melds = solveMelds(new Map(counts));
    return melds ? { pairs: [], melds } : null;
  }
  for (let i = startIdx; i < keyList.length; i++) {
    const k = keyList[i];
    if ((counts.get(k) || 0) < 2) continue;
    counts.set(k, counts.get(k) - 2);
    const rest = solveWithPairs(counts, keyList, need - 1, i);
    if (rest) { rest.pairs.push(k); return rest; }
    counts.set(k, counts.get(k) + 2);
  }
  return null;
}

/**
 * 把 cards 拆成面子 + 对子。
 * pairCount = 0：全部组成三张组（7 组面子）；
 * pairCount = k：每有一组跑牌（四张），胡牌结构多一对将，共 k 对。
 * 成功返回 { melds: [[牌,牌,牌],...], pairs: [[牌,牌],...] }，失败返回 null。
 */
function decompose(cards, pairCount = 0) {
  const byKey = groupByKey(cards);
  const counts = new Map();
  for (const [k, arr] of byKey) counts.set(k, arr.length);
  const keyList = [...counts.keys()];
  const sol = solveWithPairs(counts, keyList, pairCount || 0, 0);
  if (!sol) return null;
  const stacks = {};
  for (const [k, arr] of byKey) stacks[k] = arr.slice();
  const pairs = sol.pairs.map((k) => [stacks[k].shift(), stacks[k].shift()]);
  const melds = sol.melds.map((mk) => mk.map((k) => stacks[k].shift()));
  return { melds, pairs };
}

// 该玩家桌上面子里的跑牌组数（决定胡牌需要几对将）
function paoCount(state, seat) {
  return state.players[seat].melds.filter((m) => m.kind === 'pao').length;
}

/* ---------------------------------------------------------------- 对局状态 */

/**
 * players: [{ id, name, isBot, score }] 长度为 3 或 4
 * 3 人：每人 20 张（庄家摸牌后 21 张），牌墙 20 张；
 * 4 人：每人 14 张（庄家摸牌后 15 张），牌墙 24 张。
 */
function createGame(players, rng = Math.random) {
  const playerCount = players.length;
  if (playerCount !== 3 && playerCount !== 4) {
    throw new Error('跑胡子仅支持 3 人或 4 人');
  }
  // 胡牌条件为 5 句话：3 人局与 4 人局均为每人 14 张（庄家摸后 15 张）
  const dealSize = 14;
  const deck = makeDeck(rng);
  const state = {
    round: 1,
    dealer: 0,
    turn: 0,
    phase: 'decide', // decide | react | over
    playerCount,
    dealSize,
    wall: [],
    discards: [],
    lastDiscard: null,
    lastDiscarder: null,
    players: players.map((p, seat) => ({
      seat,
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      score: p.score || 0,
      hand: [],
      melds: [],
      ready: false,
    })),
    opening: true,   // 庄家尚未出第一张牌（用于天胡/地胡判定）
    mustDiscard: false, // 碰/吃后只能出牌
    window: null,    // 响应窗口（亮牌 / 弃牌）
    lastDraw: null,  // 最近一次亮出的摸牌 { card, seat }
    over: null,
    log: [],
    tick: 0,
  };

  for (let r = 0; r < dealSize; r++) {
    for (const p of state.players) p.hand.push(deck.pop());
  }
  state.wall = deck;

  // 起手有 4 张相同者必须提牌（补摸）
  for (const p of state.players) autoMeldCheck(state, p.seat);

  // 庄家先摸多出的一张（亮出展示），随后进入理牌阶段；理完牌直接出牌
  autoDraw(state, state.dealer);

  return state;
}

function playerName(state, seat) { return state.players[seat].name; }

function log(state, msg) {
  state.log.push({ t: Date.now(), msg });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function findFourKey(hand) {
  const m = new Map();
  for (const c of hand) m.set(cardKey(c), (m.get(cardKey(c)) || 0) + 1);
  for (const [k, cnt] of m) if (cnt >= 4) return k;
  return null;
}

function pullByKey(hand, key, count) {
  const out = [];
  for (let i = hand.length - 1; i >= 0 && out.length < count; i--) {
    if (cardKey(hand[i]) === key) out.push(hand.splice(i, 1)[0]);
  }
  return out;
}

/**
 * 自动提/跑检查（两者都是强制）：
 *   - 手中有 4 张相同 → 提（4 张亮出），补摸 1 张；
 *   - 手中摸到了桌上 碰/煨 的第四张 → 跑（3 张变 4 张），不补牌。
 * 循环至两种情形都不存在为止。
 */
function autoMeldCheck(state, seat, fromDraw) {
  const p = state.players[seat];
  let guard = 0;
  while (guard++ < 40) {
    const fourKey = findFourKey(p.hand);
    if (fourKey) {
      const cards = pullByKey(p.hand, fourKey, 4);
      p.melds.push({ kind: 'ti', cards });
      log(state, `${playerName(state, seat)} 提「${cardChar(cards[0])}」`);
      if (state.wall.length > 0) {
        p.hand.push(state.wall.pop());
      } else {
        endByWall(state);
        return;
      }
      continue;
    }
    // 跑：桌上 碰/煨 + 手中第四张（跑不补牌）
    const meld = p.melds.find((m) => {
      if (m.kind !== 'peng' && m.kind !== 'wei') return false;
      const c0 = m.cards[0];
      return p.hand.some((c) => c.t === c0.t && c.n === c0.n);
    });
    if (meld) {
      const c0 = meld.cards[0];
      const extra = p.hand.find((c) => c.t === c0.t && c.n === c0.n);
      p.hand.splice(p.hand.indexOf(extra), 1);
      meld.cards.push(extra);
      meld.kind = 'pao';
      log(state, `${playerName(state, seat)} 跑「${cardChar(extra)}」`);
      continue;
    }
    break;
  }
  // 煨：摸到的牌与手中两张相同 → 强制亮出，不可拆散（提/跑结算后检查）
  if (fromDraw) {
    const same = p.hand.filter((c) => c.t === fromDraw.t && c.n === fromDraw.n);
    if (same.length === 3) {
      for (const c of same) p.hand.splice(p.hand.indexOf(c), 1);
      p.melds.push({ kind: 'wei', cards: same });
      log(state, `${playerName(state, seat)} 摸到牌成煨「${cardChar(fromDraw)}」（强制亮出，不可拆散）`);
    }
  }
}

function endByWall(state) {
  state.phase = 'over';
  state.over = { winner: null, reason: 'wall', deltas: new Array(state.playerCount).fill(0) };
  log(state, '牌墙摸完，荒庄流局');
}

/**
 * 摸牌：从牌墙摸 1 张，处理强制提/跑，然后亮牌展示——
 * 进入 'reveal' 阶段（留出思考时间），随后由 openDrawWindow 开启抢牌窗口或进入出牌。
 * 返回：'reveal'（展示阶段）| 'wall'（流局）
 */
function autoDraw(state, seat) {
  if (state.wall.length === 0) {
    endByWall(state);
    return 'wall';
  }
  const p = state.players[seat];
  const card = state.wall.pop();
  p.hand.push(card);
  autoMeldCheck(state, seat, card);
  if (state.phase === 'over') return 'wall';
  state.turn = seat;
  state.mustDiscard = false;
  // 摸到的牌始终公开亮出（跑 n 次也只摸这一张、展示这一张）
  state.lastDraw = { card, seat };
  // 庄家开局第一摸：亮出展示 + 理牌时间，理完牌直接出牌（无展示等待、不可抢）
  if (state.opening && seat === state.dealer && state.discards.length === 0) {
    state.phase = 'arrange';
    return 'arrange';
  }
  state.phase = 'reveal';
  return 'reveal';
}

/**
 * 展示期结束：开启抢牌窗口（无人可抢则摸牌者进入出牌阶段）。
 * - 庄家开局多摸的第一张牌：只展示、不可抢，庄家直接先手出牌；
 * - 摸到的牌若已被强制提/跑消耗，直接进入出牌阶段。
 */
function openDrawWindow(state) {
  if (state.phase !== 'reveal') return;
  const { card, seat } = state.lastDraw;
  if (!state.players[seat].hand.some((c) => c.i === card.i)) {
    state.phase = 'decide';
    return;
  }
  openWindow(state, 'draw');
}

/* ---------------------------------------------------------------- 可行动作判定 */

function findWeiOptions(hand) {
  const m = new Map();
  for (const c of hand) m.set(cardKey(c), (m.get(cardKey(c)) || 0) + 1);
  const result = [];
  for (const [k, cnt] of m) {
    if (cnt === 3) {
      const { t, n } = parseKey(k);
      result.push(hand.find((c) => c.t === t && c.n === n));
    }
  }
  return result; // 每种可煨的牌各给一张代表
}

// 自摸胡：手中全部牌拆成面子 + 对将（每有一组跑牌多一对将）
function canHuSelf(state, seat) {
  const p = state.players[seat];
  if (p.hand.length === 0) {
    // 手牌全部成组：直接胡（不受起胡线与对将限制）
    const huVal = calcHuVal(state, seat, [], []);
    return { melds: [], pairs: [], huVal, tianhu: state.opening && seat === state.dealer };
  }
  const d = decompose(p.hand, paoCount(state, seat));
  if (!d) return null;
  const huVal = calcHuVal(state, seat, d.melds, d.pairs);
  // 天胡不受起胡线限制
  const tianhu = state.opening && seat === state.dealer;
  if (huVal < HU_MIN && !tianhu) return null;
  return { melds: d.melds, pairs: d.pairs, huVal, tianhu };
}

// 接炮胡：手中 + 别人打出的牌
function canHuDiscard(state, seat) {
  return canHuDiscardCard(state, seat, state.lastDiscard, true);
}

// 用某张来源牌（打出的牌或亮出的摸牌）接胡
function canHuDiscardCard(state, seat, card, isDiscard) {
  const p = state.players[seat];
  const cards = [...p.hand, card];
  const d = decompose(cards, paoCount(state, seat));
  if (!d) return null;
  const huVal = calcHuVal(state, seat, d.melds, d.pairs);
  const dihu = isDiscard && state.opening && state.lastDiscarder === state.dealer; // 地胡不受起胡线限制
  if (huVal < HU_MIN && !dihu) return null;
  return { melds: d.melds, pairs: d.pairs, huVal, dihu };
}

function calcHuVal(state, seat, handMelds, pairs) {
  let v = 0;
  for (const m of state.players[seat].melds) v += meldValue(m);
  for (const cards of handMelds) {
    const kind = cardKey(cards[0]) === cardKey(cards[2]) ? 'peng' : 'seq';
    v += meldValue({ kind, cards });
  }
  for (const pair of pairs) v += pairValue(pair[0]);
  return v;
}

/* ---------------------------------------------------------------- 响应窗口（亮牌 / 弃牌） */

/**
 * 响应窗口内的各玩家选项：
 * - 亮牌窗口（kind='draw'）：摸牌者可自摸胡或保留；其余玩家可 胡/碰/跑/吃；
 * - 弃牌窗口（kind='discard'）：其余玩家可 胡/碰/跑/吃，打牌者不能响应。
 */
function windowOptions(state, seat, win) {
  const w = win || state.window;
  if (!w) return null;
  const src = w.sourceCard;
  const o = { hu: false, peng: false, pao: false, chi: [], pass: false };

  if (w.kind === 'draw' && seat === w.sourceSeat) {
    // 摸牌者：可自摸胡（优先级最高）；不提供「保留此牌」操作，
    // 无人要牌时自动留牌继续（pass 仅供服务器超时兜底）
    o.hu = !!canHuSelf(state, seat);
    o.pass = false;
    return o;
  }

  o.hu = !!canHuDiscardCard(state, seat, src, w.kind === 'discard');
  const p = state.players[seat];
  const cnt = p.hand.filter((c) => c.t === src.t && c.n === src.n).length;
  o.peng = cnt >= 2;
  o.pao = p.melds.some(
    (m) => (m.kind === 'peng' || m.kind === 'wei') && m.cards[0].t === src.t && m.cards[0].n === src.n
  );
  if (seat === (w.sourceSeat + 1) % state.playerCount) {
    // 同字号三连
    for (const [d1, d2] of [[-2, -1], [-1, 1], [1, 2]]) {
      const n1 = src.n + d1;
      const n2 = src.n + d2;
      if (n1 >= 1 && n1 <= 10 && n2 >= 1 && n2 <= 10) {
        const a = p.hand.find((c) => c.t === src.t && c.n === n1);
        const b = p.hand.find((c) => c.t === src.t && c.n === n2);
        if (a && b) o.chi.push([a, b]);
      }
    }
    // 二七十（贰柒拾）与一二三同规则
    if (src.n === 2 || src.n === 7 || src.n === 10) {
      const others = [2, 7, 10].filter((x) => x !== src.n);
      const a = p.hand.find((c) => c.t === src.t && c.n === others[0]);
      const b = p.hand.find((c) => c.t === src.t && c.n === others[1]);
      if (a && b) o.chi.push([a, b]);
    }
    // 同数混搭一句话：如 叁三三 / 三三叁
    pushMixedTripleChi(p, src, o.chi);
  }
  o.pass = true;
  return o;
}

// 同数混搭一句话的吃牌组合（一同一异 / 两异）
function pushMixedTripleChi(p, src, out) {
  const oppT = src.t === 1 ? 0 : 1;
  const same = p.hand.filter((c) => c.t === src.t && c.n === src.n);
  const opp = p.hand.filter((c) => c.t === oppT && c.n === src.n);
  if (same.length >= 1 && opp.length >= 1) out.push([same[0], opp[0]]);
  if (opp.length >= 2) out.push([opp[0], opp[1]]);
}

/**
 * 打开响应窗口：计算各玩家选项与必须响应的座位。
 * 无人可响应时直接推进（亮牌→摸牌者出牌；弃牌→下家摸牌）。
 */
function openWindow(state, kind) {
  const sourceSeat = kind === 'draw' ? state.lastDraw.seat : state.lastDiscarder;
  const sourceCard = kind === 'draw' ? state.lastDraw.card : state.lastDiscard;
  const w = {
    kind,
    sourceSeat,
    sourceCard,
    eligible: [],
    can: {},
    claims: new Map(), // seat -> action
    passed: new Set(),
  };
  for (let s = 0; s < state.playerCount; s++) {
    const o = windowOptions(state, s, w);
    w.can[s] = o;
    const mustRespond = kind === 'draw'
      ? (s === sourceSeat ? o.hu : (o.hu || o.peng || o.pao || o.chi.length > 0))
      : (s !== sourceSeat && (o.hu || o.peng || o.pao || o.chi.length > 0));
    if (mustRespond) w.eligible.push(s);
  }
  if (w.eligible.length === 0) {
    afterNoClaim(state, kind);
    return;
  }
  state.window = w;
  state.phase = kind === 'draw' ? 'draw' : 'react';
}

// 无人要牌时继续按顺序进行
function afterNoClaim(state, kind) {
  if (kind === 'draw') {
    // 摸牌者保留此牌，进入出牌阶段
    state.phase = 'decide';
    state.turn = state.lastDraw.seat;
    state.mustDiscard = false;
  } else {
    // 弃牌无人要：下家进入摸牌前阶段（可煨或摸牌）
    const next = (state.lastDiscarder + 1) % state.playerCount;
    state.turn = next;
    state.phase = 'pre';
    state.mustDiscard = false;
  }
}

// 所有必须响应者都已表态（抢或让）→ 按优先级结算
function maybeResolve(state) {
  const w = state.window;
  if (!w) return;
  for (const s of w.eligible) {
    if (!w.claims.has(s) && !w.passed.has(s)) return;
  }
  resolveWindow(state);
}

function actionTier(a) {
  if (a.type === 'hu') return 0;
  if (a.type === 'pao') return 1;
  if (a.type === 'peng') return 2;
  return 3; // chi
}

/**
 * 按优先级结算：胡 > 跑 > 碰 > 吃；同优先级按座位顺序（从来源座位起，
 * 摸牌者自摸胡最优先）。
 */
function resolveWindow(state) {
  const w = state.window;
  if (!w) return;
  state.window = null;
  const order = [w.sourceSeat];
  for (let s = 0; s < state.playerCount; s++) {
    if (s !== w.sourceSeat) order.push(s);
  }
  let winner = null;
  for (let tier = 0; tier <= 3 && winner === null; tier++) {
    for (const s of order) {
      const a = w.claims.get(s);
      if (a && actionTier(a) === tier) { winner = s; break; }
    }
  }
  if (winner === null) {
    afterNoClaim(state, w.kind);
    return;
  }
  applyClaim(state, winner, w.claims.get(winner), w);
}

// 抢牌成功：把来源牌交给赢家，赢家接手出牌
function applyClaim(state, seat, action, w) {
  const src = w.sourceCard;
  const p = state.players[seat];

  if (action.type === 'hu') {
    if (w.kind === 'draw' && seat === w.sourceSeat) {
      const res = canHuSelf(state, seat);
      if (res) doWin(state, seat, { self: true, ...res }, null);
      else afterNoClaim(state, w.kind); // 兜底：状态已变，按无人要处理
    } else {
      const res = canHuDiscardCard(state, seat, src, w.kind === 'discard');
      if (res) doWin(state, seat, { self: false, ...res, bySeat: w.sourceSeat }, src);
      else afterNoClaim(state, w.kind);
    }
    return;
  }

  // 移除来源牌：亮牌窗口从摸牌者手中拿，弃牌窗口从弃牌堆拿
  if (w.kind === 'draw') {
    const drawer = state.players[w.sourceSeat];
    const idx = drawer.hand.findIndex((c) => c.i === src.i);
    if (idx >= 0) drawer.hand.splice(idx, 1);
    state.lastDraw = null;
  } else {
    state.discards.pop();
    state.lastDiscard = null;
    state.lastDiscarder = null;
  }

  if (action.type === 'peng') {
    const taken = [];
    for (let i = p.hand.length - 1; i >= 0 && taken.length < 2; i--) {
      const c = p.hand[i];
      if (c.t === src.t && c.n === src.n) taken.push(p.hand.splice(i, 1)[0]);
    }
    p.melds.push({ kind: 'peng', cards: [src, ...taken] });
    log(state, `${playerName(state, seat)} 碰「${cardChar(src)}」`);
    state.turn = seat;
    state.phase = 'decide';
    state.mustDiscard = true;
  } else if (action.type === 'pao') {
    const meld = p.melds.find(
      (m) => (m.kind === 'peng' || m.kind === 'wei') && m.cards[0].t === src.t && m.cards[0].n === src.n
    );
    meld.cards.push(src);
    meld.kind = 'pao';
    log(state, `${playerName(state, seat)} 跑「${cardChar(src)}」`);
    // 跑不补牌，但照常接手出牌
    state.turn = seat;
    state.phase = 'decide';
    state.mustDiscard = true;
  } else {
    // chi
    const a = p.hand.find((c) => c.i === action.cardA);
    const b = p.hand.find((c) => c.i === action.cardB);
    p.hand.splice(p.hand.indexOf(a), 1);
    p.hand.splice(p.hand.indexOf(b), 1);
    const cards = [src, a, b].sort((x, y) => x.n - y.n);
    p.melds.push({ kind: 'seq', cards });
    log(state, `${playerName(state, seat)} 吃「${cards.map(cardChar).join('')}」`);
    state.turn = seat;
    state.phase = 'decide';
    state.mustDiscard = true;
  }
}

// 出牌阶段「组合」：用刚摸到（亮出）的牌 + 手中两张组成吃/碰
function zuheOptions(state, seat) {
  if (!state.lastDraw || state.lastDraw.seat !== seat) return [];
  const p = state.players[seat];
  const drawn = p.hand.find((c) => c.i === state.lastDraw.card.i);
  if (!drawn) return [];
  const out = [];
  const pushIf = (a, b) => {
    if (a && b && a.i !== b.i) out.push([a, b]);
  };
  // 碰形式：两张与摸到的牌相同
  const same = p.hand.filter((c) => c.i !== drawn.i && c.t === drawn.t && c.n === drawn.n);
  if (same.length >= 2) out.push([same[0], same[1]]);
  // 吃形式：同字号三连
  for (const [d1, d2] of [[-2, -1], [-1, 1], [1, 2]]) {
    const n1 = drawn.n + d1;
    const n2 = drawn.n + d2;
    if (n1 < 1 || n1 > 10 || n2 < 1 || n2 > 10) continue;
    const a = p.hand.find((c) => c.i !== drawn.i && c.t === drawn.t && c.n === n1);
    const b = p.hand.find((c) => c.i !== drawn.i && c.t === drawn.t && c.n === n2 && (!a || c.i !== a.i));
    pushIf(a, b);
  }
  // 二七十
  if (drawn.n === 2 || drawn.n === 7 || drawn.n === 10) {
    const others = [2, 7, 10].filter((x) => x !== drawn.n);
    const a = p.hand.find((c) => c.i !== drawn.i && c.t === drawn.t && c.n === others[0]);
    const b = p.hand.find((c) => c.i !== drawn.i && c.t === drawn.t && c.n === others[1] && (!a || c.i !== a.i));
    pushIf(a, b);
  }
  // 同数混搭一句话：叁三三 / 三三叁
  const oppT = drawn.t === 1 ? 0 : 1;
  const sameRest = p.hand.filter((c) => c.i !== drawn.i && c.t === drawn.t && c.n === drawn.n);
  const opp = p.hand.filter((c) => c.i !== drawn.i && c.t === oppT && c.n === drawn.n);
  pushIf(sameRest[0], opp[0]);
  pushIf(opp[0], opp[1]);
  return out;
}

/**
 * 当前玩家（phase==='decide' 且轮到 seat）的可行动作
 */
function decideOptions(state, seat) {
  const p = state.players[seat];
  const o = { canDiscard: p.hand.map((c) => c.i), canHu: false, canZuhe: [] };
  // 碰/吃后必须出牌；但手牌全部成组（0 张）时必须能胡
  if (state.mustDiscard && p.hand.length > 0) return o;
  o.canHu = !!canHuSelf(state, seat);
  o.canZuhe = zuheOptions(state, seat).map(([a, b]) => [a.i, b.i]);
  return o;
}

/* ---------------------------------------------------------------- 动作处理 */

/**
 * 应用一个动作。成功返回 { ok: true }，失败返回 { ok: false, error }。
 * 动作合法即修改 state（服务器随后广播）。
 */
function applyAction(state, seat, action) {
  if (state.phase === 'over') return { ok: false, error: '本局已结束' };
  const p = state.players[seat];
  if (!p) return { ok: false, error: '无效座位' };

  switch (action.type) {
    case 'discard': {
      if (state.phase !== 'decide' || state.turn !== seat) return { ok: false, error: '还没轮到你出牌' };
      const idx = p.hand.findIndex((c) => c.i === action.card);
      if (idx < 0) return { ok: false, error: '你手里没有这张牌' };
      doDiscard(state, seat, idx);
      return { ok: true };
    }
    case 'hu': {
      if (state.phase === 'over') return { ok: false, error: '本局已结束' };
      if (state.phase === 'arrange') return { ok: false, error: '牌局尚未开始，理牌中…' };
      if (state.phase === 'pre') return { ok: false, error: '请先摸牌或煨牌' };
      if (state.phase === 'reveal') return { ok: false, error: '牌刚亮出，请稍等思考时间结束' };
      // 任何时候都可以点胡：符合条件则胡，不符合则判诈胡
      let win = null;
      if (state.phase === 'decide' && state.turn === seat && (!state.mustDiscard || p.hand.length === 0)) {
        const res = canHuSelf(state, seat);
        if (res) win = { self: true, ...res };
      } else if ((state.phase === 'draw' || state.phase === 'react') && state.window) {
        const w = state.window;
        const isDrawer = w.kind === 'draw' && seat === w.sourceSeat;
        if (isDrawer) {
          // 摸牌者自摸胡（优先级最高）
          const res = canHuSelf(state, seat);
          if (res) {
            w.claims.set(seat, { type: 'hu' });
            maybeResolve(state);
            return { ok: true };
          }
        } else if (w.can[seat] && w.can[seat].hu) {
          const res = canHuDiscardCard(state, seat, w.sourceCard, w.kind === 'discard');
          if (res) {
            w.claims.set(seat, { type: 'hu' });
            maybeResolve(state);
            return { ok: true };
          }
        }
      }
      if (win) {
        doWin(state, seat, win);
        return { ok: true };
      }
      // 诈胡：各赔另外各家
      for (let s = 0; s < state.playerCount; s++) {
        if (s === seat) continue;
        state.players[seat].score -= FAKE_HU_PENALTY;
        state.players[s].score += FAKE_HU_PENALTY;
      }
      log(state, `💥 ${playerName(state, seat)} 诈胡！各赔 ${FAKE_HU_PENALTY} 分`);
      return { ok: true, zhaHu: true };
    }
    case 'wei': {
      // 煨跳过摸牌阶段：在摸牌前进行，煨完不摸牌不出牌，直接轮到下家
      if (state.phase !== 'pre' || state.turn !== seat) {
        return { ok: false, error: '当前不能煨牌（煨在摸牌前进行）' };
      }
      const card = p.hand.find((c) => c.i === action.card);
      if (!card) return { ok: false, error: '你手里没有这张牌' };
      const same = p.hand.filter((c) => c.t === card.t && c.n === card.n);
      if (same.length !== 3) return { ok: false, error: '需要三张相同的牌才能煨' };
      for (const c of same) p.hand.splice(p.hand.indexOf(c), 1);
      p.melds.push({ kind: 'wei', cards: same });
      log(state, `${playerName(state, seat)} 煨「${cardChar(card)}」`);
      state.turn = (seat + 1) % state.playerCount;
      state.phase = 'pre';
      return { ok: true };
    }
    case 'draw': {
      // 摸牌：pre 阶段不煨则摸牌
      if (state.phase !== 'pre' || state.turn !== seat) return { ok: false, error: '当前不能摸牌' };
      autoDraw(state, seat);
      return { ok: true };
    }
    case 'zuhe': {
      // 出牌阶段：用刚摸到（亮出）的牌 + 手中两张组成吃/碰，记入胡息
      if (state.phase !== 'decide' || state.turn !== seat || state.mustDiscard) {
        return { ok: false, error: '当前不能组合' };
      }
      if (!state.lastDraw || state.lastDraw.seat !== seat) return { ok: false, error: '当前没有可组合的摸牌' };
      const drawn = p.hand.find((c) => c.i === state.lastDraw.card.i);
      if (!drawn) return { ok: false, error: '摸到的牌已不在手中' };
      const a = p.hand.find((c) => c.i === action.cardA);
      const b = p.hand.find((c) => c.i === action.cardB);
      if (!a || !b || a.i === b.i || a.i === drawn.i || b.i === drawn.i) return { ok: false, error: '选择无效' };
      const cards = [drawn, a, b];
      const kind = isZuheCombo(cards);
      if (!kind) return { ok: false, error: '不能组成吃/碰形式' };
      p.hand.splice(p.hand.indexOf(drawn), 1);
      p.hand.splice(p.hand.indexOf(a), 1);
      p.hand.splice(p.hand.indexOf(b), 1);
      if (kind === 'peng') {
        p.melds.push({ kind: 'peng', cards });
        log(state, `${playerName(state, seat)} 组合碰「${cardChar(drawn)}」`);
      } else {
        const sorted = [...cards].sort((x, y) => x.t - y.t || x.n - y.n);
        p.melds.push({ kind: 'seq', cards: sorted });
        log(state, `${playerName(state, seat)} 组合吃「${sorted.map(cardChar).join('')}」`);
      }
      state.lastDraw = null;
      state.mustDiscard = true;
      return { ok: true };
    }
    case 'pao': {
      if (!((state.phase === 'draw' || state.phase === 'react') && state.window)) {
        return { ok: false, error: '当前不能跑牌' };
      }
      const w = state.window;
      if (w.kind === 'draw' && seat === w.sourceSeat) return { ok: false, error: '摸牌者不能抢自己的牌' };
      const o = w.can[seat];
      if (!o || !o.pass) return { ok: false, error: '你不需要响应' };
      if (!o.pao) return { ok: false, error: '当前不能跑牌' };
      w.claims.set(seat, { type: 'pao' });
      maybeResolve(state);
      return { ok: true };
    }
    case 'peng': {
      if (!((state.phase === 'draw' || state.phase === 'react') && state.window)) {
        return { ok: false, error: '当前不能碰牌' };
      }
      const w = state.window;
      if (w.kind === 'draw' && seat === w.sourceSeat) return { ok: false, error: '摸牌者不能抢自己的牌' };
      const o = w.can[seat];
      if (!o || !o.pass) return { ok: false, error: '你不需要响应' };
      if (!o.peng) return { ok: false, error: '当前不能碰牌' };
      w.claims.set(seat, { type: 'peng' });
      maybeResolve(state);
      return { ok: true };
    }
    case 'chi': {
      if (!((state.phase === 'draw' || state.phase === 'react') && state.window)) {
        return { ok: false, error: '当前不能吃牌' };
      }
      const w = state.window;
      if (w.kind === 'draw' && seat === w.sourceSeat) return { ok: false, error: '摸牌者不能抢自己的牌' };
      const o = w.can[seat];
      if (!o || !o.pass) return { ok: false, error: '你不需要响应' };
      if (!o.chi.length) return { ok: false, error: '当前不能吃牌' };
      const valid = o.chi.some(([a, b]) => (a.i === action.cardA && b.i === action.cardB) || (a.i === action.cardB && b.i === action.cardA));
      if (!valid) return { ok: false, error: '选择的吃牌组合无效' };
      w.claims.set(seat, { type: 'chi', cardA: action.cardA, cardB: action.cardB });
      maybeResolve(state);
      return { ok: true };
    }
    case 'pass': {
      if (!((state.phase === 'draw' || state.phase === 'react') && state.window)) {
        return { ok: false, error: '当前无需响应' };
      }
      const w = state.window;
      const isDrawer = w.kind === 'draw' && seat === w.sourceSeat;
      const o = w.can[seat];
      if (!isDrawer && (!o || !o.pass)) return { ok: false, error: '你不需要响应' };
      if (w.claims.has(seat)) return { ok: false, error: '已经抢过牌了' };
      w.passed.add(seat);
      maybeResolve(state);
      return { ok: true };
    }
    default:
      return { ok: false, error: '未知动作' };
  }
}

// 出牌：亮出弃牌，开启响应窗口；无人要则下家摸牌
function doDiscard(state, seat, handIdx) {
  const p = state.players[seat];
  const [card] = p.hand.splice(handIdx, 1);
  state.discards.push(card);
  state.lastDiscard = card;
  state.lastDiscarder = seat;
  if (state.opening && seat === state.dealer) state.opening = false;
  log(state, `${playerName(state, seat)} 出「${cardChar(card)}」`);
  openWindow(state, 'discard');
}

// 组合判定：三张牌是否构成 碰（完全相同）/ 一句话（同字号三连、二七十、同数混搭）
function isZuheCombo(cards) {
  const [x, y, z] = cards;
  // 碰：三张完全相同
  if (x.t === y.t && y.t === z.t && x.n === y.n && y.n === z.n) return 'peng';
  // 同数混搭一句话：如 叁三三 / 三三叁（三张同数字，大小不全同）
  if (x.n === y.n && y.n === z.n) return 'seq';
  // 同字号三连或二七十
  if (x.t === y.t && y.t === z.t) {
    const ns = [x.n, y.n, z.n].sort((a, b) => a - b);
    if (ns[1] === ns[0] + 1 && ns[2] === ns[0] + 2) return 'seq';
    if (ns[0] === 2 && ns[1] === 7 && ns[2] === 10) return 'seq';
  }
  return null;
}

function doWin(state, seat, res, winCard) {
  const winner = state.players[seat];
  const breakdown = [];
  for (const m of winner.melds) {
    breakdown.push({ label: meldLabel(m), value: meldValue(m), kind: m.kind, cards: m.cards });
  }
  for (const cards of res.melds) {
    const kind = cardKey(cards[0]) === cardKey(cards[2]) ? 'peng' : 'seq';
    breakdown.push({ label: meldLabel({ kind, cards }), value: meldValue({ kind, cards }), kind, cards });
  }
  for (const pair of res.pairs) {
    breakdown.push({ label: '对' + cardChar(pair[0]), value: pairValue(pair[0]), kind: 'pair', cards: pair });
  }

  const huVal = res.huVal;
  const mults = [];
  const special = [];

  if (res.self) {
    mults.push({ name: '自摸', x: 2 });
  }
  if (res.self && res.tianhu) {
    mults.push({ name: '天胡', x: 4 });
    special.push('天胡');
  }
  if (!res.self && res.dihu) {
    mults.push({ name: '地胡', x: 2 });
    special.push('地胡');
  }
  const allCards = res.self ? winner.hand : [...winner.hand, winCard];
  if (allCards.length > 0 && allCards.every((c) => c.t === 0)) {
    mults.push({ name: '十八小', x: 2 });
    special.push('十八小');
  } else if (allCards.length > 0 && allCards.every((c) => c.t === 1)) {
    mults.push({ name: '十八大', x: 2 });
    special.push('十八大');
  }

  let total = huVal;
  for (const m of mults) total *= m.x;

  // 结算：自摸其余各家各付总分；接炮放炮者付 2 倍，其余各家各付 1 倍
  const deltas = new Array(state.playerCount).fill(0);
  if (res.self) {
    for (let s = 0; s < state.playerCount; s++) {
      if (s === seat) continue;
      deltas[seat] += total;
      deltas[s] -= total;
    }
  } else {
    for (let s = 0; s < state.playerCount; s++) {
      if (s === seat) {
        deltas[s] += total * state.playerCount;
      } else if (s === res.bySeat) {
        deltas[s] -= total * 2;
      } else {
        deltas[s] -= total;
      }
    }
  }
  for (let s = 0; s < state.playerCount; s++) state.players[s].score += deltas[s];

  state.window = null;
  state.phase = 'over';
  state.over = {
    winner: seat,
    reason: 'hu',
    deltas,
    hu: {
      self: res.self,
      huVal,
      mults,
      special,
      total,
      breakdown,
      bySeat: res.bySeat !== undefined ? res.bySeat : null,
    },
  };
  const kindName = res.self ? '自摸' : '接炮';
  const extra = special.length ? `（${special.join('、')}）` : '';
  log(state, `🎉 ${playerName(state, seat)} ${kindName}胡牌！${huVal} 胡 ${extra} 每家付 ${total} 分`);
}

/* ---------------------------------------------------------------- 下一局 */

function startNextRound(state, rng = Math.random) {
  const deck = makeDeck(rng);
  const prevOver = state.over;
  state.round += 1;
  if (prevOver && prevOver.winner !== null && prevOver.winner !== undefined) {
    state.dealer = prevOver.winner; // 胡牌者坐庄；荒庄连庄
  }
  state.turn = state.dealer;
  state.phase = 'decide';
  state.wall = [];
  state.discards = [];
  state.lastDiscard = null;
  state.lastDiscarder = null;
  state.opening = true;
  state.mustDiscard = false;
  state.window = null;
  state.lastDraw = null;
  state.over = null;
  state.tick += 1;

  for (const p of state.players) {
    p.hand = [];
    p.melds = [];
    p.ready = false;
  }
  for (let r = 0; r < state.dealSize; r++) {
    for (const p of state.players) p.hand.push(deck.pop());
  }
  state.wall = deck;
  for (const p of state.players) autoMeldCheck(state, p.seat);
  // 庄家先摸多出的一张（亮出展示），随后进入理牌阶段
  autoDraw(state, state.dealer);
}

/**
 * 理牌时间结束，开局：庄家已在理牌前摸过多摸的那一张，理完牌直接出牌（不再摸牌）
 */
function beginRound(state) {
  if (state.phase !== 'arrange') return;
  state.phase = 'decide';
}

/* ---------------------------------------------------------------- 导出 */

module.exports = {
  SMALL_CHARS,
  BIG_CHARS,
  RED_NUMS,
  HU_MIN,
  FAKE_HU_PENALTY,
  makeDeck,
  cardChar,
  cardLabel,
  isRed,
  cardKey,
  keyOf,
  trioValue,
  pairValue,
  seqValue,
  meldValue,
  meldLabel,
  decompose,
  paoCount,
  createGame,
  startNextRound,
  applyAction,
  decideOptions,
  findWeiOptions,
  windowOptions,
  openDrawWindow,
  beginRound,
  canHuSelf,
  canHuDiscard,
  canHuDiscardCard,
  calcHuVal,
  autoDraw,
};
