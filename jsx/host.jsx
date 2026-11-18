// monoSync — Premiere Pro 호스트 스크립트 (ExtendScript / ES3)
//
// 흐름: 자막 텍스트 → 자막 넣을 V트랙 + 음성 A트랙 선택 → 싱크
//   MS_seqInfo()                          시퀀스 트랙 목록·인아웃
//   MS_trackClips(aIdx, from, to)         음성 트랙에서 범위 안 클립들의 원본 파일·구간
//   MS_countRange(vIdx, from, to)         자막 트랙에서 범위 안 기존 클립 수
//   MS_removeRange(vIdx, from, to)        범위 안 기존 클립 지우기
//   MS_place(mogrt, vIdx, s, e, text)     템플릿(.mogrt)을 s초에 올리고 길이·글자 맞춤 (비동기면 pending)
//   MS_fill(vIdx, s, e, text)             pending 된 클립을 찾아 길이·글자 맞춤
//   MS_removeAt(vIdx, starts)             방금 넣은 자막 지우기(되돌리기)
//   MS_addCaptions(srt)                   캡션 트랙으로 넣기(대안)
// ※ 한글은 evalScript 브릿지에서 깨질 수 있어 encodeURIComponent로 주고받는다.
// ※ ES3: var만, JSON 객체 없음. 모든 함수는 JSON "문자열"을 돌려준다.

var MS_TPS = 254016000000;
function MS_q(s) { return '"' + encodeURIComponent(String(s)) + '"'; }
function MS_fail(why) { return '{"ok":false,"reason":' + MS_q(why) + '}'; }
function MS_time(sec) { var t = new Time(); t.seconds = sec; return t; }
function MS_seq() { return app.project.activeSequence; }

// ---------- 시퀀스 정보 ----------
function MS_seqInfo() {
    try {
        var seq = MS_seq();
        if (!seq) return MS_fail("열려 있는 시퀀스가 없어요.");
        var v = [], a = [], i;
        for (i = 0; i < seq.videoTracks.numTracks; i++) v.push('{"i":' + i + ',"name":' + MS_q(seq.videoTracks[i].name) + ',"n":' + seq.videoTracks[i].clips.numItems + '}');
        for (i = 0; i < seq.audioTracks.numTracks; i++) a.push('{"i":' + i + ',"name":' + MS_q(seq.audioTracks[i].name) + ',"n":' + seq.audioTracks[i].clips.numItems + '}');
        var inS = 0, outS = 0, endS = 0;
        try { endS = parseFloat(seq.end) / MS_TPS; } catch (e0) {}
        try { inS = seq.getInPointAsTime().seconds; outS = seq.getOutPointAsTime().seconds; }
        catch (e1) { try { inS = parseFloat(seq.getInPoint()); outS = parseFloat(seq.getOutPoint()); } catch (e2) {} }
        var hasIO = (outS > inS + 0.05) && !(inS < 0.01 && Math.abs(outS - endS) < 0.05);
        var ph = 0; try { ph = parseFloat(seq.getPlayerPosition().ticks) / MS_TPS; } catch (e3) {}
        var tpf = 0; try { tpf = parseFloat(seq.timebase) || 0; } catch (e4) {}
        return '{"ok":true,"seq":' + MS_q(seq.name) + ',"id":' + MS_q(seq.sequenceID) + ',"v":[' + v.join(",") + '],"a":[' + a.join(",") +
            '],"in":' + inS + ',"out":' + outS + ',"end":' + endS + ',"hasIO":' + hasIO + ',"ph":' + ph + ',"tpf":' + tpf + '}';
    } catch (e) { return MS_fail("시퀀스 읽기 실패: " + e); }
}

function MS_overlap(c, from, to) { return c.end.seconds > from + 0.001 && c.start.seconds < to - 0.001; }

