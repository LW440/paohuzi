'use strict';

/**
 * 跑胡子机器人：贪心策略。
 * - 能胡就胡；
 * - 能煨就煨；
 * - 出牌时选择"出掉后剩余手牌结构最好"的那张；
 * - 响应（吃/碰/跑）优先胡 > 跑 > 碰，吃牌选择剩余结构最好的组合。
 */

const E = require('./engine.js');

function countsOf(hand) {
  const m = new Map();
  for (const c of hand) m.set(E.cardKey(c), (m.get(E.cardKey(c)) || 0) + 1);
  return m;
}

// 贪心拆牌：先拆坎再拆顺子，返回 { melds, loose }
function greedyMelds(hand) {
  const cnt = countsOf(hand);
  let melds = 0;
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 10; n++) {
      const k = E.keyOf(t, n);
      while ((cnt.get(k) || 0) >= 3) {
        cnt.set(k, cnt.get(k) - 3);
        melds++;
      }
    }
  }
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 8; n++) {
      const a = E.keyOf(t, n);
      const b = E.keyOf(t, n + 1);
      const c = E.keyOf(t, n + 2);
      while ((cnt.get(a) || 0) > 0 && (cnt.get(b) || 0) > 0 && (cnt.get(c) || 0) > 0) {
        cnt.set(a, cnt.get(a) - 1);
        cnt.set(b, cnt.get(b) - 1);
        cnt.set(c, cnt.get(c) - 1);
        melds++;
      }
    }
    // 二七十（贰柒拾）与一二三同规则
    const a = E.keyOf(t, 2);
    const b = E.keyOf(t, 7);
    const c = E.keyOf(t, 10);
    while ((cnt.get(a) || 0) > 0 && (cnt.get(b) || 0) > 0 && (cnt.get(c) || 0) > 0) {
      cnt.set(a, cnt.get(a) - 1);
      cnt.set(b, cnt.get(b) - 1);
      cnt.set(c, cnt.get(c) - 1);
      melds++;
    }
  }
  // 同数混搭一句话：叁三三 / 三三叁
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 10; n++) {
      const ks = E.keyOf(t, n);
      const ko = E.keyOf(1 - t, n);
      while ((cnt.get(ks) || 0) >= 2 && (cnt.get(ko) || 0) >= 1) {
        cnt.set(ks, cnt.get(ks) - 2);
        cnt.set(ko, cnt.get(ko) - 1);
        melds++;
      }
      while ((cnt.get(ks) || 0) >= 1 && (cnt.get(ko) || 0) >= 2) {
        cnt.set(ks, cnt.get(ks) - 1);
        cnt.set(ko, cnt.get(ko) - 2);
        melds++;
      }
    }
  }
  let loose = 0;
  for (const v of cnt.values()) loose += v;
  return { melds, loose, cnt };
}

// 手牌结构评分：完整面子权重最高，其次是对子、相邻牌
function handScore(hand) {
  const { melds, cnt } = greedyMelds(hand);
  let s = melds * 12;
  for (let t = 0; t < 2; t++) {
    for (let n = 1; n <= 10; n++) {
      const c = cnt.get(E.keyOf(t, n)) || 0;
      if (c >= 2) s += 3;
      if (c >= 1 && n < 10 && (cnt.get(E.keyOf(t, n + 1)) || 0) >= 1) s += 1;
    }
  }
  return s;
}

function chooseDiscard(hand) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < hand.length; i++) {
    const rest = hand.slice(0, i).concat(hand.slice(i + 1));
    const s = handScore(rest);
    // 平局时优先保留红牌（红牌胡数高）
    const redBonus = E.isRed(hand[i]) ? 0.01 : 0;
    if (s + redBonus > bestScore) {
      bestScore = s + redBonus;
      best = hand[i];
    }
  }
  return best || hand[0] || null;
}

/**
 * 摸牌前决策（phase==='pre' 且轮到该座位）：能煨则煨（跳过摸牌阶段），否则摸牌
 */
function preAction(state, seat) {
  const wei = E.findWeiOptions(state.players[seat].hand);
  if (wei.length) return { type: 'wei', card: wei[0].i };
  return { type: 'draw' };
}

/**
 * 回合内决策（phase==='decide' 且轮到该座位）
 */
function decideAction(state, seat) {
  const o = E.decideOptions(state, seat);
  if (o.canHu) return { type: 'hu' };
  if (o.canZuhe.length) {
    // 组合：选择剩余手牌结构最好的吃/碰组合
    let best = o.canZuhe[0];
    let bestScore = -Infinity;
    const hand = state.players[seat].hand;
    const drawnId = state.lastDraw ? state.lastDraw.card.i : -1;
    for (const [a, b] of o.canZuhe) {
      const rest = hand.filter((c) => c.i !== a && c.i !== b && c.i !== drawnId);
      const s = handScore(rest);
      if (s > bestScore) {
        bestScore = s;
        best = [a, b];
      }
    }
    return { type: 'zuhe', cardA: best[0], cardB: best[1] };
  }
  const card = chooseDiscard(state.players[seat].hand);
  return { type: 'discard', card: card.i };
}

/**
 * 响应窗口决策（phase==='draw' 亮牌 或 'react' 弃牌）
 * 机器人按「胡 > 跑 > 碰 > 吃 > 让」选择；摸牌者自摸胡优先。
 */
function reactAction(state, seat) {
  const o = E.windowOptions(state, seat);
  if (!o) return { type: 'pass' };
  if (o.hu) return { type: 'hu' };
  if (o.pao) return { type: 'pao' };
  if (o.peng) return { type: 'peng' };
  if (o.chi.length) {
    let best = o.chi[0];
    let bestScore = -Infinity;
    const hand = state.players[seat].hand;
    for (const [a, b] of o.chi) {
      const rest = hand.filter((c) => c.i !== a.i && c.i !== b.i);
      const s = handScore(rest);
      if (s > bestScore) {
        bestScore = s;
        best = [a, b];
      }
    }
    return { type: 'chi', cardA: best[0].i, cardB: best[1].i };
  }
  return { type: 'pass' };
}

module.exports = { decideAction, reactAction, preAction, handScore, greedyMelds };
