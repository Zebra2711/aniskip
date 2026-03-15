// ==UserScript==
// @name         AniSkip
// @namespace    https://github.com/zebra2711/aniskip
// @version      0.1
// @description  Skip OP, ED, recaps, and filler on AnimeVietSub
// @match        *://animevietsub.mx/phim/*/*.html
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

  function resolveEnd(seg, dur) {
    return seg.is_end ? (dur || _cachedDur || liveDur() || 0) : seg.end;
  }

  function migrateSegsEndSentinel(segs, dur) {
    if (!dur || !segs.length) return segs;
    let changed = false;
    const out = segs.map(s => {
      if (s.end === -1) { changed = true; return { ...s, end: dur || 0, is_end: true }; }
      if (s.end !== -1 && Math.abs(s.end - dur) < 5) { changed = true; return { ...s, end: dur, is_end: true }; }
      if (!s.hasOwnProperty("is_end")) { changed = true; return { ...s, is_end: false }; }
      return s;
    });
    return changed ? out : segs;
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
    inp.addEventListener("blur", () => { if (inp.value && !inp.value.includes(":")) inp.value = autoFmt(inp.value); });
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
  let _autoVariantIdx = -1;
  let _autoVariants = null;
  let inStart = null;
  let inEnd = null;
  let collapsed = true;
  let is_prevEdit = false

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
    function onMeta() {
      _cachedDur = liveDur();
      const migrated = migrateSegsEndSentinel(_segsCache ?? loadSegs(), _cachedDur);
      if (migrated !== loadSegs()) saveSegs(migrated);
      refreshTimeline(_segsCache ?? loadSegs(), _cachedDur);
      updateHdrStats();
    }
    if (jwp) {
      jwp.on("meta", onMeta);
      jwp.on("firstFrame", () => { tlContainer = null; _tlSig = ""; onMeta(); });
      jwp.on("playlistItem", () => { tlContainer = null; _cachedJwp = null; _tlSig = ""; invalidateMergedCache(); _autoVariants = null; _autoVariantIdx = -1; });
    }
    if (videoEl) videoEl.addEventListener("loadedmetadata", () => { tlContainer = null; onMeta(); });
  }

  let _tlSig = "";
  function refreshTimeline(segs, dur) {
    if (!dur) return;
    const container = document.querySelector(".jw-timesegment-container");
    let h = (dur * 1000) | 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      h = Math.imul(h ^ s.type.charCodeAt(0), 2654435761) ^ (s.start * 1000 | 0) ^ (s.end * 1000 | 0);
    }
    const sig = h + "|" + segs.length;
    if (sig === _tlSig && tlContainer && document.contains(tlContainer)) return;
    _tlSig = sig;

    if (!tlContainer || !document.contains(tlContainer)) {
      tlContainer = null;
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
      const segEnd = resolveEnd(seg, dur);
      css(bar, {
        position: "absolute", top: "0",
        left: (seg.start / dur * 100) + "%",
        width: Math.max(0.3, (segEnd - seg.start) / dur * 100) + "%",
        height: "100%", background: TYPES[seg.type]?.color || "#fff",
        opacity: "0.75", borderRadius: "2px", pointerEvents: "none",
      });
      bar.title = (TYPES[seg.type]?.label || seg.type) + " " + fmt(seg.start) + " – " + (seg.is_end ? "END" : fmt(seg.end));
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
      const segs = _segsCache ?? loadSegs();
      const saved = segs.reduce((acc, s) => acc + (resolveEnd(s, dur) - s.start), 0);
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
    setInterval(() => {
      if (collapsed) return;
      const pos = liveGetPos();
      const v = document.querySelector("#media-player video, video");
      nudgeCurr.style.color = (v && !v.paused) ? "#06d6a0" : "#e63946";
      if (pos === null) return;
      const ms = String(Math.round((pos % 1) * 1000)).padStart(3, "0");
      nudgeCurr.textContent = fmt(pos) + "." + ms;
    }, 250);

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
          inp.dispatchEvent(new Event("blur"));
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

    let _editLen = 90;
    const keepLenRow = document.createElement("div");
    css(keepLenRow, { display: "none", alignItems: "center", gap: "4px", marginBottom: "4px" });
    const keepLenChk = document.createElement("input");
    keepLenChk.type = "checkbox";
    keepLenChk.checked = true;
    css(keepLenChk, { margin: "0", accentColor: "#f9c74f" });
    keepLenChk.addEventListener("change", () => {
      keepLenInp.style.display = keepLenChk.checked ? "" : "none";
    });
    const keepLenLbl = document.createElement("span");
    css(keepLenLbl, { ...S.label, marginBottom: "0", color: "#f9c74f" });
    keepLenLbl.textContent = "Keep len";

    const keepLenInp = document.createElement("input");
    keepLenInp.type = "text"; keepLenInp.placeholder = "0:00.000"; keepLenInp.value = "1:30";
    css(keepLenInp, { ...S.input, width: "70px", padding: "2px 4px", height: "22px", fontSize: "12px", marginBottom: "0", marginLeft: "auto", textAlign: "right" });
    keepLenInp.addEventListener("blur", () => {
      const v = parseFmt(keepLenInp.value);
      if (!isNaN(v) && v > 0) {
        _editLen = v;
        const ms = Math.round((v % 1) * 1000);
        keepLenInp.value = fmt(v) + (ms > 0 ? "." + String(ms).padStart(3, "0") : "");
        if (keepLenChk.checked) {
          const s = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : 0);
          const anchor = isNaN(s) ? 0 : (s ?? 0);
          const dur = _cachedDur || liveDur() || 0;
          let newEnd = anchor + _editLen;
          if (dur > 0 && newEnd > dur) { newEnd = dur; }
          inEnd._raw = newEnd;
          const msE = Math.round((newEnd % 1) * 1000);
          inEnd.value = fmt(newEnd) + (msE > 0 ? "." + String(msE).padStart(3, "0") : "");
        }
      } else keepLenInp.value = _editLen > 0 ? fmt(_editLen) : "";
    });
    keepLenInp.addEventListener("keydown", e => { if (e.key === "Enter") keepLenInp.blur(); });
    attachAutoFormat(keepLenInp);
    keepLenRow.append(keepLenChk, keepLenLbl, keepLenInp);
    body.appendChild(keepLenRow);
    inStart.addEventListener("blur", () => {
      if (editIndex === null || !keepLenChk.checked || !_editLen) return;
      const s = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : null);
      if (isNaN(s)) return;
      const sVal = s ?? 0;
      if (sVal === (inStart._undoRaw ?? 0)) return;
      const newEnd = sVal + _editLen;
      inEnd._raw = newEnd;
      const msE = Math.round((newEnd % 1) * 1000);
      inEnd.value = fmt(newEnd) + (msE > 0 ? "." + String(msE).padStart(3, "0") : "");
    });
    inEnd.addEventListener("blur", () => {
      if (editIndex === null || !keepLenChk.checked || !_editLen) return;
      const rawE = inEnd._raw ?? (inEnd.value.trim() ? parseFmt(inEnd.value) : null);
      const eVal = (rawE === null || rawE <= 0) ? (_cachedDur || liveDur() || 0) : rawE;
      if (isNaN(eVal)) return;
      if (eVal === (inEnd._undoRaw ?? (_cachedDur || liveDur() || 0))) return;
      const newStart = Math.max(0, eVal - _editLen);
      inStart._raw = newStart;
      const msS = Math.round((newStart % 1) * 1000);
      inStart.value = fmt(newStart) + (msS > 0 ? "." + String(msS).padStart(3, "0") : "");
    });

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
      const raw = inEnd._raw ?? (inEnd.value.trim() ? parseFmt(inEnd.value) : null);
      const t = (raw === -1 || raw === null) ? (_cachedDur || liveDur()) : raw;
      if (t && !isNaN(t)) liveSeekTo(t, false); else showToast("Invalid end time");
    };

    const discardBtn = document.createElement("button");
    discardBtn.textContent = "Discard";
    css(discardBtn, {
      padding: "5px 10px", background: "#f77f00", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", display: "none",
    });

    function resetForm() {
      nudgeVal.value = "90"; nudgeUnit = "s"; nudgeUnitBtn.textContent = "s";
      editIndex = null;
      inStart.value = ""; inEnd.value = "";
      inStart._raw = undefined; inEnd._raw = undefined;
      inStart._undoVal = undefined; inEnd._undoVal = undefined;
      typeSelect.value = "op";
      saveBtn.textContent = "Save Segment";
      discardBtn.style.display = "none";
      jumpBeginBtn.style.display = "none";
      jumpEndBtn.style.display = "none";
      keepLenRow.style.display = "none";
      keepLenChk.checked = false;
      keepLenInp.value = "";
      _editLen = 0;
    }

    function startEditSegment(i) {
      const seg = (_segsCache ?? loadSegs())[i];
      if (!seg) return;
      editIndex = i;
      liveSeekTo(seg.start, false);
      typeSelect.value = seg.type;
      const msS = Math.round((seg.start % 1) * 1000);
      inStart.value = fmt(seg.start) + (msS > 0 ? "." + String(msS).padStart(3, "0") : "");
      inStart._raw = seg.start; inStart._undoVal = inStart.value; inStart._undoRaw = seg.start;
      if (seg.is_end) {
        inEnd.value = ""; inEnd._raw = -1; inEnd._undoVal = ""; inEnd._undoRaw = -1;
        _editLen = (_cachedDur || liveDur() || 0) - seg.start;
      } else {
        const msE = Math.round((seg.end % 1) * 1000);
        inEnd.value = fmt(seg.end) + (msE > 0 ? "." + String(msE).padStart(3, "0") : "");
        inEnd._raw = seg.end; inEnd._undoVal = inEnd.value; inEnd._undoRaw = seg.end;
        _editLen = seg.end - seg.start;
      }
      saveBtn.textContent = "Update";
      discardBtn.style.display = "";
      jumpBeginBtn.style.display = "";
      jumpEndBtn.style.display = "";
      keepLenRow.style.display = "flex";
      nudgeVal.value = "100"; nudgeUnit = "ms"; nudgeUnitBtn.textContent = "ms";
      keepLenChk.checked = true;
      keepLenInp.style.display = "";
      const _ms = Math.round((_editLen % 1) * 1000);
      keepLenInp.value = _editLen > 0 ? fmt(_editLen) + (_ms > 0 ? "." + String(_ms).padStart(3, "0") : "") : "";
      body.scrollTop = 0;
      renderList();
    }

    saveBtn.onclick = () => {
      const s    = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : 0);
      const rawE = inEnd._raw   ?? (inEnd.value.trim()   ? parseFmt(inEnd.value)   : null);
      const isEnd = (!rawE || rawE <= 0);
      const e     = isEnd ? (_cachedDur || liveDur() || 0) : rawE;
      if (isNaN(s) || (!isEnd && (isNaN(e) || e <= s))) { showToast("Check start / end times"); return; }
      const segs = loadSegs();
      if (editIndex !== null) {
        segs[editIndex] = { type: typeSelect.value, start: s, end: e, is_end: isEnd };
        showToast("Segment updated");
      } else {
        segs.push({ type: typeSelect.value, start: s, end: e, is_end: isEnd });
        showToast("Segment saved");
      }
      saveSegs(segs);
      is_prevEdit = true;
      resetForm();
      refreshTimeline(_segsCache ?? loadSegs(), _cachedDur || liveDur());
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
      chk.dataset.key = k;
      const typesRef = skipTypes;
      const saveFn   = saveSkipTypes;
      chk.onchange = function () {
         const key = this.dataset.key;
         typesRef[key] = this.checked;
         saveFn(typesRef);
         invalidateMergedCache();
      };
      //chk.onchange = () => { skipTypes[k] = chk.checked; saveSkipTypes(skipTypes); invalidateMergedCache(); };
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
      const segs = _segsCache ?? loadSegs();
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
          refreshTimeline(_segsCache ?? loadSegs(), _cachedDur || liveDur());
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
        const dispEnd = seg.is_end ? "END" : fmt(seg.end);
        timeSpan.textContent = fmt(seg.start) + " – " + dispEnd;
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
          refreshTimeline(_segsCache ?? loadSegs(), _cachedDur || liveDur());
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
        if (r.added > 0) {
          const currentKey = storeKey();
          if (parsed[currentKey]) {
            _segsCache = null;
            _segsCacheKey = null;
            invalidateMergedCache();
            refreshTimeline(loadSegs(), _cachedDur || liveDur());
            renderList();
          }
        }
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
            if (r.added > 0) {
              const currentKey = storeKey();
              if (parsed[currentKey]) {
                _segsCache = null;
                _segsCacheKey = null;
                invalidateMergedCache();
                refreshTimeline(loadSegs(), _cachedDur || liveDur());
                renderList();
              }
            }
            showToast("Imported +" + r.added + " segs, " + r.skipped + " episode(s) skipped");
          } catch (_) { showToast("Failed to parse file"); }
        };
        reader.readAsText(file);
      };
      fileInput.click();
    };
    ioRow.append(exportBtn, importBtn);
    body.appendChild(ioRow);

    const bottomRow = document.createElement("div");
    css(bottomRow, { display: "flex", gap: "4px", marginTop: "4px" });

    const autoBtn = document.createElement("button");
    autoBtn.textContent = "Auto";
    css(autoBtn, {
      flex: "1", padding: "5px", background: "#9b5de5", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px",
    });
    autoBtn.onclick = () => {
      const existing = _segsCache ?? loadSegs();
      const existingTypes = new Set(existing.map(s => s.type));
      if (existingTypes.has("op") && existingTypes.has("ed")) {
        showToast("Already has OP + ED, skipped"); return;
      }
      if (!_autoVariants) _autoVariants = computeAutoVariants();
      if (!_autoVariants.length) { showToast("No sibling episodes found"); return; }
      _autoVariantIdx = (_autoVariantIdx + 1) % _autoVariants.length;
      const variant = _autoVariants[_autoVariantIdx];
      const toAdd = variant.filter(v => !existingTypes.has(v.type));
      if (!toAdd.length) { showToast("All types already present"); return; }
      saveSegs([...existing, ...toAdd.map(v => ({ type: v.type, start: v.start, end: v.end, is_end: !!v.is_end }))]);
      refreshTimeline(_segsCache ?? loadSegs(), _cachedDur || liveDur());
      renderList();
      autoBtn.textContent = "Auto (" + (_autoVariantIdx + 1) + "/" + _autoVariants.length + ")";
      showToast(
        "Auto " + (_autoVariantIdx + 1) + "/" + _autoVariants.length + ": " +
        toAdd.map(v => (TYPES[v.type]?.label || v.type) + " " + fmt(v.start) + "-" + fmt(v.end)).join(", ")
      );
    };

    const clearAllBtn = document.createElement("button");
    clearAllBtn.textContent = "Clear ALL";
    css(clearAllBtn, {
      flex: "1", padding: "5px",
      background: "#6c1f1f", color: "#ffaaaa",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontSize: "13px", fontWeight: "bold",
    });
    function clearAll() {
      // Delete ALL episode segment data (keep settings & upstream snapshot)
      for (const key of GM_listValues()) {
        if (!NON_SEG_KEYS.has(key)) {
          GM_deleteValue(key);
        }
      }

      // Reset all runtime caches
      _segsCache = null;
      _segsCacheKey = null;
      _mergedCache = null;
      _autoVariants = null;
      _autoVariantIdx = -1;
      invalidateMergedCache();

      // Force refresh of current episode
      _segsCache = [];
      _segsCacheKey = storeKey();
    }

    clearAllBtn.onclick = () => {
      if (!confirm("Delete ALL saved segments?")) return;
      clearAll();
      refreshTimeline([], 0);
      renderList();
      showToast("All segment data cleared");
    };

    bottomRow.append(autoBtn, clearAllBtn);
    body.appendChild(bottomRow);

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

  function getSeriesSlug() {
    const parts = (_segsCacheKey ?? storeKey()).split("/");
    return parts.length >= 2 ? parts[1] : "";
  }

  function computeAutoVariants() {
    const slug = getSeriesSlug();
    if (!slug) return [];
    const all = getAllLocal();
    const curDur = _cachedDur || liveDur();

    // Filter siblings: must share series slug, must not be current episode
    // Levenshtein — two-row space-optimised DP (same as Myers diff core, used in git/IDEs)
    function levenshtein(a, b) {
      const m = a.length, n = b.length;
      if (m < n) return levenshtein(b, a);
      let prev = Array.from({ length: n + 1 }, (_, i) => i);
      for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = curr;
      }
      return prev[n];
    }

    function nameSim(a, b) {
      const d = levenshtein(a, b);
      return 1 - d / Math.max(a.length, b.length, 1);
    }

    // Strip trailing numeric ID suffix like -a5073 or -111340 before comparing series names
    function stripId(s) { return s.replace(/-[a-z]?\d{3,}$/i, "").replace(/-+$/, ""); }

    function seriesSlugOf(k) { return k.split("/")[0] || ""; }

    // Filter siblings: must share series slug, must not be current episode
    let siblings = Object.entries(all).filter(([k]) => k !== (_segsCacheKey ?? storeKey()) && k.includes(slug));

    // Fallback: if no same-series siblings, find other series by name similarity
    // e.g. "sousou-no-frieren-i2-a5073" matches "sousou-no-frieren-2nd-season-a5448"
    if (!siblings.length) {
      const curSeriesName = stripId(slug);
      const allSeries = [...new Set(Object.keys(all).map(seriesSlugOf))].filter(s => s !== slug);
      // Rank each foreign series by name similarity to current
      const ranked = allSeries
        .map(s => ({ s, sim: nameSim(stripId(s), curSeriesName) }))
        .filter(x => x.sim > 0.3)                           // minimum similarity threshold
        .sort((a, b) => b.sim - a.sim);
      if (ranked.length) {
        // Use the single best-matching series only to avoid mixing unrelated shows
        const bestSlug = ranked[0].s;
        siblings = Object.entries(all).filter(([k]) => seriesSlugOf(k) === bestSlug);
      }
    }

    // Detect noisy episode keys: first ep (tap-01-) and finale (tap-NNend-)
    // These commonly have non-standard OP/ED timing — reduce their influence
    function isNoisyEp(k) {
      const ep = k.split("/").pop() || "";
      return /tap-01[^0-9]/i.test(ep) || /tap-\d+end/i.test(ep);
    }

    // Prefer episodes with similar duration (use max seg.end as proxy)
    // Allow 15% tolerance; if nothing qualifies fall back to all siblings
    if (curDur > 0) {
      const durClose = siblings.filter(([, segs]) => {
        const known = segs.map(s => s.end).filter(e => e !== -1);
        if (!known.length) return false;
        const proxy = Math.max(...known);
        return Math.abs(proxy - curDur) / curDur < 0.15;
      });
      if (durClose.length) siblings = durClose;
    }

    if (!siblings.length) return [];

    // Collect (start, len) per type — normalise is_end and out-of-range ends
    // Noisy episodes (first/last) are included but duplicated only once regardless
    // of how many normal episodes exist, capping their statistical weight
    const noisyKeys = new Set(siblings.filter(([k]) => isNoisyEp(k)).map(([k]) => k));
    const normalSiblings  = siblings.filter(([k]) => !noisyKeys.has(k));
    const noisySiblings   = siblings.filter(([k]) =>  noisyKeys.has(k));
    // Only append noisy eps when we have fewer than 3 normal eps (sparse data)
    const effectiveSibs = normalSiblings.length >= 3
      ? normalSiblings
      : [...normalSiblings, ...noisySiblings];

    // ── Vector encoding ────────────────────────────────────────────────────
    // Represent each sibling as a feature vector of normalised [start, len]
    // per segment type — same representation used in embedding-based retrieval.
    // Normalise by episode proxy-duration so vectors are scale-invariant.
    const TYPE_KEYS = Object.keys(TYPES); // fixed order = fixed vector dims

    function episodeVector(segs, dur) {
      // proxy dur: max known end, or supplied dur
      const proxy = dur || Math.max(1, ...segs.map(s => s.end > 0 ? s.end : 0));
      const v = new Float64Array(TYPE_KEYS.length * 2); // [start0,len0, start1,len1, ...]
      for (const seg of segs) {
        const idx = TYPE_KEYS.indexOf(seg.type);
        if (idx === -1 || seg.end <= 0) continue;
        const len = seg.end - seg.start;
        v[idx * 2]     = seg.start / proxy;
        v[idx * 2 + 1] = len       / proxy;
      }
      return v;
    }

    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
      return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    }

    // Build a "query" vector: centroid of all sibling vectors (acts like the
    // mean embedding of the series — similar to averaged sentence embeddings)
    const sibVecs = effectiveSibs.map(([, segs]) => episodeVector(segs, curDur));
    const centroid = new Float64Array(TYPE_KEYS.length * 2);
    for (const v of sibVecs) v.forEach((x, i) => { centroid[i] += x; });
    if (sibVecs.length) centroid.forEach((_, i) => { centroid[i] /= sibVecs.length; });

    // Cosine similarity of each sibling to the centroid → weight
    // Episodes far from the series norm (weird timing) get low weight automatically
    // Extract leading episode number from filename e.g. "tap-17-95936.html" → 17
    function epNum(k) {
      const m = (k.split("/").pop() || "").match(/(?:tap-|ep-)(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    }
    const curEpNum = epNum(_segsCacheKey ?? storeKey());

    const simWeights = effectiveSibs.map(([k], idx) => {
      const s = cosine(sibVecs[idx], centroid);
      const base = Math.exp(3 * s);
      // Episode-proximity decay: closer episode number → higher weight
      // w_prox = exp(-|cur - sib| / 5): distance 0→1.0, 5→0.37, 10→0.14
      if (curEpNum !== null) {
        const sibNum = epNum(k);
        // Only reward proximity if episode timing is already close to series avg
        // (cosine > 0.5 means it's not an outlier) — prevents tap-01/end noise
        // from getting boosted just because they happen to be numerically close
        if (sibNum !== null && s > 0.5) {
          const dist = Math.abs(curEpNum - sibNum);
          return base * Math.exp(-dist / 5);
        }
      }
      return base;
    });

    const byType = {};
    effectiveSibs.forEach(([, sibSegs], sibIdx) => {
      const w = simWeights[sibIdx];
      for (const seg of sibSegs) {
        const sibEnd = seg.end > 0 ? seg.end : null;
        if (!sibEnd) continue;
        if (!byType[seg.type]) byType[seg.type] = [];
        const len = sibEnd - seg.start;
        let entry;
        if (seg.is_end && curDur > 0) {
          entry = { start: curDur - len, len, is_end: true,  w };
        } else if (curDur > 0 && sibEnd > curDur) {
          entry = { start: Math.max(0, curDur - len), len, is_end: false, w };
        } else {
          entry = { start: seg.start, len, is_end: false, w };
        }
        byType[seg.type].push(entry);
      }
    });

    // DBSCAN on start position — order-independent, no greedy bias
    // const EPS = 60, MIN_PTS = 2;
    // function dbscan(entries) {
    //   // Trick 1: sort by start so neighbor scan is O(n) sliding window, not O(n²)
    //   const pts = [...entries].sort((a, b) => a.start - b.start);
    //   const n = pts.length;
    //   const label = new Int32Array(n).fill(-1); // -1 unvisited, 0 noise, >0 cluster

    //   function neighbors(idx) {
    //     const out = [idx];
    //     for (let j = idx - 1; j >= 0 && pts[idx].start - pts[j].start <= EPS; j--) out.push(j);
    //     for (let j = idx + 1; j < n  && pts[j].start - pts[idx].start <= EPS; j++) out.push(j);
    //     return out;
    //   }
    const MIN_PTS = 2;
    // Scale to video duration — not magic numbers:
    // OP/ED start can drift ~12% of dur within same series (data: 162s/1420s)
    // Length variance is tight ~1% of dur (data: ±5s on 90s seg in 1420s video)
    // Fallback to absolute floor when dur unknown (short clips / no metadata yet)
    const durRef  = curDur > 0 ? curDur : 1500;
    const EPS_START = Math.max(60,  durRef * 0.12);
    const EPS_LEN   = Math.max(10,  durRef * 0.01);
    function dbscan(entries) {
      // Trick 1: sort by start — sliding window still O(n) for start scan
      const pts = [...entries].sort((a, b) => a.start - b.start);
      const n = pts.length;
      const label = new Int32Array(n).fill(-1);

      function neighbors(idx) {
        const out = [idx];
        // expand left/right within start window, then filter by len
        for (let j = idx - 1; j >= 0 && pts[idx].start - pts[j].start <= EPS_START; j--)
          if (Math.abs(pts[idx].len - pts[j].len) <= EPS_LEN) out.push(j);
        for (let j = idx + 1; j < n  && pts[j].start - pts[idx].start <= EPS_START; j++)
          if (Math.abs(pts[idx].len - pts[j].len) <= EPS_LEN) out.push(j);
        return out;
      }

      // Trick 2: proper core-point expansion — only dense points seed clusters,
      // border points get absorbed, true outliers become noise
      let cid = 0;
      for (let i = 0; i < n; i++) {
        if (label[i] !== -1) continue;
        const nbrs = neighbors(i);
        if (nbrs.length < MIN_PTS) { label[i] = 0; continue; } // mark noise for now
        cid++;
        label[i] = cid;
        const queue = nbrs.filter(j => j !== i);
        while (queue.length) {
          const j = queue.pop();
          if (label[j] === 0) { label[j] = cid; continue; } // absorb border point
          if (label[j] !== -1) continue;
          label[j] = cid;
          const jn = neighbors(j);
          if (jn.length >= MIN_PTS) jn.forEach(k => { if (label[k] <= 0) queue.push(k); });
        }
      }

      const groups = {};
      for (let i = 0; i < n; i++) {
        const g = label[i];
        if (g > 0) { if (!groups[g]) groups[g] = []; groups[g].push(pts[i]); }
      }

      // Trick 3: re-admit noise singletons when data is sparse so we never
      // silently discard the only evidence of a segment type
      const clusters = Object.values(groups);
      if (clusters.length === 0 || n <= 3) {
        for (let i = 0; i < n; i++) {
          if (label[i] <= 0) clusters.push([pts[i]]);
        }
      }
      return clusters;
    }

    function median(arr) {
      const s = [...arr].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    // Welford's single-pass mean+variance — numerically stable (used in Chromium, LLVM)
    function welford(arr) {
      let n = 0, mean = 0, M2 = 0;
      for (const x of arr) {
        n++;
        const delta = x - mean;
        mean += delta / n;
        M2 += delta * (x - mean);
      }
      return { mean, variance: n > 1 ? M2 / (n - 1) : 0 };
    }

    // Adaptive blend: CV small → trust mean (tight data); CV large → trust median (noisy data)
    // alpha = exp(-CV * 15): CV<0.05 → alpha≈1 (pure mean), CV>0.3 → alpha≈0 (pure median)
    // Same decay shape used in Google/Netflix latency percentile estimators
    function adaptiveEstimate(arr) {
      if (arr.length === 1) return arr[0];
      const med = median(arr);
      const { mean, variance } = welford(arr);
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      const alpha = Math.exp(-cv * 15);
      return alpha * mean + (1 - alpha) * med;
    }

    const typeClusters = {};
    for (const [type, entries] of Object.entries(byType)) {
      const clusters = dbscan(entries).map(g => {
        const starts = g.map(e => e.start);
        const lens   = g.map(e => e.len);
        const ws     = g.map(e => e.w);
        const wSum   = ws.reduce((a, b) => a + b, 0) || 1;

        // Weighted mean (cosine-similarity weighted — high-similarity eps dominate)
        const wMeanStart = starts.reduce((s, v, i) => s + v * ws[i], 0) / wSum;
        const wMeanLen   = lens  .reduce((s, v, i) => s + v * ws[i], 0) / wSum;

        // Adaptive blend: if cluster is tight use weighted mean, else median
        const estStart = (() => {
          const { mean, variance } = welford(starts);
          const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
          const alpha = Math.exp(-cv * 15);
          return alpha * wMeanStart + (1 - alpha) * median(starts);
        })();
        const estLen = (() => {
          const { mean, variance } = welford(lens);
          const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
          const alpha = Math.exp(-cv * 15);
          return alpha * wMeanLen + (1 - alpha) * median(lens);
        })();

        const { mean: mLen, variance: vLen } = welford(lens);
        const cvLen = mLen > 0 ? Math.sqrt(vLen) / mLen : 1;
        // Confidence now also includes total cosine weight — high-similarity cluster wins
        const confidence = (g.length * (wSum / g.length)) / (1 + cvLen);
        return {
          type,
          start:      Math.round(estStart * 10) / 10,
          end:        Math.round((estStart + estLen) * 10) / 10,
          is_end:     g.some(e => e.is_end),
          count:      g.length,
          confidence,
        };
      });
      // Sort by confidence instead of raw count
      clusters.sort((a, b) => b.confidence - a.confidence);
      typeClusters[type] = clusters;
    }
    // Base variant = most popular cluster per type (highest episode count wins)
    const types = Object.keys(typeClusters);
    const base = types.map(t => typeClusters[t][0]);
    const variants = [base];

    // Extra variants = minority clusters (e.g. op at 331 instead of 0)
    for (const type of types) {
      for (let i = 1; i < typeClusters[type].length; i++) {
        variants.push(base.map(seg => seg.type === type ? typeClusters[type][i] : seg));
      }
    }
    // Clamp any segment whose end exceeds curDur — shift whole segment back
    if (curDur > 0) {
      variants.forEach(v => v.forEach(seg => {
        if (seg.end > curDur) {
          const len = seg.end - seg.start;
          seg.start = Math.round(Math.max(0, curDur - len) * 10) / 10;
          seg.end   = curDur;
        }
      }));
    }
    // Sort variants so the one whose tail-segment ends are closest to curDur comes first
    if (curDur > 0) {
    variants.sort((a, b) => {
       const score = v => {
         const tail = v.reduce((best, seg) => {
           const e = seg.end === -1 ? curDur : seg.end;
           return e > best ? e : best;
         }, 0);
         return Math.abs(tail - curDur);
       };
      return score(a) - score(b);
    });
  }
  return variants;
  }

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
      if (_cachedDur > 0) refreshTimeline(_segsCache ?? loadSegs(), _cachedDur);
      updateHdrStats();
    }, 1000);

    function getMergedSkipSegs(segs) {
      if (_mergedCache) return _mergedCache;
      const dur = _cachedDur || liveDur();
      const active = segs
        .map(s => s.end === -1 ? { ...s, end: dur || 999999 } : s)
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
      if (Date.now() - lastSkip < SKIP_COOL) return;
      if (editIndex !== null) {
        if (lockSeg) {
          const pos = liveGetPos();
          const seg = (_segsCache ?? loadSegs())[editIndex];
          const s = inStart._raw ?? (inStart.value.trim() ? parseFmt(inStart.value) : null);
          const rawE = inEnd._raw ?? (inEnd.value.trim() ? parseFmt(inEnd.value) : null);
          let e = (rawE === -1 || rawE === null) ? (_cachedDur || liveDur() || Infinity) : rawE;
          //showToast("p: "+Math.ceil(pos)+" E:"+e + " e - delta = " + Math.floor(e - delta) );
          if (pos !== null && s !== null && !isNaN(s) && e !== null && !isNaN(e) && e > 0) {
            if (seg.is_end) {
              // Guard that allow it not jumb to next ep (0.5 < gaps(new_e;pos) < 1.0)
              // NOTE: Make suremax timeout < 500 (safe)
              const e_floor = Math.floor(e);
              e = Math.round(e) > e ? e_floor : e_floor - 0.6;
            }
            if ( pos >= e || pos < s) {
              const v = document.querySelector("#media-player video, video");
              if (v && !v.paused) {
                v.currentTime = s;
              }
            }
          }
        }
        return;
      }
      const pos = liveGetPos();
      if (pos === null || pos === 0 ) {
        if (autoplay && editIndex === null || is_prevEdit) {
          const v = document.querySelector("#media-player video, video");
          if (v) { v.currentTime = 0; if (v.paused) v.play().catch(() => {}); }
          // if (_cachedDur > 0)
          //   showToast("Autoplay");
          const _segs  = _segsCache ?? loadSegs();
          const merged = getMergedSkipSegs(_segs);
          const startSeg = merged.find(seg => seg.start === 0);
          liveSeekTo(startSeg ? startSeg.end : 0);
          if (is_prevEdit){
            liveSeekTo(startSeg.end,false);
            is_prevEdit = false;
          }
        }
        return;
      }
      const _segs = _segsCache ?? loadSegs();
      const merged = getMergedSkipSegs(_segs);
      const hit      = bsearchSeg(merged, pos);
      if (!hit) return;
      const hitIndex = _segs.findIndex(s => s.start === hit.start && s.end === hit.end);
      if (hitIndex !== editIndex) {
        //if (is_prevEdit && _segs[hitIndex]?.is_end){
        if (is_prevEdit){
          liveSeekTo(hit.end,false);
          return;
        }
        lastSkip = Date.now();
        if (_segs[hitIndex]?.is_end) {
          liveSeekTo(99999999);
          return;
        }
        liveSeekTo(hit.end);
        showToast("Skipped " + hit.labels.join(" + "));
      }
      is_prevEdit = false;
    }, 250);

    detectPlayer((jwp, videoEl) => {
      initEngine(jwp, videoEl);
      const inp = document.querySelector("#avs-widget input");
      if (inp) inp.placeholder = "MM:SS";
      refreshTimeline(_segsCache ?? loadSegs(), _cachedDur || liveDur());
    });
  });
})();