// ---------- 음성 트랙 클립 ----------
function MS_trackClips(aIdx, from, to) {
    try {
        var seq = MS_seq();
        if (!seq) return MS_fail("열려 있는 시퀀스가 없어요.");
        if (aIdx < 0 || aIdx >= seq.audioTracks.numTracks) return MS_fail("음성 트랙 A" + (aIdx + 1) + "이 없어요.");
        var cl = seq.audioTracks[aIdx].clips, out = [], skipped = 0;
        for (var i = 0; i < cl.numItems; i++) {
            var c = cl[i];
            if (!MS_overlap(c, from, to)) continue;
            var dis = false; try { dis = c.disabled ? true : false; } catch (eD) {}
            var path = ""; try { path = String(c.projectItem.getMediaPath()); } catch (eP) {}
            if (dis || !path) { skipped++; continue; }
            var speed = 1, rev = false;
            try { speed = c.getSpeed() || 1; } catch (eS) {}
            try { rev = c.isSpeedReversed() ? true : false; } catch (eR) {}
            out.push('{"name":' + MS_q(c.name) + ',"path":' + MS_q(path) + ',"start":' + c.start.seconds + ',"end":' + c.end.seconds +
                ',"inPoint":' + c.inPoint.seconds + ',"outPoint":' + c.outPoint.seconds + ',"speed":' + speed + ',"reversed":' + rev + '}');
        }
        return '{"ok":true,"clips":[' + out.join(",") + '],"skipped":' + skipped + '}';
    } catch (e) { return MS_fail("음성 트랙 읽기 실패: " + e); }
}

// ---------- 자막 트랙 범위 ----------
function MS_vtrack(vIdx) {
    var seq = MS_seq();
    if (!seq || vIdx < 0 || vIdx >= seq.videoTracks.numTracks) return null;
    return seq.videoTracks[vIdx];
}
function MS_countRange(vIdx, from, to) {
    try {
        var tr = MS_vtrack(vIdx); if (!tr) return MS_fail("트랙 없음");
        var n = 0;
        for (var i = 0; i < tr.clips.numItems; i++) if (MS_overlap(tr.clips[i], from, to)) n++;
        return '{"ok":true,"n":' + n + '}';
    } catch (e) { return MS_fail(String(e)); }
}
function MS_removeRange(vIdx, from, to) {
    try {
        var tr = MS_vtrack(vIdx); if (!tr) return MS_fail("트랙 없음");
        var n = 0;
        for (var i = tr.clips.numItems - 1; i >= 0; i--) {
            var c = tr.clips[i];
            if (MS_overlap(c, from, to)) { try { c.remove(false, false); n++; } catch (e1) {} }
        }
        return '{"ok":true,"n":' + n + '}';
    } catch (e) { return MS_fail(String(e)); }
}
// starts: "12.345,15.2,..." — 그 시작 시간에 있는 클립 지우기
function MS_removeAt(vIdx, starts) {
    try {
        var tr = MS_vtrack(vIdx); if (!tr) return MS_fail("트랙 없음");
        var list = String(starts).split(","), n = 0;
        for (var i = tr.clips.numItems - 1; i >= 0; i--) {
            var c = tr.clips[i], s = c.start.seconds;
            for (var k = 0; k < list.length; k++) {
                if (list[k] !== "" && Math.abs(parseFloat(list[k]) - s) < 0.02) { try { c.remove(false, false); n++; } catch (e1) {} break; }
            }
        }
        return '{"ok":true,"n":' + n + '}';
    } catch (e) { return MS_fail(String(e)); }
}

