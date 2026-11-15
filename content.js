(() => {
  if (window.__interactiveLearningAssistantLoaded) return;
  window.__interactiveLearningAssistantLoaded = true;

  let autoEnabled = false;
  let processing = false;
  let lastAnsweredFingerprint = "";
  let observerTimer = 0;

  chrome.storage.local.get(["autoEnabled"]).then((settings) => {
    autoEnabled = Boolean(settings.autoEnabled);
    if (autoEnabled) scheduleAutomaticRun();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SET_AUTO_MODE") {
      autoEnabled = Boolean(message.enabled);
      if (autoEnabled) scheduleAutomaticRun();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "ANALYZE_NOW") {
      runFlow(Boolean(message.automatic)).then(sendResponse);
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => {
    if (autoEnabled) scheduleAutomaticRun();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  function scheduleAutomaticRun() {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => {
      if (autoEnabled && !processing) runFlow(true);
    }, 700);
  }

  async function runFlow(automatic) {
    if (processing) return { ok: false, reason: "A question is already being processed." };
    const questionData = extractQuestion();
    if (!questionData) {
      const frameInfo = {
        frameUrl: location.href,
        radioCount: queryAllDeep('input[type="radio"], input[type="checkbox"]').length,
        customCount: queryAllDeep(
          '[role="radio"], [role="checkbox"], [aria-checked], [class*="option"], [class*="choice"], [class*="answer"], [class*="item"]'
        ).filter(isInViewport).length,
        textSample: (document.body && document.body.innerText || "").trim().slice(0, 180)
      };
      if (window !== window.top) {
        return { ok: true, skipped: true, frameInfo };
      }
      if (hasNetAcadFrame()) {
        await reportStatus("Waiting for the course question inside its NetAcad frame.");
        return { ok: true, skipped: true, frameInfo };
      }
      await reportStatus("No active question with visible answer options was found.");
      return { ok: false, reason: "No active question found.", frameInfo };
    }

    const fingerprint = `${questionData.question}|${questionData.options.map((item) => item.text).join("|")}`;
    if (automatic && fingerprint === lastAnsweredFingerprint) {
      await advanceAfterFeedback();
      return { ok: true, skipped: true };
    }

    processing = true;
    try {
      await reportStatus("Analyzing the visible question...");
      const result = await chrome.runtime.sendMessage({
        type: "ANALYZE_QUESTION",
        question: questionData.question,
        options: questionData.options.map(({ index, text }) => ({ index, text }))
      });
      if (!result || result.error) throw new Error(result && result.error || "Analysis failed.");

      if (result.selected_indices.length === 0) {
        await reportStatus(`No selection made. ${result.explanation}`);
        return { ok: true, result };
      }

      const selection = await selectOptions(questionData.options, result.selected_indices);
      if (selection.verified.length !== result.selected_indices.length) {
        const optionSummary = questionData.options.map((option, index) =>
          `${index}: ${option.text}`
        ).join(" | ");
        const message = `Click was not confirmed. Question: ${questionData.question.slice(0, 180)} | Options: ${optionSummary.slice(0, 220)}`;
        await reportStatus(message);
        return { ok: false, error: message };
      }

      lastAnsweredFingerprint = fingerprint;
      await reportStatus(`Selected ${selection.verified.length} option(s). ${result.explanation}`);

      if (automatic && autoEnabled) await submitAndAdvance();
      return { ok: true, result, selection };
    } catch (error) {
      await reportStatus(`Could not complete the flow: ${error.message}`);
      return { ok: false, error: error.message };
    } finally {
      processing = false;
    }
  }

  function extractQuestion() {
    // Adjust these group selectors if the target LMS uses custom question containers.
    const inputs = queryAllDeep('input[type="radio"], input[type="checkbox"]')
      .filter((input) => {
        const label = getOptionLabel(input);
        return !input.disabled && label && isInViewport(label);
      });
    if (!inputs.length) return extractCustomQuestion();

    const first = inputs[0];
    const group = first.closest('fieldset, [role="radiogroup"], [role="group"], [data-question]')
      || findSmallestOptionContainer(first, inputs);
    const groupedInputs = inputs.filter((input) => group.contains(input));
    if (!groupedInputs.length) return null;

    const options = groupedInputs.map((input, index) => {
      const label = getOptionLabel(input);
      return { index, text: (label.innerText || "").trim(), input, label };
    }).filter((option) => option.text);
    if (!options.length) return null;

    const question = getQuestionText(group, options);
    if (!question) return null;
    return { question, options };
  }

  function extractCustomQuestion() {
    // Adapt themes may render choices as clickable divs instead of native inputs.
    const groupSelector = [
      "fieldset",
      '[role="radiogroup"]',
      '[role="group"]',
      "[data-question]",
      "[data-adapt-id]",
      ".component-mcq",
      ".component-gmcq",
      ".mcq",
      ".gmcq",
      '[class*="mcq"]',
      '[class*="gmcq"]'
    ].join(",");
    const optionSelector = [
      ".component-item",
      ".mcq-item",
      ".gmcq-item",
      '[role="radio"]',
      '[role="checkbox"]',
      "[aria-checked]",
      '[tabindex]:not([tabindex="-1"])',
      '[class*="option"]',
      '[class*="choice"]',
      '[class*="answer"]',
      '[class*="item"]',
      "label"
    ].join(",");

    const groups = [...queryAllDeep(groupSelector), document.body].filter(Boolean);
    for (const group of groups) {
      if (!isInViewport(group)) continue;
      const candidates = queryAllDeep(optionSelector, group)
        .filter((element) => isInViewport(element) && (element.innerText || "").trim())
        .filter((element) => !queryAllDeep(optionSelector, element)
          .some((child) => (child.innerText || "").trim()));
      const options = candidates.map((element, index) => ({
        index,
        text: (element.innerText || "").trim(),
        input: null,
        label: element
      }));
      if (options.length < 2) continue;

      const question = getQuestionText(group, options);
      if (question) return { question, options };
    }
    return null;
  }

  function getOptionLabel(input) {
    if (input.labels && input.labels.length) return input.labels[0];
    // Customize label selectors here for LMS markup that does not use a <label for="...">.
    return input.closest("label") || input.parentElement ||
      (input.getRootNode().host && input.getRootNode().host);
  }

  function queryAllDeep(selector, root) {
    const scope = root || document;
    const results = [...scope.querySelectorAll(selector)];
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) results.push(...queryAllDeep(selector, element.shadowRoot));
    }
    return [...new Set(results)];
  }

  function findSmallestOptionContainer(input, visibleInputs) {
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const count = visibleInputs.filter((candidate) => node.contains(candidate)).length;
      if (count > 1) return node;
    }
    return input.form || document.body;
  }

  function getQuestionText(group, options) {
    // Prefer dedicated prompt elements; headings like "Question 1" are not the question.
    const prompt = group.querySelector(
      "legend, [data-question-text], .question-text, .mcq-question, .gmcq-question"
    );
    if (prompt && prompt.innerText.trim()) return prompt.innerText.trim();

    const optionTexts = options.map((option) => normalizeText(option.text));
    const ancestors = [];
    let node = group;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      ancestors.push(node);
    }
    const promptCandidates = ancestors.flatMap((ancestor) => [
      ...ancestor.querySelectorAll(
        "p, [data-question-text], [class*='question'], [class*='prompt'], [class*='stem']"
      )
    ]).map((element) => (element.innerText || "").trim())
      .filter((text) => text.length >= 20 && text.length <= 500)
      .filter((text) => !/^question\s*\d*$/i.test(text))
      .filter((text) => !optionTexts.includes(normalizeText(text)))
      .filter((text) => text.includes("?") || /\b(true or false|select|which|what|where|why)\b/i.test(text));
    if (promptCandidates.length) {
      return promptCandidates.sort((a, b) => a.length - b.length)[0];
    }

    const lines = (group.innerText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const remaining = lines.filter((line) =>
      !/^question\s*\d*$/i.test(line) &&
      !optionTexts.includes(normalizeText(line))
    );
    return remaining.join("\n").trim().slice(0, 4000);
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0;
    return visible && rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
  }

  function hasNetAcadFrame() {
    return [...document.querySelectorAll("iframe")].some((frame) => {
      try {
        const host = new URL(frame.src, location.href).hostname;
        return host === "netacad.com" || host.endsWith(".netacad.com");
      } catch (error) {
        return false;
      }
    });
  }

  async function selectOptions(options, selectedIndices) {
    const verified = [];
    for (const index of selectedIndices) {
      const option = options[index];
      if (!option) continue;
      const input = option.input || option.label.querySelector(
        'input[type="radio"], input[type="checkbox"]'
      );
      if (input) {
        input.click();
      } else {
        // Prefer the Adapt item/card ancestor, whose delegated handler owns the choice.
        const target = option.label.closest(
          'label, button, [role="radio"], [role="checkbox"], [aria-checked], [tabindex], .component-item, .mcq-item, .gmcq-item'
        ) || option.label;
        target.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window
        }));
        target.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window
        }));
        target.click();
      }

      await delay(180);
      if (isOptionSelected(option)) verified.push(index);
    }
    return { verified };
  }

  function isOptionSelected(option) {
    const input = option.input || option.label.querySelector(
      'input[type="radio"], input[type="checkbox"]'
    );
    if (input && input.checked) return true;

    let element = option.label;
    for (let depth = 0; element && depth < 5; depth += 1, element = element.parentElement) {
      if (element.getAttribute("aria-checked") === "true" ||
          element.getAttribute("aria-selected") === "true" ||
          element.getAttribute("aria-pressed") === "true") return true;
      if (/\b(selected|checked|active|is-selected|is-checked)\b/i.test(element.className || "")) {
        return true;
      }
    }
    return false;
  }

  async function submitAndAdvance() {
    await delay(randomDelay());
    if (!autoEnabled) return;

    const checkButton = findActionButton(["check", "submit", "submit answer"]);
    if (checkButton) {
      checkButton.click();
      await waitForDomChange(8000);
      if (!autoEnabled) return;
      await delay(randomDelay());
    }

    const nextButton = findActionButton(["next", "continue", "next question", "next lesson"]);
    if (nextButton && autoEnabled) {
      nextButton.click();
      await reportStatus("Advanced to the next step.");
      await delay(500);
      scheduleAutomaticRun();
    } else if (!checkButton) {
      await reportStatus("Answer selected; no Check, Submit, or Next button was found.");
    }
  }

  async function advanceAfterFeedback() {
    if (!autoEnabled || processing) return;
    const nextButton = findActionButton(["next", "continue", "next question", "next lesson"]);
    if (!nextButton) return;
    processing = true;
    try {
      await delay(randomDelay());
      if (autoEnabled && nextButton.isConnected) {
        nextButton.click();
        await reportStatus("Advanced to the next step.");
      }
    } finally {
      processing = false;
      scheduleAutomaticRun();
    }
  }

  function findActionButton(actionWords) {
    // Add LMS-specific CSS selectors here if action controls are not native buttons.
    const candidates = [...document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], [role="button"], a'
    )].filter((element) => !element.disabled && isInViewport(element));
    const normalized = (element) =>
      `${element.innerText || element.value || ""} ${element.getAttribute("aria-label") || ""}`
        .trim().toLowerCase();

    return candidates.find((element) =>
      actionWords.some((word) => normalized(element) === word || normalized(element).includes(word))
    ) || null;
  }

  function waitForDomChange(timeout) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        temporaryObserver.disconnect();
        resolve();
      };
      const temporaryObserver = new MutationObserver(finish);
      temporaryObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      const timer = setTimeout(finish, timeout);
    });
  }

  function randomDelay() {
    return 1500 + Math.floor(Math.random() * 1501);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function reportStatus(text) {
    return chrome.runtime.sendMessage({ type: "SET_STATUS", text }).catch(() => {});
  }
})();
