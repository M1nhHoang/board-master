// ─── Background Service Worker (entry point) ───
// Handles hotkey commands, API calls, and relays messages

import { analyzePosition, analyzeGomokuPosition, analyzeGomokuSwap2 } from './api.js';
import { buildUpdateMessage } from './evaluation.js';

function ruleNameToNumber(name) {
  const map = {
    'freestyle':       0,
    'standard-renju':  1,
    'free-renju':      2,
    // Freestyle main rule + swap opening protocol. Use these rule
    // codes for /move during the opening; the dedicated /swap2
    // endpoint drives the actual swap-protocol decisions.
    'free-swap1':      5,
    'free-swap2':      6,
  };
  return map[name] ?? 0;
}

// ─── Hotkey commands ───
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-hints') {
    chrome.runtime.sendMessage({ command: 'toggleHints' });
    broadcastToContentScripts({ command: 'toggleHints' });
  }
  if (command === 'toggle-auto') {
    chrome.runtime.sendMessage({ command: 'toggleAuto' });
    broadcastToContentScripts({ command: 'toggleAuto' });
  }
});

// ─── Message handling ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script sent a FEN for analysis
  if (msg.command === 'analyzeFEN') {
    console.log('[BM][bg] analyzeFEN received:', msg.fen);
    chrome.storage.local.get('boardMasterState', (result) => {
      const st = result.boardMasterState || {};
      const settings = st.chessSettings || { skillLevel: 20, searchDepth: 12, multiPV: 3 };
      console.log('[BM][bg] Calling API with settings:', JSON.stringify(settings));

      // Notify popup that analysis is in progress
      safeSend({ command: 'analysisStarted' });

      analyzePosition(msg.fen, settings)
        .then((apiResult) => {
          console.log('[BM][bg] API response:', JSON.stringify(apiResult));
          const update = buildUpdateMessage(apiResult, settings, msg.fen);
          console.log('[BM][bg] Sending updateHints:', JSON.stringify(update));
          safeSend(update);
          // Forward to content script — either the sender tab or the active tab
          if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, update).catch(() => {});
          } else {
            // Request came from popup — send to active tab
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, update).catch(() => {});
              }
            });
          }
        })
        .catch((err) => {
          console.error('[BM][bg] API error:', err);
          safeSend({
            command: 'analysisError',
            error: err.message || 'API request failed',
          });
        });
    });
    return false;
  }

  // Content script sent gomoku board for analysis
  if (msg.command === 'analyzeGomoku') {
    console.log('[BM][bg] analyzeGomoku received, moves:', msg.moves?.length,
      'rulePref:', msg.rulePreference || '(none)');
    chrome.storage.local.get('boardMasterState', (result) => {
      const st = result.boardMasterState || {};
      const settings = st.gomokuSettings || { searchDepth: 10 };
      // Content script may force a specific rule (e.g. 'free-swap2' = 6)
      // during a swap2 game so renju constraints don't kick in. Honour
      // that override before falling back to user/state defaults.
      const ruleName = msg.rulePreference || st.gomokuRule || settings.defaultRule || 'freestyle';
      const rule = ruleNameToNumber(ruleName);
      const maxDepth = settings.searchDepth || 10;
      console.log('[BM][bg] Gomoku rule:', ruleName, '→', rule, 'depth:', maxDepth);

      safeSend({ command: 'analysisStarted' });

      analyzeGomokuPosition(msg.boardSize, rule, msg.moves, maxDepth)
        .then((apiResult) => {
          console.log('[BM][bg] Gomoku API response:', JSON.stringify(apiResult));
          if (apiResult.success && apiResult.move) {
            const update = {
              command: 'updateGomokuHints',
              move: apiResult.move,
              turn: msg.turn || 'X',
              engineTime: (apiResult.engineTime || 0) + 'ms',
              totalMoves: msg.moves?.length || 0,
              isRetry: msg.isRetry || false,
            };
            safeSend(update);
            if (sender.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, update).catch(() => {});
            } else {
              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) {
                  chrome.tabs.sendMessage(tabs[0].id, update).catch(() => {});
                }
              });
            }
          } else {
            safeSend({
              command: 'analysisError',
              error: apiResult.error || 'Gomoku engine returned no move',
            });
          }
        })
        .catch((err) => {
          console.error('[BM][bg] Gomoku API error:', err);
          safeSend({
            command: 'analysisError',
            error: err.message || 'Gomoku API request failed',
          });
        });
    });
    return false;
  }

  // Swap2 protocol decision (opening / swap / move / put_two)
  if (msg.command === 'analyzeGomokuSwap2') {
    console.log('[BM][bg] analyzeGomokuSwap2 received, stones:', msg.moves?.length);
    chrome.storage.local.get('boardMasterState', (result) => {
      const st = result.boardMasterState || {};
      const settings = st.gomokuSettings || { searchDepth: 10 };
      const maxDepth = settings.searchDepth || 10;
      console.log('[BM][bg] swap2 → POST /api/games/gomoku/swap2',
        JSON.stringify({ boardSize: msg.boardSize, moves: msg.moves, maxDepth }));

      safeSend({ command: 'analysisStarted' });

      analyzeGomokuSwap2(msg.boardSize, msg.moves, maxDepth)
        .then((apiResult) => {
          console.log('[BM][bg] Gomoku swap2 response:', JSON.stringify(apiResult));
          if (!apiResult.success) {
            safeSend({
              command: 'analysisError',
              error: apiResult.error || 'swap2 engine returned no decision',
            });
            return;
          }
          const update = {
            command: 'updateGomokuSwap2',
            action: apiResult.action,                      // opening|swap|move|put_two
            move:   apiResult.move  || null,               // when action === 'move'
            moves:  apiResult.moves || [],                 // when action === 'opening' | 'put_two'
            engineTime: (apiResult.engineTime || 0) + 'ms',
            stoneCount: msg.moves?.length || 0,
          };
          safeSend(update);
          if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, update).catch(() => {});
          } else {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, update).catch(() => {});
            });
          }
        })
        .catch((err) => {
          console.error('[BM][bg] Gomoku swap2 API error:', err);
          safeSend({
            command: 'analysisError',
            error: err.message || 'Gomoku swap2 API request failed',
          });
        });
    });
    return false;
  }

  // Popup requests analysis for the current tab
  if (msg.command === 'requestAnalysis') {
    broadcastToContentScripts({ command: 'getFEN' });
    return false;
  }

  // Popup asks us to ensure content scripts are loaded
  if (msg.command === 'ensureScripts') {
    ensureContentScripts(msg.tabId, msg.url).then(() => {
      sendResponse();
    });
    return true; // async sendResponse
  }

  // Content script messages → forward to popup
  if (sender.tab) {
    console.log('[BM][bg] Forwarding to popup:', msg.command);
    safeSend(msg);
  }

  return false;
});

