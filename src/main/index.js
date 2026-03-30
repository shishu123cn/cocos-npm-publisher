const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PanelManager = require('./panel-manager');

const PACKAGE_NAME = 'cocos-npm-publisher';

function getProjectPath() {
  try {
    // Creator 3.x 会把 Editor 挂到全局变量
    if (typeof Editor !== 'undefined' && Editor.Project && Editor.Project.path) {
      return Editor.Project.path;
    }
  } catch (e) {}
  return process.env.COCOS_PROJECT_PATH || process.cwd();
}

function detectIndent(jsonText) {
  // 尝试从 "    " 这种缩进推断（兼容 2/4 空格等）
  const m = jsonText.match(/\n(\s+)"[^"]+":/);
  if (!m) return 2;
  return m[1].length;
}

function parseRegistryFromNpmrc(npmrcText) {
  const lines = npmrcText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('registry=')) {
      const value = line.slice('registry='.length).trim();
      return value;
    }
  }
  return '';
}

function checkHasAuth(npmrcText) {
  // 不强依赖具体字段名，只要存在 auth 相关内容就认为“已登录”
  return /_authToken\s*=|_auth\s*=|_password\s*=|always-auth\s*=\s*true|auth\s*=|username\s*=/i.test(npmrcText);
}

function normalizeNpmrcAuth(npmrcText, registry) {
  // 修复 npm warn：新版 npm 不接受 //host/path/:always-auth=true 这种 scoped always-auth
  // 我们在发布前自动清理，并确保全局 always-auth=true（当存在 auth 时）。
  const authScope = getAuthScopeFromRegistry(registry);
  if (!authScope) return { changed: false, text: npmrcText };

  const lines = String(npmrcText || '').split(/\r?\n/).map((l) => l.trimEnd());
  const hasAuth = /_authToken\s*=|_auth\s*=|_password\s*=|auth\s*=|username\s*=/i.test(npmrcText);

  let changed = false;
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true;
    // 删除旧的全局 always-auth（npm v9+ 已废弃，会触发 warning 且被忽略）
    if (t.startsWith('always-auth=')) {
      changed = true;
      return false;
    }
    // 删除旧的 scoped always-auth（后面统一重写）
    if (t.startsWith(`${authScope}:always-auth`)) {
      changed = true;
      return false;
    }
    return true;
  });

  if (hasAuth) {
    // 使用 scoped always-auth，npm v9+ 不再支持全局 always-auth
    filtered.push(`${authScope}:always-auth=true`);
  }

  const newText = filtered.join('\n') + '\n';
  return { changed: changed || newText !== npmrcText, text: newText };
}

function base64BasicAuth(username, password) {
  const u = String(username ?? '');
  const p = String(password ?? '');
  return Buffer.from(`${u}:${p}`).toString('base64');
}

function getAuthScopeFromRegistry(registry) {
  try {
    const u = new URL(registry);
    let pathname = u.pathname || '/';
    if (!pathname.endsWith('/')) pathname += '/';
    return `//${u.host}${pathname}`;
  } catch (e) {
    return '';
  }
}

function writeNpmrcAuth(npmrcText, registry, username, password) {
  const authScope = getAuthScopeFromRegistry(registry);
  if (!authScope) {
    throw new Error('registry 解析失败，无法生成 npmrc authScope');
  }

  const auth = base64BasicAuth(username, password);

  const lines = String(npmrcText || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd());

  // 删除旧的 auth 相关配置（保持其他行不动）
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true;
    if (t.startsWith('registry=')) return true;
    if (t.startsWith('always-auth=')) return false;
    if (t.includes(`${authScope}:_auth`)) return false;
    if (t.includes(`${authScope}:username`)) return false;
    if (t.includes(`${authScope}:always-auth`)) return false;
    if (t.includes(`${authScope}:_password`)) return false;
    if (t.startsWith(`${authScope}:_auth`)) return false;
    if (t.startsWith(`${authScope}:username`)) return false;
    if (t.startsWith(`${authScope}:always-auth`)) return false;
    if (t.startsWith(`${authScope}:_password`)) return false;
    return true;
  });

  // npm v9+ 已废弃全局 always-auth；使用 scoped always-auth 让 npm 对该 registry 始终发送认证头
  filtered.push(`${authScope}:_auth=${auth}`);
  filtered.push(`${authScope}:always-auth=true`);

  // 保证末尾换行
  return filtered.join('\n') + '\n';
}

