(() => {
  if (window.__REVU_OVERLAY_LOADED__) return;
  window.__REVU_OVERLAY_LOADED__ = true;

  let pinMode = true;
  let pins = [];

  // Isolated overlay container
  const root = document.createElement("div");
  root.id = "__revu_overlay_root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  });

  const hoverBox = document.createElement("div");
  Object.assign(hoverBox.style, {
    position: "fixed",
    display: "none",
    border: "2px solid #6d9bff",
    background: "rgba(109, 155, 255, 0.14)",
    borderRadius: "4px",
    pointerEvents: "none",
    transition: "all 40ms linear",
  });

  const hoverLabel = document.createElement("div");
  Object.assign(hoverLabel.style, {
    position: "fixed",
    display: "none",
    background: "#111622",
    color: "#e6eaf2",
    fontSize: "11px",
    padding: "2px 7px",
    borderRadius: "4px",
    border: "1px solid #6d9bff",
    whiteSpace: "nowrap",
    maxWidth: "360px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    pointerEvents: "none",
  });

  const pinsLayer = document.createElement("div");
  Object.assign(pinsLayer.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
  });

  root.appendChild(hoverBox);
  root.appendChild(hoverLabel);
  root.appendChild(pinsLayer);
  document.documentElement.appendChild(root);

  function cssEscape(str) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return "body";
    if (el.id) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;

    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      const cls = Array.from(cur.classList || [])
        .filter((c) => c && !c.startsWith("__revu"))
        .slice(0, 2);
      if (cls.length) {
        part += "." + cls.map(cssEscape).join(".");
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function renderPins() {
    pinsLayer.innerHTML = "";
    const curRoute = location.pathname + location.search;
    for (const p of pins) {
      if (p.route && p.route !== curRoute) continue;
      let target = null;
      try {
        target = document.querySelector(p.selector);
      } catch {
        continue;
      }
      if (!target) continue;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const badge = document.createElement("div");
      badge.textContent = String(p.num);
      badge.title = `${p.selector}: ${p.body}`;
      Object.assign(badge.style, {
        position: "fixed",
        left: `${Math.max(4, rect.left - 8)}px`,
        top: `${Math.max(4, rect.top - 8)}px`,
        width: "22px",
        height: "22px",
        borderRadius: "999px",
        background: "#3ddc97",
        color: "#07140d",
        fontWeight: "700",
        fontSize: "11px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 2px 8px rgba(0,0,0,0.45)",
        border: "2px solid #0e1015",
      });
      pinsLayer.appendChild(badge);
    }
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!pinMode) {
        hoverBox.style.display = "none";
        hoverLabel.style.display = "none";
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || root.contains(el)) return;
      const rect = el.getBoundingClientRect();
      hoverBox.style.display = "block";
      hoverBox.style.left = `${rect.left}px`;
      hoverBox.style.top = `${rect.top}px`;
      hoverBox.style.width = `${rect.width}px`;
      hoverBox.style.height = `${rect.height}px`;

      const sel = buildSelector(el);
      hoverLabel.textContent = sel;
      hoverLabel.style.display = "block";
      hoverLabel.style.left = `${Math.max(6, Math.min(window.innerWidth - 220, rect.left))}px`;
      hoverLabel.style.top = `${Math.max(6, rect.top - 26)}px`;
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!pinMode) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || root.contains(el)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const selector = buildSelector(el);
      const textExcerpt = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);

      window.parent.postMessage(
        {
          type: "revu:pin-select",
          selector,
          route: location.pathname + location.search,
          textExcerpt,
          x: Math.round(e.clientX),
          y: Math.round(e.clientY),
        },
        "*"
      );
    },
    true
  );

  window.addEventListener("scroll", renderPins, true);
  window.addEventListener("resize", renderPins);

  let lastRoute = location.pathname + location.search;
  setInterval(() => {
    const r = location.pathname + location.search;
    if (r !== lastRoute) {
      lastRoute = r;
      window.parent.postMessage({ type: "revu:route-changed", route: r }, "*");
      renderPins();
    }
  }, 400);

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "revu:set-pin-mode") {
      pinMode = Boolean(msg.enabled);
      if (!pinMode) {
        hoverBox.style.display = "none";
        hoverLabel.style.display = "none";
      }
      document.documentElement.style.cursor = pinMode ? "crosshair" : "";
    } else if (msg.type === "revu:sync-pins") {
      pins = Array.isArray(msg.pins) ? msg.pins : [];
      renderPins();
    } else if (msg.type === "revu:focus-pin" && msg.selector) {
      try {
        const el = document.querySelector(msg.selector);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const prevOutline = el.style.outline;
          el.style.outline = "3px solid #3ddc97";
          setTimeout(() => {
            el.style.outline = prevOutline;
            renderPins();
          }, 1200);
        }
      } catch {
        // ignore invalid selector
      }
    }
  });

  window.parent.postMessage(
    { type: "revu:overlay-ready", route: location.pathname + location.search },
    "*"
  );
})();
