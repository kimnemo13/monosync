/* monoSync — 대사(음성 인식 결과)와 사용자 자막 텍스트 맞추기
 *
 * 입력
 *   words : [{t0, t1, text}]   음성 인식 단어들 (타임라인 기준 초, 시간순)
 *   lines : ["자막1", "자막2", ...]   사용자가 준 자막 (한 줄 = 자막 하나, "|" = 자막 안 줄바꿈)
 *   opt   : {mode:"same"|"translate", minDur, padEnd, joinGap, gapFrame}
 * 출력
 *   {items:[{i, text, start, end, score, how}], overall, recognized}
 *     how: "match"(대사와 일치) | "guess"(앞뒤 사이에 추정) | "order"(번역 모드: 순서·길이로 배치)
 *
 * same(같은 말) 모드: 글자 단위 정렬(Needleman-Wunsch 변형).
 *   - 자막 글자는 되도록 인식 글자와 짝을 짓고, 인식 쪽 남는 글자(자막 안 단 대사, 잡음)는 싸게 건너뛴다.
 * translate(번역 자막) 모드: 말소리 구간을 이어 붙인 '말한 시간' 위에 자막을 글자 수 비율로 나눠 놓고,
 *   경계를 가까운 숨 쉬는 틈(무음)에 붙인다.
 */