// ---------- 그래픽 글자 쓰기 (monoShorts 줄바꿈 코드 기반) ----------
// raw 값 안의 JSON 문자열을 해독. q = 여는 따옴표 다음 위치. {text, start, end}
function MS_decodeStr(raw, q) {
    var text = "", i = q;
    while (i < raw.length) {
        var ch = raw.charAt(i);
        if (ch === '"') return { text: text, start: q, end: i };
        if (ch === "\\") {
            var n = raw.charAt(i + 1), len = 2, dec;
            if (n === "n") dec = "\n"; else if (n === "r") dec = "\r"; else if (n === "t") dec = "\t";
            else if (n === "u") { dec = String.fromCharCode(parseInt(raw.substr(i + 2, 4), 16)); len = 6; }
            else dec = n;
            text += dec; i += len;
        } else { text += ch; i++; }
    }
    return null;
}
// 형식 A(프리미어 텍스트): "mText":"..." / 형식 B(모션 그래픽 템플릿): "textEditValue":"..."
function MS_findField(raw) {
    var re = /"(textEditValue|mText|mTextString)"\s*:\s*"/g, m;
    while ((m = re.exec(raw)) !== null) {
        var d = MS_decodeStr(raw, m.index + m[0].length);
        if (d) { d.key = m[1]; return d; }
    }
    return null;
}
function MS_utf8len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } else n += 3;
    }
    return n;
}
// 값 맨 앞 4바이트 머리말이 '뒤따르는 길이'면 새 길이로 (글자 수 또는 UTF-8 바이트 수 — 원본과 같은 방식으로)
function MS_fixPrefix(oldRaw, newRaw) {
    if (oldRaw.indexOf("{") !== 4 || newRaw.indexOf("{") !== 4) return newRaw;
    var c = [], k;
    for (k = 0; k < 4; k++) c.push(oldRaw.charCodeAt(k) & 255);
    var be = ((c[0] * 256 + c[1]) * 256 + c[2]) * 256 + c[3], le = ((c[3] * 256 + c[2]) * 256 + c[1]) * 256 + c[0];
    var oBody = oldRaw.substring(4), nBody = newRaw.substring(4), val = -1, big = true;
    if (be === oBody.length) { val = nBody.length; big = true; }
    else if (le === oBody.length) { val = nBody.length; big = false; }
    else if (be === MS_utf8len(oBody)) { val = MS_utf8len(nBody); big = true; }
    else if (le === MS_utf8len(oBody)) { val = MS_utf8len(nBody); big = false; }
    else return newRaw;
    var b = [(val >>> 24) & 255, (val >>> 16) & 255, (val >>> 8) & 255, val & 255];
    if (!big) b.reverse();
    return String.fromCharCode(b[0], b[1], b[2], b[3]) + nBody;
}
function MS_jsonEsc(s, br) {
    var o = "";
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch === "\\") o += "\\\\";
        else if (ch === '"') o += '\\"';
        else if (ch === "\n") o += br;
        else if (ch === "\t") o += " ";
        else o += ch;
    }
    return o;
}
// 스타일 구간 길이 합을 새 글자 수에 맞춤 (형식 B)
function MS_fixRuns(raw, newLen) {
    var m = raw.match(/"fontTextRunLength"\s*:\s*\[([0-9,\s]*)\]/);
    if (!m) return raw;
    var arr = m[1].split(","), sum = 0, k;
    for (k = 0; k < arr.length; k++) { arr[k] = parseInt(arr[k], 10) || 0; sum += arr[k]; }
    var diff = newLen - sum;
    for (k = arr.length - 1; k >= 0 && diff !== 0; k--) {
        var nv = arr[k] + diff;
        if (nv >= (k === 0 ? 0 : 1) || k === 0) { arr[k] = Math.max(0, nv); diff = 0; }
        else { diff += arr[k] - 1; arr[k] = 1; }
    }
    return raw.replace(m[0], '"fontTextRunLength":[' + arr.join(",") + "]");
}
function MS_norm(s) { return String(s).replace(/\r\n?/g, "\n"); }

