// ==UserScript==
// @name         AniSkip
// @namespace    https://github.com/zebra2711/aniskip
// @version      0.1
// @description  Skip OP, ED, recaps, and filler on AnimeVietSub
// @match        *://animevietsub.mx/phim/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ─── Style helpers ─── */
  function css(el, props) { Object.assign(el.style, props); return el; }
  const S = {
    input:   { background: "#0f3460", color: "#e0e0e0", border: "none", borderRadius: "4px",
               fontSize: "13px", fontWeight: "bold" },
    btn:     { background: "#0f3460", color: "#e0e0e0", border: "1px solid #2a2a4a", borderRadius: "4px",
               cursor: "pointer", fontWeight: "bold", fontSize: "13px", marginBottom: "0",
               height: "30px", padding: "0 10px",
               display: "flex", alignItems: "center", justifyContent: "center" },
    label:   { color: "#adb5bd", fontSize: "12px", fontWeight: "bold", marginBottom: "4px" },
    divider: { borderTop: "1px solid #2a2a4a", marginBottom: "6px" },
  };

  /* ─── Storage ─── */
  let _storeKey = null;
  function storeKey() {
    return _storeKey || (_storeKey = location.pathname.replace(/^\//, ""));
  }

  function loadSkipTypes() {
    const defaults = { op: true, ed: true, recap: true, preview: true, filler: true, ad: true };
    try {
      const saved = JSON.parse(GM_getValue("skip_types", "{}"));
      return { ...defaults, ...saved };
    } catch (_) {
      return defaults;
    }
  }
  function saveSkipTypes(st) { GM_setValue("skip_types", JSON.stringify(st)); }
  let skipTypes = {};

  let _segsCache = null;
  let _segsCacheKey = null;
  function loadSegs() {
    const k = storeKey();
    if (_segsCache !== null && _segsCacheKey === k) return _segsCache;
    try { _segsCache = JSON.parse(GM_getValue(k, "[]")) || []; } catch (_) { _segsCache = []; }
    _segsCacheKey = k;
    return _segsCache;
  }
  function saveSegs(s) {
    _segsCache = s;
    _segsCacheKey = storeKey();
    invalidateMergedCache();
    GM_setValue(_segsCacheKey, JSON.stringify(s));
  }

  function fmt(s) {
    s = s < 0 ? 0 : s | 0;
    const hh = (s / 3600) | 0;
    const rem = s - hh * 3600;
    const mm = (rem / 60) | 0;
    const ss = rem - mm * 60;
    if (hh > 0) return hh + ":" + (mm > 9 ? mm : "0" + mm) + ":" + (ss > 9 ? ss : "0" + ss);
    return mm + ":" + (ss > 9 ? ss : "0" + ss);
  }

  function parseFmt(str) {
    str = String(str).trim();
    const dotIdx = str.lastIndexOf(".");
    let ms = 0;
    if (dotIdx !== -1) {
      ms = parseFloat("0" + str.slice(dotIdx));
      str = str.slice(0, dotIdx);
    }
    if (!str.includes(":")) {
      const asNum = parseFloat(str);
      if (!isNaN(asNum) && asNum >= 100) return asNum + ms;
    }
    str = str.replace(/[^0-9:]/g, "");
    if (str.includes(":")) {
      const parts = str.split(":");
      if (parts.length >= 3) return +parts[0] * 3600 + +parts[1] * 60 + +parts[2] + ms;
      return +parts[0] * 60 + +(parts[1] || 0) + ms;
    }
    const d = str.replace(/\D/g, "");
    if (!d) return NaN;
    if (d.length <= 2) return parseInt(d, 10) + ms;
    if (d.length <= 4) return parseInt(d.slice(0, -2), 10) * 60 + parseInt(d.slice(-2), 10) + ms;
    return parseInt(d.slice(0, -4), 10) * 3600 + parseInt(d.slice(-4, -2), 10) * 60 + parseInt(d.slice(-2), 10) + ms;
  }

  function autoFmt(raw) {
    const d = raw.replace(/\D/g, "").slice(0, 6);
    if (!d) return "";
    const len = d.length;
    const ss = +d.slice(-2) || 0;
    const mm = len > 2 ? (+d.slice(-4, -2) || 0) : 0;
    const hh = len > 4 ? (+d.slice(0, -4) || 0) : 0;
    if (hh > 0) return hh + ":" + (mm > 9 ? mm : "0" + mm) + ":" + (ss > 9 ? ss : "0" + ss);
    return mm + ":" + (ss > 9 ? ss : "0" + ss);
  }

  function attachAutoFormat(inp) {
    inp.addEventListener("input", () => { inp.value = inp.value.replace(/[^\d:.]/g, "").slice(0, 12); inp._raw = undefined; });
    inp.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text");
      inp.value = text.replace(/[^\d:.]/g, "").slice(0, 12);
    });
    inp.addEventListener("blur", () => { if (inp.value) inp.value = autoFmt(inp.value); });
  }

  const TYPES = {
    op:      { label: "OP",      color: "#00b4d8" },
    ed:      { label: "ED",      color: "#f77f00" },
    recap:   { label: "Recap",   color: "#9b5de5" },
    preview: { label: "Preview", color: "#06d6a0" },
    filler:  { label: "Filler",  color: "#adb5bd" },
    ad:      { label: "Ad",      color: "#e63946" },
  };

  function liveGetPos() {
    const p = getJwp();
    if (p) { const pos = p.getPosition(); return typeof pos === "number" ? pos : 0; }
    const v = document.querySelector("#media-player video, video");
    return v ? (v.currentTime || 0) : null;
  }

  function liveSeekTo(t, play = true) {
    t = t < 0 ? 0 : (t || 0);
    const p = getJwp();
    if (p && typeof p.seek === "function") {
      const wasPaused = typeof p.getState === "function" && p.getState() === "paused";
      if (typeof p.play === "function") p.play();
      setTimeout(() => {
        p.seek(t);
        if (!play && wasPaused && typeof p.pause === "function") setTimeout(() => p.pause(), 0);
      }, 0);
      return true;
    }
    const v = document.querySelector("#media-player video, video");
    if (v) {
      const wasPaused = v.paused;
      v.currentTime = t;
      if (play && wasPaused) v.play().catch(() => {});
      else if (!play && !wasPaused) v.pause();
      return true;
    }
    return false;
  }

  function detectPlayer(cb) {
    let found = false, tries = 0;
    const id = setInterval(() => {
      tries++;
      if (found) return;
      if (window.jwplayer && typeof window.jwplayer === "function") {
        const p = window.jwplayer();
        if (p && typeof p.on === "function") {
          found = true; clearInterval(id);
          const state = typeof p.getState === "function" ? p.getState() : "";
          if (state && state !== "idle" && state !== "error") cb(p, null);
          else { p.on("ready", () => cb(p, null)); p.on("firstFrame", () => cb(p, null)); }
          return;
        }
      }
      if (tries > 60) {
        found = true; clearInterval(id);
        cb(null, document.querySelector("#media-player video, video") || null);
      }
    }, 500);
  }

  const SKIP_COOL = 3000;
  let lastSkip = -Infinity;
  let tlContainer = null;
  let updateHdrStats = () => {};
  let autoplay = GM_getValue("autoplay", false);
  let lockSeg = GM_getValue("lock_seg", false);
  let _cachedJwp = null;
  let _cachedDur = 0;
  let _mergedCache = null;
  let editIndex = null;
  let inStart = null;
  let inEnd = null;

  function invalidateMergedCache() { _mergedCache = null; }

  function getJwp() {
    if (_cachedJwp) return _cachedJwp;
    if (window.jwplayer && typeof window.jwplayer === "function") {
      const p = window.jwplayer();
      if (p && typeof p.getPosition === "function") { _cachedJwp = p; return p; }
    }
    return null;
  }

  function liveDur() {
    if (_cachedDur) return _cachedDur;
    const p = getJwp();
    if (p && typeof p.getDuration === "function") return p.getDuration() || 0;
    const v = document.querySelector("#media-player video, video");
    return v ? (v.duration || 0) : 0;
  }

  function initEngine(jwp, videoEl) {
    function onMeta() { _cachedDur = liveDur(); refreshTimeline(loadSegs(), _cachedDur); updateHdrStats(); }
    if (jwp) {
      jwp.on("meta", onMeta);
      jwp.on("firstFrame", () => { tlContainer = null; _tlSig = ""; onMeta(); });
      jwp.on("playlistItem", () => { tlContainer = null; _cachedJwp = null; _tlSig = ""; invalidateMergedCache(); });
    }
    if (videoEl) videoEl.addEventListener("loadedmetadata", () => { tlContainer = null; onMeta(); });
  }

  let _tlSig = "";
  function refreshTimeline(segs, dur) {
    if (!dur) return;
    let h = (dur * 1000) | 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      h = Math.imul(h ^ s.type.charCodeAt(0), 2654435761) ^ (s.start * 1000 | 0) ^ (s.end * 1000 | 0);
    }
    const sig = h + "|" + segs.length;
    if (sig === _tlSig && tlContainer) return;
    _tlSig = sig;

    if (!tlContainer) {
      const container = document.querySelector(".jw-timesegment-container");
      if (!container) return;
      tlContainer = document.createElement("div");
      css(tlContainer, {
        position: "absolute", top: "0", left: "0",
        width: "100%", height: "100%",
        pointerEvents: "none", zIndex: "5",
      });
      container.appendChild(tlContainer);
    }
    tlContainer.innerHTML = "";
    for (const seg of segs) {
      const bar = document.createElement("div");
      css(bar, {
        position: "absolute", top: "0",
        left: (seg.start / dur * 100) + "%",
        width: Math.max(0.3, (seg.end - seg.start) / dur * 100) + "%",
        height: "100%", background: TYPES[seg.type]?.color || "#fff",
        opacity: "0.75", borderRadius: "2px", pointerEvents: "none",
      });
      bar.title = (TYPES[seg.type]?.label || seg.type) + " " + fmt(seg.start) + " – " + fmt(seg.end);
      tlContainer.appendChild(bar);
    }
  }

  function showToast(msg) {
    const old = document.getElementById("avs-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.id = "avs-toast";
    t.textContent = msg;
    css(t, {
      position: "fixed", bottom: "160px", right: "16px",
      background: "#00b4d8", color: "#fff",
      padding: "7px 14px", borderRadius: "6px",
      fontSize: "13px", fontWeight: "bold",
      zIndex: "2147483647", pointerEvents: "none",
      transition: "opacity 0.5s",
    });
    document.body.appendChild(t);
    setTimeout(() => (t.style.opacity = "0"), 1600);
    setTimeout(() => t.remove(), 2200);
  }

  /* ─── WIDGET ─── */
  function buildWidget() {
    if (document.getElementById("avs-widget")) return;

    const wrap = document.createElement("div");
    wrap.id = "avs-widget";
    css(wrap, {
      position: "fixed", zIndex: "2147483647", width: "220px",
      background: "#1a1a2e", borderRadius: "8px",
      boxShadow: "0 3px 14px rgba(0,0,0,0.6)", fontFamily: "sans-serif",
      fontSize: "13px", overflow: "hidden", userSelect: "none",
      top: "10px", right: "10px", left: "auto", bottom: "auto",
    });

    const hdr = document.createElement("div");
    css(hdr, {
      background: "#16213e", color: "#e0e0e0",
      padding: "6px 8px", fontWeight: "bold", fontSize: "13px",
      display: "flex", justifyContent: "space-between", alignItems: "center",
      cursor: "move",
    });

    const hdrTitle = document.createElement("span");
    hdrTitle.textContent = "AniSkip";

    const hdrStats = document.createElement("span");
    css(hdrStats, { display: "flex", alignItems: "center", gap: "5px", flex: "1", justifyContent: "flex-end", marginRight: "6px" });

    const hdrDur   = document.createElement("span");
    const hdrSaved = document.createElement("span");
    css(hdrDur,   { color: "#06d6a0", fontWeight: "bold", fontSize: "12px" });
    css(hdrSaved, { color: "#e63946", fontWeight: "bold", fontSize: "12px" });
    hdrStats.append(hdrDur, hdrSaved);

    updateHdrStats = function () {
      const dur  = _cachedDur;
      const segs = loadSegs();
      const saved = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
      hdrDur.textContent   = dur > 0   ? fmt(dur - saved) : "";
      hdrSaved.textContent = saved > 0 ? "+ " + fmt(saved) : "";
    };

    const collapseBtn = document.createElement("span");
    collapseBtn.textContent = "+";
    css(collapseBtn, { cursor: "pointer", padding: "0 4px", fontSize: "14px" });

    hdr.append(hdrTitle, hdrStats, collapseBtn);

    const body = document.createElement("div");
    body.style.padding = "6px";
    body.style.display = "none";

    /* ── Quick Jump ── */
    const quickRow = document.createElement("div");
    css(quickRow, { display: "flex", gap: "4px", alignItems: "center", marginBottom: "6px", height: "30px" });

    const timeInput = document.createElement("input");
    timeInput.type = "text"; timeInput.placeholder = "MM:SS";
    css(timeInput, { ...S.input, flex: "1", padding: "4px 6px", height: "30px", marginBottom: "0", outline: "none" });

    const jumpBtn = document.createElement("button");
    jumpBtn.textContent = "Jump";
    css(jumpBtn, {
      height: "30px", padding: "0px 8px", background: "#00b4d8", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", marginBottom: "0",
      display: "flex", justifyContent: "center", alignItems: "center",
    });
    jumpBtn.onclick = () => {
      let t;
      if (!timeInput.value.trim()) {
        t = (liveGetPos() ?? 0) + 90;
      } else {
        t = parseFmt(timeInput.value);
        if (isNaN(t)) { showToast("Invalid time"); return; }
      }
      if (liveSeekTo(t)) showToast("Jumped to " + fmt(t));
      else showToast("Player not found");
    };
    timeInput.addEventListener("keydown", e => { if (e.key === "Enter") jumpBtn.click(); });
    attachAutoFormat(timeInput);
    quickRow.append(timeInput, jumpBtn);
    body.appendChild(quickRow);

    /* ── Nudge row 1: [<] [time] [>] ── */
    const nudgeRow1 = document.createElement("div");
    css(nudgeRow1, { display: "flex", gap: "4px", alignItems: "center", marginBottom: "2px", height: "30px" });

    const nudgeCurr = document.createElement("span");
    nudgeCurr.textContent = "0:00.000";
    css(nudgeCurr, {
      flex: "1", textAlign: "center", color: "#06d6a0", cursor: "pointer",
      fontSize: "13px", fontWeight: "bold", fontFamily: "monospace", marginBottom: "0",
    });
    nudgeCurr.onclick = () => {
      const p = getJwp();
      const v = document.querySelector("#media-player video, video");
      const paused = v ? v.paused : false;
      if (paused) {
        if (p && typeof p.play  === "function") p.play();  else if (v) v.play().catch(() => {});
      } else {
        if (p && typeof p.pause === "function") p.pause(); else if (v) v.pause();
      }
    };
    let collapsed = true;
    setInterval(() => {
      if (collapsed) return;
      const pos = liveGetPos();
      const v = document.querySelector("#media-player video, video");
      nudgeCurr.style.color = (v && !v.paused) ? "#06d6a0" : "#e63946";
      if (pos === null) return;
      const ms = String(Math.round((pos % 1) * 1000)).padStart(3, "0");
      nudgeCurr.textContent = fmt(pos) + "." + ms;
    }, 80);

    /* ── Nudge row 2: step [-] [val] [+] [ms|s] ── */
    const nudgeRow2 = document.createElement("div");
    css(nudgeRow2, { display: "flex", gap: "4px", alignItems: "center", height: "30px" });

    let nudgeUnit = "s";
    const nudgeVal = document.createElement("input");
    nudgeVal.type = "number"; nudgeVal.value = "90"; nudgeVal.min = "1"; nudgeVal.id = "avs-nudge-val";
    css(nudgeVal, { ...S.input, flex: "1", textAlign: "center", padding: "4px", height: "30px", outline: "none", marginBottom: "0" });
    nudgeVal.style.MozAppearance = "textfield";

    const spinStyle = document.createElement("style");
    spinStyle.textContent = "#avs-nudge-val::-webkit-outer-spin-button,#avs-nudge-val::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}";
    document.head.appendChild(spinStyle);

    const nudgeUnitBtn = document.createElement("button");
    nudgeUnitBtn.textContent = "s";
    css(nudgeUnitBtn, { ...S.btn, padding: "0", color: "#00b4d8", width: "36px", minWidth: "36px", textAlign: "center" });
    nudgeUnitBtn.onclick = () => { nudgeUnit = nudgeUnit === "ms" ? "s" : "ms"; nudgeUnitBtn.textContent = nudgeUnit; };

    const mkSeekBtn = (label, dir) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      css(btn, S.btn);
      btn.onclick = () => {
        const pos = liveGetPos();
        if (pos === null) { showToast("Player not found"); return; }
        const v = document.querySelector("#media-player video, video");
        const wasPaused = v ? v.paused : false;
        const delta = parseFloat(nudgeVal.value || 5) * (nudgeUnit === "ms" ? 0.001 : 1) * dir;
        liveSeekTo(pos + delta, !wasPaused);
      };
      return btn;
    };

    const mkStepBtn = (label, dir) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      css(btn, S.btn);
      btn.onclick = () => { nudgeVal.value = Math.max(1, parseFloat(nudgeVal.value || 1) + dir); };
      return btn;
    };

    const jumpStartBtn = document.createElement("button");
    jumpStartBtn.textContent = "i<";
    css(jumpStartBtn, S.btn);
    jumpStartBtn.onclick = () => { liveSeekTo(0, false); };
    nudgeRow2.append(jumpStartBtn, mkStepBtn("-", -1), nudgeVal, mkStepBtn("+", 1), nudgeUnitBtn);
    nudgeRow1.append(mkSeekBtn("<", -1), nudgeCurr, mkSeekBtn(">", 1));
    body.appendChild(nudgeRow1);
    body.appendChild(nudgeRow2);

    const div1 = document.createElement("div");
    css(div1, S.divider);
    body.appendChild(div1);

    /* ── Save segment ── */
    const saveLabel = document.createElement("div");
    saveLabel.textContent = "Save segment";
    css(saveLabel, S.label);
    body.appendChild(saveLabel);

    const typeSelect = document.createElement("select");
    css(typeSelect, {
      width: "100%", marginBottom: "4px", padding: "3px", height: "30px",
      background: "#0f3460", color: "#e0e0e0", border: "none", borderRadius: "4px",
      fontSize: "13px", fontWeight: "bold",
    });
    for (const [k, v] of Object.entries(TYPES)) {
      const o = document.createElement("option"); o.value = k; o.textContent = v.label;
      typeSelect.appendChild(o);
    }
    body.appendChild(typeSelect);

    function timeRow(placeholder) {
      const row = document.createElement("div");
      css(row, { display: "flex", gap: "3px", marginBottom: "4px" });

      const inp = document.createElement("input");
      inp.type = "text"; inp.placeholder = placeholder;
      css(inp, { ...S.input, flex: "1", padding: "3px 5px", height: "30px", marginBottom: "0" });

      const nowBtn = document.createElement("button");
      nowBtn.textContent = "Now";
      css(nowBtn, { ...S.btn, padding: "2px 6px", color: "#adb5bd", fontSize: "12px" });
      nowBtn.onclick = () => {
        const p = getJwp();
        if (p && typeof p.pause === "function") p.pause();
        else { const v = document.querySelector("#media-player video, video"); if (v) v.pause(); }
        const pos = liveGetPos();
        if (pos !== null) {
          const ms = Math.round((pos % 1) * 1000);
          inp.value = fmt(pos) + (ms > 0 ? "." + String(ms).padStart(3, "0") : "");
          inp._raw = pos;
        } else showToast("Player not found");
      };

      const undoBtn = document.createElement("button");
      undoBtn.textContent = "U";
      css(undoBtn, { ...S.btn, padding: "2px 6px", background: "#f77f00", color: "#fff", border: "none", fontSize: "12px" });
      undoBtn.onclick = () => {
        if (inp._undoVal !== undefined) { inp.value = inp._undoVal; inp._raw = inp._undoRaw; }
        else { inp.value = ""; inp._raw = undefined; }
      };

      row.append(inp, nowBtn, undoBtn);
      return { row, inp };
    }

    const { row: startRow, inp: _inStart } = timeRow("Start");
    const { row: endRow,   inp: _inEnd   } = timeRow("End");
    inStart = _inStart;
    inEnd   = _inEnd;
    attachAutoFormat(inStart);
    attachAutoFormat(inEnd);
    body.append(startRow, endRow);

    const saveBtnRow = document.createElement("div");
    css(saveBtnRow, { display: "flex", gap: "4px", marginBottom: "6px" });

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save Segment";
    css(saveBtn, {
      flex: "1", padding: "5px", background: "#06d6a0", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px",
    });

    const jumpBeginBtn = document.createElement("button");
    jumpBeginBtn.textContent = "B";
    css(jumpBeginBtn, {
      padding: "5px 8px", background: "#0f3460", color: "#e0e0e0",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", display: "none",
    });
    jumpBeginBtn.onclick = () => {
      const t = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : null);
      if (t !== null && !isNaN(t)) liveSeekTo(t, false); else showToast("Invalid start time");
    };

    const jumpEndBtn = document.createElement("button");
    jumpEndBtn.textContent = "E";
    css(jumpEndBtn, {
      padding: "5px 8px", background: "#0f3460", color: "#e0e0e0",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", display: "none",
    });
    jumpEndBtn.onclick = () => {
      const t = inEnd._raw ?? (inEnd.value.trim() ? parseFmt(inEnd.value) : null);
      if (t !== null && !isNaN(t)) liveSeekTo(t, false); else showToast("Invalid end time");
    };

    const discardBtn = document.createElement("button");
    discardBtn.textContent = "Discard";
    css(discardBtn, {
      padding: "5px 10px", background: "#f77f00", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", display: "none",
    });

    function resetForm() {
      editIndex = null;
      inStart.value = ""; inEnd.value = "";
      inStart._raw = undefined; inEnd._raw = undefined;
      inStart._undoVal = undefined; inEnd._undoVal = undefined;
      typeSelect.value = "op";
      saveBtn.textContent = "Save Segment";
      discardBtn.style.display = "none";
      jumpBeginBtn.style.display = "none";
      jumpEndBtn.style.display = "none";
    }

    function startEditSegment(i) {
      const seg = loadSegs()[i];
      if (!seg) return;
      editIndex = i;
      liveSeekTo(seg.start, false);
      typeSelect.value = seg.type;
      const msS = Math.round((seg.start % 1) * 1000);
      inStart.value = fmt(seg.start) + (msS > 0 ? "." + String(msS).padStart(3, "0") : "");
      inStart._raw = seg.start; inStart._undoVal = inStart.value; inStart._undoRaw = seg.start;
      const msE = Math.round((seg.end % 1) * 1000);
      inEnd.value = fmt(seg.end) + (msE > 0 ? "." + String(msE).padStart(3, "0") : "");
      inEnd._raw = seg.end; inEnd._undoVal = inEnd.value; inEnd._undoRaw = seg.end;
      saveBtn.textContent = "Update";
      discardBtn.style.display = "";
      jumpBeginBtn.style.display = "";
      jumpEndBtn.style.display = "";
      body.scrollTop = 0;
      renderList();
    }

    saveBtn.onclick = () => {
      const s    = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : 0);
      const rawE = inEnd._raw   ?? (inEnd.value.trim()   ? parseFmt(inEnd.value)   : null);
      const e    = (!rawE || rawE <= 0) ? (_cachedDur || liveDur()) : rawE;
      if (isNaN(s) || isNaN(e) || e <= 0 || e <= s) { showToast("Check start / end times"); return; }
      const segs = loadSegs();
      if (editIndex !== null) {
        segs[editIndex] = { type: typeSelect.value, start: s, end: e };
        showToast("Segment updated");
      } else {
        segs.push({ type: typeSelect.value, start: s, end: e });
        showToast("Segment saved");
      }
      saveSegs(segs);
      resetForm();
      refreshTimeline(loadSegs(), liveDur());
      renderList();
    };

    discardBtn.onclick = () => { resetForm(); renderList(); };
    saveBtnRow.append(saveBtn, jumpBeginBtn, jumpEndBtn, discardBtn);
    body.appendChild(saveBtnRow);

    /* ── Auto-skip types ── */
    const typesLabel = document.createElement("div");
    typesLabel.textContent = "Auto-skip:";
    css(typesLabel, S.label);
    body.appendChild(typesLabel);

    const typesFlex = document.createElement("div");
    css(typesFlex, { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "6px" });
    for (const [k, v] of Object.entries(TYPES)) {
      const lblWrap = document.createElement("label");
      css(lblWrap, { display: "flex", alignItems: "center", gap: "3px", cursor: "pointer", fontSize: "13px", color: "#e0e0e0", fontWeight: "bold" });
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.checked = !!skipTypes[k];
      css(chk, { margin: "0", accentColor: v.color });
      const chkLabel = document.createElement("span");
      chkLabel.textContent = v.label;
      lblWrap.append(chk, chkLabel);
      chk.onchange = () => { skipTypes[k] = chk.checked; saveSkipTypes(skipTypes); invalidateMergedCache(); };
      typesFlex.appendChild(lblWrap);
    }
    body.appendChild(typesFlex);

    const autoplayRow = document.createElement("div");
    Object.assign(autoplayRow.style, { display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" });

    const autoplayWrap = document.createElement("label");
    Object.assign(autoplayWrap.style, { display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "13px", color: "#e0e0e0", fontWeight: "bold" });
    const autoplayChk = document.createElement("input");
    autoplayChk.type = "checkbox"; autoplayChk.checked = autoplay;
    Object.assign(autoplayChk.style, { margin: "0" });
    const autoplayLbl = document.createElement("span");
    autoplayLbl.textContent = "Autoplay";
    autoplayWrap.append(autoplayChk, autoplayLbl);
    autoplayChk.onchange = () => { autoplay = autoplayChk.checked; GM_setValue("autoplay", autoplay); };

    const lockWrap = document.createElement("label");
    Object.assign(lockWrap.style, { display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "13px", color: "#e0e0e0", fontWeight: "bold" });
    const lockChk = document.createElement("input");
    lockChk.type = "checkbox"; lockChk.checked = lockSeg;
    Object.assign(lockChk.style, { margin: "0", accentColor: "#f9c74f" });
    const lockLbl = document.createElement("span");
    lockLbl.textContent = "Lock seg";
    lockWrap.append(lockChk, lockLbl);
    lockChk.onchange = () => { lockSeg = lockChk.checked; GM_setValue("lock_seg", lockSeg); };

    autoplayRow.append(autoplayWrap, lockWrap);
    body.appendChild(autoplayRow);

    const div2 = document.createElement("div");
    css(div2, { ...S.divider, marginBottom: "5px" });
    body.appendChild(div2);

    /* ── Segment list ── */
    const listEl = document.createElement("div");
    css(listEl, { maxHeight: "110px", overflowY: "auto" });
    body.appendChild(listEl);

    function renderList() {
      listEl.innerHTML = "";
      const segs = loadSegs();
      if (!segs.length) {
        const empty = document.createElement("div");
        empty.textContent = "No segments yet";
        css(empty, { color: "#6c757d", fontSize: "12px", padding: "2px 0", fontWeight: "bold" });
        listEl.appendChild(empty); return;
      }
      const fragment = document.createDocumentFragment();
      segs.forEach((seg, i) => {
        const r = document.createElement("div");
        css(r, {
          display: "flex", alignItems: "center", gap: "6px",
          padding: "3px 4px", borderBottom: "1px solid #16213e",
          flexWrap: "nowrap", minHeight: "26px",
        });

        function commitEdit(newType, newStart, newEnd) {
          const s = loadSegs();
          s[i] = { type: newType, start: newStart, end: newEnd };
          saveSegs(s);
          refreshTimeline(loadSegs(), liveDur());
          renderList();
        }

        const badge = document.createElement("span");
        badge.textContent = TYPES[seg.type]?.label || seg.type;
        css(badge, {
          background: TYPES[seg.type]?.color || "#555", color: "#fff",
          padding: "2px 7px", borderRadius: "4px", fontSize: "13px",
          fontWeight: "bold", whiteSpace: "nowrap", height: "22px",
          lineHeight: "18px", display: "flex", alignItems: "center", cursor: "pointer",
        });
        badge.title = "Click to change type";
        badge.onclick = () => {
          timeSpan.style.display = "none";
          const picker = document.createElement("div");
          css(picker, { display: "flex", flexWrap: "wrap", gap: "2px" });
          for (const [k, v] of Object.entries(TYPES)) {
            const opt = document.createElement("span");
            opt.textContent = v.label;
            css(opt, {
              background: k === seg.type ? v.color : "#2a2a4a", color: "#fff",
              padding: "1px 5px", borderRadius: "3px",
              fontSize: "13px", fontWeight: "bold", cursor: "pointer", whiteSpace: "nowrap",
            });
            opt.onmousedown = e => { e.preventDefault(); commitEdit(k, seg.start, seg.end); };
            picker.appendChild(opt);
          }
          badge.replaceWith(picker);
          delBtn.style.display = "none";
          const cancel = e => { if (!r.contains(e.target)) { document.removeEventListener("mousedown", cancel); renderList(); } };
          setTimeout(() => document.addEventListener("mousedown", cancel), 0);
        };

        const timeSpan = document.createElement("span");
        timeSpan.textContent = fmt(seg.start) + " – " + fmt(seg.end);
        css(timeSpan, {
          flex: "1", fontSize: "13px", color: "#adb5bd", fontWeight: "bold",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          height: "22px", lineHeight: "18px", display: "flex", alignItems: "center", cursor: "pointer",
        });
        if (editIndex === i) timeSpan.style.color = "#f9c74f";
        timeSpan.title = "Click to edit times";
        timeSpan.onclick = () => startEditSegment(i);

        const delBtn = document.createElement("button");
        delBtn.textContent = "×";
        css(delBtn, {
          padding: "2px 8px", background: "#e63946", color: "#fff",
          border: "none", borderRadius: "4px", cursor: "pointer",
          fontSize: "13px", fontWeight: "bold", height: "22px",
          lineHeight: "18px", display: "flex", alignItems: "center",
          justifyContent: "center", minWidth: "22px", margin: "0",
        });
        delBtn.onclick = () => {
          if (editIndex === i) { resetForm(); renderList();}
          const s = loadSegs();
          s.splice(i, 1);
          saveSegs(s);
          refreshTimeline(loadSegs(), liveDur());
          renderList();
        };

        r.append(badge, timeSpan, delBtn);
        fragment.appendChild(r);
      });
      listEl.appendChild(fragment);
    }

    /* ── Upstream + IO ── */
    const urlDiv = document.createElement("div");
    css(urlDiv, { marginTop: "6px", borderTop: "1px solid #2a2a4a", paddingTop: "6px" });

    const urlLabelRow = document.createElement("div");
    css(urlLabelRow, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" });

    const urlLabel = document.createElement("div");
    urlLabel.textContent = "JSON URL";
    css(urlLabel, { ...S.label, marginBottom: "0" });

    const overrideWrap = document.createElement("label");
    css(overrideWrap, {
      display: "flex", alignItems: "center", gap: "4px",
      cursor: "pointer", fontSize: "12px",
      color: "#adb5bd", fontWeight: "bold",
    });
    const overrideChk = document.createElement("input");
    overrideChk.type = "checkbox";
    const ovText = document.createElement("span");
    ovText.textContent = "Override";
    overrideWrap.append(overrideChk, ovText);
    urlLabelRow.append(urlLabel, overrideWrap);

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "https://exam.ple/aniskip.json";
    urlInput.value = GM_getValue("upstream_url", "");
    css(urlInput, { ...S.input, width: "100%", padding: "4px 6px", boxSizing: "border-box", marginBottom: "4px" });

    async function validateUrlInput() {
      const url = urlInput.value.trim();
      if (!url) { urlInput.style.border = ""; return; }
      try {
        const res = await fetch(url, { method: "HEAD" });
        urlInput.style.border = res.ok ? "1.5px solid #06d6a0" : "1.5px solid #e63946";
      } catch (_) {
        urlInput.style.border = "1.5px solid #e63946";
      }
    }
    urlInput.addEventListener("change", () => { GM_setValue("upstream_url", urlInput.value.trim()); });
    urlInput.addEventListener("blur", validateUrlInput);
    validateUrlInput();

    const syncRow = document.createElement("div");
    css(syncRow, { display: "flex", gap: "4px", marginBottom: "4px" });

    const syncBtn = document.createElement("button");
    syncBtn.textContent = "Sync";
    css(syncBtn, {
      flex: "1", padding: "5px", background: "#06d6a0", color: "#1a1a2e",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", marginBottom: "2px",
    });
    syncBtn.onclick = async () => {
      const url = urlInput.value.trim();
      if (!url) { showToast("Enter a URL first"); return; }
      syncBtn.textContent = "…";
      try {
        const headers = {};
        const cachedEtag = GM_getValue("upstream_etag_" + url, "");
        const cachedLM   = GM_getValue("upstream_lm_"   + url, "");
        if (cachedEtag) headers["If-None-Match"]     = cachedEtag;
        else if (cachedLM) headers["If-Modified-Since"] = cachedLM;

        const fetchUrl = (cachedEtag || cachedLM) ? url : url + "?_=" + Date.now();
        const res = await fetch(fetchUrl, { headers });

        if (res.status === 304) { showToast("Already up to date"); syncBtn.textContent = "Sync"; return; }
        if (!res.ok) throw new Error(res.status);

        const etag = res.headers.get("ETag");
        const lm   = res.headers.get("Last-Modified");
        if (etag) GM_setValue("upstream_etag_" + url, etag);
        if (lm)   GM_setValue("upstream_lm_"   + url, lm);

        const parsed = await res.json();
        const override = overrideChk.checked;
        const r = mergeInto(parsed, override);
        refreshTimeline(loadSegs(), liveDur());
        renderList();
        showToast("Synced +" + r.added + " new, " + r.skipped + " skipped" + (override ? " (override)" : ""));

        setTimeout(() => GM_setValue("upstream_snapshot", JSON.stringify(parsed)), 0);
      } catch (e) { showToast("Sync failed: " + e.message); }
      syncBtn.textContent = "Sync";
    };

    const diffBtn = document.createElement("button");
    diffBtn.textContent = "Export diff";
    css(diffBtn, {
      flex: "1", padding: "5px", background: "#f77f00", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontSize: "13px", fontWeight: "bold", marginBottom: "2px",
    });
    diffBtn.onclick = () => {
      let upstream = {};
      try { upstream = JSON.parse(GM_getValue("upstream_snapshot", "{}")); } catch (_) {}
      const local = getAllLocal();
      const diff = {};
      for (const [key, segs] of Object.entries(local)) {
        const upSegs  = upstream[key] || [];
        const newSegs = segs.filter(s => !upSegs.some(u => u.start === s.start && u.end === s.end));
        if (newSegs.length) diff[key] = newSegs;
      }
      if (!Object.keys(diff).length) { showToast("No new segments vs upstream"); return; }
      download("aniskipDiff.json", JSON.stringify(diff, null, 2));
      showToast("Exported " + Object.keys(diff).length + " episode(s) with new segments");
    };

    syncRow.append(syncBtn, diffBtn);
    urlDiv.append(urlLabelRow, urlInput, syncRow);
    body.appendChild(urlDiv);

    const ioRow = document.createElement("div");
    css(ioRow, { display: "flex", gap: "4px", marginTop: "2px" });

    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Export all";
    css(exportBtn, { ...S.input, flex: "1", padding: "5px", cursor: "pointer", marginBottom: "2px" });
    exportBtn.onclick = () => {
      const all = getAllLocal();
      download("aniskip.json", JSON.stringify(all, null, 2));
      showToast("Exported " + Object.keys(all).length + " episode(s)");
    };

    const importBtn = document.createElement("button");
    importBtn.textContent = "Import file";
    css(importBtn, { ...S.input, flex: "1", padding: "5px", cursor: "pointer", marginBottom: "2px" });
    importBtn.onclick = () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file"; fileInput.accept = ".json";
      fileInput.onchange = () => {
        const file = fileInput.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const parsed = JSON.parse(e.target.result);
            const r = mergeInto(parsed);
            refreshTimeline(loadSegs(), liveDur());
            renderList();
            showToast("Imported +" + r.added + " segs, " + r.skipped + " episode(s) skipped");
          } catch (_) { showToast("Failed to parse file"); }
        };
        reader.readAsText(file);
      };
      fileInput.click();
    };
    ioRow.append(exportBtn, importBtn);
    body.appendChild(ioRow);

    const clearAllBtn = document.createElement("button");
    clearAllBtn.textContent = "Clear ALL";
    css(clearAllBtn, {
      width: "100%", padding: "5px", marginTop: "4px",
      background: "#6c1f1f", color: "#ffaaaa",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontSize: "13px", fontWeight: "bold",
    });
    clearAllBtn.onclick = () => {
      if (!confirm("Delete ALL saved segments?")) return;
      clearAll();
      refreshTimeline([], 0);
      renderList();
      showToast("All segment data cleared");
    };
    body.appendChild(clearAllBtn);

    wrap.append(hdr, body);
    document.body.appendChild(wrap);
    renderList();

    collapseBtn.onclick = () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "block";
      collapseBtn.textContent = collapsed ? "+" : "–";
    };

    hdr.addEventListener("mousedown", e => {
      e.preventDefault();
      const MARGIN = 10;
      let px = e.clientX, py = e.clientY;
      const onMove = ev => {
        wrap.style.left   = Math.max(MARGIN, Math.min(wrap.offsetLeft + ev.clientX - px, window.innerWidth  - wrap.offsetWidth  - MARGIN)) + "px";
        wrap.style.top    = Math.max(MARGIN, Math.min(wrap.offsetTop  + ev.clientY - py, window.innerHeight - wrap.offsetHeight - MARGIN)) + "px";
        wrap.style.right  = "auto";
        wrap.style.bottom = "auto";
        px = ev.clientX; py = ev.clientY;
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", () => document.removeEventListener("mousemove", onMove), { once: true });
    });

    return renderList;
  }

  const NON_SEG_KEYS = new Set(["skip_types", "autoplay", "upstream_url", "upstream_snapshot"]);
  function getAllLocal() {
    const all = {};
    for (const key of GM_listValues()) {
      if (NON_SEG_KEYS.has(key)) continue;
      try {
        const segs = JSON.parse(GM_getValue(key, "[]")) || [];
        if (Array.isArray(segs) && segs.length) all[key] = segs;
      } catch (_) {}
    }
    return all;
  }

  function mergeInto(parsed, override = false) {
    let added = 0, skipped = 0;
    const entries = Array.isArray(parsed) ? [[storeKey(), parsed]] : Object.entries(parsed);
    for (const [key, usegs] of entries) {
      if (!Array.isArray(usegs)) continue;
      let existing = [];
      try { existing = JSON.parse(GM_getValue(key, "[]")) || []; } catch (_) {}
      if (override || existing.length === 0) {
        GM_setValue(key, JSON.stringify(usegs));
        added += usegs.length;
      } else {
        const existSet = new Set(existing.map(x => x.start + "," + x.end));
        let newAdded = 0;
        for (const seg of usegs) {
          const id = seg.start + "," + seg.end;
          if (!existSet.has(id)) { existing.push(seg); existSet.add(id); newAdded++; }
        }
        GM_setValue(key, JSON.stringify(existing));
        if (newAdded > 0) added += newAdded; else skipped++;
      }
    }
    return { added, skipped };
  }

  function clearAll() { for (const key of GM_listValues()) GM_deleteValue(key); }

  function download(filename, data) {
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function waitForBody(cb) {
    if (document.body) { cb(); return; }
    new MutationObserver((_, obs) => { if (document.body) { obs.disconnect(); cb(); } })
      .observe(document.documentElement, { childList: true });
  }

  waitForBody(() => {
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const popup = node.classList.contains("lobibox-confirm") ? node : node.querySelector?.(".lobibox-confirm");
          if (!popup) continue;
          const bold = popup.querySelector(".lobibox-body-text b");
          if (bold) {
            const timeInput = document.querySelector("#avs-widget input[placeholder='MM:SS']");
            if (timeInput) {
              timeInput.value = bold.textContent.trim();
              timeInput.dispatchEvent(new Event("blur"));
            }
          }
          popup.remove();
          document.querySelectorAll(".lobibox-backdrop, .modal-backdrop").forEach(el => el.remove());
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  waitForBody(() => {
    skipTypes = loadSkipTypes();
    buildWidget();
    _cachedDur = liveDur(); updateHdrStats();
    setInterval(() => {
      if (!_cachedDur) _cachedDur = liveDur();
      if (_cachedDur > 0) refreshTimeline(loadSegs(), _cachedDur);
      updateHdrStats();
    }, 100);

    function getMergedSkipSegs(segs) {
      if (_mergedCache) return _mergedCache;
      const active = segs
        .filter(s => skipTypes[s.type] ?? true)
        .sort((a, b) => a.start - b.start);
      const merged = [];
      for (const seg of active) {
        const last = merged[merged.length - 1];
        if (last && seg.start <= last.end) {
          last.end = Math.max(last.end, seg.end);
          last.labels.push(TYPES[seg.type]?.label || seg.type);
        } else {
          merged.push({ start: seg.start, end: seg.end, labels: [TYPES[seg.type]?.label || seg.type] });
        }
      }
      _mergedCache = merged;
      return merged;
    }

    function bsearchSeg(merged, pos) {
      let lo = 0, hi = merged.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const seg = merged[mid];
        if (pos < seg.start)     hi = mid - 1;
        else if (pos >= seg.end) lo = mid + 1;
        else return seg;
      }
      return null;
    }

    setInterval(() => {
       if (lockSeg && editIndex !== null) {
         const pos = liveGetPos();
         const seg = loadSegs()[editIndex];
         const s = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : null);
         const e = inEnd._raw   ?? (inEnd.value.trim()   ? parseFmt(inEnd.value)   : null);
         if (pos !== null && s !== null && !isNaN(s) && e !== null && !isNaN(e)) {
           if (pos >= e || pos < s) {
            const v = document.querySelector("#media-player video, video");
            if (v && !v.paused) {
              v.currentTime = s;
            }
           }
         }
         return;
      }
      if (Date.now() - lastSkip < SKIP_COOL) return;
      const pos = liveGetPos();
      if ((pos === null || pos === 0) && autoplay && editIndex === null) {
        const v = document.querySelector("#media-player video, video");
        if (v) { v.currentTime = 0; if (v.paused) v.play().catch(() => {}); }
        showToast("Autoplay");
        const _segs  = loadSegs();
        const merged = getMergedSkipSegs(_segs);
        const startSeg = merged.find(seg => seg.start === 0);
        liveSeekTo(startSeg ? startSeg.end : 0);
        return;
      }
      if (pos === null || pos === 0) return;
      const _segs  = loadSegs();
      const merged = getMergedSkipSegs(_segs);
      const hit      = bsearchSeg(merged, pos);
      const hitIndex = hit ? _segs.findIndex(s => s.start === hit.start && s.end === hit.end) : -1;
      if (hit && hitIndex !== editIndex) {
        lastSkip = Date.now();
        liveSeekTo(hit.end);
        showToast("Skipped " + hit.labels.join(" + "));
      }
    }, 100);

    detectPlayer((jwp, videoEl) => {
      initEngine(jwp, videoEl);
      const inp = document.querySelector("#avs-widget input");
      if (inp) inp.placeholder = "MM:SS";
      refreshTimeline(loadSegs(), liveDur());
    });
  });
})();
