/**
 * @file electron.js
 * ملف تشغيل تطبيق سطح المكتب (.EXE) لنظام Windows 7 / 8 / 8.1 / 10 / 11 (32-bit & 64-bit)
 * يدعم التحديث السلس الفوري (Online OTA & Offline In-Place EXE Upgrade) والمزامنة اللحظية مع الموبايل
 * مع حماية 100% لقاعدة البيانات وتفعيل السيريل في (%APPDATA%\AKStorePOS_Data)
 */

const { app, BrowserWindow, ipcMain, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// الرابط السحابي الافتراضي للتحديث والمزامنة اللحظية بين نسخة الـ EXE والموبايل والكمبيوتر
const DEFAULT_CLOUD_SERVER_URL =
  'https://ais-pre-dtdtj6sx4wxmcf7m5rnwyq-461022146256.europe-west2.run.app';

// 1. تثبيت مسار موحد ودائم لبيانات النظام والترخيص في (%APPDATA%\AKStorePOS_Data)
const APP_DATA_FOLDER_NAME = 'AKStorePOS_Data';
app.setName('AKStorePOS');
try {
  const persistentUserDataPath = path.join(app.getPath('appData'), APP_DATA_FOLDER_NAME);
  if (!fs.existsSync(persistentUserDataPath)) {
    fs.mkdirSync(persistentUserDataPath, { recursive: true });
  }
  app.setPath('userData', persistentUserDataPath);
} catch (err) {
  console.error('Failed to set persistent userData path:', err);
}

const VAULT_FILE_PATH = path.join(app.getPath('userData'), 'akstore_persistent_vault.json');
const UPDATE_CONFIG_PATH = path.join(app.getPath('userData'), 'akstore_update_config.json');

// 2. فحص إصدار الويندوز والرامات لتفعيل وضع التوافق وأقل استهلاك للموارد تلقائياً
const winRelease = os.release() || '';
const isLegacyWindows =
  process.platform === 'win32' &&
  (winRelease.startsWith('6.1') || // Windows 7
    winRelease.startsWith('6.2') || // Windows 8
    winRelease.startsWith('6.3') || // Windows 8.1
    winRelease.startsWith('6.0') || // Windows Vista
    winRelease.startsWith('5.'));   // Windows XP

const totalRamGB = os.totalmem() / (1024 * 1024 * 1024);
const isLowSpecPC = isLegacyWindows || totalRamGB <= 4.2 || process.argv.includes('--low-spec');

if (isLowSpecPC) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('process-per-site');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
}

// منع فتح أكثر من نسخة من البرنامج في نفس الوقت على جهاز الكاشير
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow;

/**
 * قراءة إعدادات التحديث والمزامنة المحفوظة لنسخة الـ EXE
 */
function loadUpdateConfig() {
  try {
    if (fs.existsSync(UPDATE_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(UPDATE_CONFIG_PATH, 'utf8'));
      return {
        useRemoteUpdateServer:
          parsed.useRemoteUpdateServer !== undefined ? Boolean(parsed.useRemoteUpdateServer) : true,
        remoteServerUrl: (parsed.remoteServerUrl || DEFAULT_CLOUD_SERVER_URL).replace(/\/$/, ''),
        lastUpdatedAt: parsed.lastUpdatedAt || parsed.updatedAt || null
      };
    }
  } catch (e) {
    console.error('Error reading update config:', e);
  }
  return {
    useRemoteUpdateServer: true,
    remoteServerUrl: DEFAULT_CLOUD_SERVER_URL,
    lastUpdatedAt: null
  };
}