function bumpVersion(version, type) {
  // 简化语义化版本号解析：只处理 x.y.z
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

function tryParseJsonMaybe(text) {
  // releaseNote 可能是字符串，也可能是 JSON（用户要求“格式正确”）
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {}
  }
  return raw;
}

function scanExtensions() {
  const projectPath = getProjectPath();
  const extensionsDir = path.join(projectPath, 'extensions');
  const results = [];

  if (!fs.existsSync(extensionsDir)) {
    return results;
  }

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const extDirPath = path.join(extensionsDir, e.name);
    const npmrcPath = path.join(extDirPath, '.npmrc');
    const pkgPath = path.join(extDirPath, 'package.json');

    // 按你的规则：只有存在 .npmrc 才认为可发布，并且 registry 来自 .npmrc
    if (!fs.existsSync(npmrcPath) || !fs.existsSync(pkgPath)) continue;

    try {
      const pkgText = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgText);
      const npmrcText = fs.readFileSync(npmrcPath, 'utf-8');

      const registry = parseRegistryFromNpmrc(npmrcText);
      if (!registry) continue;

      results.push({
        dirPath: extDirPath,
        name: pkg.name || e.name,
        description: pkg.description || '',
        currentVersion: pkg.version || '0.0.0',
        author: pkg.author || '',
        releaseNote: pkg.releaseNote || '',
        registry,
        hasAuth: checkHasAuth(npmrcText),
      });
    } catch (err) {
      // 忽略单个扩展的解析错误，避免阻断整个列表
      console.warn(`[${PACKAGE_NAME}] 扫描扩展失败: ${e.name}`, err?.message || err);
    }
  }

  return results;
}

