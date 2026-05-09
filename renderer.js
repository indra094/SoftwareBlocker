const state = {
  config: null,
  runtimeState: null,
  blockedApps: [],
  runningApps: [],
  unlocked: false,
  isEditing: false,
  formHydrated: false
};

const setupView = document.getElementById("setupView");
const unlockView = document.getElementById("unlockView");
const dashboardView = document.getElementById("dashboardView");
const liveStatus = document.getElementById("liveStatus");
const statusDetail = document.getElementById("statusDetail");
const appList = document.getElementById("appList");
const activityLog = document.getElementById("activityLog");
const setupMessage = document.getElementById("setupMessage");
const unlockMessage = document.getElementById("unlockMessage");
const dashboardMessage = document.getElementById("dashboardMessage");
const pinDialog = document.getElementById("pinDialog");
const pinDialogMessage = document.getElementById("pinDialogMessage");
const runningAppsDialog = document.getElementById("runningAppsDialog");
const runningAppsList = document.getElementById("runningAppsList");
const runningAppsMessage = document.getElementById("runningAppsMessage");

function setMessage(element, text, isError = false) {
  element.textContent = text;
  element.style.color = isError ? "#8a2f1e" : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value) {
  if (!value) {
    return "No blocked launches yet in this session.";
  }

  return new Date(value).toLocaleString();
}

function renderActivityLog() {
  const entries = state.runtimeState?.lastBlocked || [];
  const lastRun = state.runtimeState?.lastEnforcedAt;

  if (entries.length === 0) {
    activityLog.innerHTML = `
      <div class="log-item">
        <div>
          <strong>No recent blocked apps</strong>
          <span>Last enforcement event: ${formatTimestamp(lastRun)}</span>
        </div>
      </div>
    `;
    return;
  }

  activityLog.innerHTML = entries
    .map(
      (entry) => `
        <div class="log-item">
          <div>
            <strong>${escapeHtml(entry.name)}</strong>
            <span>${escapeHtml(entry.path || "Path unavailable")} | PID ${entry.pid}</span>
          </div>
        </div>
      `
    )
    .join("");
}

function renderApps() {
  if (state.blockedApps.length === 0) {
    appList.innerHTML = `
      <div class="app-item">
        <div class="app-info">
          <strong>No apps selected yet</strong>
          <span>Use "Add running apps" or "Browse for .exe files" to choose software that should be blocked.</span>
        </div>
      </div>
    `;
    return;
  }

  appList.innerHTML = state.blockedApps
    .map(
      (entry, index) => `
        <div class="app-item">
          <div class="app-info">
            <strong>${escapeHtml(entry.name)}</strong>
            <span>${escapeHtml(entry.path || "Path unavailable. Blocking will match by process name.")}</span>
          </div>
          <button class="danger remove-app-button" data-index="${index}">Remove</button>
        </div>
      `
    )
    .join("");

  document.querySelectorAll(".remove-app-button").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      state.blockedApps.splice(index, 1);
      state.isEditing = true;
      renderApps();
      renderStatus();
    });
  });
}

function renderStatus() {
  const config = state.config;
  const runtimeState = state.runtimeState;

  if (!config) {
    liveStatus.textContent = "Loading...";
    statusDetail.textContent = "";
    return;
  }

  if (!config.hasPin) {
    liveStatus.textContent = "Setup required";
    statusDetail.textContent = "Create the admin PIN to turn on blocking.";
    return;
  }

  if (!config.armed) {
    liveStatus.textContent = "Paused";
    statusDetail.textContent = "Blocking is disarmed until you arm it again with the admin PIN.";
    return;
  }

  if (runtimeState?.withinWindow) {
    liveStatus.textContent = "Blocking now";
    statusDetail.textContent = state.blockedApps.length === 0
      ? "The daily window is active, but no blocked apps are selected yet."
      : `Watching ${state.blockedApps.length} selected app${state.blockedApps.length === 1 ? "" : "s"} during the active daily window.`;
    return;
  }

  liveStatus.textContent = "Waiting";
  statusDetail.textContent = `Outside the blocking window. Last enforcement: ${formatTimestamp(runtimeState?.lastEnforcedAt)}`;
}

function renderViewMode() {
  const hasPin = Boolean(state.config?.hasPin);

  setupView.classList.toggle("hidden", hasPin);
  unlockView.classList.toggle("hidden", !hasPin || state.unlocked);
  dashboardView.classList.toggle("hidden", !hasPin || !state.unlocked);
}

function syncFormFields() {
  if (!state.config) {
    return;
  }

  document.getElementById("startTime").value = state.config.schedule.start;
  document.getElementById("endTime").value = state.config.schedule.end;
  document.getElementById("armedToggle").checked = state.config.armed;
  document.getElementById("startupToggle").checked = state.config.startupEnabled;
}

function markEditing() {
  if (state.unlocked) {
    state.isEditing = true;
  }
}

function addAppsToSelection(appEntries) {
  for (const appEntry of appEntries) {
    if (!appEntry) {
      continue;
    }

    const duplicate = state.blockedApps.some((entry) => {
      return (
        entry.name.toLowerCase() === appEntry.name.toLowerCase() &&
        entry.path.toLowerCase() === appEntry.path.toLowerCase()
      );
    });

    if (!duplicate) {
      state.blockedApps.push(appEntry);
    }
  }

  state.isEditing = true;
  renderApps();
  renderStatus();
}

