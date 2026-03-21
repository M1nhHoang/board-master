// ─── Lichess Platform Adapter ───
// Handles board detection and FEN reading for lichess.org

(function () {
  'use strict';

  // ─── Board detection ───
  function detectGame() {
    return !!document.querySelector('cg-board, .cg-wrap');
  }

  // ─── FEN reading ───
  // Lichess exposes the FEN in several DOM locations.
  function readFen() {
    // 1. Dedicated .fen element (analysis board)
    const fenEl = document.querySelector('.fen');
    if (fenEl) return fenEl.textContent.trim();

    // 2. og:description meta (contains FEN on game pages)
    const meta = document.querySelector('meta[property="og:description"]');
    if (meta) {
      const match = meta.content?.match(
        /^([rnbqkpRNBQKP1-8/]+ [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+)/
      );
      if (match) return match[1];
    }

    return null;
  }

  function requestFen() {
    return Promise.resolve(readFen());
  }

  // ─── Auto-push on move change ───
  let lastKnownFen = '';

  function onGameDetected() {
    // Poll for FEN changes (lichess re-renders the board on each move)
    setInterval(() => {
      const fen = readFen();
      if (fen && fen !== lastKnownFen) {
        lastKnownFen = fen;
        ChessCore.handleFenChange(fen);
      }
    }, 500);
  }

  // ─── Register with core ───
  ChessCore.register('lichess.org', {
    detectGame,
    requestFen,
    onGameDetected,
  });
})();
