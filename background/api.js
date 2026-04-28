// ─── Chess API Client ───

export const API_BASE = 'https://minhhoang.info';

export async function analyzePosition(fen, settings) {
  const body = { fen };
  if (settings.searchDepth) body.depth = settings.searchDepth;
  if (settings.multiPV) body.multiPV = settings.multiPV;
  if (settings.skillLevel !== undefined) body.skillLevel = settings.skillLevel;

  const resp = await fetch(`${API_BASE}/api/games/chess/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export async function analyzeGomokuPosition(boardSize, rule, moves, maxDepth) {
  const body = { boardSize, rule, moves };
  if (maxDepth) body.maxDepth = maxDepth;

  const resp = await fetch(`${API_BASE}/api/games/gomoku/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Gomoku API error: ${resp.status}`);
  return resp.json();
}

// Drive the swap2 opening protocol. Send 0, 3, or 5 stones; engine
// returns one of: { action: 'opening', moves: [3] } when proposer,
// 'swap' / 'move' / 'put_two' when chooser. See swap2.md.
export async function analyzeGomokuSwap2(boardSize, moves, maxDepth) {
  const body = { boardSize, moves };
  if (maxDepth) body.maxDepth = maxDepth;

  const resp = await fetch(`${API_BASE}/api/games/gomoku/swap2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Gomoku swap2 API error: ${resp.status}`);
  return resp.json();
}
