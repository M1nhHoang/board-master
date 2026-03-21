// ─── Main View (Chess & Gomoku hint display) ───

function gameBadgeText() {
  if (state.gameType === 'chess') return `♚ Chess · ${state.platform || 'unknown'}`;
  return `⊕ Gomoku · ${state.platform || 'unknown'}`;
}

function updateMainView() {
  const isChess = state.gameType === 'chess';

  $('#main-game-badge').textContent = gameBadgeText();

  $('#gomoku-rule-section').style.display = isChess ? 'none' : '';
  $('#hints-title').textContent = isChess ? 'HINTS' : 'HINT';

  const hintsOn = state.hintsOn;
  $('#chess-hints-card').style.display = (isChess && hintsOn) ? '' : 'none';
  $('#gomoku-hint-card').style.display = (!isChess && hintsOn) ? '' : 'none';

  if (isChess && hintsOn) renderChessHints();
  if (!isChess && hintsOn) renderGomokuHint();

  // Status text
  const statusEl = $('#main-status-text');
  if (statusEl) {
    statusEl.textContent = state.analyzing ? 'Analyzing…' : 'Connected';
  }

  $('#eval-section').style.display = (isChess && state.chessSettings.showEvalBar) ? '' : 'none';
  if (isChess) {
    $('#eval-bar-fill').style.width = state.evalPercent + '%';
    $('#eval-score').textContent = `${state.evalSide} ${state.evalScore}`;
    $('#eval-depth').textContent = `Depth: ${state.evalDepth}`;
  }
}

function renderChessHints() {
  const medals = ['🥇', '🥈', '🥉'];
  const list = $('#hints-list');
  list.innerHTML = '';

  const multiPV = state.chessSettings.multiPV;
  const hintsToShow = state.hints.slice(0, multiPV);

  if (hintsToShow.length === 0) {
    if (state.lastError) {
      list.innerHTML = `<div class="hint-row" style="opacity:0.7;justify-content:center;color:#dc2626;">⚠ ${escapeHtml(state.lastError)}</div>`;
    } else {
      list.innerHTML = '<div class="hint-row" style="opacity:0.5;justify-content:center;">Analyzing position…</div>';
    }
    $('#hint-ponder').style.display = 'none';
    $('#hint-engine').textContent = 'Engine: —';
    return;
  }

  hintsToShow.forEach((hint, i) => {
    const evalCls = hint.positive ? 'hint-eval' : 'hint-eval negative';
    const pvHtml = state.chessSettings.showPVLines
      ? `<div class="hint-pv">↳ ${escapeHtml(hint.pv)}</div>` : '';

    list.insertAdjacentHTML('beforeend', `
      <div class="hint-row">
        <span class="hint-medal">${medals[i] || ''}</span>
        <div class="hint-body">
          <div class="hint-move">
            <span class="hint-move-text">${escapeHtml(hint.move)}</span>
            <span class="${evalCls}">[${escapeHtml(hint.eval)}]</span>
          </div>
          ${pvHtml}
        </div>
      </div>
    `);
  });

  const ponderEl = $('#hint-ponder');
  ponderEl.style.display = state.chessSettings.showPonder ? '' : 'none';
  ponderEl.textContent = `Ponder: ${state.ponder}`;
  $('#hint-engine').textContent = `Engine: ${state.engineTime}`;
}

function renderGomokuHint() {
  const turn = state.gomokuTurn || '?';
  const label = turn === 'X' ? 'X (Black)' : turn === 'O' ? 'O (White)' : '?';
  $('#gomoku-hint-pos').textContent = `${label} → ${state.gomokuHintPos}`;
  $('#gomoku-hint-engine').textContent = `Engine: ${state.gomokuEngineTime}`;
}
