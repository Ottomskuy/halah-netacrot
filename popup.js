const autoEnabled = document.getElementById("autoEnabled");
const analyzeNow = document.getElementById("analyzeNow");
const status = document.getElementById("status");

chrome.storage.local.get(["autoEnabled", "lastStatus"]).then((settings) => {
  autoEnabled.checked = Boolean(settings.autoEnabled);
  status.textContent = settings.lastStatus || "Ready.";
});

autoEnabled.addEventListener("change", async () => {
  autoEnabled.disabled = true;
  try {
    const tab = await getActiveTab();
    const response = await chrome.runtime.sendMessage({
      type: "SET_AUTO_MODE",
      enabled: autoEnabled.checked,
      tabId: tab.id
    });
    if (response && response.error) throw new Error(response.error);
    status.textContent = autoEnabled.checked
      ? "Auto mode is on for this tab."
      : "Auto mode is off.";
  } catch (error) {
    autoEnabled.checked = !autoEnabled.checked;
    status.textContent = error.message;
  } finally {
    autoEnabled.disabled = false;
  }
});

analyzeNow.addEventListener("click", async () => {
  analyzeNow.disabled = true;
  status.textContent = "Starting analysis...";
  try {
    const tab = await getActiveTab();
    const response = await chrome.runtime.sendMessage({ type: "TRIGGER_MANUAL", tabId: tab.id });
    if (response && response.error) throw new Error(response.error);
    const result = response && response.outcome && response.outcome.result;
    status.textContent = result
      ? `Selected ${result.selected_indices.length} option(s). ${result.explanation}`
      : "Analysis completed.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    analyzeNow.disabled = false;
  }
});

document.getElementById("openOptions").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.lastStatus) {
    status.textContent = changes.lastStatus.newValue || "Ready.";
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !Number.isInteger(tab.id)) throw new Error("No active tab was found.");
  return tab;
}
