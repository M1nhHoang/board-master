// ─── Xiangqi Content Script ───
// Detects xiangqi games on playok.com and xiangqi.com

(function () {
  'use strict';

  const hostname = location.hostname;
  let platform = '';

  if (hostname.includes('playok.com')) platform = 'playok.com';
  else if (hostname.includes('xiangqi.com')) platform = 'xiangqi.com';
  else return;

  // playok also serves gomoku/checkers/etc — only run on the xiangqi
  // path to avoid spamming xiangqi gameDetected from other games.
  if (platform === 'playok.com' && !/\/xiangqi(\/|$)/i.test(location.pathname)) {
    return;
  }

  let contextValid = true;
  let notified = false;
  let observer = null;

  function detectGame() {
    if (platform === 'playok.com') {
      return !!document.querySelector('canvas, .board, #board');
    }
    if (platform === 'xiangqi.com') {
      return !!document.querySelector('.board, .game-board, canvas');
    }
    return false;
  }

  function safeSend(msg) {
    if (!contextValid) return;
    try { chrome.runtime.sendMessage(msg); }
    catch (e) {
      if (e && e.message && e.message.includes('Extension context invalidated')) {
        contextValid = false;
        if (observer) { observer.disconnect(); observer = null; }
      }
    }
  }

  function notifyGameDetected() {
    if (notified) return;
    notified = true;
    safeSend({ command: 'gameDetected', gameType: 'xiangqi', platform });
    if (observer) { observer.disconnect(); observer = null; }
  }

  observer = new MutationObserver(() => {
    if (!contextValid) { observer.disconnect(); observer = null; return; }
    if (detectGame()) notifyGameDetected();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (detectGame()) notifyGameDetected();

  chrome.runtime.onMessage.addListener(() => {});
})();
