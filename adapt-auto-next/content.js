(() => {
  if (window.__adaptAutoNextLoaded) return;
  window.__adaptAutoNextLoaded = true;

  const MESSAGE_MARKER = "ADAPT_COURSE_DATA";
  const courseData = Object.create(null);
  const processedComponents = new Set();
  let autoEnabled = false;
  let processing = false;
  let observerTimer = 0;
  let countTimer = 0;
  let reportedComponentCount = -1;
  let lastAdvancedPage = "";

  chrome.storage.local.get(["autoEnabled"]).then((settings) => {
    autoEnabled = Boolean(settings.autoEnabled);
    if (autoEnabled) scheduleRun();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.autoEnabled) return;
    autoEnabled = Boolean(changes.autoEnabled.newValue);
    if (autoEnabled) scheduleRun();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data ||
        event.data.marker !== MESSAGE_MARKER || !event.data.updates) return;
    Object.assign(courseData, event.data.updates);
    updateStatus(`Course data received: ${Object.keys(courseData).length} component(s).`);
    if (autoEnabled) scheduleRun();
  });

  injectMainWorldHook();

  const observer = new MutationObserver(() => {
    scheduleCountRefresh();
    if (autoEnabled) scheduleRun();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true
  });
  scheduleCountRefresh();

  function injectMainWorldHook() {
    const appendScript = () => {
      const parent = document.documentElement || document.head;
      if (!parent || document.querySelector("script[data-adapt-course-hook]")) return false;

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("injected.js");
      script.dataset.adaptCourseHook = "true";
      script.onload = () => script.remove();
      script.onerror = () => {
        script.remove();
        updateStatus("Could not load the page data hook. Check extension access and reload this page.");
      };
      parent.appendChild(script);
      return true;
    };

    if (appendScript()) return;
    const retryObserver = new MutationObserver(() => {
      if (appendScript()) retryObserver.disconnect();
    });
    retryObserver.observe(document, { childList: true, subtree: true });
  }

  function scheduleRun() {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => {
      if (autoEnabled && !processing) processPage();
    }, 600);
  }

  function scheduleCountRefresh() {
    window.clearTimeout(countTimer);
    countTimer = window.setTimeout(refreshComponentCount, 400);
  }

  function refreshComponentCount() {
    const count = findQuizComponents().length;
    if (count === reportedComponentCount) return;
    reportedComponentCount = count;
    chrome.storage.local.set({ detectedComponentCount: count });
  }

  async function processPage() {
    if (processing || !autoEnabled) return;
    processing = true;
    try {
      const components = findQuizComponents();
      if (!components.length) {
        await updateStatus("No quiz components detected; checking for a next-page control.");
        await delay(2000);
        await clickNextOnce(pageFingerprint());
        return;
      }

      let missingData = false;
      for (const component of components) {
        if (!autoEnabled) return;
        const key = `${component.id}|${component.options.map((option) => option.text).join("|")}`;
        if (processedComponents.has(key)) continue;

        const answer = courseData[component.id];
        if (!answer) {
          missingData = true;
          continue;
        }

        processedComponents.add(key);
        clickCorrectOptions(component.options, answer.selected_indices);
        await delay(randomDelay());
        if (!autoEnabled) return;

        const submit = findSubmitButton(component.root);
        if (submit) {
          submit.click();
          await updateStatus(`Answered component ${component.id}; submitted.`);
          await delay(500);
        } else {
          await updateStatus(`Answered component ${component.id}; no Check/Submit button found.`);
        }
      }

      if (missingData) {
        await updateStatus(`Quiz detected, but answer data is not available for every component (${components.length} found).`);
        return;
      }

      await delay(2000);
      if (autoEnabled) await clickNextOnce(pageFingerprint());
    } finally {
      processing = false;
    }
  }

  function findQuizComponents() {
    // Adapt commonly renders quiz components with data-adapt-id and MCQ/GMCQ classes.
    const selector = [
      "[data-adapt-id]",
      ".component-mcq",
      ".component-gmcq",
      ".mcq",
      ".gmcq",
      '[class*="mcq"]',
      '[class*="gmcq"]'
    ].join(",");
    const roots = [...document.querySelectorAll(selector)];
    const found = new Map();

    for (const root of roots) {
      if (!isVisible(root)) continue;
      const options = findOptions(root);
      if (!options.length) continue;
      const id = root.getAttribute("data-adapt-id") ||
        root.getAttribute("data-component-id") || root.id;
      if (id && !found.has(id)) found.set(id, { id, root, options });
    }
    return [...found.values()];
  }

  function findOptions(root) {
    // Prefer native controls; Adapt themes often wrap them in visible labels.
    const inputs = [...root.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    if (inputs.length) {
      return inputs.map((input) => {
        const label = (input.labels && input.labels[0]) ||
          input.closest("label") ||
          input.closest(".component-item, li, .choice") ||
          input.parentElement;
        return { input, clickable: label, text: (label && label.innerText || "").trim() };
      }).filter((option) => option.clickable);
    }

    // Customize these item selectors if the Adapt theme uses different markup.
    return [...root.querySelectorAll(
      ".component-item, .mcq-item, .gmcq-item, [role='radio'], [role='checkbox']"
    )].filter(isVisible).map((element) => ({
      input: null,
      clickable: element,
      text: (element.innerText || "").trim()
    }));
  }

  function clickCorrectOptions(options, indices) {
    for (const index of indices) {
      const option = options[index];
      if (!option || !option.clickable) continue;
      if (option.input && option.input.checked) continue;
      // Clicking the label/item lets the framework receive its normal UI event.
      option.clickable.click();
    }
  }

  function findSubmitButton(root) {
    // Adapt themes often use .js-btn-action; keep text matching as a fallback.
    const candidates = [...root.querySelectorAll(
      ".js-btn-action, button, input[type='submit'], [role='button']"
    )].filter((element) => !element.disabled && isVisible(element));
    return candidates.find((element) =>
      /^(submit|check|check answer|submit answer)$/i.test(
        (element.innerText || element.value || element.getAttribute("aria-label") || "").trim()
      )
    ) || null;
  }

  async function clickNextOnce(key) {
    if (key === lastAdvancedPage || !autoEnabled) return;
    const button = findNextButton();
    if (!button) {
      await updateStatus("No Next/Continue navigation control was found.");
      return;
    }

    lastAdvancedPage = key;
    button.click();
    await updateStatus("Moved to the next page.");
  }

  function findNextButton() {
    // Adapt themes may use navigation links, icon buttons, or translated labels.
    const candidates = [...document.querySelectorAll(
      ".js-btn-action, button, a, [role='button'], [aria-label], [title]"
    )].filter((element) => !element.disabled && isVisible(element));
    return candidates.find((element) => {
      const label = [
        element.innerText,
        element.value,
        element.getAttribute("aria-label"),
        element.getAttribute("title")
      ].filter(Boolean).join(" ").trim();
      return /\b(next|continue|next page|lanjut|berikutnya)\b/i.test(label);
    }) || null;
  }

  function pageFingerprint() {
    const quizIds = findQuizComponents().map((component) => component.id).join(",");
    return `${location.href}|${quizIds}|${(document.body && document.body.innerText || "").slice(0, 500)}`;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function randomDelay() {
    return 1500 + Math.floor(Math.random() * 1001);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function updateStatus(text) {
    const count = findQuizComponents().length;
    const updates = { lastStatus: text };
    if (count !== reportedComponentCount) {
      reportedComponentCount = count;
      updates.detectedComponentCount = count;
    }
    await chrome.storage.local.set(updates);
  }
})();
