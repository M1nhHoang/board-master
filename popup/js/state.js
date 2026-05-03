// ─── Default State & Storage ───
const DEFAULT_STATE = {
  view: 'not-detected',
  gameType: 'chess',
  platform: '',
  connected: false,
  hintsOn: true,
  autoMode: false,

  chessSettings: {
    skillLevel: 20,
    searchDepth: 12,
    multiPV: 3,
    autoDelay: 1000,
    showEvalBar: true,
    showPVLines: true,
    showPonder: true,
    highlightBestMove: true,
  },

  gomokuSettings: {
    boardSize: 15,
    defaultRule: 'freestyle',
    searchDepth: 10,
    autoDelay: 1000,
    randomDelay: false,
    randomDelayMin: 200,
    randomDelayMax: 5000,
    highlightBestMove: true,
    // When true, the playok content script routes 0/3/5-stone
    // decision points through /api/games/gomoku/swap2 and auto-plays
    // the engine's chosen action (opening / swap / move / put_two).
    swap2: false,
  },

  // Runtime data (populated by API)
  analyzing: false,
  lastError: '',
  hints: [],
  ponder: '',
  engineTime: '—',
  evalScore: '0.00',
  evalPercent: 50,
  evalDepth: 0,
  evalSide: 'White',

  autoNext: '—',
  autoNextEval: '0.00',
  autoCountdown: 0,
  autoCountdownPercent: 0,
  autoMoves: 0,
  autoWinChance: 50,

  gomokuRule: 'freestyle',
  gomokuTurn: '',
  gomokuHintPos: '',
  gomokuEngineTime: '—',
  gomokuStones: 0,
  gomokuAutoNext: '',
  gomokuAutoCountdown: 0,
  gomokuAutoCountdownPercent: 0,
  // Swap2 protocol decision from the engine. action ∈
  // {'opening','swap','move','put_two', ''}; stoneCount = 0/3/5
  // (the protocol step we acted at). Used by the popup to surface
  // a colour-choice recommendation in addition to the board-cell
  // highlight.
  gomokuSwap2Action: '',
  gomokuSwap2StoneCount: 0,
};

let state = {};

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get('boardMasterState', (result) => {
      state = Object.assign({}, DEFAULT_STATE, result.boardMasterState || {});
      state.chessSettings = Object.assign({}, DEFAULT_STATE.chessSettings, state.chessSettings);
      state.gomokuSettings = Object.assign({}, DEFAULT_STATE.gomokuSettings, state.gomokuSettings);

      // Always reset runtime data — never restore stale analysis results
      state.analyzing = false;
      state.lastError = '';
      state.hints = [];
      state.ponder = '';
      state.engineTime = '\u2014';
      state.evalScore = '0.00';
      state.evalPercent = 50;
      state.evalDepth = 0;
      state.autoNext = '\u2014';
      state.autoNextEval = '0.00';
      state.autoCountdown = 0;
      state.autoCountdownPercent = 0;

      // Reset gomoku runtime data too
      state.gomokuTurn = '';
      state.gomokuHintPos = '';
      state.gomokuEngineTime = '\u2014';
      state.gomokuStones = 0;
      state.gomokuAutoNext = '';
      state.gomokuAutoCountdown = 0;
      state.gomokuAutoCountdownPercent = 0;
      state.gomokuSwap2Action = '';
      state.gomokuSwap2StoneCount = 0;

      // Migrate legacy rule keys from before the spec rename:
      //   'standard-renju' \u2192 'standard' (rule 1 = Standard Gomoku, no overline)
      //   'free-renju'     \u2192 'renju'    (rule 2 = Renju, black restricted)
      const RULE_MIGRATE = { 'standard-renju': 'standard', 'free-renju': 'renju' };
      if (RULE_MIGRATE[state.gomokuRule]) state.gomokuRule = RULE_MIGRATE[state.gomokuRule];
      if (RULE_MIGRATE[state.gomokuSettings.defaultRule]) {
        state.gomokuSettings.defaultRule = RULE_MIGRATE[state.gomokuSettings.defaultRule];
      }
      // Sync session rule with persisted default. If they drifted apart
      // (older builds let the two dropdowns set independent fields)
      // prefer defaultRule since that's the user's persisted choice.
      if (state.gomokuSettings.defaultRule && state.gomokuRule !== state.gomokuSettings.defaultRule) {
        state.gomokuRule = state.gomokuSettings.defaultRule;
      }

      console.log('[BM][popup] State loaded:', JSON.stringify(state, null, 2));
      resolve();
    });
  });
}

function saveState() {
  chrome.storage.local.set({ boardMasterState: state });
}
