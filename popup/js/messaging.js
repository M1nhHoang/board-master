// ─── Communication with content scripts ───

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, message);
    }
  });
}

// ─── Listen for messages from background / content scripts ───
chrome.runtime.onMessage.addListener((msg) => {
  console.log('[BM][popup] Message received:', msg.command, msg);

  if (msg.command === 'gameDetected') {
    state.connected = true;
    state.gameType = msg.gameType || 'chess';
    state.platform = msg.platform || '';
    state.view = 'main';
    saveState();
    navigateTo('main');
  }

  if (msg.command === 'analysisStarted') {
    state.analyzing = true;
    if (state.view === 'main') updateMainView();
    return;
  }

  if (msg.command === 'analysisError') {
    state.analyzing = false;
    state.lastError = msg.error || 'Unknown error';
    if (state.view === 'main') updateMainView();
    return;
  }

  if (msg.command === 'updateHints') {
    console.log('[BM][popup] updateHints \u2014 hints:', msg.hints?.length, 'eval:', msg.evalScore, 'engine:', msg.engineTime);
    state.analyzing = false;
    state.lastError = '';
    if (msg.hints) state.hints = msg.hints;
    if (msg.ponder !== undefined) state.ponder = msg.ponder;
    if (msg.engineTime !== undefined) state.engineTime = msg.engineTime;
    if (msg.evalScore !== undefined) state.evalScore = msg.evalScore;
    if (msg.evalPercent !== undefined) state.evalPercent = msg.evalPercent;
    if (msg.evalDepth !== undefined) state.evalDepth = msg.evalDepth;
    if (msg.evalSide !== undefined) state.evalSide = msg.evalSide;

    if (msg.hints && msg.hints.length > 0) {
      state.autoNext = msg.hints[0].move;
      state.autoNextEval = msg.hints[0].eval;
    }

    saveState();
    if (state.view === 'main') updateMainView();
    if (state.view === 'auto') {
      updateAutoView();
      if (state.autoMode) startAutoCountdown();
    }
  }

  if (msg.command === 'updateGomokuHints') {
    state.analyzing = false;
    state.lastError = '';
    if (msg.turn) state.gomokuTurn = msg.turn;
    if (msg.move) {
      const col = String.fromCharCode(65 + msg.move.x);
      const row = msg.move.y + 1;
      state.gomokuHintPos = col + row;
      state.gomokuAutoNext = col + row;
    }
    if (msg.engineTime) state.gomokuEngineTime = msg.engineTime;
    if (msg.totalMoves !== undefined) state.gomokuStones = msg.totalMoves;
    // Regular /move response → not in a swap2 decision phase any more.
    state.gomokuSwap2Action = '';
    state.gomokuSwap2StoneCount = 0;

    saveState();
    if (state.view === 'main') updateMainView();
    if (state.view === 'auto') {
      updateAutoView();
      if (state.autoMode) startGomokuAutoCountdown();
    }
  }

  if (msg.command === 'updateGomokuSwap2') {
    state.analyzing = false;
    state.lastError = '';
    state.gomokuSwap2Action = msg.action || '';
    state.gomokuSwap2StoneCount = msg.stoneCount || 0;
    if (msg.engineTime) state.gomokuEngineTime = msg.engineTime;
    // First proposed/highlighted stone (if any) — for actions that
    // produce a single move ('move') or a list ('opening'/'put_two')
    // surface its coords so renderGomokuHint can show them.
    const firstMove = msg.move || (msg.moves && msg.moves[0]) || null;
    if (firstMove) {
      const col = String.fromCharCode(65 + firstMove.x);
      const row = firstMove.y + 1;
      state.gomokuHintPos = col + row;
    } else {
      state.gomokuHintPos = '';
    }
    saveState();
    if (state.view === 'main') updateMainView();
  }

  if (msg.command === 'updateAuto') {
    Object.assign(state, msg.payload);
    saveState();
    if (state.view === 'auto' || (state.view === 'main' && state.autoMode)) updateAutoView();
  }

  if (msg.command === 'toggleHints') {
    state.hintsOn = !state.hintsOn;
    saveState();
    const toggle = $('#toggle-hints');
    if (toggle) toggle.classList.toggle('on', state.hintsOn);
    updateMainView();
  }

  if (msg.command === 'toggleAuto') {
    state.autoMode = !state.autoMode;
    if (!state.autoMode) stopAutoCountdown();
    saveState();
    navigateTo('main');
  }
});

// ─── Auto-mode countdown ───
let autoCountdownTimer = null;

function startAutoCountdown() {
  stopAutoCountdown();
  const delay = state.chessSettings?.autoDelay || 1000;
  const totalMs = delay;
  let remaining = totalMs;
  const step = 100; // update every 100ms

  state.autoCountdown = (remaining / 1000).toFixed(1);
  state.autoCountdownPercent = 100;
  updateAutoView();

  autoCountdownTimer = setInterval(() => {
    remaining -= step;
    if (remaining <= 0) {
      remaining = 0;
      stopAutoCountdown();
    }
    state.autoCountdown = (remaining / 1000).toFixed(1);
    state.autoCountdownPercent = Math.round((remaining / totalMs) * 100);
    updateAutoView();
  }, step);
}

function stopAutoCountdown() {
  if (autoCountdownTimer) {
    clearInterval(autoCountdownTimer);
    autoCountdownTimer = null;
  }
}

function startGomokuAutoCountdown() {
  stopAutoCountdown();
  const delay = state.gomokuSettings?.autoDelay || 1000;
  let remaining = delay;
  const step = 100;

  state.gomokuAutoCountdown = (remaining / 1000).toFixed(1);
  state.gomokuAutoCountdownPercent = 100;
  updateAutoView();

  autoCountdownTimer = setInterval(() => {
    remaining -= step;
    if (remaining <= 0) {
      remaining = 0;
      stopAutoCountdown();
    }
    state.gomokuAutoCountdown = (remaining / 1000).toFixed(1);
    state.gomokuAutoCountdownPercent = Math.round((remaining / delay) * 100);
    updateAutoView();
  }, step);
}
