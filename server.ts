/**
 * @file server.ts
 * خادم النظام والمزامنة اللحظية ثنائية الاتجاه (كمبيوتر ⇄ موبايل ⇄ نسخة EXE) + قارئ الباركود اللاسلكي
 * Express + Vite Full-Stack Server with Real-Time Bidirectional Database Sync (SSE + REST) & Mobile Barcode Scanner Bridge
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 1. Real-Time Mobile-to-PC Barcode Scanner State
// ============================================================================
interface ScannedBarcodeEvent {
  id: string;
  barcode: string;
  timestamp: number;
  deviceName?: string;
}

interface ScannerSession {
  sessionId: string;
  createdAt: number;
  lastMobilePing: number;
  mobileDeviceName: string;
  events: ScannedBarcodeEvent[];
  sseClients: Set<express.Response>;
}

const scannerSessions = new Map<string, ScannerSession>();

function getOrCreateSession(sessionId: string): ScannerSession {
  const cleanId = sessionId.trim().toUpperCase();
  let session = scannerSessions.get(cleanId);
  if (!session) {
    session = {
      sessionId: cleanId,
      createdAt: Date.now(),
      lastMobilePing: 0,
      mobileDeviceName: '',
      events: [],
      sseClients: new Set()
    };
    scannerSessions.set(cleanId, session);
  }
  return session;
}

function broadcastToSession(session: ScannerSession, payload: unknown) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  session.sseClients.forEach((client) => {
    try {
      client.write(message);
    } catch {
      session.sseClients.delete(client);
    }
  });
}

// ============================================================================
// 2. Real-Time Bidirectional PC <-> Mobile <-> .EXE Database Sync Engine (Isolated Per Email)
// ============================================================================
const TENANTS_SYNC_STORE_FILE_PATH = path.join(__dirname, 'database_sync_tenants.json');

interface ServerSyncStore {
  email: string;
  revision: number;
  lastModified: number;
  lastUpdatedByDevice: string;
  lastUpdatedByName: string;
  deletedIds: string[];
  state: Record<string, any> | null;
}

const tenantStores = new Map<string, ServerSyncStore>();
const tenantSseClients = new Map<string, Set<express.Response>>();

function normalizeSyncEmail(raw?: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned.length > 160) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return '';
  return cleaned;
}

function loadTenantSyncStores() {
  try {
    if (fs.existsSync(TENANTS_SYNC_STORE_FILE_PATH)) {
      const raw = fs.readFileSync(TENANTS_SYNC_STORE_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [key, val] of Object.entries(parsed)) {
          const email = normalizeSyncEmail(key);
          const item = val as any;
          if (email && item && typeof item === 'object') {
            tenantStores.set(email, {
              email,
              revision: Number(item.revision) || 1,
              lastModified: Number(item.lastModified) || Date.now(),
              lastUpdatedByDevice: String(item.lastUpdatedByDevice || ''),
              lastUpdatedByName: String(item.lastUpdatedByName || ''),
              deletedIds: Array.isArray(item.deletedIds) ? item.deletedIds.slice(-1000) : [],
              state: item.state || null
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not load database_sync_tenants.json, starting fresh:', err);
  }
}

loadTenantSyncStores();

function getOrCreateTenantStore(email: string): ServerSyncStore {
  let store = tenantStores.get(email);
  if (!store) {
    store = {
      email,
      revision: 0,
      lastModified: 0,
      lastUpdatedByDevice: '',
      lastUpdatedByName: '',
      deletedIds: [],
      state: null
    };
    tenantStores.set(email, store);
  }
  return store;
}

function getOrCreateTenantSseSet(email: string): Set<express.Response> {
  let set = tenantSseClients.get(email);
  if (!set) {
    set = new Set<express.Response>();
    tenantSseClients.set(email, set);
  }
  return set;
}

function saveTenantSyncStores() {
  try {
    const serializable: Record<string, ServerSyncStore> = {};
    tenantStores.forEach((store, email) => {
      serializable[email] = store;
    });
    fs.writeFileSync(TENANTS_SYNC_STORE_FILE_PATH, JSON.stringify(serializable), 'utf8');
  } catch (err) {
    console.error('Failed to persist database_sync_tenants.json:', err);
  }
}

function broadcastSyncEventToEmail(email: string, payload: unknown) {
  const clients = tenantSseClients.get(email);
  if (!clients || clients.size === 0) return;
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((client) => {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  });
}

/**
 * دمج ذكي للمصفوفات بحسب المعرف (id) مع احترام العناصر المحذوفة (deletedIds)
 * لضمان عدم ضياع أي صنف أو فاتورة أو عميل تم إدخاله من الكمبيوتر أو الموبايل
 */
