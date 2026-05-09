const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const APP_TITLE = "Software Blocker";
const DEFAULT_CONFIG = {
  schedule: {
    start: "09:00",
    end: "17:00"
  },
  blockedApps: [],
  armed: true,
  startupEnabled: true,
  pinSalt: "",
  pinHash: ""
};

let mainWindow = null;
let tray = null;
let blockingTimer = null;
let isQuitting = false;
let config = null;
let runtimeState = {
  withinWindow: false,
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
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  }
}

function loadConfig() {
  ensureConfig();
  const raw = fs.readFileSync(getConfigPath(), "utf8");
  const parsed = JSON.parse(raw);
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    schedule: {
      ...DEFAULT_CONFIG.schedule,
      ...(parsed.schedule || {})
    },
    blockedApps: Array.isArray(parsed.blockedApps) ? parsed.blockedApps : []
  };
}

function saveConfig(nextConfig) {
  config = nextConfig;
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

function sanitizeConfigForRenderer() {
  return {
    hasPin: Boolean(config.pinHash && config.pinSalt),
    schedule: config.schedule,
    blockedApps: config.blockedApps,
    armed: config.armed,
    startupEnabled: config.startupEnabled
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

  const activeLabel = config.armed ? "Armed" : "Paused";
  const windowLabel = runtimeState.withinWindow ? "blocking window active" : "outside blocking window";
  tray.setToolTip(`${APP_TITLE} - ${activeLabel}, ${windowLabel}`);
}

function syncStartupRegistration() {
  const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
  app.setLoginItemSettings({
    openAtLogin: Boolean(config.startupEnabled),
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
    width: 880,
    height: 720,
    minWidth: 760,
    minHeight: 620,
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

function shouldBlockProcess(processInfo, blockedSetByPath, blockedSetByName) {
  const executablePath = (processInfo.ExecutablePath || "").toLowerCase();
  const name = (processInfo.Name || "").toLowerCase();
  const currentExecutable = process.execPath.toLowerCase();

  if (Number(processInfo.ProcessId) === process.pid) {
    return false;
  }

  if (executablePath && executablePath === currentExecutable) {
    return false;
  }

  if (executablePath && blockedSetByPath.has(executablePath)) {
    return true;
  }

  return blockedSetByName.has(name);
}

async function enforceBlockingIfNeeded() {
  runtimeState.withinWindow = Boolean(config.armed) && isWithinWindow(config.schedule);
  updateTrayTooltip();

  if (!config.armed || !runtimeState.withinWindow || config.blockedApps.length === 0) {
    return;
  }

  const blockedSetByPath = new Set(config.blockedApps.map((entry) => entry.path.toLowerCase()));
  const blockedSetByName = new Set(config.blockedApps.map((entry) => entry.name.toLowerCase()));

  const processes = await listRunningProcesses();
  const matches = processes.filter((processInfo) =>
    shouldBlockProcess(processInfo, blockedSetByPath, blockedSetByName)
  );

  const blockedNow = [];

  for (const processInfo of matches) {
    try {
      await killProcess(processInfo.ProcessId);
      blockedNow.push({
        pid: processInfo.ProcessId,
        name: processInfo.Name,
        path: processInfo.ExecutablePath || ""
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
  const { schedule } = payload;

  if (!schedule?.start || !schedule?.end) {
    errors.push("Start and end time are required.");
  }

  if (schedule?.start === schedule?.end) {
    errors.push("Start and end time cannot be the same.");
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
    schedule: payload.schedule,
    blockedApps: payload.blockedApps,
    startupEnabled: Boolean(payload.startupEnabled),
    armed: Boolean(payload.armed)
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

ipcMain.handle("request-quit", async (_event, payload) => {
  const pin = String(payload?.pin || "");
  if (!verifyPin(pin)) {
    return { ok: false, error: "Incorrect PIN." };
  }

  isQuitting = true;
  app.quit();
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
