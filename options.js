const PROVIDER_DEFAULTS = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile"
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free"
  },
  gemini: {
    baseUrl: "",
    model: "gemini-3.5-flash-lite"
  }
};

const form = document.getElementById("settingsForm");
const provider = document.getElementById("provider");
const baseUrl = document.getElementById("baseUrl");
const model = document.getElementById("model");
const apiKey = document.getElementById("apiKey");
const status = document.getElementById("status");

chrome.storage.local.get(["provider", "baseUrl", "model", "apiKey"]).then((settings) => {
  provider.value = settings.provider || "groq";
  baseUrl.value = settings.baseUrl || PROVIDER_DEFAULTS.groq.baseUrl;
  const savedModel = settings.model === "gemini-2.0-flash"
    ? PROVIDER_DEFAULTS.gemini.model
    : settings.model;
  model.value = savedModel || PROVIDER_DEFAULTS[provider.value].model;
  apiKey.value = settings.apiKey || "";
  updateBaseUrlAvailability();
});

provider.addEventListener("change", () => {
  const defaults = PROVIDER_DEFAULTS[provider.value];
  baseUrl.value = defaults.baseUrl;
  model.value = defaults.model;
  updateBaseUrlAvailability();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (provider.value !== "gemini") {
      const endpoint = new URL(baseUrl.value.trim());
      if (endpoint.protocol !== "https:") {
        throw new Error("The API base URL must use HTTPS.");
      }
      const originPattern = `${endpoint.origin}/*`;
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error("Host access was not granted for this API URL.");
    }

    await chrome.storage.local.set({
      provider: provider.value,
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim(),
      apiKey: apiKey.value.trim()
    });
    status.textContent = "Settings saved on this device.";
  } catch (error) {
    status.textContent = `Could not save settings: ${error.message}`;
  }
});

function updateBaseUrlAvailability() {
  const isGemini = provider.value === "gemini";
  baseUrl.disabled = isGemini;
  baseUrl.required = !isGemini;
}
