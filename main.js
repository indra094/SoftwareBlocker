const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const APP_TITLE = "Software Blocker";
const DEFAULT_SCHEDULE = {
  start: "09:00",
  end: "17:00"
};
const DEFAULT_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let mainWindow = null;
let tray = null;
let blockingTimer = null;
let isQuitting = false;
let config = null;
let runtimeState = {
  withinWindow: false,
  activeBuckets: [],
  lastEnforcedAt: null,
  lastBlocked: [],
  lastError: null
};

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

app.setName(APP_TITLE);

app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

function createBucketId() {
  return crypto.randomUUID();
}

function normalizeAppEntry(filePath) {
  return {
    path: filePath,
    name: path.basename(filePath)
  };
}

function normalizeRunningAppEntry(processInfo) {
  return {
    path: processInfo.ExecutablePath || "",
    name: processInfo.Name || "Unknown.exe"
  };
}

function normalizeBlockedAppEntry(entry) {
  if (!entry) {
    return null;
  }

  const entryPath = String(entry.path || "").trim();
  const entryName = String(entry.name || (entryPath ? path.basename(entryPath) : "")).trim();

  if (!entryName) {
    return null;
  }

  return {
    path: entryPath,
    name: entryName
  };
}

function dedupeBlockedApps(appEntries) {
  const seen = new Set();
  const normalizedEntries = [];

  for (const appEntry of appEntries || []) {
    const normalized = normalizeBlockedAppEntry(appEntry);
    if (!normalized) {
      continue;
    }

    const key = `${normalized.name.toLowerCase()}|${normalized.path.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedEntries.push(normalized);
  }

  return normalizedEntries;
}

function createDefaultBucket(index = 0, overrides = {}) {
  const fallbackName = `Bucket ${index + 1}`;
  const days = Array.isArray(overrides.days) && overrides.days.length > 0
    ? [...new Set(overrides.days.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [...DEFAULT_DAYS];

  return {
    id: String(overrides.id || createBucketId()),
    name: String(overrides.name || "").trim() || fallbackName,
    schedule: {
      ...DEFAULT_SCHEDULE,
      ...(overrides.schedule || {})
    },
    days,
    blockedApps: dedupeBlockedApps(overrides.blockedApps)
  };
}

function createDefaultConfig() {
  return {
    buckets: [createDefaultBucket(0)],
    startupEnabled: true,
    pinSalt: "",
    pinHash: ""
  };
}

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function ensureConfig() {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(createDefaultConfig(), null, 2), "utf8");
  }
}

function normalizeBucketsFromParsedConfig(parsed) {
  if (Array.isArray(parsed.buckets) && parsed.buckets.length > 0) {
    return parsed.buckets.map((bucket, index) => createDefaultBucket(index, bucket));
  }

  const hasLegacyShape =
    parsed.schedule ||
    (Array.isArray(parsed.blockedApps) && parsed.blockedApps.length > 0);

  if (hasLegacyShape) {
    return [
      createDefaultBucket(0, {
        id: "legacy-default",
        name: "Main bucket",
        schedule: parsed.schedule,
        blockedApps: parsed.blockedApps
      })
    ];
  }

  return createDefaultConfig().buckets;
}

function loadConfig() {
  ensureConfig();
  const raw = fs.readFileSync(getConfigPath(), "utf8");
  const parsed = JSON.parse(raw);

  return {
    buckets: normalizeBucketsFromParsedConfig(parsed),
    pinSalt: String(parsed.pinSalt || ""),
    pinHash: String(parsed.pinHash || ""),
    startupEnabled: true
  };
}

function saveConfig(nextConfig) {
  config = nextConfig;
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

function sanitizeConfigForRenderer() {
  return {
    hasPin: Boolean(config.pinHash && config.pinSalt),
    buckets: config.buckets,
    startupEnabled: true
  };
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString("hex");
}

function createPinRecord(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    pinSalt: salt,
    pinHash: hashPin(pin, salt)
  };
}

function verifyPin(pin) {
  if (!config.pinSalt || !config.pinHash) {
    return false;
  }

  return hashPin(pin, config.pinSalt) === config.pinHash;
}

function minutesFromTimeString(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isWithinWindow(schedule, now = new Date()) {
  if (!schedule?.start || !schedule?.end) {
    return false;
  }

  if (schedule.start === schedule.end) {
    return false;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = minutesFromTimeString(schedule.start);
  const endMinutes = minutesFromTimeString(schedule.end);

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function getPreviousDayIndex(dayIndex) {
  return (dayIndex + 6) % 7;
}

function getActiveBuckets(now = new Date()) {
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return config.buckets.filter((bucket) => {
    if (!Array.isArray(bucket.days) || bucket.days.length === 0) {
      return false;
    }

    const startMinutes = minutesFromTimeString(bucket.schedule.start);
    const endMinutes = minutesFromTimeString(bucket.schedule.end);

    if (startMinutes === endMinutes) {
      return false;
    }

    if (startMinutes < endMinutes) {
      return bucket.days.includes(currentDay) && currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }

    if (currentMinutes >= startMinutes) {
      return bucket.days.includes(currentDay);
    }

    if (currentMinutes < endMinutes) {
      return bucket.days.includes(getPreviousDayIndex(currentDay));
    }

    return false;
  });
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
      <rect width="64" height="64" rx="14" fill="#123524"/>
      <path d="M20 34l8 8 16-20" fill="none" stroke="#f7f7e8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function updateTrayTooltip() {
  if (!tray) {
    return;
  }

  const bucketCount = runtimeState.activeBuckets.length;
  const windowLabel = bucketCount > 0
    ? `${bucketCount} blocking bucket${bucketCount === 1 ? "" : "s"} active`
    : "outside blocking windows";
  tray.setToolTip(`${APP_TITLE} - ${windowLabel}`);
}

function syncStartupRegistration() {
  const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
    path: process.execPath,
    args
  });
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 820,
    minHeight: 680,
    show: !process.argv.includes("--hidden"),
    title: APP_TITLE,
    autoHideMenuBar: true,
    backgroundColor: "#f3efe4",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile("index.html");

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_TITLE);
  tray.on("double-click", showWindow);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showWindow },
    {
      label: "Blocking Active",
      enabled: false
    },
    {
      label: "Quit From Dashboard",
      click: showWindow
    }
  ]);

  tray.setContextMenu(contextMenu);
  updateTrayTooltip();
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

async function listRunningProcesses() {
  const output = await runPowerShell(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress"
  );

  if (!output) {
    return [];
  }

  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function killProcess(pid) {
  return new Promise((resolve, reject) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/F", "/T"],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }

        resolve();
      }
    );
  });
}

function collectBlockingRulesFromBuckets(activeBuckets) {
  const blockedPaths = new Map();
  const blockedNames = new Map();

  for (const bucket of activeBuckets) {
    for (const appEntry of bucket.blockedApps) {
      const entryPath = appEntry.path.toLowerCase();
      const entryName = appEntry.name.toLowerCase();

      if (entryPath) {
        const pathBuckets = blockedPaths.get(entryPath) || new Set();
        pathBuckets.add(bucket.name);
        blockedPaths.set(entryPath, pathBuckets);
      }

      if (entryName) {
        const nameBuckets = blockedNames.get(entryName) || new Set();
        nameBuckets.add(bucket.name);
        blockedNames.set(entryName, nameBuckets);
      }
    }
  }

  return { blockedPaths, blockedNames };
}

function getMatchingBucketNames(processInfo, blockedPaths, blockedNames) {
  const executablePath = (processInfo.ExecutablePath || "").toLowerCase();
  const name = (processInfo.Name || "").toLowerCase();
  const currentExecutable = process.execPath.toLowerCase();

  if (Number(processInfo.ProcessId) === process.pid) {
    return [];
  }

  if (executablePath && executablePath === currentExecutable) {
    return [];
  }

  const matches = new Set();

  if (executablePath && blockedPaths.has(executablePath)) {
    for (const bucketName of blockedPaths.get(executablePath)) {
      matches.add(bucketName);
    }
  }

  if (blockedNames.has(name)) {
    for (const bucketName of blockedNames.get(name)) {
      matches.add(bucketName);
    }
  }

  return [...matches];
}

async function enforceBlockingIfNeeded() {
  const activeBuckets = getActiveBuckets();
  runtimeState.activeBuckets = activeBuckets.map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    schedule: bucket.schedule,
    blockedAppCount: bucket.blockedApps.length
  }));
  runtimeState.withinWindow = activeBuckets.length > 0;
  updateTrayTooltip();

  if (activeBuckets.length === 0) {
    return;
  }

  const { blockedPaths, blockedNames } = collectBlockingRulesFromBuckets(activeBuckets);
  if (blockedPaths.size === 0 && blockedNames.size === 0) {
    return;
  }

  const processes = await listRunningProcesses();
  const blockedNow = [];

  for (const processInfo of processes) {
    const matchingBucketNames = getMatchingBucketNames(processInfo, blockedPaths, blockedNames);
    if (matchingBucketNames.length === 0) {
      continue;
    }

    try {
      await killProcess(processInfo.ProcessId);
      blockedNow.push({
        pid: processInfo.ProcessId,
        name: processInfo.Name,
        path: processInfo.ExecutablePath || "",
        bucketNames: matchingBucketNames
      });
    } catch (error) {
      runtimeState.lastError = error.message;
    }
  }

  if (blockedNow.length > 0) {
    runtimeState.lastBlocked = blockedNow;
    runtimeState.lastEnforcedAt = new Date().toISOString();
    runtimeState.lastError = null;

    if (Notification.isSupported()) {
      new Notification({
        title: APP_TITLE,
        body: `Closed ${blockedNow.length} blocked app${blockedNow.length === 1 ? "" : "s"}.`
      }).show();
    }
  }
}

async function runBlockingCycle() {
  try {
    await enforceBlockingIfNeeded();
    if (mainWindow) {
      mainWindow.webContents.send("state-updated");
    }
  } catch (error) {
    runtimeState.lastError = error.message;
    if (mainWindow) {
      mainWindow.webContents.send("state-updated");
    }
  }
}

function startBlockingLoop() {
  if (blockingTimer) {
    clearInterval(blockingTimer);
  }

  runBlockingCycle();
  blockingTimer = setInterval(runBlockingCycle, 3000);
}

function validateConfigPayload(payload) {
  const errors = [];

  if (!Array.isArray(payload.buckets) || payload.buckets.length === 0) {
    errors.push("Add at least one blocking bucket.");
    return errors;
  }

  for (const bucket of payload.buckets) {
    if (!bucket.schedule?.start || !bucket.schedule?.end) {
      errors.push(`"${bucket.name}" needs both a start and end time.`);
    }

    if (bucket.schedule?.start === bucket.schedule?.end) {
      errors.push(`"${bucket.name}" cannot use the same start and end time.`);
    }

    if (!Array.isArray(bucket.days) || bucket.days.length === 0) {
      errors.push(`"${bucket.name}" needs at least one active day.`);
    }

    if (!Array.isArray(bucket.blockedApps) || bucket.blockedApps.length === 0) {
      errors.push(`"${bucket.name}" needs at least one app to block.`);
    }
  }

  return errors;
}

ipcMain.handle("get-state", async () => {
  return {
    config: sanitizeConfigForRenderer(),
    runtimeState,
    environment: {
      hostname: os.hostname(),
      isPackaged: app.isPackaged
    }
  };
});

ipcMain.handle("pick-apps", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select applications to block",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Programs", extensions: ["exe"] }]
  });

  if (result.canceled) {
    return [];
  }

  return result.filePaths.map(normalizeAppEntry);
});

ipcMain.handle("list-running-apps", async () => {
  const processes = await listRunningProcesses();
  const seen = new Set();

  return processes
    .filter((processInfo) => {
      const name = String(processInfo.Name || "");
      const executablePath = String(processInfo.ExecutablePath || "");

      if (!name.toLowerCase().endsWith(".exe")) {
        return false;
      }

      if (Number(processInfo.ProcessId) === process.pid) {
        return false;
      }

      if (executablePath.toLowerCase() === process.execPath.toLowerCase()) {
        return false;
      }

      return true;
    })
    .map(normalizeRunningAppEntry)
    .filter((entry) => {
      const key = `${entry.name.toLowerCase()}|${entry.path.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
});

ipcMain.handle("initialize-pin", async (_event, payload) => {
  const pin = String(payload?.pin || "");
  const confirmPin = String(payload?.confirmPin || "");

  if (config.pinHash) {
    return { ok: false, error: "A PIN already exists." };
  }

  if (pin.length < 4) {
    return { ok: false, error: "Use at least 4 digits or characters for the PIN." };
  }

  if (pin !== confirmPin) {
    return { ok: false, error: "PIN entries do not match." };
  }

  const pinRecord = createPinRecord(pin);
  saveConfig({
    ...config,
    ...pinRecord
  });
  syncStartupRegistration();
  startBlockingLoop();

  return { ok: true };
});

ipcMain.handle("verify-pin", async (_event, payload) => {
  const pin = String(payload?.pin || "");
  if (!verifyPin(pin)) {
    return { ok: false, error: "Incorrect PIN." };
  }

  return { ok: true };
});

ipcMain.handle("save-settings", async (_event, payload) => {
  const pin = String(payload?.pin || "");
  if (!verifyPin(pin)) {
    return { ok: false, error: "Incorrect PIN." };
  }

  const nextConfig = {
    ...config,
    buckets: (payload.buckets || []).map((bucket, index) => createDefaultBucket(index, bucket)),
    startupEnabled: true
  };

  const errors = validateConfigPayload(nextConfig);
  if (errors.length > 0) {
    return { ok: false, error: errors.join(" ") };
  }

  saveConfig(nextConfig);
  syncStartupRegistration();
  await runBlockingCycle();

  return { ok: true };
});

ipcMain.handle("change-pin", async (_event, payload) => {
  const currentPin = String(payload?.currentPin || "");
  const nextPin = String(payload?.nextPin || "");
  const confirmNextPin = String(payload?.confirmNextPin || "");

  if (!verifyPin(currentPin)) {
    return { ok: false, error: "Current PIN is incorrect." };
  }

  if (nextPin.length < 4) {
    return { ok: false, error: "Use at least 4 digits or characters for the new PIN." };
  }

  if (nextPin !== confirmNextPin) {
    return { ok: false, error: "New PIN entries do not match." };
  }

  saveConfig({
    ...config,
    ...createPinRecord(nextPin)
  });

  return { ok: true };
});

app.whenReady().then(() => {
  config = loadConfig();
  createWindow();
  createTray();
  syncStartupRegistration();

  if (config.pinHash) {
    startBlockingLoop();
  }

  updateTrayTooltip();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    showWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Keep the app alive in the tray on Windows.
  }
});