function mergeEntityArraysById(
  existingArr: any[] | undefined,
  incomingArr: any[] | undefined,
  deletedSet: Set<string>
): any[] {
  if (!Array.isArray(incomingArr) && !Array.isArray(existingArr)) return [];
  if (!Array.isArray(existingArr) || existingArr.length === 0) {
    return (incomingArr || []).filter((item) => !item?.id || !deletedSet.has(String(item.id)));
  }
  if (!Array.isArray(incomingArr) || incomingArr.length === 0) {
    return existingArr.filter((item) => !item?.id || !deletedSet.has(String(item.id)));
  }

  const map = new Map<string, any>();
  const orderedIds: string[] = [];

  // Incoming items take priority in ordering and values unless existing has a strictly newer updatedAt
  for (const item of incomingArr) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || item.code || '');
    if (!id || deletedSet.has(id)) continue;
    if (!map.has(id)) {
      map.set(id, item);
      orderedIds.push(id);
    } else {
      const existing = map.get(id);
      const existingTime = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const candidateTime = item?.updatedAt ? new Date(item.updatedAt).getTime() : 0;
      if (candidateTime >= existingTime) {
        map.set(id, item);
      }
    }
  }

  // Preserve any existing items from other devices that were not deleted (or have a strictly newer updatedAt)
  for (const item of existingArr) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || item.code || '');
    if (!id || deletedSet.has(id)) continue;
    if (!map.has(id)) {
      map.set(id, item);
      orderedIds.push(id);
    } else {
      const incomingItem = map.get(id);
      const incomingTime = incomingItem?.updatedAt ? new Date(incomingItem.updatedAt).getTime() : 0;
      const existingTime = item?.updatedAt ? new Date(item.updatedAt).getTime() : 0;
      if (existingTime > incomingTime) {
        map.set(id, item);
      }
    }
  }

  return orderedIds.map((id) => map.get(id)!);
}

function mergeDatabaseStatesOnServer(
  existingState: Record<string, any> | null,
  incomingState: Record<string, any>,
  deletedSet: Set<string>,
  replaceAll = false
): Record<string, any> {
  if (!existingState || replaceAll) {
    const cleaned = { ...incomingState };
    const collections = [
      'users',
      'products',
      'customers',
      'suppliers',
      'sales',
      'purchases',
      'returns',
      'expenses',
      'installmentPlans',
      'warehouses',
      'warehouseTransfers'
    ];
    for (const key of collections) {
      if (Array.isArray(cleaned[key])) {
        cleaned[key] = cleaned[key].filter((item: any) => !item?.id || !deletedSet.has(String(item.id)));
      }
    }
    return cleaned;
  }

  const mergedSettings = {
    ...(existingState.settings || {}),
    ...(incomingState.settings || {})
  };

  const mergedWarehouses = mergeEntityArraysById(
    existingState.warehouses,
    incomingState.warehouses,
    deletedSet
  );
  mergedSettings.warehouses = mergedWarehouses;

  return {
    users: mergeEntityArraysById(existingState.users, incomingState.users, deletedSet),
    products: mergeEntityArraysById(existingState.products, incomingState.products, deletedSet),
    customers: mergeEntityArraysById(existingState.customers, incomingState.customers, deletedSet),
    suppliers: mergeEntityArraysById(existingState.suppliers, incomingState.suppliers, deletedSet),
    sales: mergeEntityArraysById(existingState.sales, incomingState.sales, deletedSet),
    purchases: mergeEntityArraysById(existingState.purchases, incomingState.purchases, deletedSet),
    returns: mergeEntityArraysById(existingState.returns, incomingState.returns, deletedSet),
    expenses: mergeEntityArraysById(existingState.expenses, incomingState.expenses, deletedSet),
    installmentPlans: mergeEntityArraysById(
      existingState.installmentPlans,
      incomingState.installmentPlans,
      deletedSet
    ),
    settings: mergedSettings,
    warehouses: mergedWarehouses,
    warehouseTransfers: mergeEntityArraysById(
      existingState.warehouseTransfers,
      incomingState.warehouseTransfers,
      deletedSet
    )
  };
}