function renderRunningAppsList() {
  if (state.runningApps.length === 0) {
    runningAppsList.innerHTML = `
      <div class="log-item">
        <div>
          <strong>No running apps found</strong>
          <span>Launch the app first, then click Refresh list.</span>
        </div>
      </div>
    `;
    return;
  }

  runningAppsList.innerHTML = state.runningApps
    .map(
      (appEntry, index) => `
        <label class="running-app-option">
          <input type="checkbox" data-index="${index}" />
          <div>
            <strong>${escapeHtml(appEntry.name)}</strong>
            <span>${escapeHtml(appEntry.path || "Path unavailable. Blocking will still match by process name.")}</span>
          </div>
        </label>
      `
    )
    .join("");
}

async function loadRunningApps() {
  state.runningApps = await window.softwareBlocker.listRunningApps();
  renderRunningAppsList();
}

async function refreshState() {
  const data = await window.softwareBlocker.getState();
  state.config = data.config;
  state.runtimeState = data.runtimeState;

  if (!state.isEditing) {
    state.blockedApps = [...data.config.blockedApps];
  } else if (state.blockedApps.length === 0 && data.config.blockedApps.length > 0) {
    state.blockedApps = [...data.config.blockedApps];
    state.isEditing = false;
  }

  renderViewMode();

  if (!state.formHydrated || !state.isEditing) {
    syncFormFields();
    state.formHydrated = true;
  }

  renderApps();
  renderStatus();
  renderActivityLog();
}

document.getElementById("createPinButton").addEventListener("click", async () => {
  const pin = document.getElementById("setupPin").value;
  const confirmPin = document.getElementById("setupPinConfirm").value;
  const result = await window.softwareBlocker.initializePin({ pin, confirmPin });

  if (!result.ok) {
    setMessage(setupMessage, result.error, true);
    return;
  }

  state.unlocked = true;
  state.blockedApps = [];
  state.isEditing = false;
  state.formHydrated = false;
  setMessage(setupMessage, "PIN created. Set your schedule and save whenever you're ready.");
  await refreshState();
});

document.getElementById("unlockButton").addEventListener("click", async () => {
  const pin = document.getElementById("unlockPin").value;
  const result = await window.softwareBlocker.verifyPin({ pin });

  if (!result.ok) {
    setMessage(unlockMessage, result.error, true);
    return;
  }

  state.unlocked = true;
  state.blockedApps = [...state.config.blockedApps];
  state.isEditing = false;
  state.formHydrated = false;
  document.getElementById("actionPin").value = pin;
  setMessage(unlockMessage, "");
  await refreshState();
});

document.getElementById("addAppsButton").addEventListener("click", async () => {
  const pickedApps = await window.softwareBlocker.pickApps();
  addAppsToSelection(pickedApps);
});

document.getElementById("addRunningAppsButton").addEventListener("click", async () => {
  setMessage(runningAppsMessage, "");
  await loadRunningApps();
  runningAppsDialog.showModal();
});

document.getElementById("refreshRunningAppsButton").addEventListener("click", async () => {
  await loadRunningApps();
});

document.getElementById("confirmRunningAppsButton").addEventListener("click", () => {
  const selectedApps = Array.from(
    runningAppsList.querySelectorAll("input[type='checkbox']:checked")
  ).map((checkbox) => state.runningApps[Number(checkbox.dataset.index)]);

  if (selectedApps.length === 0) {
    setMessage(runningAppsMessage, "Choose at least one running app to add.", true);
    return;
  }

  addAppsToSelection(selectedApps);
  runningAppsDialog.close();
});

document.getElementById("saveButton").addEventListener("click", async () => {
  const pin = document.getElementById("actionPin").value;
  const schedule = {
    start: document.getElementById("startTime").value,
    end: document.getElementById("endTime").value
  };
  const payload = {
    pin,
    schedule,
    blockedApps: state.blockedApps,
    armed: document.getElementById("armedToggle").checked,
    startupEnabled: document.getElementById("startupToggle").checked
  };

  const result = await window.softwareBlocker.saveSettings(payload);
  if (!result.ok) {
    setMessage(dashboardMessage, result.error, true);
    return;
  }

  setMessage(dashboardMessage, "Settings saved.");
  state.config = {
    ...state.config,
    ...payload
  };
  state.isEditing = false;
  state.formHydrated = false;
  await refreshState();
});

document.getElementById("changePinButton").addEventListener("click", () => {
  pinDialogMessage.textContent = "";
  pinDialog.showModal();
});

document.getElementById("confirmPinChangeButton").addEventListener("click", async () => {
  const currentPin = document.getElementById("currentPinInput").value;
  const nextPin = document.getElementById("newPinInput").value;
  const confirmNextPin = document.getElementById("newPinConfirmInput").value;

  const result = await window.softwareBlocker.changePin({
    currentPin,
    nextPin,
    confirmNextPin
  });

  if (!result.ok) {
    setMessage(pinDialogMessage, result.error, true);
    return;
  }

  document.getElementById("actionPin").value = nextPin;
  document.getElementById("currentPinInput").value = "";
  document.getElementById("newPinInput").value = "";
  document.getElementById("newPinConfirmInput").value = "";
  setMessage(dashboardMessage, "PIN updated.");
  pinDialog.close();
});

document.getElementById("quitButton").addEventListener("click", async () => {
  const pin = document.getElementById("actionPin").value;
  const result = await window.softwareBlocker.requestQuit({ pin });

  if (!result.ok) {
    setMessage(dashboardMessage, result.error, true);
  }
});

window.softwareBlocker.onStateUpdated(() => {
  refreshState();
});

["startTime", "endTime", "armedToggle", "startupToggle", "actionPin"].forEach((id) => {
  const element = document.getElementById(id);
  element.addEventListener("input", markEditing);
  element.addEventListener("change", markEditing);
});

setInterval(refreshState, 5000);
refreshState();
