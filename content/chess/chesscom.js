// ─── Chess.com Platform Adapter ───
// Board detection & FEN reading for chess.com.
// The page-world FEN reader is loaded separately via manifest (chesscom-page.js).

(function () {
  'use strict';

  // ─── Board detection ───
  function detectGame() {
    const el = document.querySelector('wc-chess-board, chess-board, .board');
    if (el) console.log('[BM][chess.com] detectGame found:', el.tagName);
    return !!el;
  }

  // ─── FEN request (content-script ↔ page bridge via CustomEvents) ───
  function requestFen() {
    return new Promise((resolve) => {
      const handler = (e) => {
        window.removeEventListener('bm-fen-response', handler);
        const fen = e.detail?.fen || null;
        console.log('[BM][chess.com] requestFen got:', fen);
        resolve(fen);
      };
      window.addEventListener('bm-fen-response', handler);
      window.dispatchEvent(new Event('bm-request-fen'));

      setTimeout(() => {
        window.removeEventListener('bm-fen-response', handler);
        console.log('[BM][chess.com] requestFen timeout (1s)');
        resolve(null);
      }, 1000);
    });
  }

  // ─── Listen for automatic FEN pushes from page script ───
  function onGameDetected() {
    console.log('[BM][chess.com] onGameDetected — listening for FEN changes...');

    window.addEventListener('bm-fen-changed', (e) => {
      console.log('[BM][chess.com] bm-fen-changed:', e.detail?.fen);
      ChessCore.handleFenChange(e.detail?.fen);
    });
  }

  // ─── Perform a move via DOM simulation (content → page bridge) ───
  function performMove(from, to) {
    return new Promise((resolve) => {
      const handler = (e) => {
        window.removeEventListener('bm-auto-move-done', handler);
        console.log('[BM][chess.com] autoMove done:', e.detail);
        resolve(true);
      };
      window.addEventListener('bm-auto-move-done', handler);
      window.dispatchEvent(new CustomEvent('bm-auto-move', { detail: { from, to } }));

      setTimeout(() => {
        window.removeEventListener('bm-auto-move-done', handler);
        resolve(false);
      }, 2000);
    });
  }

  // ─── Register with core ───
  ChessCore.register('chess.com', {
    detectGame,
    requestFen,
    onGameDetected,
    performMove,
  });
})();
