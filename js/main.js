/* monoSync 패널 — 화면 동작 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var E = window.MSEngine, A = window.MSAlign, U = window.MSUpdater;
  var LS = "monosync.";
  var state = { clips: [], result: null, busy: false };

  // ---------- 호스트 연결 ----------
  function host(script) {
    return new Promise(function (resolve) {
      if (!window.__adobe_cep__) return resolve('{"ok":false,"reason":"' + encodeURIComponent("프리미어 밖에서 열렸어요") + '"}');
      window.__adobe_cep__.evalScript(script, function (r) { resolve(r); });
    });
  }
  function parseHost(r) {
    var o;
    try { o = JSON.parse(r); } catch (e) { return { ok: false, reason: "호스트 응답 오류: " + r }; }
    (function dec(x) {
      Object.keys(x).forEach(function (k) {
        if (typeof x[k] === "string") { try { x[k] = decodeURIComponent(x[k]); } catch (e) {} }
        else if (x[k] && typeof x[k] === "object") dec(x[k]);
      });
    })(o);
    return o;
  }
  (function loadHost() {
    if (!window.__adobe_cep__) return;
    var p = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "");
    window.__adobe_cep__.evalScript('$.evalFile("' + (p + "/jsx/host.jsx").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '")', function () {});
  })();

  // ---------- 저장 ----------
  function save(k, v) { try { localStorage.setItem(LS + k, v); } catch (e) {} }
  function load(k, d) { try { var v = localStorage.getItem(LS + k); return v === null ? d : v; } catch (e) { return d; } }

  // ---------- 상태 표시 ----------
  function status(msg, kind) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }
  function progress(p) { $("bar").style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + "%"; $("prog").style.display = p == null ? "none" : "block"; }
  function setBusy(b) {
    state.busy = b;
    ["btnRun", "btnPick", "btnInsert", "btnSave"].forEach(function (id) { $(id).disabled = b; });
    $("btnStop").style.display = b ? "" : "none";
    if (!b) updateButtons();
  }
  function fmt(t) {
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  }

  function checkTools() {
    var t = E ? E.tools(load("model", "")) : {};
    var ok = function (v) { return v ? "ok" : "no"; };
    $("tFfmpeg").className = "dot " + ok(t.ffmpeg);
    $("tWhisper").className = "dot " + ok(t.whisper);
    $("tModel").className = "dot " + ok(t.model);
    $("tModel").title = t.model ? "모델: " + E.path.basename(t.model) : "모델 없음";
    var sel = $("model"); sel.innerHTML = "";
    (t.models || []).forEach(function (m) {
      var o = document.createElement("option"); o.value = m; o.textContent = m.replace(/^ggml-|\.bin$/g, ""); sel.appendChild(o);
    });
    if (t.model) sel.value = E.path.basename(t.model);
    var missing = [];
    if (!t.ffmpeg) missing.push("ffmpeg"); if (!t.whisper) missing.push("whisper-cli"); if (!t.model) missing.push("음성 인식 모델");
    $("setupWarn").style.display = missing.length ? "block" : "none";
    $("setupWarn").textContent = missing.length ? "설치가 덜 됐어요: " + missing.join(", ") + " — 받은 폴더의 install-mac.command를 다시 실행해 주세요." : "";
    return !missing.length;
  }

  // ---------- 1) 텍스트 ----------
  function lines() { return A.parseLines($("text").value); }
  function updateCount() {
    var n = lines().length;
    $("count").textContent = n ? "자막 " + n + "개" : "";
    save("text", $("text").value);
    updateButtons();
  }
  var reT = null;
  $("text").addEventListener("input", function () {
    updateCount();
    if (state.words) { clearTimeout(reT); reT = setTimeout(realign, 500); }   // 텍스트 고치면 바로 다시 맞춤
  });
  $("btnLoad").addEventListener("click", function () { $("file").click(); });
  $("file").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var buf = rd.result, txt = new TextDecoder("utf-8").decode(buf);
      if (txt.indexOf("�") >= 0) { try { txt = new TextDecoder("euc-kr").decode(buf); } catch (e) {} }   // 윈도우 메모장(한글 ANSI)
      $("text").value = txt.replace(/^﻿/, "");
      updateCount();
      status("「" + f.name + "」 불러옴");
    };
    rd.readAsArrayBuffer(f);
    this.value = "";
  });

  // ---------- 2) 클립 ----------
  function renderClips() {
    var box = $("clips"); box.innerHTML = "";
    if (!state.clips.length) { box.innerHTML = '<div class="muted">아직 없음 — 타임라인에서 대사 클립을 선택하고 위 버튼을 누르세요.</div>'; return; }
    state.clips.forEach(function (c) {
      var d = document.createElement("div"); d.className = "clip";
      d.innerHTML = '<span class="cn"></span><span class="ct"></span>';
      d.querySelector(".cn").textContent = c.name;
      d.querySelector(".ct").textContent = fmt(c.start) + " – " + fmt(c.end) + (c.speed !== 1 ? " · 속도 " + Math.round(c.speed * 100) + "%" : "");
      box.appendChild(d);
    });
  }
  $("btnPick").addEventListener("click", function () {
    host("MS_getSelection()").then(function (r) {
      var o = parseHost(r);
      if (!o.ok) { status(o.reason, "err"); return; }
      var seen = {}, out = [], skipped = 0;
      o.clips.sort(function (a, b) { return a.start - b.start; }).forEach(function (c) {
        if (!c.path) { skipped++; return; }                      // 그래픽·중첩 시퀀스 등 원본 파일 없는 클립
        var k = c.path + "@" + c.start.toFixed(3);
        if (seen[k]) return; seen[k] = 1;                        // 연결된 비디오/오디오는 하나로
        out.push(c);
      });
      state.clips = out; state.seq = o.seq; state.result = null;
      renderClips(); renderResult();
      if (!out.length) status("선택한 것 중 원본 파일이 있는 클립이 없어요. (그래픽·중첩 시퀀스는 안 돼요)", "err");
      else status("클립 " + out.length + "개 가져옴" + (skipped ? " (원본 없는 " + skipped + "개 제외)" : ""));
      updateButtons();
    });
  });

  // ---------- 3) 맞추기 ----------
  function opts() {
    return {
      mode: document.querySelector('input[name=mode]:checked').value,
      minDur: parseFloat($("oMin").value) || 0.8,
      padEnd: parseFloat($("oPad").value) || 0,
      joinGap: parseFloat($("oJoin").value) || 0
    };
  }

  $("btnRun").addEventListener("click", function () {
    if (!checkTools()) { status("설치가 덜 됐어요.", "err"); return; }
    var L = lines();
    if (!L.length) { status("자막 텍스트를 먼저 넣어 주세요.", "err"); return; }
    if (!state.clips.length) { status("대사 클립을 먼저 가져와 주세요.", "err"); return; }
    var rev = state.clips.filter(function (c) { return c.reversed; });
    if (rev.length) { status("거꾸로 재생한 클립은 맞출 수 없어요: " + rev[0].name, "err"); return; }
    var lang = $("lang").value, model = $("model").value, allWords = [], n = state.clips.length;
    setBusy(true); progress(0); state.cancelled = false;
    var chain = Promise.resolve();
    state.clips.forEach(function (c, k) {
      chain = chain.then(function () {
        if (state.cancelled) throw new Error("중지했어요.");
        return E.transcribe(c, lang, model, function (p, msg) {
          progress((k + p) / n);
          status((n > 1 ? "[" + (k + 1) + "/" + n + "] " : "") + msg);
        }).then(function (json) {
          var ws = A.wordsFromWhisper(json, c.start, c.speed || 1).filter(function (w) { return w.t0 < c.end + 0.05; });
          allWords = allWords.concat(ws);
        });
      });
    });
    chain.then(function () {
      state.words = allWords;
      realign();
      progress(null); setBusy(false);
    }).catch(function (e) {
      progress(null); setBusy(false);
      status(e.message || String(e), "err");
    });
  });
  $("btnStop").addEventListener("click", function () { state.cancelled = true; E.cancel(); });

  function realign() {
    if (!state.words) return;
    try {
      state.result = A.run(state.words, lines(), opts());
    } catch (e) { state.result = null; status(e.message, "err"); renderResult(); return; }
    renderResult();
    var r = state.result, nm = r.items.filter(function (x) { return x.how === "match"; }).length, ng = r.items.length - nm;
    if (opts().mode === "same" && r.overall < 0.35)
      status("대사와 거의 안 맞아요(" + Math.round(r.overall * 100) + "%). 번역 자막이면 '번역 자막' 모드로, 아니면 언어 설정을 확인해 주세요.", "warn");
    else if (opts().mode === "same")
      status("대사와 맞춤 " + nm + "개" + (ng ? " · 추정 배치 " + ng + "개(주황색)" : "") + " — 줄을 누르면 그 위치로 이동해요.", ng ? "warn" : "ok");
    else status("번역 모드로 " + r.items.length + "개 배치 — 줄을 누르면 그 위치로 이동해요.", "ok");
  }
  // 옵션·모드·텍스트를 바꾸면 인식은 그대로 두고 바로 다시 맞춤
  ["oMin", "oPad", "oJoin"].forEach(function (id) {
    $(id).value = load(id, $(id).value);
    $(id).addEventListener("change", function () { save(id, this.value); realign(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll("input[name=mode]"), function (r) {
    if (r.value === load("mode", "same")) r.checked = true;
    r.addEventListener("change", function () { save("mode", this.value); realign(); });
  });
  $("lang").value = load("lang", "ko");
  $("lang").addEventListener("change", function () { save("lang", this.value); });
  $("model").addEventListener("change", function () { save("model", this.value); checkTools(); });
  $("btnRealign").addEventListener("click", realign);

  function renderResult() {
    var box = $("result"); box.innerHTML = "";
    var r = state.result;
    $("resultWrap").style.display = r ? "block" : "none";
    if (!r) return;
    r.items.forEach(function (it, k) {
      var d = document.createElement("div");
      d.className = "row " + (it.how === "match" ? "m" : it.how === "order" ? "o" : "g");
      d.innerHTML = '<span class="no"></span><span class="tm"></span><span class="tx"></span>';
      d.querySelector(".no").textContent = k + 1;
      d.querySelector(".tm").textContent = fmt(it.start) + "–" + fmt(it.end);
      d.querySelector(".tx").textContent = it.text.replace(/\|/g, " ⏎ ");
      d.title = it.how === "match" ? "대사와 일치 " + Math.round(it.score * 100) + "%" : it.how === "guess" ? "대사에서 못 찾아 앞뒤 사이에 추정 배치" : "번역 모드: 순서·길이로 배치";
      d.addEventListener("click", function () { host("MS_seek(" + it.start.toFixed(3) + ")"); });
      box.appendChild(d);
    });
    $("heard").textContent = r.recognized || "(인식된 대사 없음)";
    updateButtons();
  }

  // ---------- 4) 넣기 ----------
  function stamp() {
    var d = new Date(), p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function saveSRT() {
    return host("MS_projectDir()").then(function (r) {
      var o = parseHost(r);
      var dir = o.ok ? E.path.join(o.dir, "monoSync") : E.path.join(E.home, "Documents", "monoSync");
      var nm = ((state.seq || (o.ok ? o.name : "") || "자막").replace(/\.prproj$/i, "").replace(/[\/\\:*?"<>|]/g, "_")) + "_" + stamp() + ".srt";
      return E.writeText(E.path.join(dir, nm), "﻿" + A.toSRT(state.result.items));
    });
  }
  $("btnSave").addEventListener("click", function () {
    if (!state.result) return;
    saveSRT().then(function (f) { status("SRT 저장: " + f, "ok"); }).catch(function (e) { status("저장 실패: " + e.message, "err"); });
  });
  $("btnInsert").addEventListener("click", function () {
    if (!state.result) return;
    setBusy(true);
    saveSRT().then(function (f) {
      return host("MS_addCaptions('" + encodeURIComponent(f) + "')").then(function (r) {
        var o = parseHost(r);
        setBusy(false);
        if (o.ok) status("캡션 트랙에 자막 " + state.result.items.length + "개를 넣었어요. 트랙 스타일을 고르면 내 폰트·박스가 적용돼요.", "ok");
        else status(o.reason + "\n(SRT: " + f + ")", "err");
      });
    }).catch(function (e) { setBusy(false); status("넣기 실패: " + e.message, "err"); });
  });

  function updateButtons() {
    if (state.busy) return;
    $("btnRun").disabled = !(lines().length && state.clips.length);
    $("btnInsert").disabled = $("btnSave").disabled = !state.result;
  }

  $("btnHelp").addEventListener("click", function () { var h = $("help"); h.style.display = h.style.display === "block" ? "none" : "block"; });
  $("btnHeard").addEventListener("click", function () { var h = $("heard"); h.style.display = h.style.display === "block" ? "none" : "block"; });
  $("btnClearCache").addEventListener("click", function () { E.clearCache(); status("저장해 둔 인식 결과를 지웠어요. 다음엔 새로 들어요."); });

  // ---------- 업데이트 ----------
  function initUpdater() {
    if (!U) return;
    $("ver").textContent = "v" + U.localVersion();
    if (!U.isAuto()) return;
    U.check(function (m) { $("upd").textContent = m; }).then(function (r) {
      if (r.status === "updated") {
        $("upd").textContent = "v" + r.version + " 업데이트 완료" + (r.needsRestart ? " — 프리미어를 다시 켜 주세요." : "");
        if (!r.needsRestart) setTimeout(function () { location.reload(); }, 1200);
      } else if (r.status === "pinned") $("upd").textContent = "버전 고정됨 (v" + r.version + ")";
      else $("upd").textContent = "";
    }).catch(function () { $("upd").textContent = ""; });
  }

  // ---------- 시작 ----------
  $("text").value = load("text", "");
  updateCount(); renderClips(); checkTools(); initUpdater(); updateButtons();
})();
