(() => {
  const MARKER = "ADAPT_COURSE_DATA";
  const data = window.__COURSE_DATA__ || Object.create(null);
  const sentFingerprints = new Map();
  window.__COURSE_DATA__ = data;

  function collect(value) {
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
          if (item._isCorrect === true) selected.push(index);
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

      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child && typeof child === "object") walk(child, id, depth + 1);
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
    } catch (error) {
      // Non-JSON responses and unrelated payloads are expected.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function" && !originalFetch.__adaptHooked) {
    const hookedFetch = function (...args) {
      const request = Reflect.apply(originalFetch, this, args);
      return request.then((response) => {
        try {
          const url = response.url || String(args[0] && (args[0].url || args[0]) || "");
          const contentType = response.headers.get("content-type") || "";
          if (/json/i.test(contentType) || /components?\.json(?:[?#]|$)/i.test(url)) {
            response.clone().json().then(parseAndCollect).catch(() => {});
          }
        } catch (error) {
          // Keep the page's original fetch behavior unchanged.
        }
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
              !/components?\.json(?:[?#]|$)/i.test(this.__adaptCourseUrl || "")) return;

          if (this.responseType === "json") {
            parseAndCollect(this.response);
          } else if (!this.responseType || this.responseType === "text") {
            parseAndCollect(this.responseText);
          }
        } catch (error) {
          // Ignore non-JSON and inaccessible response bodies.
        }
      }, { once: true });
      return Reflect.apply(originalSend, this, args);
    };
    XMLHttpRequest.prototype.__adaptHooked = true;
  }
})();
