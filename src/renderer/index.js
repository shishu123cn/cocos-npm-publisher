const { ipcRenderer } = require('electron');

const PACKAGE_NAME = 'cocos-npm-publisher';

const el = {
  plugins: document.getElementById('plugins'),
  consoleText: document.getElementById('console-text'),
  btnClearConsole: document.getElementById('btn-clear-console'),
};

function bumpVersion(version, type) {
  const v = String(version || '').trim();
  const clean = v.startsWith('v') ? v.slice(1) : v;
  const parts = clean.split('.');
  const major = Number(parts[0] || 0);
  const minor = Number(parts[1] || 0);
  const patch = Number(parts[2] || 0);

  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'major') return `${major + 1}.0.0`;
  return v;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

const state = {
  extensions: [],
  cards: [],
};

function setConsoleValue(val) {
  el.consoleText.value = val;
  el.consoleText.scrollTop = el.consoleText.scrollHeight;
}

function appendConsoleLine(line) {
  const current = el.consoleText.value;
  el.consoleText.value = current ? `${current}\n${line}` : line;
  el.consoleText.scrollTop = el.consoleText.scrollHeight;
}

function renderCards() {
  el.plugins.innerHTML = '';
  state.cards = [];

  if (state.extensions.length === 0) {
    el.plugins.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div>未发现可发布的扩展</div><div style="font-size:12px;opacity:0.6;">请确保 extensions 目录下的扩展包含 .npmrc 和 package.json</div></div>';
    return;
  }

  for (const extInfo of state.extensions) {
    const defaultNewVersion = bumpVersion(extInfo.currentVersion, 'patch');
    const card = document.createElement('div');
    card.className = 'card';

    const hasAuth = Boolean(extInfo.hasAuth);

    card.innerHTML = `
      <div class="card-top">
        <div class="card-name">${escapeHtml(extInfo.name)}</div>
        <div class="card-badges">
          <span class="card-auth-badge ${hasAuth ? 'authed' : 'no-auth'}">${hasAuth ? '✓ 已认证' : '⚠ 未登录'}</span>
          <span class="card-version-badge">v${escapeHtml(extInfo.currentVersion)}</span>
        </div>
      </div>
      ${extInfo.description ? `<div class="card-desc">${escapeHtml(extInfo.description)}</div>` : ''}
      <div class="card-registry" title="${escapeHtml(extInfo.registry)}">${escapeHtml(extInfo.registry)}</div>

      <div class="card-divider"></div>

      <div class="grid">
        <div class="field field-inline">
          <label>新版本 (Version)</label>
          <div class="row">
            <div class="version-arrow">
              <span class="ver-old">${escapeHtml(extInfo.currentVersion)}</span>
              →
            </div>
            <input class="version-input new-version-input" type="text" value="${escapeHtml(defaultNewVersion)}" />
            <div class="bump-buttons">
              <button class="bump-btn active" data-bump="patch" type="button">Patch</button>
              <button class="bump-btn" data-bump="minor" type="button">Minor</button>
              <button class="bump-btn" data-bump="major" type="button">Major</button>
            </div>
            <button class="btn publish-btn publish-inline" type="button" style="display:${hasAuth ? 'inline-flex' : 'none'};">
              发布
            </button>
          </div>
        </div>

        <div class="field">
          <label>发布说明 (Release Note)</label>
          <textarea class="release-note-textarea" placeholder="描述本次发布的变更内容…">${escapeHtml(extInfo.releaseNote || '')}</textarea>
        </div>

        <div class="field login-field" style="display:${hasAuth ? 'none' : 'flex'};">
          <label>NPM 登录</label>
          <input class="login-username" type="text" placeholder="用户名" value="" />
          <input class="login-password" type="password" placeholder="密码" value="" />
          <button class="btn login-btn" type="button">登录</button>
        </div>
      </div>
    `;

    const newVersionInput = card.querySelector('.new-version-input');
    const releaseNoteTextarea = card.querySelector('.release-note-textarea');
    const publishBtn = card.querySelector('.publish-btn');
    const loginField = card.querySelector('.login-field');
    const loginBtn = card.querySelector('.login-btn');
    const loginUsernameInput = card.querySelector('.login-username');
    const loginPasswordInput = card.querySelector('.login-password');
    const authBadge = card.querySelector('.card-auth-badge');

    const bumpButtons = Array.from(card.querySelectorAll('.bump-btn'));
    for (const btn of bumpButtons) {
      btn.addEventListener('click', () => {
        for (const b of bumpButtons) b.classList.toggle('active', b === btn);
        const bumpType = btn.dataset.bump;
        const computed = bumpVersion(extInfo.currentVersion, bumpType);
        newVersionInput.value = computed;
      });
    }

    publishBtn.addEventListener('click', async () => {
      if (state.cards.find((c) => c.cardEl === card)?.busy) return;
      const payload = {
        newVersion: newVersionInput.value.trim(),
        releaseNoteText: releaseNoteTextarea.value,
      };
      if (!payload.newVersion) {
        alert('请输入目标版本号');
        return;
      }

      // 记录发布前的版本号和发布说明，失败时用于回滚 UI
      const prevVersion = newVersionInput.value;
      const prevReleaseNote = releaseNoteTextarea.value;

      publishBtn.disabled = true;
      publishBtn.textContent = '发布中...';

      try {
        appendConsoleLine(`[${new Date().toLocaleTimeString()}] 发布: ${extInfo.name}@${payload.newVersion}`);
        const result = await ipcRenderer.invoke(`${PACKAGE_NAME}:publish-package`, extInfo, payload);
        if (result?.success) {
          // 发布成功后重新扫描以更新版本徽章
          await scanExtensions();
        } else {
          // 发布失败：主进程已回滚 package.json，UI 也恢复输入
          newVersionInput.value = prevVersion;
          releaseNoteTextarea.value = prevReleaseNote;
        }
      } catch (e) {
        appendConsoleLine(`[${new Date().toLocaleTimeString()}] 发布失败: ${e?.message || e}`);
        newVersionInput.value = prevVersion;
        releaseNoteTextarea.value = prevReleaseNote;
      } finally {
        publishBtn.disabled = false;
        publishBtn.textContent = '发布';
      }
    });

    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        const username = (loginUsernameInput.value || '').trim();
        const password = loginPasswordInput.value || '';
        if (!username || !password) {
          alert('请输入账号和密码');
          return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = '登录中...';
        try {
          appendConsoleLine(`[${new Date().toLocaleTimeString()}] 登录: ${extInfo.name}`);
          const result = await ipcRenderer.invoke(`${PACKAGE_NAME}:npm-login`, extInfo, { username, password });
          if (result?.success) {
            appendConsoleLine(`[${new Date().toLocaleTimeString()}] 登录成功`);
            extInfo.hasAuth = true;
            if (loginField) loginField.style.display = 'none';
            if (publishBtn) publishBtn.style.display = 'inline-flex';
            if (authBadge) {
              authBadge.className = 'card-auth-badge authed';
              authBadge.textContent = '✓ 已认证';
            }
          } else {
            appendConsoleLine(`[${new Date().toLocaleTimeString()}] 登录失败: ${result?.error || 'unknown error'}`);
            alert(result?.error || '登录失败');
          }
        } catch (e) {
          appendConsoleLine(`[${new Date().toLocaleTimeString()}] 登录失败: ${e?.message || e}`);
          alert(e?.message || '登录失败');
        } finally {
          loginBtn.disabled = false;
          loginBtn.textContent = '登录';
        }
      });
    }

    state.cards.push({
      cardEl: card,
      extInfo,
      busy: false,
      bumpType: 'patch',
      newVersionInput,
      releaseNoteTextarea,
      publishBtn,
    });

    el.plugins.appendChild(card);
  }
}

async function scanExtensions() {
  state.extensions = await ipcRenderer.invoke(`${PACKAGE_NAME}:scan-extensions`);
  renderCards();
}

function bindEvents() {
  el.btnClearConsole.addEventListener('click', () => {
    setConsoleValue('');
  });

  ipcRenderer.on(`${PACKAGE_NAME}:log`, (event, log) => {
    const ts = log?.timestamp || new Date().toLocaleTimeString();
    const level = log?.level || 'info';
    const prefix = `[${ts}] ${level.toUpperCase()} `;
    appendConsoleLine(prefix + (log?.message ?? ''));
  });
}

async function init() {
  bindEvents();
  setConsoleValue('');
  await scanExtensions();
}

init();

