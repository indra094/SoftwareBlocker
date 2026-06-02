const state = {
  config: null,
  runtimeState: null,
  buckets: [],
  runningApps: [],
  appPickerBucketIndex: null,
  unlocked: false,
  isEditing: false
};

const DEFAULT_SCHEDULE = {
  start: "09:00",
  end: "17:00"
};

const setupView = document.getElementById("setupView");
const unlockView = document.getElementById("unlockView");
const dashboardView = document.getElementById("dashboardView");
const liveStatus = document.getElementById("liveStatus");
const statusDetail = document.getElementById("statusDetail");
const bucketList = document.getElementById("bucketList");
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

function createBucketId() {
  return globalThis.crypto?.randomUUID?.() || `bucket-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyBucket(index = state.buckets.length) {
  return {
    id: createBucketId(),
    name: `Bucket ${index + 1}`,
    schedule: { ...DEFAULT_SCHEDULE },
    blockedApps: []
  };
}

function cloneBuckets(buckets) {
  return (buckets || []).map((bucket, index) => ({
    id: bucket.id || createBucketId(),
    name: bucket.name || `Bucket ${index + 1}`,
    schedule: {
      ...DEFAULT_SCHEDULE,
      ...(bucket.schedule || {})
    },
    blockedApps: (bucket.blockedApps || []).map((entry) => ({
      name: entry.name || "",
      path: entry.path || ""
    }))
  }));
}

function getBucket(index) {
  return state.buckets[index] || null;
}

function markEditing() {
  if (state.unlocked) {
    state.isEditing = true;
  }
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
    .map((entry) => {
      const bucketLabel = Array.isArray(entry.bucketNames) && entry.bucketNames.length > 0
        ? ` | Bucket${entry.bucketNames.length === 1 ? "" : "s"}: ${entry.bucketNames.join(", ")}`
        : "";

      return `
        <div class="log-item">
          <div>
            <strong>${escapeHtml(entry.name)}</strong>
            <span>${escapeHtml(entry.path || "Path unavailable")} | PID ${entry.pid}${escapeHtml(bucketLabel)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderBucketApps(bucket, bucketIndex) {
  if (bucket.blockedApps.length === 0) {
    return `
      <div class="app-item">
        <div class="app-info">
          <strong>No apps in this bucket yet</strong>
          <span>Use "Add running apps" or "Browse for .exe files" to populate this bucket.</span>
        </div>
      </div>
    `;
  }

  return bucket.blockedApps
    .map(
      (entry, appIndex) => `
        <div class="app-item">
          <div class="app-info">
            <strong>${escapeHtml(entry.name)}</strong>
            <span>${escapeHtml(entry.path || "Path unavailable. Blocking will match by process name.")}</span>
          </div>
          <button class="danger" type="button" data-action="remove-app" data-bucket-index="${bucketIndex}" data-app-index="${appIndex}">
            Remove
          </button>
        </div>
      `
    )
    .join("");
}

function renderBuckets() {
  if (state.buckets.length === 0) {
    bucketList.innerHTML = `
      <div class="bucket-empty">
        <strong>No buckets yet</strong>
        <span>Add a bucket to define a time range and the apps it should block.</span>
      </div>
    `;
    return;
  }

  bucketList.innerHTML = state.buckets
    .map(
      (bucket, index) => `
        <section class="bucket-card" data-bucket-index="${index}">
          <div class="bucket-card-head">
            <div class="bucket-title-block">
              <p class="eyebrow">Bucket ${index + 1}</p>
              <label class="bucket-name-field">
                <span>Bucket Name</span>
                <input type="text" value="${escapeHtml(bucket.name)}" data-field="name" placeholder="School, Work, Gaming, etc." />
              </label>
            </div>
            <button class="danger" type="button" data-action="remove-bucket">Remove bucket</button>
          </div>

          <div class="grid bucket-grid">
            <label>
              <span>Start Time</span>
              <input type="time" value="${escapeHtml(bucket.schedule.start)}" data-field="start" />
            </label>
            <label>
              <span>End Time</span>
              <input type="time" value="${escapeHtml(bucket.schedule.end)}" data-field="end" />
            </label>
          </div>

          <p class="hint bucket-hint">
            Overnight windows are supported. Example: 22:00 to 06:00 blocks this bucket all night.
          </p>

          <div class="button-group bucket-actions">
            <button class="secondary" type="button" data-action="add-running-apps">Add running apps</button>
            <button class="secondary" type="button" data-action="browse-apps">Browse for .exe files</button>
          </div>

          <div class="app-list">
            ${renderBucketApps(bucket, index)}
          </div>
        </section>
      `
    )
    .join("");
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
    statusDetail.textContent = "Create the admin PIN to turn on bucket-based blocking.";
    return;
  }

  const activeBuckets = runtimeState?.activeBuckets || [];
  if (activeBuckets.length > 0) {
    const activeNames = activeBuckets.map((bucket) => bucket.name).join(", ");
    const watchedCount = activeBuckets.reduce((total, bucket) => total + bucket.blockedAppCount, 0);
    liveStatus.textContent = "Blocking now";
    statusDetail.textContent = `Active bucket${activeBuckets.length === 1 ? "" : "s"}: ${activeNames}. Watching ${watchedCount} app${watchedCount === 1 ? "" : "s"}.`;
    return;
  }

  liveStatus.textContent = "Waiting";
  statusDetail.textContent = `Outside all blocking windows. Last enforcement: ${formatTimestamp(runtimeState?.lastEnforcedAt)}`;
}

function renderViewMode() {
  const hasPin = Boolean(state.config?.hasPin);

  setupView.classList.toggle("hidden", hasPin);
  unlockView.classList.toggle("hidden", !hasPin || state.unlocked);
  dashboardView.classList.toggle("hidden", !hasPin || !state.unlocked);
}

function addAppsToBucket(bucketIndex, appEntries) {
  const bucket = getBucket(bucketIndex);
  if (!bucket) {
    return;
  }

  for (const appEntry of appEntries) {
    if (!appEntry) {
      continue;
    }

    const duplicate = bucket.blockedApps.some((entry) => {
      return (
        entry.name.toLowerCase() === String(appEntry.name || "").toLowerCase() &&
        entry.path.toLowerCase() === String(appEntry.path || "").toLowerCase()
      );
    });

    if (!duplicate) {
      bucket.blockedApps.push({
        name: appEntry.name || "",
        path: appEntry.path || ""
      });
    }
  }

  markEditing();
  renderBuckets();
}

function removeAppFromBucket(bucketIndex, appIndex) {
  const bucket = getBucket(bucketIndex);
  if (!bucket) {
    return;
  }

  bucket.blockedApps.splice(appIndex, 1);
  markEditing();
  renderBuckets();
}

function removeBucket(bucketIndex) {
  state.buckets.splice(bucketIndex, 1);
  markEditing();
  renderBuckets();
}

async function openRunningAppsPicker(bucketIndex) {
  state.appPickerBucketIndex = bucketIndex;
  setMessage(runningAppsMessage, "");
  state.runningApps = await window.softwareBlocker.listRunningApps();
  renderRunningAppsList();
  runningAppsDialog.showModal();
}

async function addBrowsedApps(bucketIndex) {
  const pickedApps = await window.softwareBlocker.pickApps();
  addAppsToBucket(bucketIndex, pickedApps);
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

async function refreshState() {
  const data = await window.softwareBlocker.getState();
  state.config = data.config;
  state.runtimeState = data.runtimeState;

  if (!state.isEditing) {
    state.buckets = cloneBuckets(data.config.buckets);
  }

  renderViewMode();
  renderBuckets();
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
  state.isEditing = false;
  setMessage(setupMessage, "PIN created. Build one or more buckets, then save.");
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
  state.buckets = cloneBuckets(state.config?.buckets || []);
  state.isEditing = false;
  document.getElementById("actionPin").value = pin;
  setMessage(unlockMessage, "");
  await refreshState();
});

document.getElementById("addBucketButton").addEventListener("click", () => {
  state.buckets.push(createEmptyBucket());
  markEditing();
  renderBuckets();
});

bucketList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const bucketIndex = Number(button.dataset.bucketIndex ?? button.closest("[data-bucket-index]")?.dataset.bucketIndex);
  const action = button.dataset.action;

  if (action === "remove-bucket") {
    removeBucket(bucketIndex);
    return;
  }

  if (action === "remove-app") {
    removeAppFromBucket(bucketIndex, Number(button.dataset.appIndex));
    return;
  }

  if (action === "add-running-apps") {
    await openRunningAppsPicker(bucketIndex);
    return;
  }

  if (action === "browse-apps") {
    await addBrowsedApps(bucketIndex);
  }
});