(function (root) {
  "use strict";

  var WORDCH = /[\p{L}\p{N}]/u;

  function normChars(s) {
    var out = [];
    var arr = Array.from(String(s).normalize("NFC").toLowerCase());
    for (var i = 0; i < arr.length; i++) if (WORDCH.test(arr[i])) out.push(arr[i]);
    return out;
  }

  function cleanLine(s) { return String(s).replace(/\s+/g, " ").trim(); }

  // 텍스트 → 자막 목록. 빈 줄 무시, 앞쪽 번호("1." "1)" "#1")와 SRT 시간줄은 지움.
  function parseLines(text) {
    var raw = String(text || "").replace(/\r\n?/g, "\n").split("\n"), out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i].trim();
      if (!s) continue;
      if (/^\d+$/.test(s)) continue;                                   // SRT 번호
      if (/-->/.test(s) && /\d\d:\d\d/.test(s)) continue;             // SRT 시간
      if (!normChars(s).length) continue;                              // 글자·숫자가 없는 줄(보이지 않는 문자만 있는 줄 등)
      out.push(cleanLine(s));
    }
    return out;
  }

  // ---------- 같은 말 모드 ----------
  var SC_MATCH = 20, SC_MIS = -10, SC_SKIP_A = -10, SC_SKIP_B = -3;

  function alignSame(words, lines) {
    // A: 자막 글자
    var A = [], lineOf = [];
    for (var li = 0; li < lines.length; li++) {
      var cs = normChars(lines[li].replace(/\|/g, " "));
      for (var k = 0; k < cs.length; k++) { A.push(cs[k]); lineOf.push(li); }
    }
    // B: 인식 글자 + 시간
    var B = [], bt0 = [], bt1 = [];
    for (var w = 0; w < words.length; w++) {
      var wc = normChars(words[w].text), n = wc.length;
      for (var c = 0; c < n; c++) {
        B.push(wc[c]);
        bt0.push(words[w].t0 + (words[w].t1 - words[w].t0) * c / n);
        bt1.push(words[w].t0 + (words[w].t1 - words[w].t0) * (c + 1) / n);
      }
    }
    var n = A.length, m = B.length;
    if (!n) throw new Error("자막 텍스트에 글자가 없어요.");
    if (!m) throw new Error("대사가 인식되지 않았어요. 선택한 클립에 말소리가 있는지 확인해 주세요.");
    if (n * m > 200e6) throw new Error("한 번에 맞추기엔 너무 길어요(자막 " + n + "자 × 대사 " + m + "자). 클립을 나눠서 해 주세요.");

    // 점수는 두 줄만, 되짚기(방향)는 전체 저장. 0=대각, 1=위(A 건너뜀), 2=왼쪽(B 건너뜀)
    var W = m + 1;
    var prev = new Int32Array(W), cur = new Int32Array(W);
    var dir = new Uint8Array((n + 1) * W);
    for (var j = 0; j <= m; j++) { prev[j] = 0; dir[j] = 2; }        // 앞쪽 인식 글자 건너뛰기는 공짜
    for (var i = 1; i <= n; i++) {
      cur[0] = prev[0] + SC_SKIP_A; dir[i * W] = 1;
      var ai = A[i - 1], row = i * W, last = (i === n);
      for (j = 1; j <= m; j++) {
        var d = prev[j - 1] + (ai === B[j - 1] ? SC_MATCH : SC_MIS);
        var u = prev[j] + SC_SKIP_A;
        var l = cur[j - 1] + (last ? 0 : SC_SKIP_B);                    // 뒤쪽 인식 글자 건너뛰기도 공짜
        if (d >= u && d >= l) { cur[j] = d; dir[row + j] = 0; }
        else if (u >= l) { cur[j] = u; dir[row + j] = 1; }
        else { cur[j] = l; dir[row + j] = 2; }
      }
      var t = prev; prev = cur; cur = t;
    }
    // 되짚기
    var pairA = new Int32Array(n).fill(-1), strong = new Uint8Array(n);
    i = n; j = m;
    while (i > 0 && j >= 0) {
      if (j === 0) { i--; continue; }
      var dd = dir[i * W + j];
      if (dd === 0) { pairA[i - 1] = j - 1; strong[i - 1] = (A[i - 1] === B[j - 1]) ? 1 : 0; i--; j--; }
      else if (dd === 1) i--;
      else j--;
    }

    // 줄별 시간
    var items = [], totStrong = 0;
    var first = 0;
    for (li = 0; li < lines.length; li++) {
      var last2 = first;
      while (last2 < n && lineOf[last2] === li) last2++;
      var len = last2 - first, s0 = Infinity, e0 = -Infinity, s1 = Infinity, e1 = -Infinity, ns = 0, nw = 0;
      for (var q = first; q < last2; q++) {
        var b = pairA[q];
        if (b < 0) continue;
        nw++; s1 = Math.min(s1, bt0[b]); e1 = Math.max(e1, bt1[b]);
        if (strong[q]) { ns++; s0 = Math.min(s0, bt0[b]); e0 = Math.max(e0, bt1[b]); }
      }
      totStrong += ns;
      var score = len ? ns / len : 0;
      var it = { i: li, text: lines[li], score: score, how: "guess", start: null, end: null };
      if (ns >= 1 && score >= 0.25) { it.start = s0; it.end = e0; it.how = "match"; }
      items.push(it);
      first = last2;
    }
    fillGuesses(items, words);
    return { items: items, overall: totStrong / n };
  }

  // 못 맞춘 줄: 앞뒤로 맞춘 줄 사이에서, 음성이 있는 구간(음성 클립)만 이어 붙인 시간 위에 글자 수 비율로 나눔
  var REGIONS = null;   // run()이 opt.regions로 넣어 줌: [{t0,t1}] 시간순, 겹침 없음
  function regionsIn(from, to) {
    var out = [];
    ((VOICED && VOICED.length ? VOICED : REGIONS) || []).forEach(function (r) { var a = Math.max(r.t0, from), b = Math.min(r.t1, to); if (b - a > 0.05) out.push({ t0: a, t1: b }); });
    return out;
  }
  function fillGuesses(items, words) {
    var T0 = REGIONS && REGIONS.length ? REGIONS[0].t0 : (words.length ? words[0].t0 : 0);
    var T1 = REGIONS && REGIONS.length ? REGIONS[REGIONS.length - 1].t1 : (words.length ? words[words.length - 1].t1 : 1);
    var k = 0;
    while (k < items.length) {
      if (items[k].how === "match") { k++; continue; }
      var a = k; while (k < items.length && items[k].how !== "match") k++;
      var from = a > 0 ? items[a - 1].end : T0, to = k < items.length ? items[k].start : T1;
      var segs = regionsIn(from, to);
      if (!segs.length) {                                   // 사이에 음성 구간이 없음 → 앞 자막 끝/뒤 자막 시작 근처 음성 구간에 붙임
        var near = (REGIONS || []).filter(function (r) { return r.t1 > from - 0.01; })[0];
        segs = near ? [{ t0: Math.max(near.t0, from), t1: near.t1 }] : [{ t0: from, t1: Math.max(to, from + 1.5 * (k - a)) }];
      }
      var total = segs.reduce(function (x, r) { return x + (r.t1 - r.t0); }, 0);
      var wts = [], wsum = 0, x;
      for (x = a; x < k; x++) { var w = Math.max(2, normChars(items[x].text).length); wts.push(w); wsum += w; }
      // 말한 시간 좌표 s → 실제 시간 (구간 사이 틈은 건너뜀)
      var toReal = function (sp, preferStart) {
        var acc = 0;
        for (var i = 0; i < segs.length; i++) {
          var len = segs[i].t1 - segs[i].t0;
          if (sp < acc + len - 1e-9 || (!preferStart && sp <= acc + len + 1e-9) || i === segs.length - 1) return segs[i].t0 + Math.min(len, Math.max(0, sp - acc));
          acc += len;
        }
        return segs[segs.length - 1].t1;
      };
      var cum = 0;
      for (x = a; x < k; x++) {
        var d = total * wts[x - a] / wsum;
        items[x].start = toReal(cum, true); items[x].end = toReal(cum + d, false); cum += d;
        if (items[x].end <= items[x].start) items[x].end = items[x].start + 0.3;
      }
    }
  }

  // ---------- 번역 자막 모드 ----------
  function speechRegions(words, gap) {
    var r = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!normChars(w.text).length) continue;
      if (r.length && w.t0 - r[r.length - 1].t1 < gap) r[r.length - 1].t1 = Math.max(r[r.length - 1].t1, w.t1);
      else r.push({ t0: w.t0, t1: w.t1 });
    }
    return r;
  }

  function alignTranslate(words, lines) {
    var R = speechRegions(words, 0.35);
    if (!R.length) throw new Error("대사가 인식되지 않았어요. 선택한 클립에 말소리가 있는지 확인해 주세요.");
    var items = [], i;
    if (R.length === lines.length) {                                  // 말 덩어리 수 = 자막 수 → 1:1
      for (i = 0; i < lines.length; i++) items.push({ i: i, text: lines[i], start: R[i].t0, end: R[i].t1, score: 1, how: "order" });
      return { items: items, overall: 1 };
    }
    // 말한 시간 누적 좌표
    var cum = [0];
    for (i = 0; i < R.length; i++) cum.push(cum[i] + (R[i].t1 - R[i].t0));
    var S = cum[R.length];
    var wts = lines.map(function (l) { return Math.max(2, normChars(l).length); });
    var W = wts.reduce(function (a, b) { return a + b; }, 0);
    var bnd = [0], acc = 0;
    for (i = 0; i < lines.length; i++) { acc += wts[i]; bnd.push(S * acc / W); }
    // 경계를 가까운 무음 틈에 붙이기 (말 덩어리 경계 = cum[1..R-1])
    var tol = Math.min(1.5, 0.45 * S / lines.length), used = {};
    var raw = bnd.slice();
    bnd[0] = { s: 0, r: 0 };
    for (i = 1; i < lines.length; i++) {
      var best = -1, bd = Infinity, prevS = bnd[i - 1].s;
      for (var r = 1; r < R.length; r++) {
        var d = Math.abs(cum[r] - raw[i]);
        if (d < bd && !used[r] && cum[r] > prevS) { bd = d; best = r; }
      }
      if (best > 0 && bd <= tol) { used[best] = 1; bnd[i] = { s: cum[best], r: best }; }
      else bnd[i] = { s: Math.max(raw[i], prevS + 0.2), r: -1 };
    }
    bnd[lines.length] = { s: S, r: R.length };
    function toReal(s, preferStart) {
      for (var r2 = 0; r2 < R.length; r2++) {
        if (s < cum[r2 + 1] || (s === cum[r2 + 1] && !preferStart) || r2 === R.length - 1)
          return R[r2].t0 + Math.max(0, Math.min(s - cum[r2], R[r2].t1 - R[r2].t0));
      }
      return R[R.length - 1].t1;
    }
    for (i = 0; i < lines.length; i++) {
      var a = bnd[i], b = bnd[i + 1];
      var st = a.r >= 0 && a.r < R.length && Math.abs(a.s - cum[a.r]) < 1e-9 ? R[a.r].t0 : toReal(a.s, true);
      var en = b.r > 0 && Math.abs(b.s - cum[b.r]) < 1e-9 ? R[b.r - 1].t1 : toReal(b.s, false);
      items.push({ i: i, text: lines[i], start: st, end: Math.max(en, st + 0.3), score: (a.r >= 0 && b.r >= 0) ? 0.8 : 0.5, how: "order" });
    }
    return { items: items, overall: 1 };
  }

  // ---------- 다듬기 ----------
  function polish(items, opt) {
    var minDur = opt.minDur != null ? opt.minDur : 0.8;
    var padEnd = opt.padEnd != null ? opt.padEnd : 0.15;
    var joinGap = opt.joinGap != null ? opt.joinGap : 0.5;
    var gapF = opt.gapFrame != null ? opt.gapFrame : 0.04;
    items.sort(function (a, b) { return a.start - b.start || a.i - b.i; });
    for (var i = 0; i < items.length; i++) {
      var it = items[i], nx = items[i + 1];
      var limit = nx ? nx.start - gapF : Infinity;
      if (it.start < 0) it.start = 0;
      it.end = Math.min(it.end + padEnd, limit);
      if (it.end - it.start < minDur) it.end = Math.min(it.start + minDur, limit);
      if (nx && nx.start - it.end < joinGap && nx.start - it.end > 0) it.end = limit;
      if (it.end <= it.start) it.end = it.start + 0.2;              // 겹칠 정도로 붙은 경우 최소 길이
    }
    return items;
  }

  function mergeRegions(rs) {
    if (!rs || !rs.length) return null;
    var a = rs.map(function (r) { return { t0: r.t0, t1: r.t1 }; }).sort(function (x, y) { return x.t0 - y.t0; }), out = [a[0]];
    for (var i = 1; i < a.length; i++) { var l = out[out.length - 1]; if (a[i].t0 <= l.t1 + 0.02) l.t1 = Math.max(l.t1, a[i].t1); else out.push(a[i]); }
    return out;
  }
  // 자막을 음성 구간(음성 클립) 안에만 두기: 가장 많이 겹치는 구간으로, 없으면 가장 가까운 구간으로
  function clampToRegions(items, opt) {
    if (!REGIONS || !REGIONS.length) return items;
    var pad = opt.padEnd != null ? opt.padEnd : 0.15;
    items.forEach(function (it) {
      var best = null, bo = 0, bd = Infinity;
      REGIONS.forEach(function (r) {
        var ov = Math.min(r.t1, it.end) - Math.max(r.t0, it.start);
        if (ov > bo) { bo = ov; best = r; }
        var dist = it.end < r.t0 ? r.t0 - it.end : it.start > r.t1 ? it.start - r.t1 : 0;
        if (bo <= 0 && dist < bd) { bd = dist; if (!best || bo <= 0) best = r; }
      });
      if (!best) return;
      var dur = it.end - it.start;
      if (bo <= 0) {                                      // 음성 없는 곳에 있었음 → 그 구간 안으로 옮김
        if (it.end <= best.t0) { it.start = best.t0; it.end = best.t0 + Math.min(dur, best.t1 - best.t0); }
        else { it.end = best.t1; it.start = Math.max(best.t0, best.t1 - dur); }
        it.moved = true;
      } else {
        if (it.start < best.t0) it.start = best.t0;
        if (it.end > best.t1 + pad) it.end = best.t1 + pad;
      }
    });
    items.sort(function (a, b) { return a.start - b.start || a.i - b.i; });
    for (var k = 0; k < items.length - 1; k++) if (items[k].end > items[k + 1].start) items[k].end = Math.max(items[k].start + 0.1, items[k + 1].start);
    return items;
  }

  // 자막 시작을 실제 말소리 시작에, 끝을 실제 말소리 끝에 붙임 (VOICED: 음성 에너지로 찾은 말소리 구간)
  var VOICED = null;
  function snapToVoice(items) {
    if (!VOICED || !VOICED.length) return items;
    var V = VOICED;
    function inside(t) { for (var i = 0; i < V.length; i++) if (V[i].t0 <= t && t < V[i].t1) return V[i]; return null; }
    items.forEach(function (it) {
      var s = it.start, e = it.end, v = inside(s), i;
      if (v) { if (s - v.t0 <= 0.5) s = v.t0; }                       // 말하는 중에 시작 → 0.5초 안에 말이 시작됐으면 그 시작점으로
      else {                                                         // 조용한 곳에서 시작 → 다음 말소리 시작으로
        var moved = false;
        for (i = 0; i < V.length; i++) if (V[i].t0 >= s && V[i].t0 < e) { s = V[i].t0; moved = true; break; }
        if (!moved) for (i = V.length - 1; i >= 0; i--) if (V[i].t1 > s - 0.4 && V[i].t0 < s) { s = Math.max(V[i].t0, s - 0.4); break; }
      }
      var w = inside(e - 0.001);
      if (w) { if (w.t1 - e <= 0.5) e = w.t1; }                       // 말하는 중에 끝 → 0.5초 안에 말이 끝나면 거기까지
      else { for (i = V.length - 1; i >= 0; i--) if (V[i].t1 <= e && V[i].t1 > s) { e = V[i].t1; break; } }   // 조용한 곳에서 끝 → 직전 말소리 끝
      if (e - s < 0.2) e = s + 0.2;
      it.start = s; it.end = e;
    });
    items.sort(function (a, b) { return a.start - b.start || a.i - b.i; });
    for (var k = 0; k < items.length - 1; k++) if (items[k].end > items[k + 1].start) items[k].end = Math.max(items[k].start + 0.1, items[k + 1].start);
    return items;
  }

  function run(words, lines, opt) {
    opt = opt || {};
    REGIONS = mergeRegions(opt.regions);
    VOICED = mergeRegions(opt.voiced);
    words = (words || []).filter(function (w) { return w && isFinite(w.t0) && isFinite(w.t1); })
      .sort(function (a, b) { return a.t0 - b.t0; });
    var res = opt.mode === "translate" ? alignTranslate(words, lines) : alignSame(words, lines);
    res.items = clampToRegions(polish(snapToVoice(res.items), opt), opt);
    res.recognized = words.map(function (w) { return w.text; }).join("").replace(/\s+/g, " ").trim();
    return res;
  }

  // ---------- SRT ----------
  function ts(sec) {
    var ms = Math.max(0, Math.round(sec * 1000));
    var h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    function p(x, n) { x = String(x); while (x.length < n) x = "0" + x; return x; }
    return p(h, 2) + ":" + p(mi, 2) + ":" + p(s, 2) + "," + p(r, 3);
  }
  function toSRT(items) {
    return items.map(function (it, k) {
      var txt = it.text.split("|").map(function (s) { return s.trim(); }).filter(Boolean).join("\n");
      return (k + 1) + "\n" + ts(it.start) + " --> " + ts(it.end) + "\n" + txt + "\n";
    }).join("\n");
  }

  // whisper-cli -oj 결과(JSON) → 단어 목록. offsetSec/speed로 타임라인 시간으로 바꿈
  function wordsFromWhisper(json, offsetSec, speed) {
    speed = speed || 1;
    var tr = (json && json.transcription) || [], out = [];
    for (var i = 0; i < tr.length; i++) {
      var t = tr[i].text || "";
      if (/^\s*\[.*\]\s*$/.test(t) || /^\s*\(.*\)\s*$/.test(t)) continue;   // [음악] (웃음) 같은 표시
      if (!normChars(t).length) continue;
      out.push({ t0: offsetSec + tr[i].offsets.from / 1000 / speed, t1: offsetSec + tr[i].offsets.to / 1000 / speed, text: t });
    }
    return out;
  }

  var api = { run: run, parseLines: parseLines, toSRT: toSRT, ts: ts, wordsFromWhisper: wordsFromWhisper, normChars: normChars };
  // 프리미어 패널은 Node 기능이 켜져 있어 module도 있으므로, 화면(window)에는 항상 따로 걸어 둔다
  if (typeof window !== "undefined") window.MSAlign = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