// Clean up stale scanner sessions older than 12 hours every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  scannerSessions.forEach((session, key) => {
    if (session.createdAt < cutoff && session.sseClients.size === 0) {
      scannerSessions.delete(key);
    }
  });
}, 30 * 60 * 1000);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Enable CORS so Windows .EXE (file:// or localhost), PC web, and Mobile web can sync seamlessly
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Device-Id, X-Sync-Email, Cache-Control, Pragma'
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  // ============================================================================
  // Fast Health Check Endpoint for Offline-First Network Circuit Breaker
  // ============================================================================
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      status: 'ok',
      offline: false,
      timestamp: Date.now()
    });
  });

  // ============================================================================
  // Dynamic Version & Live Bundle Manifest Endpoints for Mobile PWA & Laptop .EXE Auto-Updater
  // Automatically detects any code edit in src/, index.html, public/sw.js, or dist/
  // ============================================================================
  function computeLiveBuildManifest() {
    const distDir = path.join(__dirname, 'dist');
    const distAssetsDir = path.join(distDir, 'assets');
    const assets: string[] = [
      '/',
      '/index.html',
      '/manifest.webmanifest',
      '/icon.svg',
      '/favicon.ico',
      '/apple-touch-icon.png',
      '/pwa-192x192.png',
      '/pwa-512x512.png',
      '/pwa-maskable-512x512.png'
    ];
    const bundleFiles: string[] = [];

    let maxMtimeMs = Date.now();
    try {
      const srcMtime = getLatestMtimeMs(path.join(__dirname, 'src'));
      const distMtime = fs.existsSync(distDir) ? getLatestMtimeMs(distDir) : 0;
      const rootIndexMtime = fs.existsSync(path.join(__dirname, 'index.html'))
        ? fs.statSync(path.join(__dirname, 'index.html')).mtimeMs
        : 0;
      const swMtime = fs.existsSync(path.join(__dirname, 'public', 'sw.js'))
        ? fs.statSync(path.join(__dirname, 'public', 'sw.js')).mtimeMs
        : 0;
      maxMtimeMs = Math.max(srcMtime, distMtime, rootIndexMtime, swMtime, 1730000000000);

      if (fs.existsSync(distAssetsDir)) {
        const files = fs.readdirSync(distAssetsDir).sort();
        for (const file of files) {
          if (/\.(js|css|woff2?|ttf|svg|png|jpg|webp)$/i.test(file)) {
            assets.push(`/assets/${file}`);
            if (file.startsWith('index-') && (file.endsWith('.js') || file.endsWith('.css'))) {
              bundleFiles.push(file);
            }
          }
        }
      }
    } catch {
      // ignore
    }

    const buildNumber = Math.floor(maxMtimeMs / 1000);
    const bundleSignature = `${bundleFiles.join('|')}@${buildNumber}`;
    const mainScriptAsset = bundleFiles.find((f) => f.endsWith('.js'))
      ? `/assets/${bundleFiles.find((f) => f.endsWith('.js'))}`
      : '';

    return {
      version: '2.7.0',
      buildNumber,
      bundleSignature,
      mainScriptAsset,
      assets,
      releaseDate: new Date(maxMtimeMs).toISOString().slice(0, 10),
      updatedAtIso: new Date(maxMtimeMs).toISOString(),
      channel: 'stable',
      minWindowsVersion: 'Windows 7 SP1 (32-bit & 64-bit)',
      preserveDatabaseOnUpdate: true,
      preserveLicenseOnUpdate: true,
      notesAr: [
        'تحديث تلقائي مباشر (Live OTA Update) للنسخة المحملة على الموبايل واللاب (.EXE) فور أي تعديل على النظام',
        'إضافة زر خروج من البرنامج في نهاية القائمة الجانبية بعد الإعدادات مباشرة',
        'اختفاء تلقائي سريع لإشعار الأوفلاين السفلي حتى لا يغطي الشاشة',
        'حفظ كامل 100% لقاعدة البيانات المحلية (IndexedDB + SQLite) وتفعيل السيريل عند التحديث'
      ],
      notesEn: [
        'Instant Live OTA Update for installed Mobile PWA and Laptop (.EXE) whenever system is modified',
        'Added Exit Program button at the bottom of the sidebar after Settings',
        'Auto-hiding offline notification toast so it never blocks screen content',
        '100% preservation of local IndexedDB + SQLite database and license activation'
      ]
    };
  }

  app.get('/version.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.json(computeLiveBuildManifest());
  });

  app.get('/api/update/live-bundle', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    try {
      const manifest = computeLiveBuildManifest();
      const distDir = path.join(__dirname, 'dist');
      const distIndex = path.join(distDir, 'index.html');
      const indexHtml = fs.existsSync(distIndex)
        ? fs.readFileSync(distIndex, 'utf8')
        : fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

      res.json({
        success: true,
        manifest,
        indexHtml
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Full self-contained update package endpoint (.akupdate) containing index.html + all compiled JS/CSS assets
  app.get('/api/update/full-package', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    try {
      const manifest = computeLiveBuildManifest();
      const distDir = path.join(__dirname, 'dist');
      const distAssetsDir = path.join(distDir, 'assets');
      const distIndex = path.join(distDir, 'index.html');
      const indexHtml = fs.existsSync(distIndex)
        ? fs.readFileSync(distIndex, 'utf8')
        : fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

      const bundledAssets: Record<string, { contentType: string; base64: string }> = {};
      if (fs.existsSync(distAssetsDir)) {
        const files = fs.readdirSync(distAssetsDir);
        for (const file of files) {
          const fullPath = path.join(distAssetsDir, file);
          if (fs.statSync(fullPath).isFile()) {
            const ext = path.extname(file).toLowerCase();
            const contentType =
              ext === '.js'
                ? 'application/javascript; charset=utf-8'
                : ext === '.css'
                ? 'text/css; charset=utf-8'
                : ext === '.svg'
                ? 'image/svg+xml'
                : ext === '.png'
                ? 'image/png'
                : 'application/octet-stream';
            bundledAssets[`/assets/${file}`] = {
              contentType,
              base64: fs.readFileSync(fullPath).toString('base64')
            };
          }
        }
      }

      res.json({
        success: true,
        packageType: 'AKSTORE_EXE_UPDATE_PACKAGE',
        version: manifest.version,
        buildNumber: manifest.buildNumber,
        bundleSignature: manifest.bundleSignature,
        releaseDate: manifest.releaseDate,
        exportedAt: new Date().toISOString(),
        manifest,
        indexHtml,
        bundledAssets
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ============================================================================
  // Real-Time Bidirectional Database Sync API (PC <-> Mobile <-> .EXE)
  // ============================================================================

  // 1. SSE Live Stream for Instant Cross-Device Notification (Isolated Per Email)
  app.get('/api/sync/stream', (req, res) => {
    const email = normalizeSyncEmail(req.query.email || req.headers['x-sync-email']);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (!email) {
      res.write(
        `data: ${JSON.stringify({
          type: 'sync_requires_email',
          requiresEmail: true
        })}\n\n`
      );
      res.end();
      return;
    }

    const store = getOrCreateTenantStore(email);
    const clients = getOrCreateTenantSseSet(email);
    clients.add(res);

    const liveBuild = computeLiveBuildManifest();
    res.write(
      `data: ${JSON.stringify({
        type: 'sync_init',
        email,
        revision: store.revision,
        lastModified: store.lastModified,
        lastUpdatedByDevice: store.lastUpdatedByDevice,
        lastUpdatedByName: store.lastUpdatedByName,
        hasState: Boolean(store.state),
        connectedDevices: clients.size,
        buildNumber: liveBuild.buildNumber,
        bundleSignature: liveBuild.bundleSignature,
        mainScriptAsset: liveBuild.mainScriptAsset
      })}\n\n`
    );

    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  });

  // 2. Pull Latest Shared Database State (Isolated Per Email)
  app.get('/api/sync/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const email = normalizeSyncEmail(req.query.email || req.headers['x-sync-email']);
    if (!email) {
      res.json({
        success: false,
        requiresEmail: true,
        error: 'يرجى إدخال البريد الإلكتروني الخاص بك لتفعيل المزامنة المستقلة بين الكمبيوتر والتليفون'
      });
      return;
    }

    const store = getOrCreateTenantStore(email);
    const clients = getOrCreateTenantSseSet(email);
    const sinceRevision = Number(req.query.sinceRevision) || 0;
    const sinceTimestamp = Number(req.query.since) || 0;

    if (!store.state) {
      res.json({
        success: true,
        email,
        hasState: false,
        revision: 0,
        lastModified: 0,
        state: null,
        deletedIds: [],
        connectedDevices: Math.max(1, clients.size)
      });
      return;
    }

    if (
      (sinceRevision > 0 && sinceRevision >= store.revision) ||
      (sinceTimestamp > 0 && sinceTimestamp >= store.lastModified)
    ) {
      res.json({
        success: true,
        email,
        hasState: true,
        upToDate: true,
        revision: store.revision,
        lastModified: store.lastModified,
        lastUpdatedByDevice: store.lastUpdatedByDevice,
        lastUpdatedByName: store.lastUpdatedByName,
        connectedDevices: Math.max(1, clients.size)
      });
      return;
    }

    res.json({
      success: true,
      email,
      hasState: true,
      upToDate: false,
      revision: store.revision,
      lastModified: store.lastModified,
      lastUpdatedByDevice: store.lastUpdatedByDevice,
      lastUpdatedByName: store.lastUpdatedByName,
      deletedIds: store.deletedIds,
      state: store.state,
      connectedDevices: Math.max(1, clients.size)
    });
  });

  // 3. Push Updated Database State from PC, Mobile, or .EXE (Isolated Per Email)
  app.post('/api/sync/push', (req, res) => {
    try {
      const email = normalizeSyncEmail(
        req.body?.email || req.query.email || req.headers['x-sync-email']
      );
      if (!email) {
        res.json({
          success: false,
          requiresEmail: true,
          error: 'يرجى إدخال البريد الإلكتروني الخاص بك لتفعيل المزامنة المستقلة بين الكمبيوتر والتليفون'
        });
        return;
      }

      const incomingState = req.body?.state;
      if (!incomingState || typeof incomingState !== 'object') {
        res.status(400).json({ success: false, error: 'Invalid database state payload' });
        return;
      }

      const store = getOrCreateTenantStore(email);
      const clients = getOrCreateTenantSseSet(email);
      const deviceId = String(req.body?.deviceId || 'unknown-device').slice(0, 80);
      const deviceName = String(req.body?.deviceName || 'جهاز متصل').slice(0, 80);
      const replaceAll = Boolean(req.body?.replaceAll);
      const incomingDeleted: string[] = Array.isArray(req.body?.deletedIds)
        ? req.body.deletedIds.map(String)
        : [];

      const deletedSet = new Set<string>([
        ...(replaceAll ? [] : store.deletedIds),
        ...incomingDeleted
      ]);

      const mergedState = mergeDatabaseStatesOnServer(
        store.state,
        incomingState,
        deletedSet,
        replaceAll
      );

      const updatedStore: ServerSyncStore = {
        email,
        revision: store.revision + 1,
        lastModified: Date.now(),
        lastUpdatedByDevice: deviceId,
        lastUpdatedByName: deviceName,
        deletedIds: Array.from(deletedSet).slice(-1000),
        state: mergedState
      };

      tenantStores.set(email, updatedStore);
      saveTenantSyncStores();

      // Immediately broadcast ONLY to devices connected with the exact same email
      broadcastSyncEventToEmail(email, {
        type: 'sync_update',
        email,
        revision: updatedStore.revision,
        lastModified: updatedStore.lastModified,
        lastUpdatedByDevice: updatedStore.lastUpdatedByDevice,
        lastUpdatedByName: updatedStore.lastUpdatedByName,
        deletedIds: updatedStore.deletedIds
      });

      res.json({
        success: true,
        email,
        revision: updatedStore.revision,
        lastModified: updatedStore.lastModified,
        state: updatedStore.state,
        deletedIds: updatedStore.deletedIds,
        connectedDevices: Math.max(1, clients.size)
      });
    } catch (err) {
      console.error('Error in /api/sync/push:', err);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ============================================================================
  // Real-Time Mobile-to-PC Barcode Scanner API
  // ============================================================================

  // 1. SSE Real-Time Stream for PC POS Terminal
  app.get('/api/mobile-scanner/:sessionId/stream', (req, res) => {
    const session = getOrCreateSession(req.params.sessionId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    session.sseClients.add(res);

    // Send initial state immediately
    res.write(
      `data: ${JSON.stringify({
        type: 'init',
        sessionId: session.sessionId,
        mobileConnected: Date.now() - session.lastMobilePing < 35000,
        mobileDeviceName: session.mobileDeviceName,
        events: session.events.slice(-20)
      })}\n\n`
    );

    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      session.sseClients.delete(res);
    });
  });

  // 2. Poll Session State & New Scans (Fallback for environments where SSE is buffered)
  app.get('/api/mobile-scanner/:sessionId', (req, res) => {
    const session = getOrCreateSession(req.params.sessionId);
    const since = Number(req.query.since) || 0;
    const newEvents =
      since > 0 ? session.events.filter((e) => e.timestamp > since) : session.events.slice(-20);

    res.json({
      success: true,
      sessionId: session.sessionId,
      mobileConnected: Date.now() - session.lastMobilePing < 35000,
      mobileDeviceName: session.mobileDeviceName,
      events: newEvents
    });
  });

  // 3. Mobile Device Heartbeat / Connection Ping
  app.post('/api/mobile-scanner/:sessionId/ping', (req, res) => {
    const session = getOrCreateSession(req.params.sessionId);
    session.lastMobilePing = Date.now();
    if (req.body?.deviceName) {
      session.mobileDeviceName = String(req.body.deviceName).slice(0, 60);
    }

    broadcastToSession(session, {
      type: 'mobile_connected',
      sessionId: session.sessionId,
      mobileConnected: true,
      mobileDeviceName: session.mobileDeviceName,
      timestamp: session.lastMobilePing
    });

    res.json({
      success: true,
      sessionId: session.sessionId,
      connectedClients: session.sseClients.size
    });
  });

  // 4. Mobile Device Sends a Scanned Barcode to PC
  app.post('/api/mobile-scanner/:sessionId/scan', (req, res) => {
    const session = getOrCreateSession(req.params.sessionId);
    const rawBarcode = String(req.body?.barcode || '').trim();

    if (!rawBarcode) {
      res.status(400).json({ success: false, error: 'Barcode is required' });
      return;
    }

    session.lastMobilePing = Date.now();
    if (req.body?.deviceName) {
      session.mobileDeviceName = String(req.body.deviceName).slice(0, 60);
    }

    const scanEvent: ScannedBarcodeEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      barcode: rawBarcode,
      timestamp: Date.now(),
      deviceName: session.mobileDeviceName || 'Mobile Scanner'
    };

    session.events.push(scanEvent);
    if (session.events.length > 100) {
      session.events = session.events.slice(-100);
    }

    broadcastToSession(session, {
      type: 'barcode_scanned',
      sessionId: session.sessionId,
      event: scanEvent
    });

    res.json({
      success: true,
      event: scanEvent
    });
  });

  // ============================================================================
  // Offline Asset Manifest & Service Worker Endpoints (For 100% Offline Mobile & PC Execution)
  // ============================================================================
  const distPath = path.join(__dirname, 'dist');
  const publicPath = path.join(__dirname, 'public');

  app.get(['/sw.js', '/dev-sw.js'], (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Service-Worker-Allowed', '/');
    const swPath = path.join(publicPath, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.sendFile(swPath);
    } else {
      res.status(404).end();
    }
  });

  app.get('/registerSW.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(
      `if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function(){}); }\n`
    );
  });

  app.get('/manifest.webmanifest', (_req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const manifestPath = path.join(publicPath, 'manifest.webmanifest');
    if (fs.existsSync(manifestPath)) {
      res.sendFile(manifestPath);
    } else {
      res.status(404).end();
    }
  });

  app.get('/api/offline-manifest', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const assets: string[] = [
      '/',
      '/index.html',
      '/manifest.webmanifest',
      '/icon.svg',
      '/favicon.ico',
      '/apple-touch-icon.png',
      '/pwa-192x192.png',
      '/pwa-512x512.png',
      '/pwa-maskable-512x512.png'
    ];
    try {
      const distAssetsDir = path.join(distPath, 'assets');
      if (fs.existsSync(distAssetsDir)) {
        const files = fs.readdirSync(distAssetsDir);
        for (const file of files) {
          if (/\.(js|css|woff2?|ttf|svg|png|jpg|webp)$/i.test(file)) {
            assets.push(`/assets/${file}`);
          }
        }
      }
    } catch {
      // ignore
    }
    res.json({ success: true, assets });
  });

  // ============================================================================
  // Bind Port 3000 IMMEDIATELY so Cloud Run Nginx NEVER returns 502 / warmup.html
  // ============================================================================
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AK Store POS Server listening immediately on http://0.0.0.0:${PORT}`);
  });

  // Helper to check if compiled dist/index.html is up-to-date with src/
  function getLatestMtimeMs(dirPath: string): number {
    let maxMtime = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const subMax = getLatestMtimeMs(fullPath);
          if (subMax > maxMtime) maxMtime = subMax;
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
        }
      }
    } catch {
      // ignore
    }
    return maxMtime;
  }

  function isCompiledDistFresh(): boolean {
    try {
      const distIndex = path.join(distPath, 'index.html');
      if (!fs.existsSync(distIndex)) return false;
      const distMtime = fs.statSync(distIndex).mtimeMs;
      const srcMtime = getLatestMtimeMs(path.join(__dirname, 'src'));
      const rootIndexMtime = fs.existsSync(path.join(__dirname, 'index.html'))
        ? fs.statSync(path.join(__dirname, 'index.html')).mtimeMs
        : 0;
      return distMtime >= Math.max(srcMtime, rootIndexMtime);
    } catch {
      return false;
    }
  }

  const staticDistMiddleware = express.static(distPath, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  });

  const staticPublicMiddleware = express.static(publicPath, {
    index: false
  });

  app.use(staticPublicMiddleware);

  // Lazy-initialized Vite dev server only if needed when src/ has uncompiled edits
  let vitePromise: Promise<any> | null = null;
  function getViteServer() {
    if (!vitePromise) {
      vitePromise = createViteServer({
        server: { middlewareMode: true },
        appType: 'spa'
      });
    }
    return vitePromise;
  }

  app.use(async (req, res, next) => {
    // When dist/ is built and fresh (or in production), serve compiled single-bundle assets immediately (<5ms)
    // This eliminates the 100+ module waterfall on mobile & PC and enables 100% offline execution!
    if (process.env.NODE_ENV === 'production' || isCompiledDistFresh()) {
      staticDistMiddleware(req, res, () => {
        if (
          req.method === 'GET' &&
          !req.path.startsWith('/api/') &&
          !req.path.startsWith('/assets/') &&
          (req.headers.accept?.includes('text/html') || req.path === '/' || !path.extname(req.path))
        ) {
          res.setHeader('Cache-Control', 'no-cache');
          res.sendFile(path.join(distPath, 'index.html'));
          return;
        }
        next();
      });
      return;
    }

    // Fallback to Vite middleware if src/ was edited and not yet built into dist/
    try {
      const vite = await getViteServer();
      vite.middlewares(req, res, next);
    } catch (err) {
      next(err);
    }
  });
}

startServer();
