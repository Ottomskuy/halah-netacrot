(() => {
  const MARKER = "NETACAD_ADAPT_DATA";
  const data = window.__COURSE_DATA__ || Object.create(null);
  const sentFingerprints = new Map();
  window.__COURSE_DATA__ = data;

  // 1. Trik Sakti dari scrape.js: Deteksi components.json via Performance API & Fetch Seluruh Struktur JSON
  async function autoDiscoverAndFetchAllCourseData() {
    try {
      const resources = performance.getEntriesByType("resource");
      const compRes = resources.find((r) => r.name.includes("components.json"));
      if (!compRes) return;

      const [rawUrl, queryString] = compRes.name.split("?");
      const baseUrl = rawUrl.replace(/components\.json$/, "");
      const suffix = queryString ? `?${queryString}` : "";

      const files = [
        "course.json",
        "contentObjects.json",
        "articles.json",
        "blocks.json",
        "components.json"
      ];

      for (const file of files) {
        try {
          const res = await fetch(baseUrl + file + suffix, { credentials: "include" });
          if (res.ok) {
            const json = await res.json();
            collect(json);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  autoDiscoverAndFetchAllCourseData();
  setInterval(autoDiscoverAndFetchAllCourseData, 5000);

  // 2. Mark Adapt Models Complete & Cek Progress Adapt
  function markAllAdaptComponentsComplete() {
    try {
      if (window.Adapt) {
        if (window.Adapt.components && window.Adapt.components.models) {
          window.Adapt.components.models.forEach(model => {
            try {
              if (typeof model.set === "function") {
                model.set("_isComplete", true);
                model.set("_isInteracted", true);
                model.set("_isSubmitted", true);
              }
            } catch (_) {}
          });
        }
        if (window.Adapt.trigger) {
          window.Adapt.trigger("page:scroll");
          window.Adapt.trigger("component:complete");
        }
      }
    } catch (_) {}
  }

  // Kirim status apakah adapt saat ini sudah complete 100%
  function reportAdaptProgress() {
    try {
      let is100 = true;
      if (window.Adapt && window.Adapt.components && window.Adapt.components.models) {
        for (const model of window.Adapt.components.models) {
          if (model.get && model.get("_isAvailable") !== false) {
            if (!model.get("_isComplete")) {
              is100 = false;
              break;
            }
          }
        }
      }
      window.postMessage({ marker: "NETACAD_PROGRESS_STATUS", is100 }, "*");
    } catch (_) {}
  }

  // 3. Parser Kunci Jawaban
  function collect(value) {
    if (!value) return;
    const updates = Object.create(null);
    const visited = new WeakSet();

    function walk(node, inheritedId, depth) {
      if (!node || typeof node !== "object" || depth > 80 || visited.has(node)) return;
      visited.add(node);

      const id = firstString(node._id, node._componentId, node.id, inheritedId);
      
      if (Array.isArray(node._items)) {
        const selected = [];
        const texts = [];
        node._items.forEach((item, index) => {
          if (!item || typeof item !== "object") return;
          if (item._isCorrect === true || item.isCorrect === true || item._shouldBeSelected === true) {
            selected.push(index);
          }
          texts.push(firstString(item.title, item._title, item.text, item._text, item._label, ""));
        });

        if (id && selected.length) {
          const entry = { selected_indices: selected, option_texts: texts };
          const fingerprint = JSON.stringify(entry);
          if (sentFingerprints.get(id) !== fingerprint) {
            data[id] = entry;
            updates[id] = entry;
            sentFingerprints.set(id, fingerprint);
          }
        }
      }

      if (Array.isArray(node.questions) || Array.isArray(node.answers) || Array.isArray(node.options)) {
        const optionsList = node.options || node.answers || [];
        const selected = [];
        const texts = [];
        optionsList.forEach((opt, idx) => {
          if (!opt || typeof opt !== "object") return;
          if (opt.isCorrect === true || opt._isCorrect === true || opt.correct === true || opt._shouldBeSelected === true) {
            selected.push(idx);
          }
          texts.push(firstString(opt.text, opt.label, opt.title, ""));
        });
        if (id && selected.length) {
          const entry = { selected_indices: selected, option_texts: texts };
          data[id] = entry;
          updates[id] = entry;
        }
      }

      for (const key of Object.keys(node)) {
        try {
          const child = node[key];
          if (child && typeof child === "object") walk(child, id, depth + 1);
        } catch (_) {}
      }
    }

    walk(value, "", 0);
    if (Object.keys(updates).length) {
      window.postMessage({ marker: MARKER, updates }, "*");
    }
  }

  function firstString(...values) {
    return values.find((value) => typeof value === "string" && value.trim()) || "";
  }

  function parseAndCollect(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      collect(parsed);
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function" && !originalFetch.__adaptHooked) {
    const hookedFetch = function (...args) {
      const request = Reflect.apply(originalFetch, this, args);
      return request.then((response) => {
        try {
          const url = response.url || String(args[0] && (args[0].url || args[0]) || "");
          const contentType = response.headers.get("content-type") || "";
          if (/json/i.test(contentType) || /(component|course|assessment|quiz|content).*\.json/i.test(url)) {
            response.clone().json().then(parseAndCollect).catch(() => {});
          }
        } catch (_) {}
        return response;
      });
    };
    hookedFetch.__adaptHooked = true;
    window.fetch = hookedFetch;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  if (!XMLHttpRequest.prototype.__adaptHooked) {
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__adaptCourseUrl = String(url || "");
      return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const contentType = this.getResponseHeader("content-type") || "";
          if (!/json/i.test(contentType) &&
              !/(component|course|assessment|quiz|content).*\.json/i.test(this.__adaptCourseUrl || "")) return;

          if (this.responseType === "json") {
            parseAndCollect(this.response);
          } else if (!this.responseType || this.responseType === "text") {
            parseAndCollect(this.responseText);
          }
        } catch (_) {}
      }, { once: true });
      return Reflect.apply(originalSend, this, args);
    };
    XMLHttpRequest.prototype.__adaptHooked = true;
  }

  setInterval(() => {
    if (window.Adapt) {
      if (window.Adapt.components) {
        try {
          if (typeof window.Adapt.components.toJSON === "function") {
            collect(window.Adapt.components.toJSON());
          } else if (window.Adapt.components.models) {
            collect(window.Adapt.components.models.map(m => m.attributes));
          }
        } catch (_) {}
      }
      markAllAdaptComponentsComplete();
      reportAdaptProgress();
    }
  }, 2500);

  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "FORCE_ADAPT_COMPLETE") {
      markAllAdaptComponentsComplete();
      reportAdaptProgress();
    }
  });
})();
