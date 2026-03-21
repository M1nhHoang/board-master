// ─── Auto Mode View ───

function updateAutoView() {
  const isChess = state.gameType === 'chess';

  $('#auto-game-badge').textContent = gameBadgeText();

  const ruleLine = $('#auto-rule-line');
  if (isChess) {
    ruleLine.style.display = 'none';
  } else {
    ruleLine.style.display = '';
    ruleLine.textContent = `Rule: ${capitalize(state.gomokuRule)}`;
  }

  if (isChess) {
    $('#auto-next-move').textContent = state.autoNext;
    $('#auto-next-eval').textContent = `[${state.autoNextEval}]`;
    $('#auto-next-eval').style.display = '';
    $('#auto-action-label').textContent = 'Playing in:';
    $('#auto-countdown-text').textContent = state.autoCountdown + 's';
    $('#auto-countdown-fill').style.width = state.autoCountdownPercent + '%';
    $('#auto-count-label').textContent = 'Moves played:';
    $('#auto-count-value').textContent = String(state.autoMoves);
    $('#auto-win-line').style.display = '';
    $('#auto-win-value').textContent = state.evalPercent + '%';
  } else {
    $('#auto-next-move').textContent = state.gomokuAutoNext;
    $('#auto-next-eval').style.display = 'none';
    $('#auto-action-label').textContent = 'Placing in:';
    $('#auto-countdown-text').textContent = state.gomokuAutoCountdown + 's';
    $('#auto-countdown-fill').style.width = state.gomokuAutoCountdownPercent + '%';
    $('#auto-count-label').textContent = 'Stones placed:';
    $('#auto-count-value').textContent = String(state.gomokuStones);
    $('#auto-win-line').style.display = 'none';
  }

  $('#auto-eval-section').style.display = (isChess && state.chessSettings.showEvalBar) ? '' : 'none';
  if (isChess) {
    $('#auto-eval-bar-fill').style.width = state.evalPercent + '%';
    $('#auto-eval-score').textContent = `${state.evalSide} ${state.evalScore}`;
    $('#auto-eval-depth').textContent = `Depth: ${state.evalDepth}`;
  }
}
