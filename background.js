const DEFAULTS = {
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  apiKey: "",
  autoEnabled: false,
  activeTabId: null
};

const SYSTEM_PROMPT = [
  "You are a networking tutor. The supplied question text and options are the complete task context.",
  "Use general networking knowledge to answer; do not abstain merely because this is a course question.",
  "Choose the best-supported option(s), matching the option wording to the question.",
  "Use zero-based indices from the supplied options array.",
  "Return only a JSON object with this exact shape:",
  '{"selected_indices":[0],"explanation":"A brief explanation."}',
  "For a single-choice question return one index; for a multiple-choice question return all applicable indices.",
  "Do not return an empty selected_indices array when the question and options are present; make the best-supported choice.",
  "Example: the statement 'DTP is an open standard IEEE protocol' is false because DTP is Cisco-proprietary, not an IEEE standard."
].join(" ");

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULTS).then((settings) => {
    return chrome.storage.local.set(settings);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "ANALYZE_QUESTION") {
    analyzeQuestion(message.question, message.options)
      .then(sendResponse)
      .catch(async (error) => {
        await setStatus(`Analysis failed: ${error.message}`);
        sendResponse({ error: error.message });
      });
    return true;
  }

  if (message.type === "SET_STATUS") {
    setStatus(message.text).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "SET_AUTO_MODE") {
    setAutoMode(message.enabled, message.tabId)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "TRIGGER_MANUAL") {
    triggerManual(message.tabId)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  chrome.storage.local.get(["autoEnabled", "activeTabId"]).then((settings) => {
    if (settings.autoEnabled && settings.activeTabId === tabId) {
      injectContentScript(tabId).catch((error) => {
        setStatus(`Could not resume on this page: ${error.message}`);
      });
    }
  });
});

async function setAutoMode(enabled, tabId) {
  await chrome.storage.local.set({
    autoEnabled: Boolean(enabled),
    activeTabId: enabled ? tabId : null
  });
  await setStatus(enabled ? "Auto-Interactive Flow is on." : "Auto-Interactive Flow is off.");

  if (enabled) {
    await injectContentScript(tabId);
    await sendToTabFrames(tabId, { type: "SET_AUTO_MODE", enabled: true });
    await sendToTabFrames(tabId, { type: "ANALYZE_NOW", automatic: true });
  } else if (Number.isInteger(tabId)) {
    try {
      await injectContentScript(tabId);
      await sendToTabFrames(tabId, { type: "SET_AUTO_MODE", enabled: false });
    } catch (error) {
      await setStatus(`Could not turn off flow in every frame: ${error.message}`);
    }
  }

  return { ok: true };
}

async function triggerManual(tabId) {
  await injectContentScript(tabId);
  const settings = await chrome.storage.local.get(["autoEnabled"]);
  const outcomes = await sendToTabFrames(tabId, {
    type: "ANALYZE_NOW",
    automatic: Boolean(settings.autoEnabled)
  });
  const outcome = outcomes.find((item) => item && item.result) ||
    outcomes.find((item) => item && item.error) ||
    outcomes.find((item) => item && !item.skipped);
  if (!outcome && outcomes.length) {
    const frames = outcomes
      .filter((item) => item && item.frameInfo)
      .map((item) => {
        const info = item.frameInfo;
        return `${info.frameUrl} (radio/checkbox: ${info.radioCount}, custom: ${info.customCount}; text: "${info.textSample}")`;
      })
      .join("; ");
    throw new Error(`No question was detected in ${outcomes.length} accessible frame(s). ${frames}`);
  }
  if (!outcome || !outcome.ok) {
    throw new Error(outcome && (outcome.error || outcome.reason) || "Analysis did not complete.");
  }
  return { ok: true, outcome };
}

async function injectContentScript(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("No active browser tab was found.");
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"]
  });
}

async function sendToTabFrames(tabId, message) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => true
  });
  const responses = await Promise.all(frames.map(async (frame) => {
    try {
      return await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
    } catch (error) {
      return { ok: false, error: `Frame ${frame.frameId}: ${error.message}` };
    }
  }));
  return responses;
}

async function analyzeQuestion(question, options) {
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("No readable question was found on the page.");
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("No visible answer options were found.");
  }

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.apiKey) throw new Error("Add an API key in the extension options first.");

  const result = settings.provider === "gemini"
    ? await requestGemini(settings, question, options)
    : await requestOpenAICompatible(settings, question, options);
  return validateResult(result, options.length);
}

async function requestOpenAICompatible(settings, question, options) {
  if (!settings.baseUrl || !settings.model) {
    throw new Error("Set a base URL and model in the extension options.");
  }

  const endpoint = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ question, options }) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    })
  });

  const payload = await readResponse(response);
  const content = payload.choices && payload.choices[0] &&
    payload.choices[0].message && payload.choices[0].message.content;
  if (typeof content !== "string") throw new Error("The provider returned no message content.");
  return parseModelJson(content);
}

async function requestGemini(settings, question, options) {
  if (!settings.model) throw new Error("Set a model in the extension options.");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify({ question, options }) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    })
  });

  const payload = await readResponse(response);
  const content = payload.candidates && payload.candidates[0] &&
    payload.candidates[0].content && payload.candidates[0].content.parts &&
    payload.candidates[0].content.parts[0] && payload.candidates[0].content.parts[0].text;
  if (typeof content !== "string") throw new Error("The provider returned no message content.");
  return parseModelJson(content);
}

async function readResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error && (payload.error.message || payload.error);
    throw new Error(typeof detail === "string" ? detail : `Provider request failed (${response.status}).`);
  }
  return payload;
}

function parseModelJson(content) {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error("The provider response was not valid JSON.");
  }
}

function validateResult(result, optionCount) {
  if (!result || !Array.isArray(result.selected_indices) ||
      typeof result.explanation !== "string") {
    throw new Error("The provider response did not match the required JSON shape.");
  }

  const selected = [...new Set(result.selected_indices)];
  if (selected.some((index) => !Number.isInteger(index) || index < 0 || index >= optionCount)) {
    throw new Error("The provider returned an answer index outside the available options.");
  }

  return { selected_indices: selected, explanation: result.explanation };
}

async function setStatus(text) {
  await chrome.storage.local.set({ lastStatus: text });
}
