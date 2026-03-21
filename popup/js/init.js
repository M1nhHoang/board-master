// ─── UI Setup ───

function setupHintToggle() {
  const toggle = $('#toggle-hints');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    state.hintsOn = !state.hintsOn;
    toggle.classList.toggle('on', state.hintsOn);
    saveState();
    updateMainView();
    // Tell content script to show/hide board arrows
    sendToActiveTab({ command: 'toggleHints', visible: state.hintsOn });
  });
}

function setupRuleDropdown() {
  const btn = $('#rule-dropdown-btn');
  const menu = $('#rule-dropdown-menu');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });

  menu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      state.gomokuRule = item.dataset.rule;
      menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      $('#rule-dropdown-label').textContent = `Rule: ${capitalize(state.gomokuRule)}`;
      menu.classList.remove('open');
      saveState();
    });
  });
}

// Close dropdowns on outside click
document.addEventListener('click', () => {
  $$('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
});

// ─── Init ───
async function init() {
  await loadState();
  console.log('[BM][popup] init() started');

  // Wire up navigation buttons
  $('#btn-view-platforms-empty').addEventListener('click', () => navigateTo('platforms'));
  $('#btn-view-platforms').addEventListener('click', () => navigateTo('platforms'));
  $('#btn-auto-platforms').addEventListener('click', () => navigateTo('platforms'));
  $('#btn-settings').addEventListener('click', () => navigateTo('settings'));
  $('#btn-auto-settings').addEventListener('click', () => navigateTo('settings'));
  $('#btn-settings-back').addEventListener('click', () => navigateTo('main'));
  $('#btn-platforms-back').addEventListener('click', () => navigateTo(state.connected ? 'main' : 'not-detected'));

  $('#btn-copy-email').addEventListener('click', () => {
    navigator.clipboard.writeText('boydammedamsamcotdien@gmail.com').then(() => {
      const btn = $('#btn-copy-email');
      const orig = btn.textContent;
      btn.textContent = '✅ Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 1500);
    });
  });

  $('#btn-auto-start').addEventListener('click', () => {
    state.autoMode = true;
    saveState();
    navigateTo('auto');
    // Ensure scripts are injected then start auto
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id && tab.url) {
        chrome.runtime.sendMessage(
          { command: 'ensureScripts', tabId: tab.id, url: tab.url },
          () => {
            chrome.tabs.sendMessage(tab.id, { command: 'startAuto' }, () => {
              if (chrome.runtime.lastError) {
                console.log('[BM][popup] startAuto error:', chrome.runtime.lastError.message);
              }
            });
          }
        );
      }
    });
  });

  $('#btn-auto-stop').addEventListener('click', () => {
    state.autoMode = false;
    stopAutoCountdown();
    saveState();
    navigateTo('main');
    sendToActiveTab({ command: 'stopAuto' });
  });

  $('#btn-reset-defaults').addEventListener('click', () => {
    if (state.gameType === 'chess') {
      state.chessSettings = Object.assign({}, DEFAULT_STATE.chessSettings);
    } else {
      state.gomokuSettings = Object.assign({}, DEFAULT_STATE.gomokuSettings);
    }
    saveState();
    renderSettings();
  });

  setupHintToggle();
  setupRuleDropdown();

  // Proactive detection: check if the active tab has a game
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.url) {
      navigateTo(state.view);
      return;
    }

    const url = tab.url;
    const isChessSite = url.includes('chess.com') || url.includes('lichess.org');
    const isGomokuSite = url.includes('facebook.com/gaming/play/');

    if (isGomokuSite && tab.id) {
      console.log('[BM][popup] On gomoku site:', url);
      state.connected = true;
      state.gameType = 'gomoku';
      state.platform = 'facebook-caro';
      saveState();
      navigateTo('main');

      chrome.runtime.sendMessage(
        { command: 'ensureScripts', tabId: tab.id, url: url },
        () => {
          chrome.tabs.sendMessage(tab.id, { command: 'getFEN' }, () => {
            if (chrome.runtime.lastError) {
              console.log('[BM][popup] getFEN send error:', chrome.runtime.lastError.message);
            }
          });
        }
      );
    } else if (isChessSite && tab.id) {
      console.log('[BM][popup] On chess site:', url, '\u2014 sending getFEN to tab', tab.id);

      // Fallback: if content script doesn't respond within 3s, analyze starting position
      const fallbackTimer = setTimeout(() => {
        if (state.hints.length === 0 && !state.analyzing) {
          const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
          console.log('[BM][popup] No response from content script \u2014 fallback: analyzing starting position');
          chrome.runtime.sendMessage({ command: 'analyzeFEN', fen: startFen, platform: state.platform });
        }
      }, 3000);

      const clearFallback = (msg) => {
        if (msg.command === 'updateHints') {
          clearTimeout(fallbackTimer);
          chrome.runtime.onMessage.removeListener(clearFallback);
        }
      };
      chrome.runtime.onMessage.addListener(clearFallback);

      // Ask background to ensure content scripts are injected, then request FEN
      chrome.runtime.sendMessage(
        { command: 'ensureScripts', tabId: tab.id, url: url },
        () => {
          chrome.tabs.sendMessage(tab.id, { command: 'getFEN' }, () => {
            if (chrome.runtime.lastError) {
              console.log('[BM][popup] getFEN send error:', chrome.runtime.lastError.message);
            }
          });
        }
      );

      state.connected = true;
      state.gameType = 'chess';
      state.platform = url.includes('chess.com') ? 'chess.com' : 'lichess.org';
      saveState();
      navigateTo('main');
    } else {
      // Not on a supported game site — reset connection
      state.connected = false;
      state.platform = '';
      saveState();
      navigateTo('not-detected');
    }
  });
}

init();
