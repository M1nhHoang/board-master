// ─── Evaluation & Move Formatting ───

// Convert UCI move "g1f3" → "g1→f3"
export function uciToArrow(uci) {
  if (!uci || uci.length < 4) return uci || '';
  return uci.slice(0, 2) + '→' + uci.slice(2);
}

// Convert evaluation to display format
export function formatEval(evaluation) {
  if (!evaluation) return { score: '0.00', percent: 50, positive: true };
  if (evaluation.type === 'mate') {
    const val = evaluation.value;
    return {
      score: (val > 0 ? '+' : '') + 'M' + Math.abs(val),
      percent: val > 0 ? 95 : 5,
      positive: val > 0,
    };
  }
  const cp = evaluation.value;
  const pawnVal = cp / 100;
  const score = (pawnVal >= 0 ? '+' : '') + pawnVal.toFixed(2);
  const percent = Math.round(50 + 50 * (2 / (1 + Math.exp(-cp / 200)) - 1));
  return { score, percent: Math.max(2, Math.min(98, percent)), positive: cp >= 0 };
}

// Determine whose turn it is from FEN
export function sideFromFen(fen) {
  if (!fen) return 'White';
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'Black' : 'White';
}

// Build hints/eval update message from API response
export function buildUpdateMessage(apiResult, settings, fen) {
  const ev = formatEval(apiResult.evaluation);
  const hints = (apiResult.lines || []).map((line) => {
    const lineEv = formatEval(line.score || apiResult.evaluation);
    return {
      move: uciToArrow(line.move),
      eval: lineEv.score,
      pv: (line.pv || []).slice(0, 5).map(uciToArrow).join(' '),
      positive: lineEv.positive,
    };
  });

  if (hints.length === 0 && apiResult.bestmove) {
    hints.push({
      move: uciToArrow(apiResult.bestmove),
      eval: ev.score,
      pv: '',
      positive: ev.positive,
    });
  }

  return {
    command: 'updateHints',
    hints,
    bestUci: apiResult.bestmove || '',
    ponder: uciToArrow(apiResult.ponder || ''),
    engineTime: (apiResult.engineTime || 0) + 'ms',
    evalScore: ev.score,
    evalPercent: ev.percent,
    evalDepth: settings.searchDepth || 12,
    evalSide: sideFromFen(fen),
  };
}
