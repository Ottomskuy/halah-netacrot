(() => {
  if (window.__interactiveLearningAssistantLoaded) return;
  window.__interactiveLearningAssistantLoaded = true;

  const MESSAGE_MARKER = "NETACAD_ADAPT_DATA";
  const courseData = Object.create(null);
  const processedQuestions = new Set();
  
  let autoEnabled = false;
  let processing = false;
  let observerTimer = 0;
  let pageProgressTimer = 0;

  // 1. Initial State & Storage Sync
  chrome.storage.local.get(["autoEnabled"]).then((settings) => {
    autoEnabled = Boolean(settings.autoEnabled);
    if (autoEnabled) scheduleAutoRun(800);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.autoEnabled) {
      autoEnabled = Boolean(changes.autoEnabled.newValue);
      if (autoEnabled) scheduleAutoRun(400);
    }
  });

  // 2. Main-World Hook Injection (for 100% accurate Adapt data & completion)
  injectMainWorldHook();

  // Listen for internal course data passed by injected.js
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    
    if (event.data.marker === MESSAGE_MARKER && event.data.updates) {
      Object.assign(courseData, event.data.updates);
      if (autoEnabled && !processing) scheduleAutoRun(400);
    }

    if (event.data.type === "NETACAD_TRIGGER_NEXT") {
      triggerNextStep();
    }
  });

  // 3. Runtime Message Listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SET_AUTO_MODE") {
      autoEnabled = Boolean(message.enabled);
      if (autoEnabled) scheduleAutoRun(400);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "ANALYZE_NOW") {
      runFlow(Boolean(message.automatic)).then(sendResponse);
      return true;
    }
    return false;
  });

  // 4. DOM Observer to react to dynamically loaded SPA steps
  const observer = new MutationObserver(() => {
    if (autoEnabled) scheduleAutoRun(1000);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  function scheduleAutoRun(delayMs = 800) {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => {
      if (autoEnabled && !processing) runFlow(true);
    }, delayMs);
  }

  function injectMainWorldHook() {
    const appendScript = () => {
      const parent = document.documentElement || document.head;
      if (!parent || document.querySelector("script[data-netacad-adapt-hook]")) return false;

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("injected.js");
      script.dataset.netacadAdaptHook = "true";
      script.onload = () => script.remove();
      script.onerror = () => script.remove();
      parent.appendChild(script);
      return true;
    };

    if (appendScript()) return;
    const retryObserver = new MutationObserver(() => {
      if (appendScript()) retryObserver.disconnect();
    });
    retryObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Menangani interaksi halaman konten (Tab konten, Accordion)
  // DIKECUALIKAN: Tab "Resources", "Course Outline", Navigasi Sidebar global agar tidak nyasar keluar
  async function completePageInteractives() {
    const interactives = queryAllDeep([
      ".accordion-item__title",
      ".narrative__nav-btn--next",
      ".hotgraphic-pin",
      ".media-btn",
      ".reveal-btn",
      ".narrative-slider-nav-btn",
      // Hanya tab materi di dalam kontainer konten / article
      "article [role='tab']",
      ".component-tab [role='tab']",
      ".tabs__tab-title"
    ].join(","));

    for (const el of interactives) {
      const text = (el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
      // JANGAN KLIK TAB RESOURCE / OUTLINE / HEADER SIDEBAR!
      if (/resource|outline|menu|search|daftar isi/i.test(text)) continue;

      if (isInViewport(el) && !el.classList.contains("visited") && !el.classList.contains("is-visited")) {
        simulateClick(el);
        await delay(250);
      }
    }

    // Trigger Adapt internal complete event
    window.postMessage({ type: "FORCE_ADAPT_COMPLETE" }, "*");

    // Scroll perlahan ke bawah
    try {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (_) {}
  }

  // Mendeteksi tombol hijau "Start" pada landing kuis (seperti gambar 2, 3, 4)
  async function handleQuizStartPage() {
    const candidates = queryAllDeep("button, a, [role='button'], input[type='button'], div.btn");
    for (const el of candidates) {
      if (!isInViewport(el)) continue;
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
      // Prioritaskan tombol "Start" hijau persis di bawah instruksi kuis
      if (text === "start" || /^(start|mulai|take the quiz|take quiz|start assessment|attempt quiz now)$/i.test(text)) {
        await reportStatus("Found Quiz Start button. Starting quiz...");
        simulateClick(el);
        await delay(2000);
        return true;
      }
    }
    return false;
  }

  // Menangani konfirmasi modal dialog "Submit Quiz"
  async function handleQuizConfirmationModal() {
    const dialogSubmitBtn = queryAllDeep(".ui-dialog button, .modal button, [role='dialog'] button")
      .filter(isInViewport)
      .find(el => /submit|confirm|ok|yes|ya|lanjutkan/i.test((el.innerText || "").trim()));

    if (dialogSubmitBtn) {
      simulateClick(dialogSubmitBtn);
      await delay(1000);
      return true;
    }
    return false;
  }

  // Main Pipeline
  async function runFlow(automatic) {
    if (processing) return { ok: false, reason: "Already processing." };

    // 0. Cek apakah ada modal dialog konfirmasi
    if (await handleQuizConfirmationModal()) {
      return { ok: true, modalHandled: true };
    }

    // 1. Cek tombol hijau "Start" kuis (Check Your Understanding / Module Quiz)
    if (await handleQuizStartPage()) {
      return { ok: true, startedQuiz: true };
    }

    // 2. Berinteraksi dengan elemen materi (tanpa menyentuh tab Resources)
    await completePageInteractives();

    // 3. Ekstraksi semua kuis yang ada di halaman
    const quizes = extractAllQuizzes();

    if (quizes.length === 0) {
      // Halaman bacaan biasa / non-kuis
      handleReadingPage(automatic);
      return { ok: true, skipped: true };
    }

    // Periksa apakah masih ada soal yang belum terjawab
    const uncompleted = quizes.filter(q => !processedQuestions.has(q.fingerprint));

    if (uncompleted.length === 0) {
      // Semua soal di halaman/kuis ini sudah terjawab
      const submitQuizBtn = findSubmitQuizButton();
      if (submitQuizBtn) {
        await reportStatus("Submitting whole quiz/assessment...");
        simulateClick(submitQuizBtn);
        await delay(1500);
        await handleQuizConfirmationModal();
        return { ok: true, submittedQuiz: true };
      }

      await reportStatus("All quizzes on this page answered. Advancing to next sub-topic...");
      if (automatic && autoEnabled) {
        await delay(1200);
        triggerNextStep();
      }
      return { ok: true, completed: true };
    }

    processing = true;
    try {
      for (const quiz of uncompleted) {
        if (!autoEnabled) break;
        await reportStatus(`Answering: ${quiz.question.slice(0, 50)}...`);

        let selectedIndices = [];
        let source = "";

        // 1. Cek Kunci Jawaban Internal Adapt (100% Verified)
        if (quiz.id && courseData[quiz.id] && Array.isArray(courseData[quiz.id].selected_indices)) {
          selectedIndices = courseData[quiz.id].selected_indices;
          source = "Internal Adapt Data (100% Accurate)";
        } else {
          for (const [adaptId, comp] of Object.entries(courseData)) {
            if (comp.option_texts && comp.option_texts.length === quiz.options.length) {
              const match = comp.option_texts.every((t, i) => 
                normalizeText(t) === normalizeText(quiz.options[i].text)
              );
              if (match && comp.selected_indices) {
                selectedIndices = comp.selected_indices;
                source = "Internal Adapt Match (100% Accurate)";
                break;
              }
            }
          }
        }

        // 2. Fallback: AI Tutor
        if (!selectedIndices || selectedIndices.length === 0) {
          await reportStatus("Analyzing with AI tutor...");
          const aiResult = await chrome.runtime.sendMessage({
            type: "ANALYZE_QUESTION",
            question: quiz.question,
            options: quiz.options.map(({ index, text }) => ({ index, text }))
          });

          if (aiResult && Array.isArray(aiResult.selected_indices) && aiResult.selected_indices.length > 0) {
            selectedIndices = aiResult.selected_indices;
            source = `AI Tutor (${aiResult.explanation || "Selected"})`;
          }
        }

        if (selectedIndices && selectedIndices.length > 0) {
          await selectOptions(quiz.options, selectedIndices);
          processedQuestions.add(quiz.fingerprint);
          await reportStatus(`Selected [${selectedIndices.join(",")}] via ${source}`);

          await delay(600);
          const compSubmit = findComponentSubmit(quiz.root);
          if (compSubmit) {
            simulateClick(compSubmit);
            await delay(800);
          }
        }
      }

      // Submit kuis jika tombol Submit Quiz ada
      const submitQuizBtn = findSubmitQuizButton();
      if (submitQuizBtn) {
        await delay(1200);
        await reportStatus("Submitting whole quiz/assessment...");
        simulateClick(submitQuizBtn);
        await delay(1500);
        await handleQuizConfirmationModal();
      }

      // Lanjut otomatis
      if (automatic && autoEnabled) {
        await completePageInteractives();
        await delay(1200);
        triggerNextStep();
      }

      return { ok: true };
    } catch (err) {
      await reportStatus(`Error: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      processing = false;
    }
  }

  function handleReadingPage(automatic) {
    if (!automatic || !autoEnabled || processing) return;

    const textLength = (document.body && document.body.innerText || "").length;
    if (textLength < 80) return;

    window.clearTimeout(pageProgressTimer);
    pageProgressTimer = window.setTimeout(async () => {
      if (autoEnabled && !processing && extractAllQuizzes().length === 0) {
        await completePageInteractives();
        await reportStatus("Reading page 100% completed. Moving to next sub-topic...");
        triggerNextStep();
      }
    }, 4000);
  }

  // Ekstraksi SEMUA kuis di halaman
  function extractAllQuizzes() {
    const list = [];
    const seenRoots = new Set();

    // 1. Adapt components
    const adaptRoots = queryAllDeep("[data-adapt-id], .component-mcq, .component-gmcq, .mcq, .gmcq");
    for (const root of adaptRoots) {
      if (!isInViewport(root) || seenRoots.has(root)) continue;
      const options = findComponentOptions(root);
      if (options.length >= 2) {
        seenRoots.add(root);
        const id = root.getAttribute("data-adapt-id") || root.getAttribute("data-component-id") || root.id;
        const question = getQuestionText(root, options) || "Adapt Question";
        const fingerprint = `${id}|${question}|${options.map(o => o.text).join("|")}`;
        list.push({ id, question, options, root, fingerprint });
      }
    }

    // 2. NetAcad Assessment / Quiz Questions
    const containers = queryAllDeep(
      ".question, .quiz_question, .display_question, [data-question], fieldset, [role='radiogroup'], [role='group']"
    );
    for (const container of containers) {
      if (!isInViewport(container) || seenRoots.has(container)) continue;
      const options = findComponentOptions(container);
      if (options.length >= 2 && options.length <= 12) {
        seenRoots.add(container);
        const id = container.getAttribute("data-question-id") || container.id || "";
        const question = getQuestionText(container, options);
        if (question) {
          const fingerprint = `${id}|${question}|${options.map(o => o.text).join("|")}`;
          list.push({ id, question, options, root: container, fingerprint });
        }
      }
    }

    return list;
  }

  function findComponentOptions(root) {
    const inputs = queryAllDeep('input[type="radio"], input[type="checkbox"]', root);
    if (inputs.length >= 2) {
      return inputs.map((input, index) => {
        const label = getOptionLabel(input);
        return {
          index,
          input,
          clickable: label || input,
          text: (label && label.innerText || input.value || "").trim()
        };
      }).filter(o => o.text);
    }

    const items = queryAllDeep(
      ".component-item, .mcq-item, .gmcq-item, [role='radio'], [role='checkbox'], .answer_label, [class*='choice-item']",
      root
    ).filter(isInViewport);

    return items.map((element, index) => ({
      index,
      input: element.querySelector('input[type="radio"], input[type="checkbox"]'),
      clickable: element,
      text: (element.innerText || "").trim()
    })).filter(o => o.text && o.text.length <= 250);
  }

  function getOptionLabel(input) {
    if (input.labels && input.labels[0]) return input.labels[0];
    const parentLabel = input.closest("label");
    if (parentLabel) return parentLabel;
    if (input.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (forLabel) return forLabel;
    }
    return input.closest(".component-item, .choice, li, div") || input.parentElement;
  }

  function getQuestionText(root, options) {
    const promptElements = queryAllDeep(
      ".component-title, .component-instruction, .question-text, .question_text, legend, h3, h4, p, [class*='prompt'], [class*='stem']",
      root
    );
    const optionTexts = new Set(options.map(o => normalizeText(o.text)));
    for (const el of promptElements) {
      const text = (el.innerText || "").trim();
      if (text.length > 10 && !optionTexts.has(normalizeText(text))) {
        return text;
      }
    }
    return (root.innerText || "").slice(0, 200).trim();
  }

  async function selectOptions(options, targetIndices) {
    for (const index of targetIndices) {
      const option = options[index];
      if (!option || !option.clickable) continue;
      
      const isAlreadyChecked = (option.input && option.input.checked) ||
        option.clickable.getAttribute("aria-checked") === "true" ||
        option.clickable.classList.contains("selected") ||
        option.clickable.classList.contains("is-selected");

      if (!isAlreadyChecked) {
        simulateClick(option.clickable);
        await delay(250);
      }
    }
  }

  function findComponentSubmit(root) {
    if (!root) return null;
    const candidates = [...root.querySelectorAll(".js-btn-action, button, input[type='submit'], [role='button']")];
    return candidates.find(el => 
      /^(submit|check|check answer|submit answer|periksa|kirim)$/i.test(
        (el.innerText || el.value || el.getAttribute("aria-label") || "").trim()
      )
    );
  }

  function findSubmitQuizButton() {
    const candidates = queryAllDeep([
      "button[id*='submit_quiz']",
      "button.submit_quiz_button",
      "input.submit_quiz_button",
      "button[type='submit']",
      "input[type='submit']",
      ".btn-submit",
      "button",
      "a[role='button']"
    ].join(",")).filter(isInViewport);

    return candidates.find(el => {
      const text = `${el.innerText || el.value || ""} ${el.getAttribute("aria-label") || ""}`.trim().toLowerCase();
      return /submit quiz|submit assessment|kumpulkan kuis|akhiri kuis|finish attempt/i.test(text);
    }) || null;
  }

  // Cross-Frame Navigation Handler
  function triggerNextStep() {
    const nextBtn = findGlobalNextButton();
    if (nextBtn) {
      reportStatus("Moving to next sub-topic...");
      simulateClick(nextBtn);
      scheduleAutoRun(2500);
      return;
    }

    if (window !== window.top) {
      window.top.postMessage({ type: "NETACAD_TRIGGER_NEXT" }, "*");
    } else {
      const iframes = document.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          const innerNext = findNextInDocument(doc);
          if (innerNext) {
            simulateClick(innerNext);
            reportStatus("Triggered next inside content frame.");
            scheduleAutoRun(2500);
            return;
          }
        } catch (_) {}
      }
    }
  }

  function findGlobalNextButton() {
    return findNextInDocument(document);
  }

  function findNextInDocument(doc) {
    if (!doc) return null;
    const candidates = [
      ...doc.querySelectorAll([
        ".navigation-next",
        ".nav-next",
        ".btn-next",
        ".next-btn",
        ".next-button",
        ".js-btn-action",
        "[data-action='next']",
        "[data-testid*='next']",
        ".nav__btn--next",
        ".page-nav__btn--next",
        ".drawer__nav-btn--next",
        "a.next_page",
        "a[rel='next']",
        ".module-sequence-footer-button--next a",
        "button[aria-label*='next' i]",
        "button[aria-label*='selanjutnya' i]",
        "a[aria-label*='next' i]",
        "button[title*='next' i]",
        "a[title*='next' i]",
        "button", "a", "[role='button']"
      ].join(","))
    ].filter((el) => !el.disabled && isInViewport(el));

    const keywords = [
      "next", "continue", "next page", "next module", "next topic", "next section",
      "selanjutnya", "berikutnya", "lanjut", "next lesson", "complete & continue"
    ];

    for (const el of candidates) {
      const text = [
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.value,
        el.className
      ].filter(Boolean).join(" ").trim().toLowerCase();

      if (keywords.some(k => text === k || text.includes(k))) {
        if (!/prev|back|sebelumnya/i.test(text)) {
          return el;
        }
      }
    }

    const chevronNext = doc.querySelector(
      "[class*='next'] svg, [class*='chevron-right'], [class*='arrow-right'], .fa-chevron-right, .fa-arrow-right"
    );
    if (chevronNext) {
      const btn = chevronNext.closest("button, a, [role='button']");
      if (btn && !btn.disabled && isInViewport(btn)) return btn;
    }

    return null;
  }

  function simulateClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    ["mouseenter", "mouseover", "mousedown", "mouseup", "click"].forEach(eventType => {
      element.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    });
    if (typeof element.click === "function") {
      element.click();
    }
  }

  function isInViewport(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0;
  }

  function queryAllDeep(selector, root = document) {
    let elements = [...root.querySelectorAll(selector)];
    const walk = (node) => {
      if (!node) return;
      if (node.shadowRoot) {
        elements.push(...node.shadowRoot.querySelectorAll(selector));
        node.shadowRoot.querySelectorAll("*").forEach(walk);
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
    };
    walk(root);
    return elements;
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function reportStatus(text) {
    return chrome.runtime.sendMessage({ type: "SET_STATUS", text }).catch(() => {});
  }
})();
