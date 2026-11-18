/* monoSync 패널 — 자막 텍스트 → 자막 넣을 V트랙 + 음성 A트랙 → 싱크 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var E = window.MSEngine, A = window.MSAlign, U = window.MSUpdater;
  window.addEventListener("error", function (ev) {
    var s = document.getElementById("status");
    if (s) { s.textContent = "[패널 오류] " + ev.message + " (" + String(ev.filename || "").split("/").pop() + ":" + ev.lineno + ") — 이 문구를 Claude에게 보내 주세요."; s.className = "status err"; }
  });
  if (!A || !E) { setTimeout(function () { var s = document.getElementById("status"); if (s) { s.textContent = "[패널 오류] " + (!A ? "align.js" : "engine.js") + "를 불러오지 못했어요."; s.className = "status err"; } }, 0); }
  var LS = "monosync.";
  var state = { info: null, v: -1, a: -1, range: "all", style: "gfx", result: null, placed: null, busy: false, words: null };

  // ---------- 호스트 ----------
  function host(script) {
    return new Promise(function (resolve) {
      if (!window.__adobe_cep__) return resolve('{"ok":false,"reason":"' + encodeURIComponent("프리미어 밖에서 열렸어요") + '"}');
      window.__adobe_cep__.evalScript(script, function (r) { resolve(r); });
    });
  }
  function dec(x) {
    Object.keys(x).forEach(function (k) {
      if (typeof x[k] === "string") { try { x[k] = decodeURIComponent(x[k]); } catch (e) {} }
      else if (x[k] && typeof x[k] === "object") dec(x[k]);
    });
    return x;
  }
  function call(script) {
    return host(script).then(function (r) {
      var o; try { o = JSON.parse(r); } catch (e) { return { ok: false, reason: "프리미어 응답 오류: " + String(r).slice(0, 200) }; }
      return dec(o);
    });
  }
  // 프리미어로 넘기는 문자열: ' ( ) 등까지 모두 %XX로 (encodeURIComponent는 ' 를 그대로 둬서 스크립트가 깨짐)
  function q(s) { return "'" + encodeURIComponent(String(s)).replace(/[!'()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); }) + "'"; }
  (function loadHost() {
    if (!window.__adobe_cep__) return;
    var p = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "");
    window.__adobe_cep__.evalScript('$.evalFile("' + (p + "/jsx/host.jsx").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '")', function () {});
  })();

  var mem = {};   // 저장소가 막혀도 이번 세션 동안은 기억
  function save(k, v) { mem[k] = String(v); try { localStorage.setItem(LS + k, v); } catch (e) {} }
  function load(k, d) {
    try { var v = localStorage.getItem(LS + k); if (v !== null) return v; } catch (e) {}
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : d;
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- 표시 ----------
  function status(msg, kind) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }
  function progress(p) { $("prog").style.display = p == null ? "none" : "block"; if (p != null) $("bar").style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + "%"; }
  function diag(text) { var d = $("diag"); d.textContent = text || ""; d.style.display = text ? "block" : "none"; }
  function fmt(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); }
  function setBusy(b) {
    state.busy = b;
    $("btnSync").disabled = b; markPresets();
    Array.prototype.forEach.call(document.querySelectorAll(".preset"), function (x) { x.disabled = b; });
    $("stopRow").style.display = b ? "flex" : "none";
    ["btnUndo", "btnSrt", "btnRefresh"].forEach(function (id) { $(id).disabled = b; });
  }

  function checkTools() {
    var t = E ? E.tools(load("model", "")) : {};
    var ok = function (v) { return v ? "ok" : "no"; };
    $("tFfmpeg").className = "dot " + ok(t.ffmpeg); $("tWhisper").className = "dot " + ok(t.whisper); $("tModel").className = "dot " + ok(t.model);
    var sel = $("model"); sel.innerHTML = "";
    (t.models || []).forEach(function (m) { var o = document.createElement("option"); o.value = m; o.textContent = m.replace(/^ggml-|\.bin$/g, ""); sel.appendChild(o); });
    if (t.model) sel.value = E.path.basename(t.model);
    var miss = [];
    if (!t.ffmpeg) miss.push("ffmpeg"); if (!t.whisper) miss.push("whisper-cli"); if (!t.model) miss.push("음성 인식 모델");
    $("setupWarn").style.display = miss.length ? "block" : "none";
    $("setupWarn").textContent = miss.length ? "설치가 덜 됐어요: " + miss.join(", ") + " — install-mac.command를 다시 실행해 주세요." : "";
    return !miss.length;
  }

  // ---------- 1) 텍스트 ----------
  function lines() { return A.parseLines($("text").value); }
  function updateCount() { var n = lines().length; $("count").textContent = n ? "자막 " + n + "개" : ""; save("text", $("text").value); }
  $("text").addEventListener("input", updateCount);
  $("btnLoad").addEventListener("click", function () { $("file").click(); });
  $("file").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var buf = rd.result, txt = new TextDecoder("utf-8").decode(buf);
      if (txt.indexOf("�") >= 0) { try { txt = new TextDecoder("euc-kr").decode(buf); } catch (e) {} }
      $("text").value = txt.replace(/^﻿/, ""); updateCount(); status("「" + f.name + "」 불러옴");
    };
    rd.readAsArrayBuffer(f); this.value = "";
  });

  // 복사·붙여넣기 (프리미어가 가로채는 ⌘C/⌘V 등을 패널이 직접 처리)
  function activeField() {
    var el = document.activeElement;
    return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|number|search)$/.test(el.type))) ? el : null;
  }
  function insertText(el, text) {
    el.focus();
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) {}
    if (!ok) { el.setRangeText(text, el.selectionStart, el.selectionEnd, "end"); el.dispatchEvent(new Event("input", { bubbles: true })); }
  }
  function selected(el) { return el.value.substring(el.selectionStart, el.selectionEnd); }
  function doCopy(el, cut) { var t = selected(el); if (!t) return false; E.clipWrite(t); if (cut) insertText(el, ""); return true; }
  function doPaste(el) {
    var t = E.clipRead();
    if (!t) { status("클립보드가 비어 있어요.", "warn"); return; }
    if (el.tagName === "INPUT") t = t.replace(/\s+/g, " ").trim();
    insertText(el, t.replace(/\r\n?/g, "\n"));
  }
  (function registerKeys() {
    if (!window.__adobe_cep__ || !window.__adobe_cep__.registerKeyEventsInterest) return;
    var keys = [0, 6, 7, 8, 9].map(function (k) { return { keyCode: k, metaKey: true }; });   // 맥 키코드 A Z X C V
    keys.push({ keyCode: 6, metaKey: true, shiftKey: true });
    window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(keys));
  })();
  document.addEventListener("keydown", function (ev) {
    var el = activeField();
    if (!el || !(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
    var k = (ev.key || "").toLowerCase(), code = ev.code || "";
    var is = function (ch) { return k === ch || code === "Key" + ch.toUpperCase(); };
    if (is("v")) { ev.preventDefault(); doPaste(el); }
    else if (is("c")) { ev.preventDefault(); doCopy(el, false); }
    else if (is("x")) { ev.preventDefault(); doCopy(el, true); }
    else if (is("a")) { ev.preventDefault(); el.select(); }
    else if (is("z")) { ev.preventDefault(); try { document.execCommand(ev.shiftKey ? "redo" : "undo"); } catch (e) {} }
  }, true);
  (function contextMenu() {
    if (!window.__adobe_cep__ || !window.__adobe_cep__.invokeAsync) return;
    var last = null;
    document.addEventListener("contextmenu", function () { last = activeField(); }, true);
    var item = function (id, label) { return { id: id, label: label, enabled: true, checkable: false, checked: false }; };
    window.__adobe_cep__.invokeAsync("setContextMenuByJSON", JSON.stringify({ menu: [item("cut", "잘라내기"), item("copy", "복사"), item("paste", "붙여넣기"), { id: "sep", label: "---" }, item("all", "전체 선택")] }), function (id) {
      var el = last || activeField() || $("text");
      if (id === "cut") doCopy(el, true); else if (id === "copy") doCopy(el, false); else if (id === "paste") doPaste(el);
      else if (id === "all") { el.focus(); el.select(); }
    });
  })();
  $("btnPaste").addEventListener("click", function () { var el = $("text"); el.focus(); doPaste(el); });
  $("btnCopy").addEventListener("click", function () {
    var el = $("text"); if (!el.value) return;
    var t = selected(el) || el.value;
    status(E.clipWrite(t) ? (selected(el) ? "선택한 부분을 복사했어요." : "자막 텍스트 전체를 복사했어요.") : "복사에 실패했어요.", "ok");
  });
  $("btnClear").addEventListener("click", function () {
    var el = $("text"); if (!el.value) return;
    el.focus(); el.select(); insertText(el, "");
    status("지웠어요. 잘못 지웠으면 ⌘Z로 되돌릴 수 있어요.");
  });

  // ---------- 2) 트랙 ----------
  function rangeNow() {
    var i = state.info; if (!i) return null;
    if (state.range === "io" && i.hasIO) return { from: i["in"], to: i.out };
    return { from: 0, to: Math.max(i.end, 1) + 3600 };
  }
  function renderTracks() {
    var i = state.info;
    $("vChips").innerHTML = ""; $("aChips").innerHTML = "";
    if (!i) { $("trackInfo").textContent = "시퀀스를 열고 ↻를 눌러 주세요."; return; }
    $("seqName").textContent = i.seq;
    function chip(box, kind, t, on, pick) {
      var b = document.createElement("button");
      b.className = "chip " + kind + (on ? " on" : "");
      b.innerHTML = (kind === "v" ? "V" : "A") + (t.i + 1) + "<small>" + t.n + "개</small>";
      b.title = t.name + " — 클립 " + t.n + "개";
      b.addEventListener("click", function () { pick(t.i); });
      box.appendChild(b);
    }
    i.v.forEach(function (t) { chip($("vChips"), "v", t, t.i === state.v, function (k) { state.v = k; save("v", k); renderTracks(); }); });
    i.a.forEach(function (t) { chip($("aChips"), "a", t, t.i === state.a, function (k) { state.a = k; save("a", k); renderTracks(); }); });
    $("rIO").disabled = !i.hasIO;
    $("rIO").textContent = i.hasIO ? "인~아웃 " + fmt(i["in"]) + "–" + fmt(i.out) : "인~아웃 (설정 안 됨)";
    if (!i.hasIO && state.range === "io") state.range = "all";
    $("rAll").className = state.range === "all" ? "on" : ""; $("rIO").className = state.range === "io" ? "on" : "";
    var vt = i.v[state.v], at = i.a[state.a];
    $("trackInfo").textContent = (at ? "A" + (at.i + 1) + "의 음성을 듣고 " : "음성 트랙을 고르세요 · ") + (vt ? "V" + (vt.i + 1) + "에 자막을 넣어요." : "자막 넣을 트랙을 고르세요.");
  }
  function refresh() {
    return call("MS_seqInfo()").then(function (o) {
      if (!o.ok) { state.info = null; renderTracks(); status(o.reason, "err"); return; }
      var changed = !state.info || state.info.id !== o.id;
      state.info = o;
      var pv = parseInt(load("v", "1"), 10), pa = parseInt(load("a", "1"), 10);
      if (changed || state.v < 0 || state.v >= o.v.length) state.v = pv < o.v.length ? pv : Math.min(1, o.v.length - 1);
      if (changed || state.a < 0 || state.a >= o.a.length) state.a = pa < o.a.length ? pa : Math.min(1, o.a.length - 1);
      renderTracks();
    });
  }
  $("btnRefresh").addEventListener("click", function () { refresh().then(function () { status("시퀀스를 다시 읽었어요."); }); });
  $("rAll").addEventListener("click", function () { state.range = "all"; renderTracks(); });
  $("rIO").addEventListener("click", function () { state.range = "io"; renderTracks(); });
  window.addEventListener("focus", function () { if (!state.busy) refresh(); });

  // ---------- 3) 자막 모양: 내장 [내레이션 자막] ----------
  var TEMPLATE = { file: "templates/narration.mogrt", name: "내레이션 자막" };
  function extRoot() {
    try { return decodeURIComponent(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, ""); } catch (e) { return ""; }
  }
  function tplPath() { return E.path.join(extRoot(), TEMPLATE.file); }
  function markPresets() { $("btnSync").textContent = state.busy ? "싱크 중…" : "싱크 · " + TEMPLATE.name; }
  Array.prototype.forEach.call(document.querySelectorAll(".preset"), function (b) {
    b.addEventListener("click", function () { if (!state.busy) sync(); });     // 누르면 바로 싱크
  });
  function insertMode() { return load("insertMode", "cap"); }
  function renderMode() {
    var m = insertMode();
    $("mCap").className = m === "cap" ? "on" : ""; $("mGfx").className = m === "gfx" ? "on" : "";
    $("capHelp").style.display = m === "cap" ? "block" : "none"; $("replaceRow").style.display = m === "gfx" ? "flex" : "none"; $("gfxTestBox").style.display = m === "gfx" ? "block" : "none";
  }
  $("mCap").addEventListener("click", function () { save("insertMode", "cap"); renderMode(); });
  $("mGfx").addEventListener("click", function () { save("insertMode", "gfx"); renderMode(); });
  renderMode();
  $("chkReplace").checked = load("replace", "0") === "1";
  $("chkReplace").addEventListener("change", function () { save("replace", this.checked ? "1" : "0"); });

  // ---------- 4) 싱크 ----------
  function opts() {
    return {
      mode: document.querySelector('input[name=mode]:checked').value,
      minDur: parseFloat($("oMin").value) || 0.8, padEnd: parseFloat($("oPad").value) || 0, joinGap: parseFloat($("oJoin").value) || 0
    };
  }
  // 프레임 단위로 맞추기 (템플릿 클립 시작이 프레임에 붙어서 위치 찾기가 어긋나지 않게)
  function snapItems(items) {
    var tpf = state.info && state.info.tpf ? state.info.tpf : 0, fr = tpf ? tpf / 254016000000 : 1 / 30;
    var sn = function (t) { return Math.round(t / fr) * fr; };
    items.forEach(function (it) { it.start = sn(it.start); it.end = sn(it.end); });
    for (var k = 0; k < items.length; k++) {
      var nx = items[k + 1];
      if (nx && items[k].end > nx.start) items[k].end = nx.start;
      if (items[k].end <= items[k].start) items[k].end = items[k].start + fr;
    }
    return items;
  }

  function sync() {
    diag("");
    if (!checkTools()) { status("설치가 덜 됐어요.", "err"); return; }
    var L = lines();
    if (!L.length) { status("자막 텍스트를 먼저 넣어 주세요.", "err"); return; }
    var tpl = tplPath();
    if (!E.fileExists(tpl)) { status("내레이션 자막 템플릿이 없어요: " + tpl + "\n업데이트 확인을 누르거나 다시 설치해 주세요.", "err"); return; }
    setBusy(true); progress(0); E.resetCancel();
    var rg, clips, vIdx, aIdx;
    refresh().then(function () {
      if (!state.info) throw new Error("열려 있는 시퀀스가 없어요.");
      vIdx = state.v; aIdx = state.a; rg = rangeNow();
      if (vIdx < 0 || aIdx < 0) throw new Error("자막 넣을 트랙과 음성 트랙을 골라 주세요.");
      return call("MS_trackClips(" + aIdx + "," + rg.from + "," + rg.to + ")");
    }).then(function (o) {
      if (!o.ok) throw new Error(o.reason);
      clips = o.clips;
      if (!clips.length) throw new Error("A" + (aIdx + 1) + " 트랙" + (state.range === "io" ? "의 인~아웃 구간" : "") + "에 음성 클립이 없어요.");
      return E.transcribeTrack(clips, $("lang").value, $("model").value, function (p, m) { progress(p * 0.85); status(m); });
    }).then(function (res) {
      state.words = E.wordsFromTrack(res).filter(function (w) { return w.t1 > rg.from && w.t0 < rg.to; });
      var o2 = opts(); o2.regions = clips.map(function (c) { return { t0: Math.max(c.start, rg.from), t1: Math.min(c.end, rg.to) }; });
      state.result = A.run(state.words, L, o2);
      snapItems(state.result.items);
      renderResult();
      var r = state.result;
      if (opts().mode === "same" && r.overall < 0.35)
        throw new Error("음성과 자막이 거의 안 맞아요(" + Math.round(r.overall * 100) + "%). 음성 트랙(A" + (aIdx + 1) + ")과 음성 언어를 확인해 주세요. 번역 자막이면 세부 설정에서 '번역 자막'을 고르세요.");
      return insertMode() === "gfx" ? placeGraphics(tpl, vIdx, rg) : placeCaptions();
    }).then(function (msg) {
      progress(null); setBusy(false);
      if (msg) status(msg.text, msg.kind);
    }).catch(function (e) {
      progress(null); setBusy(false); E.journal(null);
      status(e.message || String(e), "err");
    });
  }
  $("btnSync").addEventListener("click", sync);
  $("btnStop").addEventListener("click", function () { state.stop = true; E.cancel(); });

  // 첫 자막을 넣은 뒤 눈으로 확인 받기 (스크립트로는 그래픽 글자를 읽을 수 없어서)
  function askConfirm() {
    return new Promise(function (resolve) {
      var box = $("confirm"); box.style.display = "block";
      function done(v) { box.style.display = "none"; $("btnOkGo").onclick = $("btnNoStop").onclick = null; resolve(v); }
      $("btnOkGo").onclick = function () { done(true); };
      $("btnNoStop").onclick = function () { done(false); };
    });
  }

  // 첫 자막이 안 나타날 때 자동 점검: (A) 원본 템플릿 (B) ID만 바꾼 템플릿 을 빈 자리에 올려 보고 지움
  function selfTest(tpl, vIdx, genDir) {
    var at = Math.ceil((state.info ? state.info.end : 0) + 30), lines = ["[monoSync 자동 점검] V" + (vIdx + 1) + ", 시퀀스 끝+30초(" + at + "초)에 시험"];
    function one(label, file, t) {
      return call("MS_import(" + q(file) + "," + vIdx + "," + t + ")").then(function (o) {
        if (!o.ok) { lines.push(label + ": 올리기 오류 — " + o.reason); return; }
        var n = 0;
        function w() {
          return sleep(300).then(function () { return call("MS_probe(" + vIdx + "," + t + ")"); }).then(function (p) {
            if (p.ok && p.state !== "pending") { lines.push(label + ": 나타남 ✓"); return call("MS_removeOne(" + vIdx + "," + t + ")"); }
            if (++n > 40) { lines.push(label + ": 안 나타남 ✗"); return; }
            return w();
          });
        }
        return w();
      });
    }
    status("첫 자막이 안 나타나서 자동 점검 중… (최대 30초)", "warn");
    var same;
    try { same = E.makeLineTemplate(tpl, "", genDir, 999, { keepText: true }); } catch (e) { lines.push("ID만 바꾼 템플릿 만들기 실패: " + e.message); }
    return one("A 원본 템플릿", tpl, at)
      .then(function () { return same ? one("B ID만 바꾼 템플릿", same, at + 10) : null; })
      .then(function () { lines.push("C 글자 바꾼 템플릿(이번 자막): 안 나타남 ✗"); return lines.join("\n"); })
      .catch(function (e) { lines.push("점검 중 오류: " + e.message); return lines.join("\n"); });
  }

  // 자막 줄마다 글자가 들어간 템플릿을 만들어, 하나씩 천천히 올린다
  //   [줄 템플릿 만들기] → [올리기 1번] → [나타날 때까지 기다림] → [클립 수 확인] → [길이 맞춤]
  function placeGraphics(tpl, vIdx, rg) {
    var items = state.result.items, from = items[0].start - 0.01, to = items[items.length - 1].end + 0.01;
    var placed = [], k = 0, count0 = 0, total = items.length, genDir = E.newGenDir();
    state.placed = { v: vIdx, starts: placed };
    state.stop = false;
    function jr(step) { E.journal({ state: "running", step: step, k: k + 1, total: total, text: items[k] ? items[k].text : "", at: Date.now(), v: vIdx, placed: placed.slice() }); }
    function fail(msg, diagText) {
      if (diagText) diag(diagText);
      E.journal(null);
      throw new Error(msg + "\n" + placed.length + "개까지 넣고 멈췄어요." + (placed.length ? " (넣은 것은 '방금 넣은 자막 지우기'로 지울 수 있어요)" : ""));
    }
    var pre = $("chkReplace").checked ? call("MS_removeRange(" + vIdx + "," + from + "," + to + ")") :
      call("MS_countRange(" + vIdx + "," + from + "," + to + ")").then(function (o) {
        if (o.ok && o.n > 0) throw new Error("V" + (vIdx + 1) + "의 이 구간(" + fmt(from) + "–" + fmt(to) + ")에 이미 자막 클립이 " + o.n + "개 있어요.\n'범위 안에 이미 있는 자막 클립은 지우고 넣기'를 켜거나 다른 트랙을 고른 뒤 다시 싱크하세요. (음성 인식은 저장돼 있어 바로 끝나요)");
      });
    return pre.then(function () {
      status("프로젝트 저장 중… (혹시 프리미어가 멈춰도 작업이 남도록)");
      return call("MS_saveProject()");
    }).then(function () { return call("MS_count(" + vIdx + ")"); }).then(function (o) {
      if (!o.ok) fail(o.reason);
      count0 = o.n;
      function next() {
        if (k >= total) return null;
        if (state.stop) fail("중지했어요.");
        var it = items[k], text = it.text.split("|").map(function (x) { return x.trim(); }).join("\n");
        var first = placed.length === 0;
        progress(0.85 + 0.15 * k / total);
        status("V" + (vIdx + 1) + "에 자막 넣는 중… (" + (k + 1) + "/" + total + ")" + (first ? " — 첫 자막은 템플릿을 불러오느라 조금 걸려요" : ""));
        jr("줄 템플릿 만들기");
        var lineTpl;
        try { lineTpl = E.makeLineTemplate(tpl, text, genDir, k + 1); }
        catch (e) { fail("자막 템플릿을 만들지 못했어요: " + e.message); }
        jr("올리기");
        return call("MS_import(" + q(lineTpl) + "," + vIdx + "," + it.start.toFixed(5) + ")").then(function (o1) {
          if (!o1.ok) fail(o1.reason);
          jr("나타나기 기다림");
          var tries = 0, limit = first ? 60 : 24;                    // 첫 자막 최대 15초, 그 뒤 6초
          function wait() {
            return sleep(250).then(function () { return call("MS_probe(" + vIdx + "," + it.start.toFixed(5) + ")"); }).then(function (p) {
              if (!p.ok) fail(p.reason);
              if (p.state === "pending") {
                if (++tries > limit) {
                  if (first) return selfTest(tpl, vIdx, genDir).then(function (rep) { fail("1번째 자막 클립이 타임라인에 나타나지 않았어요. 자동 점검 결과를 Claude에게 보내 주세요.", rep); });
                  fail((k + 1) + "번째 자막 클립이 타임라인에 나타나지 않았어요.");
                }
                return wait();
              }
              return p;
            });
          }
          return wait();
        }).then(function () {
          return call("MS_count(" + vIdx + ")");
        }).then(function (c) {                                        // 한 번 올렸으면 클립은 정확히 하나 늘어야 함
          if (c.ok && c.n > count0 + placed.length + 1) {
            var extra = c.n - count0 - placed.length;
            placed.push(it.start);
            fail("자막 하나를 올렸는데 클립이 " + extra + "개 생겼어요. 이상 동작이라 바로 멈췄어요.");
          }
          placed.push(it.start);
          jr("길이 맞추기");
          return call("MS_setEnd(" + vIdx + "," + it.start.toFixed(5) + "," + it.end.toFixed(5) + ")");
        }).then(function (w) {
          if (!w.ok) fail(w.reason);
          k++;
          if (first) {                                                // 그래픽 방식은 아직 시험 중이라 매번 첫 자막을 눈으로 확인
            E.journal(null);
            host("MS_seek(" + (it.start + 0.05).toFixed(3) + ")");
            status("첫 자막을 넣었어요. 프리미어 화면에서 글자가 「" + it.text.replace(/\|/g, " ") + "」로 보이는지 확인해 주세요.", "warn");
            return askConfirm().then(function (ok) {
              if (!ok) {
                return call("MS_removeOne(" + vIdx + "," + it.start.toFixed(5) + ")").then(function () {
                  placed.pop();
                  fail("넣은 첫 자막을 지웠어요. 어떻게 보였는지(캡처) Claude에게 보내 주세요.");
                });
              }
              return sleep(200).then(next);
            });
          }
          return sleep(first ? 400 : 120).then(next);               // 프리미어가 숨 돌릴 틈
        });
      }
      return next();
    }).then(function () {
      E.journal(null);
      var ng = items.filter(function (x) { return x.how === "guess"; }).length;
      return { text: "V" + (vIdx + 1) + "에 자막 " + total + "개를 넣었어요." + (ng ? " 음성에서 못 찾은 " + ng + "개는 주황색 — 앞뒤 사이에 추정 배치했어요." : "") + " 줄을 누르면 그 위치로 가요.", kind: ng ? "warn" : "ok" };
    });
  }

  function stamp() { var d = new Date(), p = function (x) { return (x < 10 ? "0" : "") + x; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function saveSRT() {
    return call("MS_projectDir()").then(function (o) {
      var dir = o.ok ? E.path.join(o.dir, "monoSync") : E.path.join(E.home, "Documents", "monoSync");
      var nm = ((state.info ? state.info.seq : "") || "자막").replace(/[\/\\:*?"<>|]/g, "_") + "_" + stamp() + ".srt";
      return E.writeText(E.path.join(dir, nm), "﻿" + A.toSRT(state.result.items));
    });
  }
  function placeCaptions() {
    status("프로젝트 저장 중…");
    return call("MS_saveProject()").then(function () { return saveSRT(); }).then(function (f) {
      status("캡션 트랙 만드는 중…");
      return call("MS_addCaptions(" + q(f) + ")").then(function (o) {
        if (!o.ok) throw new Error(o.reason + "\n(SRT: " + f + ")");
        state.placed = null;
        var ng = state.result.items.filter(function (x) { return x.how === "guess"; }).length;
        return { text: "새 캡션 트랙에 자막 " + state.result.items.length + "개를 넣었어요." + (ng ? " 음성에서 못 찾은 " + ng + "개는 주황색 — 추정 배치." : "") + " 트랙 스타일에서 '내레이션'을 고르면 모양이 적용돼요.", kind: ng ? "warn" : "ok" };
      });
    });
  }

  // 그래픽 글자 시험: 어떤 조건에서 글자가 보이는지 확인용 클립 4개
  var testStarts = [];
  $("btnGfxTest").addEventListener("click", function () {
    if (state.busy) return;
    var tpl = tplPath(), v = state.v;
    var orig = E.templateText(tpl);
    var same = Array.from(orig).map(function (ch, i) { return /[가-힣]/.test(ch) ? "시험같은길이글자"[i % 8] : ch; }).join("");   // 글자 수·바이트 수가 원본과 같음
    var cases = [
      { label: "시험1", text: "시험1 짧은 글자", keepHash: false },
      { label: "시험2", text: "시험2 짧은 글자", keepHash: true },
      { label: "시험3", text: same, keepHash: false },
      { label: "시험4", text: same, keepHash: true }
    ];
    setBusy(true); diag("");
    refresh().then(function () {
      var at = Math.ceil((state.info ? state.info.end : 0) + 30), dir = E.newGenDir(), rep = ["[그래픽 글자 시험] V" + (v + 1) + ", " + fmt(at) + "부터 10초 간격"];
      testStarts = [];
      return cases.reduce(function (p, c, i) {
        return p.then(function () {
          var t = at + i * 10, f = E.makeLineTemplate(tpl, c.text, dir, 900 + i, { keepHash: c.keepHash, tag: "test" });
          status("시험 클립 올리는 중… (" + (i + 1) + "/4)");
          return call("MS_import(" + q(f) + "," + v + "," + t + ")").then(function () {
            var n = 0;
            function w() {
              return sleep(300).then(function () { return call("MS_probe(" + v + "," + t + ")"); }).then(function (p2) {
                if (p2.ok && p2.state !== "pending") { testStarts.push(t); rep.push(c.label + " (" + fmt(t) + ") 올라감 — 글자: " + c.text + (c.keepHash ? " · 원본 해시" : " · 해시 없음")); return; }
                if (++n > 40) { rep.push(c.label + ": 안 올라감"); return; }
                return w();
              });
            }
            return w();
          });
        });
      }, Promise.resolve()).then(function () {
        setBusy(false);
        diag("");
        showTestPanel(cases, at, rep);
        status("시험 클립 4개를 올렸어요. 아래에서 [보기]를 누르고, 화면에 글자가 보이는지 골라 주세요.", "warn");
      });
    }).catch(function (e) { setBusy(false); status(e.message, "err"); });
  });
  function showTestPanel(cases, at, rep) {
    var box = $("testPanel"), ans = {};
    box.innerHTML = ""; box.style.display = "block";
    var out = document.createElement("div"); out.className = "muted"; out.style.marginTop = "6px";
    function summary() {
      var lines = ["[그래픽 글자 시험 결과] monoSync v" + (U ? U.localVersion() : "?")];
      cases.forEach(function (c, i) { lines.push(c.label + " (" + (i < 2 ? "짧은 글자" : "원본과 같은 길이") + ", " + (c.keepHash ? "원본 검증값" : "검증값 뺌") + "): " + (ans[i] || "아직 안 봄")); });
      return lines.join("\n");
    }
    cases.forEach(function (c, i) {
      var t = at + i * 10, row = document.createElement("div"), up = rep.join(" ").indexOf(c.label + ": 안 올라감") < 0;
      row.className = "rowbtn";
      row.innerHTML = '<button class="b1">보기</button><span class="grow"></span><button class="b2">글자 보임</button><button class="b3">안 보임</button>';
      row.insertBefore(document.createTextNode(c.label + (up ? "" : " (안 올라감)")), row.children[1]);
      row.querySelector(".b1").onclick = function () { host("MS_seek(" + (t + 1) + ")"); };
      function pick(v, btn) { ans[i] = v; row.querySelector(".b2").style.background = row.querySelector(".b3").style.background = ""; btn.style.background = v === "글자 보임" ? "#2c6e3a" : "#6e2c2c"; out.textContent = summary(); }
      row.querySelector(".b2").onclick = function () { pick("글자 보임", this); };
      row.querySelector(".b3").onclick = function () { pick("안 보임", this); };
      if (!up) { row.querySelector(".b1").disabled = true; ans[i] = "안 올라감"; }
      box.appendChild(row);
    });
    var cp = document.createElement("div"); cp.className = "rowbtn";
    cp.innerHTML = '<button class="primary">결과 복사</button><span class="muted">→ Claude에게 붙여넣어 보내 주세요</span>';
    cp.querySelector("button").onclick = function () { E.clipWrite(summary()); status("결과를 복사했어요. Claude에게 붙여넣어 보내 주세요.", "ok"); };
    box.appendChild(cp); box.appendChild(out); out.textContent = summary();
    host("MS_seek(" + (at + 1) + ")");
  }
  $("btnGfxTestDel").addEventListener("click", function () {
    if (!testStarts.length) { status("지울 시험 클립이 없어요.", "warn"); return; }
    call("MS_removeAt(" + state.v + ",'" + testStarts.join(",") + "')").then(function (o) { status("시험 클립 " + (o.n || 0) + "개를 지웠어요.", "ok"); testStarts = []; $("testPanel").style.display = "none"; });
  });

  function renderResult() {
    var box = $("result"), r = state.result; box.innerHTML = "";
    $("resultWrap").style.display = r ? "block" : "none";
    if (!r) return;
    r.items.forEach(function (it, k) {
      var d = document.createElement("div");
      d.className = "row " + (it.how === "match" ? "m" : it.how === "order" ? "o" : "g");
      d.innerHTML = '<span class="no"></span><span class="tm"></span><span class="tx"></span>';
      d.querySelector(".no").textContent = k + 1;
      d.querySelector(".tm").textContent = fmt(it.start) + "–" + fmt(it.end);
      d.querySelector(".tx").textContent = it.text.replace(/\|/g, " ⏎ ");
      d.title = it.how === "match" ? "음성과 일치 " + Math.round(it.score * 100) + "%" : it.how === "guess" ? "음성에서 못 찾아 앞뒤 사이에 추정 배치" : "번역 모드: 순서·길이로 배치";
      d.addEventListener("click", function () { host("MS_seek(" + it.start.toFixed(3) + ")"); });
      box.appendChild(d);
    });
    $("heard").textContent = r.recognized || "(인식된 음성 없음)";
  }
  $("btnUndo").addEventListener("click", function () {
    var p = state.placed;
    if (!p || !p.starts.length) { status("지울 자막이 없어요.", "warn"); return; }
    call("MS_removeAt(" + p.v + ",'" + p.starts.join(",") + "')").then(function (o) {
      status(o.ok ? "방금 넣은 자막 " + o.n + "개를 지웠어요." : o.reason, o.ok ? "ok" : "err");
      if (o.ok) state.placed = null;
    });
  });
  $("btnSrt").addEventListener("click", function () {
    if (!state.result) return;
    saveSRT().then(function (f) { status("SRT 저장: " + f, "ok"); }).catch(function (e) { status("저장 실패: " + e.message, "err"); });
  });
  $("btnHeard").addEventListener("click", function () { var h = $("heard"); h.style.display = h.style.display === "block" ? "none" : "block"; });

  // ---------- 세부 설정 ----------
  ["oMin", "oPad", "oJoin"].forEach(function (id) { $(id).value = load(id, $(id).value); $(id).addEventListener("change", function () { save(id, this.value); }); });
  Array.prototype.forEach.call(document.querySelectorAll("input[name=mode]"), function (r) {
    if (r.value === load("mode", "same")) r.checked = true;
    r.addEventListener("change", function () { save("mode", this.value); });
  });
  $("lang").value = load("lang", "ko");
  $("lang").addEventListener("change", function () { save("lang", this.value); });
  $("model").addEventListener("change", function () { save("model", this.value); checkTools(); });
  $("btnClearCache").addEventListener("click", function () { E.clearCache(); status("저장해 둔 인식 결과를 지웠어요. 다음엔 새로 들어요."); });

  // ---------- 업데이트 ----------
  function updMsg(msg, kind) { var s = $("upd"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }
  function showVer() {
    var v = U ? U.localVersion() : "?", pin = U && U.pinned();
    $("ver").textContent = "v" + v; $("updVer").textContent = "지금 v" + v + (pin ? " · 버전 고정" : "");
  }
  function afterInstall(r) {
    try { sessionStorage.setItem(LS + "justUpdated", JSON.stringify(r)); } catch (e) {}
    if (r.needsRestart) updMsg("v" + r.version + " 설치 완료. 이번 변경은 프리미어를 껐다 켜야 적용돼요.", "ok");
    else { updMsg("v" + r.version + " 설치 완료. 패널을 다시 불러와요…", "ok"); setTimeout(function () { location.reload(); }, 1200); }
  }
  function checkUpdate(manual) {
    if (!U) { if (manual) updMsg("업데이트 기능을 불러오지 못했어요.", "err"); return; }
    if (manual) updMsg("GitHub에서 확인 중…");
    U.check(function (m) { updMsg(m); }, manual).then(function (r) {
      if (r.status === "pinned") { updMsg("버전 고정 중이라 자동 업데이트를 건너뛰었어요 (v" + r.version + ")."); return; }
      if (r.status === "none") { updMsg(manual ? "최신 버전이에요 (v" + r.version + ")." : "", "ok"); showVer(); return; }
      afterInstall(r);
    }).catch(function (e) { updMsg((manual ? "" : "자동 ") + "업데이트 확인 실패: " + e.message, "err"); });
  }
  function loadVersionList() {
    if (!U) return;
    var sel = $("selVersion");
    U.listVersions().then(function (list) {
      sel.innerHTML = "";
      if (!list.length) { sel.innerHTML = '<option value="">(올라간 버전 없음)</option>'; return; }
      list.forEach(function (tag, i) {
        var o = document.createElement("option"); o.value = tag;
        o.textContent = tag + (i === 0 ? " (최신)" : "") + (tag.replace(/^v/, "") === U.localVersion() ? " ← 지금" : "");
        sel.appendChild(o);
      });
      sel.setAttribute("data-latest", list[0]);
    }).catch(function (e) { sel.innerHTML = '<option value="">목록을 못 불러옴 (' + e.message + ')</option>'; });
  }
  function initUpdater() {
    showVer();
    try {
      var j = JSON.parse(sessionStorage.getItem(LS + "justUpdated") || "null");
      if (j) { sessionStorage.removeItem(LS + "justUpdated"); updMsg("v" + j.version + "로 업데이트됐어요" + (j.notes ? " — " + j.notes : ""), "ok"); }
    } catch (e) {}
    if (!U) { updMsg("업데이트 기능을 불러오지 못했어요.", "err"); return; }
    $("chkAutoUpd").checked = U.isAuto();
    $("chkAutoUpd").addEventListener("change", function () { U.setAuto(this.checked); updMsg(this.checked ? "자동 업데이트를 켰어요." : "자동 업데이트를 껐어요."); });
    $("btnCheckUpd").addEventListener("click", function () { checkUpdate(true); });
    $("btnInstallVer").addEventListener("click", function () {
      var sel = $("selVersion"), tag = sel.value;
      if (!tag) { updMsg("설치할 버전을 고르세요.", "err"); return; }
      updMsg(tag + " 설치 중…");
      U.installVersion(tag, tag === sel.getAttribute("data-latest"), function (m) { updMsg(m); }).then(afterInstall).catch(function (e) { updMsg("설치 실패: " + e.message, "err"); });
    });
    loadVersionList();
    if (U.isAuto()) checkUpdate(false);
  }

  // ---------- 시작 ----------
  // 업데이트를 맨 먼저 — 다른 부분에 오류가 나도 고친 버전을 받을 수 있게. 각 단계는 따로 보호.
  function safe(name, fn) {
    try { var r = fn(); if (r && r.catch) r.catch(function (e) { status("[" + name + "] " + (e.message || e), "err"); }); }
    catch (e) { status("[" + name + " 오류] " + (e.message || e) + " — 이 문구를 Claude에게 보내 주세요.", "err"); }
  }
  safe("업데이트", initUpdater);
  safe("텍스트", function () { $("text").value = load("text", ""); updateCount(); });
  safe("자막 모양", markPresets);
  safe("지난 싱크 확인", function () {
    var j = E.readJournal();
    if (!j || j.state !== "running") return;
    E.journal(null);
    if (j.placed && j.placed.length) state.placed = { v: j.v, starts: j.placed };
    status("지난번 싱크가 끝나지 않고 멈췄어요 — " + j.total + "개 중 " + j.k + "번째 자막의 '" + j.step + "' 단계 (" + new Date(j.at).toLocaleString() + ").\n" +
      "그때 넣던 자막: " + j.text + "\n" + (j.placed && j.placed.length ? "그 전까지 넣은 " + j.placed.length + "개는 '방금 넣은 자막 지우기'로 지울 수 있어요. " : "") +
      "이 문구를 Claude에게 보내 주시면 원인을 고칠게요.", "warn");
    $("resultWrap").style.display = "block";
  });
  safe("설치 확인", checkTools);
  safe("시퀀스", refresh);
})();
