const { BrowserWindow } = require('electron');
const { join } = require('path');

const PACKAGE_NAME = 'cocos-npm-publisher';

const PANEL = {
  width: 980,
  height: 720,
  minWidth: 900,
  minHeight: 650,
};

let win = null;

function open() {
  if (win) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: PANEL.width,
    height: PANEL.height,
    minWidth: PANEL.minWidth,
    minHeight: PANEL.minHeight,
    title: PACKAGE_NAME,
    autoHideMenuBar: true,
    resizable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.on('closed', () => {
    win = null;
  });

  win.on('ready-to-show', () => {
    win.show();
  });

  const htmlPath = join(__dirname, '../renderer/index.html');
  win.loadURL(`file://${htmlPath}`);
}

module.exports = { open };