function saveUpdateConfig(cfg) {
  try {
    const current = loadUpdateConfig();
    const merged = Object.assign({}, current, cfg, {
      remoteServerUrl: ((cfg && cfg.remoteServerUrl) || current.remoteServerUrl || DEFAULT_CLOUD_SERVER_URL).replace(
        /\/$/,
        ''
      ),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(UPDATE_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) {
    console.error('Error saving update config:', e);
    return null;
  }
}

/**
 * حقن البيانات المحفوظة من الخزنة الدائمة (VAULT_FILE_PATH) إلى localStorage عند تحميل النافذة
 * لضمان عدم ضياع أي بيانات أو تفعيل عند التحديث بين file:// و https://
 */
async function injectVaultIntoWindowIfNeeded(win) {
  try {
    if (!win || win.isDestroyed() || !fs.existsSync(VAULT_FILE_PATH)) return;
    const rawVault = fs.readFileSync(VAULT_FILE_PATH, 'utf8');
    const vaultData = JSON.parse(rawVault);
    if (!vaultData || typeof vaultData !== 'object') return;

    const safePayloadJson = JSON.stringify(vaultData);
    await win.webContents.executeJavaScript(`
      (function() {
        try {
          var vault = ${safePayloadJson};
          var currentDb = localStorage.getItem('soft_glass_pos_db_v1');
          var vaultDb = vault.databaseJson || vault.softGlassDbJson;
          if (!currentDb && vaultDb) {
            localStorage.setItem('soft_glass_pos_db_v1', vaultDb);
          }
          if (!localStorage.getItem('soft_glass_pos_license_data_v1') && vault.licenseDataJson) {
            localStorage.setItem('soft_glass_pos_license_data_v1', vault.licenseDataJson);
          }
          if (!localStorage.getItem('soft_glass_pos_device_id_v1') && vault.deviceCode) {
            localStorage.setItem('soft_glass_pos_device_id_v1', vault.deviceCode);
          }
          if (!localStorage.getItem('soft_glass_pos_trial_start_v1') && vault.trialStartTs) {
            localStorage.setItem('soft_glass_pos_trial_start_v1', vault.trialStartTs);
          }
        } catch (e) {}
      })();
    `);
  } catch (e) {
    // ignore injection errors
  }
}

function createWindow() {
  let screenWidth = 1280;
  let screenHeight = 800;
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    if (primaryDisplay && primaryDisplay.workAreaSize) {
      screenWidth = primaryDisplay.workAreaSize.width;
      screenHeight = primaryDisplay.workAreaSize.height;
    }
  } catch (e) {
    // fallback to 1280x800
  }

  mainWindow = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: '#e9eff5',
    title: 'AK Store - نظام الكريم لإدارة المبيعات ونقاط البيع',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // يسمح لنسخة الـ EXE بالاتصال المباشر بسيرفر التحديث والمزامنة مع الموبايل بدون قيود CORS
      backgroundThrottling: false,
      spellcheck: false
    },
    icon: path.join(__dirname, 'public/pwa-512x512.png'),
    frame: true,
    autoHideMenuBar: true
  });

  mainWindow.maximize();
  mainWindow.setMenuBarVisibility(false);

  const queryFlag = isLowSpecPC ? '?lite=1' : '';
  const updateCfg = loadUpdateConfig();

  // مسار التحديث المحلي الساخن (Hot-Update) داخل مجلد البيانات الدائم إن وُجد
  const hotUpdateIndex = path.join(app.getPath('userData'), 'live_update', 'index.html');
  // مسار الملفات المدمجة داخل الـ EXE
  const bundledProdIndex = path.join(__dirname, 'dist', 'index.html');
  const devUrl = `http://localhost:3000${queryFlag}`;

  const loadLocalBundle = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (fs.existsSync(hotUpdateIndex)) {
      mainWindow
        .loadFile(hotUpdateIndex, isLowSpecPC ? { search: 'lite=1' } : undefined)
        .catch(() => {
          mainWindow.loadFile(bundledProdIndex, isLowSpecPC ? { search: 'lite=1' } : undefined);
        });
    } else if (fs.existsSync(bundledProdIndex)) {
      mainWindow.loadFile(bundledProdIndex, isLowSpecPC ? { search: 'lite=1' } : undefined);
    }
  };

  mainWindow.webContents.on('did-finish-load', () => {
    injectVaultIntoWindowIfNeeded(mainWindow);
  });

  // تحميل التحديث السحابي المباشر مع الرجوع الفوري للنسخة المحلية المدمجة عند انقطاع الإنترنت
  if (updateCfg.useRemoteUpdateServer && updateCfg.remoteServerUrl) {
    const targetUrl =
      updateCfg.remoteServerUrl.replace(/\/$/, '') +
      (isLowSpecPC ? '/?lite=1&exe=1' : '/?exe=1');
    mainWindow.loadURL(targetUrl).catch(() => {
      loadLocalBundle();
    });
  } else if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL(devUrl).catch(() => {
      loadLocalBundle();
    });
  } else {
    loadLocalBundle();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ============================================================================
// IPC Handlers: حماية البيانات عند التحديث + إدارة تحديثات الـ EXE + الطباعة الحرارية
// ============================================================================

// 1. حفظ خزنة البيانات والترخيص على القرص الصلب خارج الكاش لضمان عدم ضياعها عند أي تحديث للـ EXE
ipcMain.handle('akstore-save-vault', async (_event, payload) => {
  try {
    fs.writeFileSync(VAULT_FILE_PATH, JSON.stringify(payload), 'utf8');
    return { success: true, path: VAULT_FILE_PATH };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// 2. استرجاع خزنة البيانات والترخيص من القرص الصلب
ipcMain.handle('akstore-load-vault', async () => {
  try {
    if (fs.existsSync(VAULT_FILE_PATH)) {
      const raw = fs.readFileSync(VAULT_FILE_PATH, 'utf8');
      return { success: true, data: JSON.parse(raw), path: VAULT_FILE_PATH };
    }
    return { success: false, data: null };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// 3. معلومات بيئة الـ EXE ومسار الحفظ الدائم
ipcMain.handle('akstore-get-exe-info', async () => {
  return {
    isElectronExe: true,
    appVersion: app.getVersion() || '2.7.0',
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData'),
    vaultFilePath: VAULT_FILE_PATH,
    updateConfig: loadUpdateConfig()
  };
});

// 4. تحديث إعدادات التحديث المباشر لنسخة الـ EXE
ipcMain.handle('akstore-configure-exe-update', async (_event, newConfig) => {
  const saved = saveUpdateConfig(newConfig || {});
  return { success: Boolean(saved), config: saved };
});

// دالة تحميل أحدث حزمة ملفات من السيرفر وحفظها محلياً داخل %APPDATA%\AKStorePOS_Data\live_update للعمل أونلاين وأوفلاين
const https = require('https');
const http = require('http');

function fetchBufferFromUrl(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    try {
      const client = targetUrl.startsWith('https') ? https : http;
      const req = client.get(targetUrl, { timeout: timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBufferFromUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function downloadAndInstallLiveBundleToDisk(serverBaseUrl) {
  try {
    const cleanBase = (serverBaseUrl || DEFAULT_CLOUD_SERVER_URL).replace(/\/$/, '');
    const bundleBuf = await fetchBufferFromUrl(`${cleanBase}/api/update/live-bundle?t=${Date.now()}`, 6000);
    const bundleData = JSON.parse(bundleBuf.toString('utf8'));
    if (!bundleData || !bundleData.success || !bundleData.indexHtml) return false;

    const liveUpdateDir = path.join(app.getPath('userData'), 'live_update');
    const liveAssetsDir = path.join(liveUpdateDir, 'assets');
    if (!fs.existsSync(liveUpdateDir)) fs.mkdirSync(liveUpdateDir, { recursive: true });
    if (!fs.existsSync(liveAssetsDir)) fs.mkdirSync(liveAssetsDir, { recursive: true });

    // Download all assets listed in manifest
    const assets = (bundleData.manifest && Array.isArray(bundleData.manifest.assets))
      ? bundleData.manifest.assets
      : [];

    for (const relPath of assets) {
      if (typeof relPath !== 'string' || relPath === '/' || relPath === '/index.html') continue;
      try {
        const assetBuf = await fetchBufferFromUrl(`${cleanBase}${relPath}`, 8000);
        const targetFile = path.join(liveUpdateDir, relPath.replace(/^\//, ''));
        const targetDir = path.dirname(targetFile);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(targetFile, assetBuf);
      } catch (_e) {
        // continue
      }
    }

    // Write index.html with relative paths so file:// loading inside .EXE works 100% offline too
    const localReadyHtml = bundleData.indexHtml
      .replace(/src="\/assets\//g, 'src="./assets/')
      .replace(/href="\/assets\//g, 'href="./assets/');
    fs.writeFileSync(path.join(liveUpdateDir, 'index.html'), localReadyHtml, 'utf8');

    return true;
  } catch (_err) {
    return false;
  }
}

// 5. تنظيف كاش ملفات الواجهة القديمة وتحميل أحدث إصدار لنسخة الـ EXE مع الحفاظ الكامل على قاعدة البيانات والتفعيل
ipcMain.handle('akstore-refresh-exe-ui', async (_event, options) => {
  try {
    const requestedServerUrl =
      options && options.targetServerUrl
        ? String(options.targetServerUrl).trim().replace(/\/$/, '')
        : '';

    const updatedCfg = saveUpdateConfig({
      useRemoteUpdateServer: true,
      remoteServerUrl: requestedServerUrl || loadUpdateConfig().remoteServerUrl || DEFAULT_CLOUD_SERVER_URL
    });

    const targetBase =
      (updatedCfg && updatedCfg.remoteServerUrl) || DEFAULT_CLOUD_SERVER_URL;

    // حفظ نسخة التحديث الجديدة على القرص الصلب داخل %APPDATA%\AKStorePOS_Data\live_update
    await downloadAndInstallLiveBundleToDisk(targetBase);

    if (session && session.defaultSession) {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({
        storages: ['serviceworkers', 'cachestorage']
      });
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      const targetUrl =
        targetBase.replace(/\/$/, '') +
        `/?exe=1&updated=${Date.now()}${isLowSpecPC ? '&lite=1' : ''}`;

      mainWindow.loadURL(targetUrl).catch(() => {
        mainWindow.reload();
      });
    }
    return { success: true, config: updatedCfg };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// 5b. تثبيت ملف تحديث (.akupdate) يدوياً أوفلاين على القرص الصلب داخل نسخة الـ EXE
ipcMain.handle('akstore-install-offline-bundle', async (_event, pkg) => {
  try {
    if (!pkg || typeof pkg !== 'object') {
      return { success: false, error: 'Invalid package' };
    }
    const liveUpdateDir = path.join(app.getPath('userData'), 'live_update');
    const liveAssetsDir = path.join(liveUpdateDir, 'assets');
    if (!fs.existsSync(liveUpdateDir)) fs.mkdirSync(liveUpdateDir, { recursive: true });
    if (!fs.existsSync(liveAssetsDir)) fs.mkdirSync(liveAssetsDir, { recursive: true });

    if (pkg.bundledAssets && typeof pkg.bundledAssets === 'object') {
      for (const [assetPath, entry] of Object.entries(pkg.bundledAssets)) {
        if (entry && entry.base64) {
          const cleanRel = String(assetPath).replace(/^\//, '');
          const destFile = path.join(liveUpdateDir, cleanRel);
          const destDir = path.dirname(destFile);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(destFile, Buffer.from(entry.base64, 'base64'));
        }
      }
    }

    if (pkg.indexHtml && typeof pkg.indexHtml === 'string') {
      const localReadyHtml = pkg.indexHtml
        .replace(/src="\/assets\//g, 'src="./assets/')
        .replace(/href="\/assets\//g, 'href="./assets/');
      fs.writeFileSync(path.join(liveUpdateDir, 'index.html'), localReadyHtml, 'utf8');
    }

    if (session && session.defaultSession) {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({
        storages: ['serviceworkers', 'cachestorage']
      });
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      const hotUpdateIndex = path.join(liveUpdateDir, 'index.html');
      if (fs.existsSync(hotUpdateIndex)) {
        mainWindow.loadFile(hotUpdateIndex, isLowSpecPC ? { search: 'lite=1' } : undefined);
      } else {
        mainWindow.reload();
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// 6. معالجات الطباعة المباشرة من Electron للطابعات الحرارية 80mm و 58mm و A4 بدون نوافذ منبثقة
ipcMain.handle('print-receipt', async (_event, options) => {
  if (!mainWindow) return false;
  return new Promise((resolve) => {
    mainWindow.webContents.print(
      {
        silent: options?.silent !== undefined ? options.silent : true,
        printBackground: true,
        deviceName: options?.deviceName || '',
        margins: {
          marginType: 'none'
        }
      },
      (success, failureReason) => {
        resolve({ success, failureReason });
      }
    );
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
