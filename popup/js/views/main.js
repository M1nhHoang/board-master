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

  // Sync rule dropdown selection + label with current state. Without
  // this, the hardcoded "selected" on Freestyle in popup.html persists
  // even when the user (or migration) changed gomokuRule to something
  // else.
  if (!isChess) {
    const ruleLabel = $('#rule-dropdown-label');
    if (ruleLabel) {
      ruleLabel.textContent = `Rule: ${capitalize(state.gomokuRule)}`;
    }
    document.querySelectorAll('#rule-dropdown-menu .dropdown-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.rule === state.gomokuRule);
    });
  }

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
  const swap2Advice = swap2AdviceText();
  if (swap2Advice) {
    $('#gomoku-hint-pos').textContent = swap2Advice;
  } else {
    $('#gomoku-hint-pos').textContent = `${label} → ${state.gomokuHintPos}`;
  }
  $('#gomoku-hint-engine').textContent = `Engine: ${state.gomokuEngineTime}`;
}

// Map a /swap2 protocol decision to a short advice line:
//   stoneCount=0           → we're proposer, place 3 opening stones
//   stoneCount=3, swap     → we're chooser; pick BLACK (click swap)
//   stoneCount=3, move     → we're chooser; keep WHITE, play stone 4
//   stoneCount=3, put_two  → we're chooser; place 2 balancing stones
//                            (proposer picks colour next)
//   stoneCount=5, swap     → we're proposer; SWAP colours (click swap)
//   stoneCount=5, move     → we're proposer; keep colour, play stone 6
function swap2AdviceText() {
  const a = state.gomokuSwap2Action;
  const n = state.gomokuSwap2StoneCount;
  if (!a) return '';
  const tail = state.gomokuHintPos ? ` → ${state.gomokuHintPos}` : '';
  if (n === 0 && a === 'opening') {
    return `Place 3 opening stones${tail}`;
  }
  if (n === 3) {
    if (a === 'swap')    return 'Pick BLACK — click "swap" on Playok';
    if (a === 'move')    return `Keep WHITE — play stone 4${tail}`;
    if (a === 'put_two') return `Place 2 balancing stones${tail}`;
  }
  if (n === 5) {
    if (a === 'swap')    return 'SWAP colours — click "swap" on Playok';
    if (a === 'move')    return `Keep colour — play stone 6${tail}`;
  }
  return '';
}