async function publishPackage(event, extInfo, payload) {
  const { dirPath, name, registry } = extInfo;
  const { newVersion, releaseNoteText } = payload;

  function log(level, message) {
    const timestamp = new Date().toLocaleTimeString();
    event.sender.send(`${PACKAGE_NAME}:log`, {
      timestamp,
      level,
      message: String(message ?? ''),
    });
  }

  const pkgPath = path.join(dirPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    log('error', `[publish] package.json 不存在: ${pkgPath}`);
    return { success: false, error: 'package.json missing' };
  }

  // 先规范化 .npmrc，避免 npm 警告（不影响发布结果）
  const npmrcPath = path.join(dirPath, '.npmrc');
  if (fs.existsSync(npmrcPath)) {
    try {
      const npmrcText = fs.readFileSync(npmrcPath, 'utf-8');
      const normalized = normalizeNpmrcAuth(npmrcText, registry);
      if (normalized.changed) {
        fs.writeFileSync(npmrcPath, normalized.text, 'utf-8');
        log('info', '[publish] 已规范化 .npmrc（always-auth）');
      }
    } catch (e) {
      log('warn', `[publish] 规范化 .npmrc 失败: ${e?.message || e}`);
    }
  }

  // 1) 回写 package.json：author / version / releaseNote
  log('info', `[publish] 更新 package.json: ${name}`);
  const originalText = fs.readFileSync(pkgPath, 'utf-8');
  let pkg = null;
  try {
    pkg = JSON.parse(originalText);
  } catch (e) {
    log('error', `[publish] package.json 解析失败: ${e.message}`);
    return { success: false, error: e.message };
  }

  pkg.version = newVersion;

  const parsedReleaseNote = tryParseJsonMaybe(releaseNoteText);
  // releaseNote：允许普通字符串，也允许用户输入 JSON（对象/数组）后写回为正确结构
  if (parsedReleaseNote !== undefined) pkg.releaseNote = parsedReleaseNote;
  else pkg.releaseNote = String(releaseNoteText ?? '');

  const indent = detectIndent(originalText);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent), 'utf-8');

  // 2) npm publish（按你的要求：固定 --access public；registry 来自 .npmrc）
  return new Promise((resolve) => {
    log('info', `[publish] npm publish -> registry: ${registry}`);

    const cmdArgs = [
      'publish',
      '--registry',
      registry,
      '--access',
      'public',
    ];

    const child = spawn('npm', cmdArgs, {
      cwd: dirPath,
      shell: false,
      env: { ...process.env },
    });

    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      // 按行发送，避免 UI 一坨文字
      text.split(/\r?\n/).filter(Boolean).forEach((line) => log('info', line));
    });

    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      text.split(/\r?\n/).filter(Boolean).forEach((line) => {
        const t = line.trimStart();
        // npm 将 notice / warn 输出到 stderr，但它们不是真正的错误
        if (/^npm notice\b/i.test(t)) {
          log('info', line);
        } else if (/^npm warn\b/i.test(t)) {
          log('warn', line);
        } else {
          log('error', line);
        }
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        log('success', `[publish] 发布成功: ${name}@${newVersion}`);
        resolve({ success: true });
      } else {
        // 发布失败 — 回滚 package.json 到发布前的内容
        try {
          fs.writeFileSync(pkgPath, originalText, 'utf-8');
          log('warn', '[publish] 已回滚 package.json');
        } catch (rollbackErr) {
          log('error', `[publish] 回滚 package.json 失败: ${rollbackErr.message}`);
        }
        log('error', `[publish] 发布失败: exit code ${code}`);
        resolve({ success: false, error: `exit code ${code}` });
      }
    });

    child.on('error', (err) => {
      // 进程启动失败也回滚
      try {
        fs.writeFileSync(pkgPath, originalText, 'utf-8');
        log('warn', '[publish] 已回滚 package.json');
      } catch (rollbackErr) {
        log('error', `[publish] 回滚 package.json 失败: ${rollbackErr.message}`);
      }
      log('error', `[publish] 进程错误: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

function registerIpcHandlers() {
  ipcMain.handle(`${PACKAGE_NAME}:scan-extensions`, () => {
    return scanExtensions();
  });

  ipcMain.handle(`${PACKAGE_NAME}:publish-package`, async (event, extInfo, payload) => {
    try {
      return await publishPackage(event, extInfo, payload);
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle(`${PACKAGE_NAME}:npm-login`, async (event, extInfo, payload) => {
    const { dirPath } = extInfo || {};
    const { username, password } = payload || {};
    if (!dirPath) return { success: false, error: 'extDirPath missing' };
    if (!username || !password) return { success: false, error: 'username/password missing' };

    const npmrcPath = path.join(dirPath, '.npmrc');
    const pkgPath = path.join(dirPath, 'package.json');

    if (!fs.existsSync(npmrcPath)) return { success: false, error: '.npmrc 文件不存在' };
    if (!fs.existsSync(pkgPath)) return { success: false, error: 'package.json 文件不存在' };

    try {
      const npmrcText = fs.readFileSync(npmrcPath, 'utf-8');
      const registry = parseRegistryFromNpmrc(npmrcText);
      if (!registry) return { success: false, error: '.npmrc 中没有 registry=' };

      const newNpmrc = writeNpmrcAuth(npmrcText, registry, username, password);
      fs.writeFileSync(npmrcPath, newNpmrc, 'utf-8');

      // 验证是否写入了 auth
      const finalText = fs.readFileSync(npmrcPath, 'utf-8');
      if (!checkHasAuth(finalText)) return { success: false, error: '写入 auth 失败（未检测到 auth 配置）' };

      // 通过写入完成即认为登录成功（发布时由 npm 处理鉴权错误）
      return { success: true };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  });
}

function load() {
  registerIpcHandlers();
}

function unload() {
  // 这里不做 ipcMain remove，因为 Creator reload 可能导致 handler 重绑问题
  // 需要更严谨的话可以在此处清理 `${PACKAGE_NAME}:...` 相关监听
}

exports.load = load;
exports.unload = unload;

exports.methods = {
  openPanel() {
    PanelManager.open();
  },
};

