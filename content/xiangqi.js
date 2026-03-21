// ─── Xiangqi Content Script ───
// Detects xiangqi games on playok.com and xiangqi.com

(function () {
  'use strict';

  const hostname = location.hostname;
  let platform = '';

  if (hostname.includes('playok.com')) platform = 'playok.com';
  else if (hostname.includes('xiangqi.com')) platform = 'xiangqi.com';
  else return;

  function detectGame() {
    if (platform === 'playok.com') {
      return !!document.querySelector('canvas, .board, #board');
    }
    if (platform === 'xiangqi.com') {
      return !!document.querySelector('.board, .game-board, canvas');
    }
    return false;
  }

  function notifyGameDetected() {
    chrome.runtime.sendMessage({
      command: 'gameDetected',
      gameType: 'xiangqi',
      platform: platform,
    });
  }

  const observer = new MutationObserver(() => {
    if (detectGame()) {
      notifyGameDetected();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  if (detectGame()) {
    notifyGameDetected();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.command) {
      case 'startAuto':
        break;
      case 'stopAuto':
        break;
      case 'toggleHints':
        break;
    }
  });
})();
