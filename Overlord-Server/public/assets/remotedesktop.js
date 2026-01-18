import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";

(function () {
  const clientId = new URLSearchParams(location.search).get("clientId");
  if (!clientId) {
    alert("Missing clientId");
    return;
  }
  const clientLabel = document.getElementById("clientLabel");
  clientLabel.textContent = clientId;

  const ws = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/api/clients/" +
      clientId +
      "/rd/ws",
  );
  const displaySelect = document.getElementById("displaySelect");
  const refreshBtn = document.getElementById("refreshDisplays");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const mouseCtrl = document.getElementById("mouseCtrl");
  const kbdCtrl = document.getElementById("kbdCtrl");
  const cursorCtrl = document.getElementById("cursorCtrl");
  const qualitySlider = document.getElementById("qualitySlider");
  const qualityValue = document.getElementById("qualityValue");
  const canvas = document.getElementById("frameCanvas");
  const canvasContainer = document.getElementById("canvasContainer");
  const ctx = canvas.getContext("2d");
  const agentFps = document.getElementById("agentFps");
  const viewerFps = document.getElementById("viewerFps");
  const statusEl = document.getElementById("streamStatus");
  ws.binaryType = "arraybuffer";

  let activeClientId = clientId;
  let renderCount = 0;
  let renderWindowStart = performance.now();
  let lastFrameAt = 0;
  let desiredStreaming = false;
  let streamState = "connecting";
  let frameWatchTimer = null;
  let offlineTimer = null;
  setStreamState("connecting", "Connecting");

  function updateFpsDisplay(agentValue) {
    if (agentValue !== undefined && agentValue !== null && agentFps) {
      agentFps.textContent = String(agentValue);
    }
    const now = performance.now();
    renderCount += 1;
    const elapsed = now - renderWindowStart;
    if (elapsed >= 1000 && viewerFps) {
      const fps = Math.round((renderCount * 1000) / elapsed);
      viewerFps.textContent = String(fps);
      renderCount = 0;
      renderWindowStart = now;
    }
  }

  function setStreamState(state, text) {
    streamState = state;
    if (statusEl) {
      const icons = {
        connecting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
        starting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
        stopping: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
        streaming: '<i class="fa-solid fa-circle text-emerald-400"></i>',
        idle: '<i class="fa-solid fa-circle text-slate-400"></i>',
        stalled: '<i class="fa-solid fa-triangle-exclamation text-amber-400"></i>',
        offline: '<i class="fa-solid fa-plug-circle-xmark text-rose-400"></i>',
        disconnected: '<i class="fa-solid fa-link-slash text-slate-400"></i>',
        error: '<i class="fa-solid fa-circle-exclamation text-rose-400"></i>',
      };
      const label = text ||
        (state === "streaming" ? "Streaming" :
          state === "starting" ? "Starting" :
            state === "stopping" ? "Stopping" :
              state === "offline" ? "Client offline" :
                state === "disconnected" ? "Disconnected" :
                  state === "stalled" ? "No frames" :
                    state === "idle" ? "Stopped" :
                      "Connecting");

      statusEl.innerHTML = `${icons[state] || icons.idle} <span>${label}</span>`;
      const base = "inline-flex items-center gap-2 px-3 py-2 rounded-full border text-sm";
      const styles = {
        streaming: "bg-emerald-900/40 text-emerald-100 border-emerald-700/70",
        starting: "bg-sky-900/40 text-sky-100 border-sky-700/70",
        stopping: "bg-amber-900/40 text-amber-100 border-amber-700/70",
        stalled: "bg-amber-900/40 text-amber-100 border-amber-700/70",
        offline: "bg-rose-900/40 text-rose-100 border-rose-700/70",
        error: "bg-rose-900/40 text-rose-100 border-rose-700/70",
        disconnected: "bg-slate-800 text-slate-300 border-slate-700",
        idle: "bg-slate-800 text-slate-300 border-slate-700",
        connecting: "bg-slate-800 text-slate-300 border-slate-700",
      };
      statusEl.className = `${base} ${styles[state] || styles.idle}`;
    }

    if (canvasContainer) {
      canvasContainer.dataset.streamState = state;
    }

    if (state === "idle" || state === "offline" || state === "disconnected" || state === "error") {
      if (agentFps) agentFps.textContent = "--";
      if (viewerFps) viewerFps.textContent = "--";
      renderCount = 0;
      renderWindowStart = performance.now();
    }

    updateControls();
  }

  function updateControls() {
    const wsOpen = ws.readyState === WebSocket.OPEN;
    const isStarting = streamState === "starting";
    const isStreaming = streamState === "streaming";
    const isStopping = streamState === "stopping";
    const isBlocked = streamState === "offline" || streamState === "disconnected" || streamState === "error";

    if (startBtn) {
      startBtn.disabled = !wsOpen || isStarting || isStreaming || isStopping || isBlocked;
    }
    if (stopBtn) {
      stopBtn.disabled = !wsOpen || (!isStarting && !isStreaming);
    }
  }

  function clearOfflineTimer() {
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      offlineTimer = null;
    }
  }

  function scheduleOffline(reason) {
    clearOfflineTimer();
    setStreamState("connecting", "Reconnecting");
    offlineTimer = setTimeout(() => {
      const now = performance.now();
      if (!lastFrameAt || now - lastFrameAt > 3000) {
        desiredStreaming = false;
        setStreamState("offline", reason || "Client offline");
      }
    }, 3000);
  }

  function handleStatus(msg) {
    if (!msg || msg.type !== "status" || !msg.status) return;
    if (msg.status === "offline") {
      scheduleOffline(msg.reason);
      return;
    }
    if (msg.status === "connecting") {
      clearOfflineTimer();
      setStreamState("connecting", "Connecting");
      return;
    }
    if (msg.status === "online") {
      clearOfflineTimer();
      if (desiredStreaming) {
        setStreamState("starting", "Reconnecting");
        if (displaySelect && displaySelect.value !== undefined) {
          sendCmd("desktop_select_display", {
            display: parseInt(displaySelect.value, 10) || 0,
          });
        }
        sendCmd("desktop_start", {});
      } else {
        setStreamState("idle", "Stopped");
      }
    }
  }

  function sendCmd(type, payload) {
    if (!activeClientId) {
      console.warn("No active client selected");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const msg = { type, ...payload };
    console.debug("rd: send", msg);
    ws.send(encodeMsgpack(msg));
  }

  let monitors = 1;

  function populateDisplays(count) {
    displaySelect.innerHTML = "";
    monitors = count || 1;
    for (let i = 0; i < monitors; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = "Display " + (i + 1);
      displaySelect.appendChild(opt);
    }

    if (displaySelect.options.length) {
      displaySelect.value = displaySelect.options[0].value;
    }
  }

  async function fetchClientInfo() {
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      const client = data.items.find((c) => c.id === activeClientId);
      if (client) {
        clientLabel.textContent = `${client.host || client.id} (${client.os || ""})`;
      }
      if (client && client.monitors) {
        populateDisplays(client.monitors);
      }
    } catch (e) {
      console.warn("failed to fetch client info", e);
    }
  }

  refreshBtn.addEventListener("click", fetchClientInfo);

  function updateQualityLabel(val) {
    if (qualityValue) {
      qualityValue.textContent = `${val}%`;
    }
  }

  function pushQuality(val) {
    const q = Number(val) || 90;
    const codec = q >= 100 ? "raw" : "jpeg";
    sendCmd("desktop_set_quality", { quality: q, codec });
  }

  displaySelect.addEventListener("change", function () {
    console.debug("rd: select display", displaySelect.value);
    sendCmd("desktop_select_display", {
      display: parseInt(displaySelect.value, 10),
    });
  });

  startBtn.addEventListener("click", function () {
    if (displaySelect && displaySelect.value !== undefined) {
      sendCmd("desktop_select_display", {
        display: parseInt(displaySelect.value, 10) || 0,
      });
    }
    desiredStreaming = true;
    lastFrameAt = 0;
    setStreamState("starting", "Starting stream");
    sendCmd("desktop_start", {});
  });
  stopBtn.addEventListener("click", function () {
    desiredStreaming = false;
    setStreamState("stopping", "Stopping stream");
    sendCmd("desktop_stop", {});
  });
  fullscreenBtn.addEventListener("click", function () {
    if (canvasContainer.requestFullscreen) {
      canvasContainer.requestFullscreen();
    } else if (canvasContainer.webkitRequestFullscreen) {
      canvasContainer.webkitRequestFullscreen();
    } else if (canvasContainer.mozRequestFullScreen) {
      canvasContainer.mozRequestFullScreen();
    }
  });
  mouseCtrl.addEventListener("change", function () {
    sendCmd("desktop_enable_mouse", { enabled: mouseCtrl.checked });
  });
  kbdCtrl.addEventListener("change", function () {
    sendCmd("desktop_enable_keyboard", { enabled: kbdCtrl.checked });
  });
  cursorCtrl.addEventListener("change", function () {
    sendCmd("desktop_enable_cursor", { enabled: cursorCtrl.checked });
  });

  if (qualitySlider) {
    updateQualityLabel(qualitySlider.value);
    qualitySlider.addEventListener("input", function () {
      updateQualityLabel(qualitySlider.value);
      pushQuality(qualitySlider.value);
    });
  }

  ws.addEventListener("message", async function (ev) {
    if (ev.data instanceof ArrayBuffer) {
      const buf = new Uint8Array(ev.data);
      if (buf.length >= 8 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x4d) {
        const fps = buf[5];
        const format = buf[6];
        lastFrameAt = performance.now();
        clearOfflineTimer();
        if (streamState !== "streaming") {
          desiredStreaming = true;
          setStreamState("streaming", "Streaming");
        }

        if (format === 1) {
          const jpegBytes = buf.slice(8);
          const blob = new Blob([jpegBytes], { type: "image/jpeg" });
          try {
            const bitmap = await createImageBitmap(blob);
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            updateFpsDisplay(fps);
          } catch {
            const img = new Image();
            const url = URL.createObjectURL(blob);
            img.onload = function () {
              canvas.width = img.width;
              canvas.height = img.height;
              ctx.drawImage(img, 0, 0);
              URL.revokeObjectURL(url);
              updateFpsDisplay(fps);
            };
            img.src = url;
          }
          return;
        }

        if (format === 2 || format === 3) {
          if (buf.length < 8 + 8) return;
          const dv = new DataView(buf.buffer, 8);
          let pos = 0;
          const width = dv.getUint16(pos, true);
          pos += 2;
          const height = dv.getUint16(pos, true);
          pos += 2;
          const blockCount = dv.getUint16(pos, true);
          pos += 2;
          pos += 2;

          if (
            width > 0 &&
            height > 0 &&
            (canvas.width !== width || canvas.height !== height)
          ) {
            canvas.width = width;
            canvas.height = height;
          }
          for (let i = 0; i < blockCount; i++) {
            if (pos + 12 > dv.byteLength) break;
            const x = dv.getUint16(pos, true);
            pos += 2;
            const y = dv.getUint16(pos, true);
            pos += 2;
            const w = dv.getUint16(pos, true);
            pos += 2;
            const h = dv.getUint16(pos, true);
            pos += 2;
            const len = dv.getUint32(pos, true);
            pos += 4;
            const start = 8 + pos;
            const end = start + len;
            if (end > buf.length) break;
            const slice = buf.subarray(start, end);
            pos += len;
            if (format === 2) {
              try {
                const bitmap = await createImageBitmap(
                  new Blob([slice], { type: "image/jpeg" }),
                );
                ctx.drawImage(bitmap, x, y, w, h);
                bitmap.close();
              } catch {}
            } else {
              if (slice.length === w * h * 4) {
                const imgData = new ImageData(new Uint8ClampedArray(slice), w, h);
                ctx.putImageData(imgData, x, y);
              }
            }
          }
          updateFpsDisplay(fps);
          return;
        }
      }

      const msg = decodeMsgpack(buf);
      if (msg && msg.type === "status" && msg.status) {
        handleStatus(msg);
        return;
      }
      return;
    }

    const msg = decodeMsgpack(ev.data);
    if (msg && msg.type === "status" && msg.status) {
      handleStatus(msg);
      return;
    }
  });

  ws.addEventListener("open", function () {
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    clearOfflineTimer();
    setStreamState("idle", "Stopped");
    fetchClientInfo().then(() => {
      if (displaySelect && displaySelect.value) {
        console.debug("rd: initial select display", displaySelect.value);
        sendCmd("desktop_select_display", {
          display: parseInt(displaySelect.value, 10),
        });
      }
    });
  });

  ws.addEventListener("close", function () {
    desiredStreaming = false;
    setStreamState("disconnected", "Disconnected");
  });

  ws.addEventListener("error", function () {
    setStreamState("error", "WebSocket error");
  });

  if (!frameWatchTimer) {
    frameWatchTimer = setInterval(() => {
      const now = performance.now();
      if (desiredStreaming) {
        if (lastFrameAt && now - lastFrameAt > 2000) {
          setStreamState("stalled", "No frames");
        } else if (!lastFrameAt && streamState === "starting") {
          setStreamState("starting", "Starting stream");
        }
      } else if (streamState !== "offline" && streamState !== "disconnected" && streamState !== "error") {
        if (streamState !== "idle") {
          setStreamState("idle", "Stopped");
        }
      }
    }, 1000);
  }

  canvas.addEventListener("mousemove", function (e) {
    if (!mouseCtrl.checked) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(
      ((e.clientY - rect.top) / rect.height) * canvas.height,
    );
    sendCmd("mouse_move", { x, y });
  });
  canvas.addEventListener("mousedown", function (e) {
    if (!mouseCtrl.checked) return;
    sendCmd("mouse_down", { button: e.button });
    e.preventDefault();
  });
  canvas.addEventListener("mouseup", function (e) {
    if (!mouseCtrl.checked) return;
    sendCmd("mouse_up", { button: e.button });
    e.preventDefault();
  });
  canvas.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  canvas.setAttribute("tabindex", "0");
  canvas.addEventListener("keydown", function (e) {
    if (!kbdCtrl.checked) return;
    sendCmd("key_down", { key: e.key, code: e.code });
    e.preventDefault();
  });
  canvas.addEventListener("keyup", function (e) {
    if (!kbdCtrl.checked) return;
    sendCmd("key_up", { key: e.key, code: e.code });
    e.preventDefault();
  });

  function stopOnExit() {
    if (ws.readyState === WebSocket.OPEN && desiredStreaming) {
      desiredStreaming = false;
      sendCmd("desktop_stop", {});
    }
  }

  window.addEventListener("beforeunload", stopOnExit);
  window.addEventListener("pagehide", stopOnExit);

  fetchClientInfo();
})();