// ─── Helpers ───

// Safe send — popup may not be open
function safeSend(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function broadcastToContentScripts(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, message);
    }
  });
}

// Inject content scripts into a tab that doesn't have them yet
// (e.g. tab was open before extension was loaded/reloaded)
async function ensureContentScripts(tabId, url) {
  if (!url) return false;
  const chessComMatch = url.startsWith('https://www.chess.com/');
  const lichessMatch  = url.startsWith('https://lichess.org/');
  const facebookCaroMatch = (url.includes('facebook.com') && url.includes('/gaming/play/')) || url.includes('fbsbx.com');
  if (!chessComMatch && !lichessMatch && !facebookCaroMatch) return false;

  try {
    // Test if content script is already there
    await chrome.tabs.sendMessage(tabId, { command: 'ping' });
    return true; // already injected
  } catch (_) {
    // Not injected — do it now
  }

  console.log('[BM][bg] Injecting content scripts into tab', tabId);
  try {
    if (facebookCaroMatch) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/gomoku.js'],
      });
    } else {
      // Inject the page-world FEN reader for chess.com
      if (chessComMatch) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/chess/chesscom-page.js'],
          world: 'MAIN',
        });
      }
      // Inject shared scripts
      const files = chessComMatch
        ? ['content/chess/arrows.js', 'content/chess/core.js', 'content/chess/chesscom.js']
        : ['content/chess/arrows.js', 'content/chess/core.js', 'content/chess/lichess.js'];
      await chrome.scripting.executeScript({
        target: { tabId },
        files,
      });
    }
    console.log('[BM][bg] Content scripts injected successfully');
    return true;
  } catch (err) {
    console.error('[BM][bg] Failed to inject content scripts:', err);
    return false;
  }
}
