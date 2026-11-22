import { appState, escapeHtml, openComposerModal } from "./app.js";

let iframeEl = null;
let currentRoute = "/";
let listenerRegistered = false;

function registerMessageListener() {
  if (listenerRegistered) return;
  listenerRegistered = true;

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "revu:overlay-ready") {
      currentRoute = msg.route || "/";
      updateRouteLabel();
      postToIframe({ type: "revu:set-pin-mode", enabled: appState.pinMode });
      syncPinsToIframe(appState.data?.comments || []);
    } else if (msg.type === "revu:route-changed") {
      currentRoute = msg.route || "/";
      updateRouteLabel();
      syncPinsToIframe(appState.data?.comments || []);
    } else if (msg.type === "revu:pin-select") {
      const target = appState.data?.session.liveUrl || appState.data?.session.target || "page";
      openComposerModal({
        file: target,
        kind: "pin",
        selector: msg.selector,
        route: msg.route || currentRoute,
        textExcerpt: msg.textExcerpt || "",
        x: msg.x,
        y: msg.y,
      });
    }
  });
}

function postToIframe(payload) {
  if (!iframeEl || !iframeEl.contentWindow) return;
  iframeEl.contentWindow.postMessage(payload, "*");
}

function updateRouteLabel() {
  const el = document.getElementById("live-route-readout");
  if (el) el.textContent = currentRoute;
}

export function syncPinsToIframe(comments) {
  if (!iframeEl) return;
  const pins = (comments || [])
    .filter((c) => c.kind === "pin" && !c.resolved)
    .map((c, idx) => ({
      id: c.id,
      num: idx + 1,
      selector: c.selector,
      route: c.route,
      body: c.body,
    }));
  postToIframe({ type: "revu:sync-pins", pins });
}

export function focusLivePin(comment) {
  postToIframe({ type: "revu:focus-pin", selector: comment.selector, id: comment.id });
}

export function toggleLivePinMode() {
  appState.pinMode = !appState.pinMode;
  const btnInteract = document.getElementById("btn-live-interact");
  const btnPin = document.getElementById("btn-live-pin");
  if (btnInteract && btnPin) {
    btnInteract.classList.toggle("active", !appState.pinMode);
    btnPin.classList.toggle("active", appState.pinMode);
  }
  postToIframe({ type: "revu:set-pin-mode", enabled: appState.pinMode });
}

export function renderLiveView(toolbarEl, bodyEl) {
  registerMessageListener();
  const proxy = appState.data.proxy;
  if (!proxy) {
    toolbarEl.innerHTML = "";
    bodyEl.innerHTML = `<div class="empty-state">Live proxy is not active for this session.</div>`;
    return;
  }

  const targetSrc = proxy.url + proxy.initialPath;

  toolbarEl.innerHTML = `
    <div class="toolbar-group">
      <button id="btn-live-pin" class="btn btn-tab ${appState.pinMode ? "active" : ""}">✦ Pin Element</button>
      <button id="btn-live-interact" class="btn btn-tab ${!appState.pinMode ? "active" : ""}">↗ Interact</button>
      <span id="live-route-readout" class="mono" style="color:var(--text-muted);font-size:12px;margin-left:8px">${escapeHtml(
        currentRoute
      )}</span>
    </div>
    <div class="toolbar-group">
      <button id="btn-live-reload" class="btn btn-ghost btn-sm">↻ Reload page</button>
      ${
        appState.data.session.liveUrl
          ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(
              appState.data.session.liveUrl
            )}" target="_blank" rel="noopener">Open direct ↗</a>`
          : ""
      }
    </div>
  `;

  toolbarEl.querySelector("#btn-live-pin").addEventListener("click", () => {
    if (!appState.pinMode) toggleLivePinMode();
  });
  toolbarEl.querySelector("#btn-live-interact").addEventListener("click", () => {
    if (appState.pinMode) toggleLivePinMode();
  });
  toolbarEl.querySelector("#btn-live-reload").addEventListener("click", () => {
    if (iframeEl) iframeEl.src = iframeEl.src;
  });

  // Preserve existing iframe if already mounted for same target so state doesn't reset on comment add
  const existing = bodyEl.querySelector("#live-iframe");
  if (existing && existing.dataset.src === targetSrc) {
    iframeEl = existing;
    syncPinsToIframe(appState.data.comments);
    return;
  }

  bodyEl.innerHTML = `<div class="live-wrap"><iframe id="live-iframe" class="live-iframe" data-src="${escapeHtml(
    targetSrc
  )}" src="${escapeHtml(targetSrc)}"></iframe></div>`;
  iframeEl = bodyEl.querySelector("#live-iframe");
}
