// ─── Settings View ───

function renderSettings() {
  const isChess = state.gameType === 'chess';
  $('#settings-title').textContent = isChess ? 'CHESS SETTINGS' : 'GOMOKU SETTINGS';

  const body = $('#settings-body');
  body.innerHTML = '';

  if (isChess) {
    const cs = state.chessSettings;

    body.innerHTML = `
      ${sliderHtml('Skill Level', 'skillLevel', cs.skillLevel, 0, 20, skillDesc(cs.skillLevel))}
      ${sliderHtml('Search Depth', 'searchDepth', cs.searchDepth, 1, 15)}
      <div class="setting-group">
        <div class="setting-label">Suggestions (multiPV)</div>
        <div class="multi-btn-group">
          ${[1, 2, 3].map(n =>
            `<button class="multi-btn${cs.multiPV === n ? ' selected' : ''}" data-mpv="${n}">${n}</button>`
          ).join('')}
        </div>
      </div>
      ${sliderHtml('Auto Move Delay (ms)', 'autoDelay', cs.autoDelay, 200, 5000)}
      ${toggleSettingHtml('Show Evaluation Bar', 'showEvalBar', cs.showEvalBar)}
      ${toggleSettingHtml('Show PV Lines', 'showPVLines', cs.showPVLines)}
      ${toggleSettingHtml('Show Ponder Move', 'showPonder', cs.showPonder)}
      ${toggleSettingHtml('Highlight Best Move', 'highlightBestMove', cs.highlightBestMove)}
    `;

    body.querySelectorAll('[data-mpv]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.chessSettings.multiPV = parseInt(btn.dataset.mpv, 10);
        saveState();
        renderSettings();
        // Re-analyze with new multiPV
        sendToActiveTab({ command: 'getFEN' });
      });
    });
  } else {
    const gs = state.gomokuSettings;

    body.innerHTML = `
      ${sliderHtml('Board Size', 'boardSize', gs.boardSize, 10, 22)}
      <div class="setting-group">
        <div class="setting-label">Default Rule</div>
        <div class="dropdown-wrapper" id="settings-rule-dropdown">
          <button class="dropdown-btn" id="settings-rule-btn">
            <span>${capitalize(gs.defaultRule)}</span>
            <span>▼</span>
          </button>
          <div class="dropdown-menu" id="settings-rule-menu">
            ${['Freestyle', 'Standard Renju', 'Free Renju'].map(r => {
              const key = r.toLowerCase();
              const sel = gs.defaultRule === key ? ' selected' : '';
              return `<div class="dropdown-item${sel}" data-srule="${key}"><span class="check">●</span> ${r}</div>`;
            }).join('')}
          </div>
        </div>
      </div>
      ${sliderHtml('Search Depth', 'searchDepth', gs.searchDepth, 1, 15)}
      ${sliderHtml('Auto Move Delay (ms)', 'autoDelay', gs.autoDelay, 200, 10000)}
      ${toggleSettingHtml('Random Delay', 'randomDelay', gs.randomDelay)}
      <div class="setting-group random-delay-range" style="display:${gs.randomDelay ? 'block' : 'none'}">
        ${sliderHtml('Min Delay (ms)', 'randomDelayMin', gs.randomDelayMin, 20, 10000)}
        ${sliderHtml('Max Delay (ms)', 'randomDelayMax', gs.randomDelayMax, 20, 10000)}
      </div>
      ${toggleSettingHtml('Highlight Best Move', 'highlightBestMove', gs.highlightBestMove)}
    `;

    const ruleBtn = body.querySelector('#settings-rule-btn');
    const ruleMenu = body.querySelector('#settings-rule-menu');
    if (ruleBtn) {
      ruleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ruleMenu.classList.toggle('open');
      });
    }
    body.querySelectorAll('[data-srule]').forEach(item => {
      item.addEventListener('click', () => {
        state.gomokuSettings.defaultRule = item.dataset.srule;
        saveState();
        renderSettings();
      });
    });
  }

  // Slider listeners
  body.querySelectorAll('input[type="range"]').forEach(slider => {
    slider.addEventListener('input', () => {
      const key = slider.dataset.key;
      const val = parseInt(slider.value, 10);
      const settingsObj = isChess ? state.chessSettings : state.gomokuSettings;
      settingsObj[key] = val;

      const valueEl = slider.parentElement.querySelector('.setting-current-value');
      if (valueEl) valueEl.textContent = String(val);

      if (key === 'skillLevel') {
        const sub = slider.parentElement.querySelector('.setting-sublabel');
        if (sub) sub.textContent = skillDesc(val);
      }

      saveState();

      // Re-analyze when engine parameters change
      if (['skillLevel', 'searchDepth'].includes(key)) {
        sendToActiveTab({ command: 'getFEN' });
      }
    });
  });

  // Toggle listeners
  body.querySelectorAll('.toggle[data-setting]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const key = toggle.dataset.setting;
      const settingsObj = isChess ? state.chessSettings : state.gomokuSettings;
      settingsObj[key] = !settingsObj[key];
      toggle.classList.toggle('on', settingsObj[key]);
      saveState();

      // Show/hide random delay range sliders
      if (key === 'randomDelay') {
        const rangeEl = body.querySelector('.random-delay-range');
        if (rangeEl) rangeEl.style.display = settingsObj[key] ? 'block' : 'none';
      }
    });
  });
}

// ─── Settings HTML helpers ───
function sliderHtml(label, key, value, min, max, sublabel) {
  const settingsKey = `data-key="${key}"`;
  return `
    <div class="setting-group">
      <div class="setting-label">
        ${escapeHtml(label)}
        <span class="setting-hint">${min} — ${max}</span>
      </div>
      <input type="range" min="${min}" max="${max}" value="${value}" ${settingsKey}>
      <div class="setting-value-row">
        ${sublabel ? `<span class="setting-sublabel">${escapeHtml(sublabel)}</span>` : '<span></span>'}
        <span class="setting-hint setting-current-value">${value}</span>
      </div>
    </div>
  `;
}

function toggleSettingHtml(label, key, isOn) {
  return `
    <div class="toggle-row">
      <span class="toggle-label">${escapeHtml(label)}</span>
      <div class="toggle${isOn ? ' on' : ''}" data-setting="${key}">
        <span class="toggle-knob"></span>
      </div>
    </div>
  `;
}