// clip의 글자를 text로 바꿈. 반환: "OK" 또는 실패 사유
var MS_lastDiag = "";
function MS_setClipText(clip, text) {
    var comps = [], tried = 0, why = "텍스트 칸을 못 찾음";
    try { var mgt = clip.getMGTComponent(); if (mgt) comps.push(mgt); } catch (eG) {}
    try { for (var ci = 0; ci < clip.components.numItems; ci++) comps.push(clip.components[ci]); } catch (eC) {}
    var want = MS_norm(text);
    for (var c = 0; c < comps.length; c++) {
        var props; try { props = comps[c].properties; } catch (eP) { continue; }
        for (var j = 0; j < props.numItems; j++) {
            var p = props[j], raw;
            try { raw = p.getValue(); } catch (eV) { continue; }
            if (typeof raw !== "string") continue;
            var fld = raw.length > 8 ? MS_findField(raw) : null;
            if (!fld) continue;
            tried++;
            var brs = ["\\r", "\r", "\\n"];
            for (var b = 0; b < brs.length; b++) {
                var body = MS_jsonEsc(want, brs[b]);
                var nraw = raw.substring(0, fld.start) + body + raw.substring(fld.end);
                if (fld.key === "textEditValue") nraw = MS_fixRuns(nraw, want.length);
                nraw = MS_fixPrefix(raw, nraw);
                try { p.setValue(nraw, true); } catch (eS) { why = "쓰기 실패: " + eS; continue; }
                var back = ""; try { back = String(p.getValue()); } catch (eB) {}
                var chk = MS_findField(back);
                if (chk && MS_norm(chk.text) === want) return "OK";
                why = "써도 반영이 안 됨";
                MS_lastDiag = "속성 '" + String(p.displayName) + "' 원래 값: " + raw.substring(0, 600) + "\n다시 읽은 값: " + back.substring(0, 600);
                if (want.indexOf("\n") < 0) break;          // 줄바꿈 없으면 표기법 바꿔 볼 필요 없음
            }
            try { p.setValue(raw, true); } catch (eU) {}    // 원래대로
        }
    }
    // 마지막 시도: 'Source Text' 칸에 글자만 넣기 (After Effects로 만든 템플릿)
    for (c = 0; c < comps.length; c++) {
        try {
            var ps = comps[c].properties;
            for (j = 0; j < ps.numItems; j++) {
                var dn = String(ps[j].displayName);
                if (dn === "Source Text" || dn === "소스 텍스트" || dn === "원본 텍스트") {
                    ps[j].setValue(want.replace(/\n/g, "\r"), true);
                    if (MS_norm(String(ps[j].getValue())).indexOf(want) >= 0) return "OK";
                }
            }
        } catch (eT) {}
    }
    if (!tried) MS_lastDiag = MS_clipDiag(clip);
    return why;
}
function MS_clipDiag(clip) {
    var out = [];
    try {
        var comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var ps = [], props = comps[i].properties;
            for (var j = 0; j < props.numItems && j < 20; j++) {
                var v = "?"; try { v = String(props[j].getValue()); } catch (e) {}
                ps.push(String(props[j].displayName) + "=" + v.substring(0, 80));
            }
            out.push("[" + String(comps[i].displayName) + "] " + ps.join(" · "));
        }
    } catch (e2) {}
    return out.join("\n");
}
function MS_takeDiag() { var d = MS_lastDiag; MS_lastDiag = ""; return MS_q(d); }

// ---------- 템플릿 올리기 (안전 방식: 한 번에 한 가지 일만) ----------
// 1) MS_count(v)                 자막 트랙 클립 수
// 2) MS_import(mogrt, v, s)      템플릿을 s초에 한 번만 올림 (재시도 없음)
// 3) MS_probe(v, s)              s초의 클립을 찾아 글자 칸 원래 값을 돌려줌 (없으면 pending)
// 4) MS_write(v, s, e, k, raw)   길이 맞추고 글자 칸에 한 번만 씀 → 다시 읽은 값을 돌려줌
function MS_findAt(tr, s) {
    for (var i = 0; i < tr.clips.numItems; i++) if (Math.abs(tr.clips[i].start.seconds - s) < 0.02) return tr.clips[i];
    return null;
}
function MS_count(vIdx) {
    try { var tr = MS_vtrack(vIdx); return tr ? '{"ok":true,"n":' + tr.clips.numItems + '}' : MS_fail("트랙 없음"); }
    catch (e) { return MS_fail(String(e)); }
}
function MS_saveProject() {
    try { app.project.save(); return '{"ok":true}'; } catch (e) { return MS_fail("프로젝트 저장 실패: " + e); }
}
function MS_import(mogrtEnc, vIdx, s) {
    try {
        var seq = MS_seq(); if (!seq) return MS_fail("열려 있는 시퀀스가 없어요.");
        var path = decodeURIComponent(mogrtEnc);
        if (!new File(path).exists) return MS_fail("템플릿 파일이 없어요: " + path);
        if (!MS_vtrack(vIdx)) return MS_fail("V" + (vIdx + 1) + " 트랙이 없어요.");
        seq.importMGT(path, MS_time(s).ticks, vIdx, -1);
        return '{"ok":true}';
    } catch (e) { return MS_fail("템플릿 올리기 실패: " + e); }
}
// 글자 칸 찾기: MGT 컴포넌트에서 textEditValue / mText가 든 속성
function MS_textProp(clip) {
    var mgt = null;
    try { mgt = clip.getMGTComponent(); } catch (e0) {}
    if (!mgt) return null;
    var props = mgt.properties;
    for (var j = 0; j < props.numItems; j++) {
        var raw; try { raw = props[j].getValue(); } catch (e1) { continue; }
        if (typeof raw === "string" && /"(textEditValue|mText)"\s*:/.test(raw)) return { prop: props[j], idx: j, raw: raw };
    }
    return null;
}
function MS_probe(vIdx, s) {
    try {
        var tr = MS_vtrack(vIdx); if (!tr) return MS_fail("트랙 없음");
        var clip = MS_findAt(tr, s);
        if (!clip) return '{"ok":true,"state":"pending"}';
        var tp = MS_textProp(clip);
        if (!tp) return '{"ok":true,"state":"notext","diag":' + MS_q(MS_clipDiag(clip)) + '}';
        return '{"ok":true,"state":"found","idx":' + tp.idx + ',"raw":' + MS_q(tp.raw) + ',"name":' + MS_q(tp.prop.displayName) + '}';
    } catch (e) { return MS_fail(String(e)); }
}
function MS_write(vIdx, s, e, idx, rawEnc) {
    try {
        var tr = MS_vtrack(vIdx); if (!tr) return MS_fail("트랙 없음");
        var clip = MS_findAt(tr, s); if (!clip) return MS_fail("클립을 다시 찾지 못했어요.");
        try { clip.end = MS_time(e); } catch (eE) {}
        var mgt = clip.getMGTComponent(), p = mgt.properties[idx];
        p.setValue(decodeURIComponent(rawEnc), true);
        var back = ""; try { back = String(p.getValue()); } catch (eB) {}
        return '{"ok":true,"back":' + MS_q(back) + '}';
    } catch (er) { return MS_fail("글자 쓰기 실패: " + er); }
}
function MS_removeOne(vIdx, s) {
    try {
        var tr = MS_vtrack(vIdx); if (!tr) return MS_fail("트랙 없음");
        var c = MS_findAt(tr, s); if (c) c.remove(false, false);
        return '{"ok":true}';
    } catch (e) { return MS_fail(String(e)); }
}

