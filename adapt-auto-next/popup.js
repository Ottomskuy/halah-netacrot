const autoEnabled = document.getElementById("autoEnabled");
const count = document.getElementById("count");
const status = document.getElementById("status");

chrome.storage.local.get(["autoEnabled", "detectedComponentCount", "lastStatus"]).then((settings) => {
  autoEnabled.checked = Boolean(settings.autoEnabled);
  count.textContent = String(settings.detectedComponentCount || 0);
  status.textContent = settings.lastStatus || "Ready.";
});

autoEnabled.addEventListener("change", async () => {
  autoEnabled.disabled = true;
  try {
    await chrome.storage.local.set({ autoEnabled: autoEnabled.checked });
    status.textContent = autoEnabled.checked ? "Auto mode is on." : "Auto mode is off.";
  } catch (error) {
    autoEnabled.checked = !autoEnabled.checked;
    status.textContent = `Could not update setting: ${error.message}`;
  } finally {
    autoEnabled.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.detectedComponentCount) {
    count.textContent = String(changes.detectedComponentCount.newValue || 0);
  }
  if (changes.lastStatus) {
    status.textContent = changes.lastStatus.newValue || "Ready.";
  }
  if (changes.autoEnabled) {
    autoEnabled.checked = Boolean(changes.autoEnabled.newValue);
  }
});
