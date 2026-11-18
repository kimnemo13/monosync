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
    $("btnSync").disabled = b; $("btnSync").textContent = b ? "싱크 중…" : "싱크";
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

  // ---------- 3) 스타일 ----------
  // 템플릿 목록: 프리미어 로컬 템플릿 폴더를 자동으로 훑어, 새로 내보낸 템플릿은 바로 골라 줌
  var tplKnown = null, thumbCache = {};
  function renderStyle() {
    $("sGfx").className = state.style === "gfx" ? "on" : ""; $("sCap").className = state.style === "cap" ? "on" : "";
    $("gfxBox").style.display = state.style === "gfx" ? "block" : "none"; $("capBox").style.display = state.style === "cap" ? "block" : "none";
    scanTemplates(false);
  }
  function scanTemplates(announce) {
    if (!E || !E.listTemplates) return;
    var cur = load("tpl", "");
    var list = E.listTemplates([cur]);
    var paths = list.map(function (t) { return t.path; }).join("|");
    var fresh = [];
    if (tplKnown) list.forEach(function (t) { if (!tplKnown[t.path]) fresh.push(t); });
    var first = tplKnown === null;
    tplKnown = {}; list.forEach(function (t) { tplKnown[t.path] = 1; });
    if (fresh.length) {                                    // 방금 내보낸 템플릿 → 자동 선택
      save("tpl", fresh[0].path); cur = fresh[0].path;
      status("새 템플릿 「" + fresh[0].name + "」을 골랐어요.", "ok");
      $("help").style.display = "none";
    } else if ((!cur || !tplKnown[cur]) && list.length && first) { save("tpl", list[0].path); cur = list[0].path; }
    if (!fresh.length && !announce && renderStyle.lastPaths === paths && renderStyle.lastCur === cur) return;
    renderStyle.lastPaths = paths; renderStyle.lastCur = cur;
    var g = $("tplGrid"); g.innerHTML = "";
    if (!list.length) {
      g.innerHTML = '<div class="tempty">아직 템플릿이 없어요.<br>V2의 자막 클립을 <b>우클릭 › 모션 그래픽 템플릿으로 내보내기</b> → 확인<br>하면 여기에 바로 나타나요.</div>';
      $("tplHint").textContent = "템플릿 없음";
      return;
    }
    list.forEach(function (t) {
      var c = document.createElement("div");
      c.className = "tcard" + (t.path === cur ? " on" : "");
      c.title = t.path;
      c.innerHTML = '<div class="th">미리보기 없음</div><div class="tn"></div>';
      c.querySelector(".tn").textContent = t.name;
      if (fresh.some(function (f) { return f.path === t.path; })) { var n = document.createElement("span"); n.className = "new"; n.textContent = "새로"; c.querySelector(".tn").appendChild(n); }
      var th = c.querySelector(".th");
      function show(img) { if (img) { th.style.backgroundImage = 'url("file://' + encodeURI(img) + '")'; th.textContent = ""; } }
      if (thumbCache[t.path] !== undefined) show(thumbCache[t.path]);
      else E.templateThumb(t.path, function (img) { thumbCache[t.path] = img; show(img); });
      c.addEventListener("click", function () { save("tpl", t.path); scanTemplates(true); status("자막 모양: " + t.name); });
      g.appendChild(c);
    });
    var sel = list.filter(function (t) { return t.path === cur; })[0];
    $("tplHint").textContent = sel ? "선택: " + sel.name : "템플릿을 눌러 고르세요";
  }
  $("sGfx").addEventListener("click", function () { state.style = "gfx"; save("style", "gfx"); renderStyle(); });
  $("sCap").addEventListener("click", function () { state.style = "cap"; save("style", "cap"); renderStyle(); });
  $("btnTpl").addEventListener("click", function () {
    call("MS_pickMogrt()").then(function (o) { if (o.ok) { save("tpl", o.path); scanTemplates(true); status("자막 모양: " + E.path.basename(o.path)); } });
  });
  $("btnTplRefresh").addEventListener("click", function () { scanTemplates(true); });
  $("btnTplFolder").addEventListener("click", function () { E.openTemplateFolder(); });
  window.addEventListener("focus", function () { if (state.style === "gfx") scanTemplates(false); });
  setInterval(function () { if (!state.busy && state.style === "gfx") scanTemplates(false); }, 3000);
  $("btnHelp").addEventListener("click", function () { var h = $("help"); h.style.display = h.style.display === "block" ? "none" : "block"; });
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
    var tpl = load("tpl", "");
    if (state.style === "gfx" && !tpl) { status("자막 모양 템플릿(.mogrt)을 먼저 골라 주세요. ('템플릿 만드는 법' 참고)", "err"); $("help").style.display = "block"; return; }
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
      state.result = A.run(state.words, L, opts());
      snapItems(state.result.items);
      renderResult();
      var r = state.result;
      if (opts().mode === "same" && r.overall < 0.35)
        throw new Error("음성과 자막이 거의 안 맞아요(" + Math.round(r.overall * 100) + "%). 음성 트랙(A" + (aIdx + 1) + ")과 음성 언어를 확인해 주세요. 번역 자막이면 세부 설정에서 '번역 자막'을 고르세요.");
      return state.style === "gfx" ? placeGraphics(tpl, vIdx, rg) : placeCaptions();
    }).then(function (msg) {
      progress(null); setBusy(false);
      if (msg) status(msg.text, msg.kind);
    }).catch(function (e) {
      progress(null); setBusy(false);
      status(e.message || String(e), "err");
    });
  }
  $("btnSync").addEventListener("click", sync);
  $("btnStop").addEventListener("click", function () { state.stop = true; E.cancel(); });

  function placeGraphics(tpl, vIdx, rg) {
    var items = state.result.items, from = items[0].start - 0.01, to = items[items.length - 1].end + 0.01;
    var pre = $("chkReplace").checked ? call("MS_removeRange(" + vIdx + "," + from + "," + to + ")") :
      call("MS_countRange(" + vIdx + "," + from + "," + to + ")").then(function (o) {
        if (o.ok && o.n > 0) throw new Error("V" + (vIdx + 1) + "의 이 구간(" + fmt(from) + "–" + fmt(to) + ")에 이미 자막 클립이 " + o.n + "개 있어요.\n'범위 안에 이미 있는 자막 클립은 지우고 넣기'를 켜거나 다른 트랙을 고른 뒤 다시 싱크하세요. (음성 인식은 저장돼 있어 바로 끝나요)");
        return o;
      });
    var placed = [];
    state.placed = { v: vIdx, starts: placed };
    state.stop = false;
    return pre.then(function () {
      var k = 0;
      function next() {
        if (k >= items.length) return null;
        if (state.stop) throw new Error("중지했어요. " + placed.length + "개까지 넣었어요.");
        var it = items[k], text = it.text.split("|").map(function (s) { return s.trim(); }).join("\n");
        progress(0.85 + 0.15 * k / items.length);
        status("V" + (vIdx + 1) + "에 자막 넣는 중… (" + (k + 1) + "/" + items.length + ")");
        var args = vIdx + "," + it.start.toFixed(5) + "," + it.end.toFixed(5) + "," + q(text);
        return call("MS_place(" + q(tpl) + "," + args + ")").then(function settle(o, tries) {
          tries = tries || 0;
          if (o.ok && o.state === "pending") {
            if (tries > 40) throw new Error((k + 1) + "번째 자막 클립이 타임라인에 나타나지 않았어요.");
            return sleep(150).then(function () { return call("MS_fill(" + args + ")"); }).then(function (o2) { return settle(o2, tries + 1); });
          }
          if (o.state === "done") { placed.push(it.start); k++; return next(); }
          if (o.state === "textfail") {
            placed.push(it.start);
            diag((o.reason || "") + (o.diag ? "\n\n" + o.diag : ""));
            var undo = call("MS_removeAt(" + vIdx + ",'" + placed.join(",") + "')");
            return undo.then(function () {
              placed.length = 0;
              throw new Error("템플릿에 글자를 넣지 못했어요(" + o.reason + "). 넣은 클립은 지웠어요.\n아래 진단 내용을 Claude에게 보내 주세요. 급하면 '캡션 트랙'으로 넣을 수 있어요.");
            });
          }
          throw new Error(o.reason || "자막 넣기 실패");
        });
      }
      return next();
    }).then(function () {
      var ng = items.filter(function (x) { return x.how === "guess"; }).length;
      return { text: "V" + (vIdx + 1) + "에 자막 " + items.length + "개를 넣었어요." + (ng ? " 음성에서 못 찾은 " + ng + "개는 주황색 — 앞뒤 사이에 추정 배치했어요." : "") + " 줄을 누르면 그 위치로 가요.", kind: ng ? "warn" : "ok" };
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
    return saveSRT().then(function (f) {
      return call("MS_addCaptions(" + q(f) + ")").then(function (o) {
        if (!o.ok) throw new Error(o.reason + "\n(SRT: " + f + ")");
        state.placed = null;
        return { text: "새 캡션 트랙에 자막 " + state.result.items.length + "개를 넣었어요.", kind: "ok" };
      });
    });
  }

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
    if (!p || !p.starts.length) { status("지울 자막이 없어요. (캡션 트랙은 타임라인에서 트랙째 지우세요)", "warn"); return; }
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
  safe("스타일", function () { state.style = load("style", "gfx"); renderStyle(); });
  safe("설치 확인", checkTools);
  safe("시퀀스", refresh);
})();