// ---------- 기타 ----------
function MS_seek(sec) {
    try { var seq = MS_seq(); if (!seq) return '{"ok":false}'; seq.setPlayerPosition(MS_time(sec).ticks); return '{"ok":true}'; }
    catch (e) { return MS_fail(String(e)); }
}
function MS_projectDir() {
    try {
        var p = app.project.path;
        if (!p) return '{"ok":false}';
        return '{"ok":true,"dir":' + MS_q(new File(p).parent.fsName) + ',"name":' + MS_q(app.project.name) + '}';
    } catch (e) { return '{"ok":false}'; }
}
function MS_pickMogrt() {
    try {
        var f = File.openDialog("자막 스타일 템플릿(.mogrt) 선택", "*.mogrt", false);
        return f ? '{"ok":true,"path":' + MS_q(f.fsName) + '}' : '{"ok":false}';
    } catch (e) { return MS_fail(String(e)); }
}

function MS_findByPath(bin, path) {
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) { var f = MS_findByPath(it, path); if (f) return f; }
        else { var mp = ""; try { mp = String(it.getMediaPath()); } catch (e) {} if (mp === path) return it; }
    }
    return null;
}
function MS_getBin(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var it = root.children[i];
        if (it.type === ProjectItemType.BIN && String(it.name) === name) return it;
    }
    return root.createBin(name);
}
function MS_addCaptions(pathEnc) {
    try {
        var path = decodeURIComponent(pathEnc), seq = MS_seq();
        if (!seq) return MS_fail("열려 있는 시퀀스가 없어요.");
        var bin = MS_getBin("monoSync 자막");
        app.project.importFiles([path], true, bin, false);
        var item = MS_findByPath(bin, path) || MS_findByPath(app.project.rootItem, path);
        if (!item) return MS_fail("SRT를 프로젝트로 가져오지 못했어요.");
        if (typeof seq.createCaptionTrack !== "function") return MS_fail("이 프리미어 버전은 스크립트로 캡션 트랙을 못 만들어요. 'monoSync 자막' 빈의 SRT를 타임라인에 끌어다 놓아 주세요.");
        var fmt; try { fmt = Sequence.CAPTION_FORMAT_SUBTITLE; } catch (eF) {}
        if (fmt !== undefined) seq.createCaptionTrack(item, 0, fmt); else seq.createCaptionTrack(item, 0);
        return '{"ok":true}';
    } catch (e) { return MS_fail("캡션 넣기 실패: " + e); }
}