bucketList.addEventListener("input", (event) => {
  const input = event.target.closest("input[data-field]");
  if (!input) {
    return;
  }

  const bucketIndex = Number(input.closest("[data-bucket-index]")?.dataset.bucketIndex);
  const bucket = getBucket(bucketIndex);
  if (!bucket) {
    return;
  }

  const field = input.dataset.field;
  if (field === "name") {
    bucket.name = input.value;
  }

  if (field === "start") {
    bucket.schedule.start = input.value;
  }

  if (field === "end") {
    bucket.schedule.end = input.value;
  }

  markEditing();
});

document.getElementById("refreshRunningAppsButton").addEventListener("click", async () => {
  state.runningApps = await window.softwareBlocker.listRunningApps();
  renderRunningAppsList();
});

document.getElementById("confirmRunningAppsButton").addEventListener("click", () => {
  const selectedApps = Array.from(
    runningAppsList.querySelectorAll("input[type='checkbox']:checked")
  ).map((checkbox) => state.runningApps[Number(checkbox.dataset.index)]);

  if (selectedApps.length === 0) {
    setMessage(runningAppsMessage, "Choose at least one running app to add.", true);
    return;
  }

  addAppsToBucket(state.appPickerBucketIndex, selectedApps);
  runningAppsDialog.close();
});

document.getElementById("saveButton").addEventListener("click", async () => {
  const pin = document.getElementById("actionPin").value;
  const payload = {
    pin,
    buckets: cloneBuckets(state.buckets)
  };

  const result = await window.softwareBlocker.saveSettings(payload);
  if (!result.ok) {
    setMessage(dashboardMessage, result.error, true);
    return;
  }

  setMessage(dashboardMessage, "Buckets saved.");
  state.config = {
    ...state.config,
    buckets: cloneBuckets(state.buckets)
  };
  state.isEditing = false;
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

document.getElementById("actionPin").addEventListener("input", markEditing);
document.getElementById("actionPin").addEventListener("change", markEditing);

window.softwareBlocker.onStateUpdated(() => {
  refreshState();
});

setInterval(refreshState, 5000);
refreshState();
