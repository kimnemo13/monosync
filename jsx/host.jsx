// monoSync — Premiere Pro 호스트 스크립트 (ExtendScript / ES3)
// 패널이 부르는 함수 3개:
//   MS_getSelection()      선택한 클립들의 원본 파일·구간 정보
//   MS_projectDir()        프로젝트 파일이 있는 폴더 (SRT 저장 위치)
//   MS_addCaptions(path)   SRT를 가져와 활성 시퀀스에 캡션 트랙으로 넣기
// ※ 한글이 evalScript 브릿지에서 깨질 수 있어서 문자열은 encodeURIComponent로 주고받는다.
// ※ ES3라 var만 사용. 모든 함수는 JSON "문자열"을 돌려준다.

function MS_q(s) { return '"' + encodeURIComponent(String(s)) + '"'; }
function MS_fail(why) { return '{"ok":false,"reason":' + MS_q(why) + '}'; }

// 선택한 클립 목록. 연결된 비디오/오디오 쌍은 패널에서 하나로 합친다.
function MS_getSelection() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return MS_fail("열려 있는 시퀀스가 없어요.");
        var sel = seq.getSelection();
        if (!sel || !sel.length) return MS_fail("타임라인에서 대사가 들어 있는 클립을 선택해 주세요.");
        var out = [];
        for (var i = 0; i < sel.length; i++) {
            var c = sel[i], pi = null, path = "";
            try { pi = c.projectItem; } catch (e0) {}
            try { if (pi) path = String(pi.getMediaPath()); } catch (e1) {}
            var speed = 1, rev = false;
            try { speed = c.getSpeed(); } catch (e2) {}
            try { rev = c.isSpeedReversed() ? true : false; } catch (e3) {}
            out.push('{"name":' + MS_q(c.name) +
                ',"type":' + MS_q(c.mediaType) +
                ',"path":' + MS_q(path) +
                ',"start":' + c.start.seconds +
                ',"end":' + c.end.seconds +
                ',"inPoint":' + c.inPoint.seconds +
                ',"outPoint":' + c.outPoint.seconds +
                ',"speed":' + (speed || 1) +
                ',"reversed":' + rev + '}');
        }
        return '{"ok":true,"seq":' + MS_q(seq.name) + ',"clips":[' + out.join(",") + ']}';
    } catch (e) { return MS_fail("선택 읽기 실패: " + e); }
}

// 재생헤드를 sec초로 (미리보기 목록에서 줄을 누르면 그 자막 위치로 이동)
function MS_seek(sec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false}';
        var t = new Time(); t.seconds = sec;
        seq.setPlayerPosition(t.ticks);
        return '{"ok":true}';
    } catch (e) { return MS_fail(String(e)); }
}

function MS_projectDir() {
    try {
        var p = app.project.path;
        if (!p) return '{"ok":false}';
        return '{"ok":true,"dir":' + MS_q(new File(p).parent.fsName) + ',"name":' + MS_q(app.project.name) + '}';
    } catch (e) { return '{"ok":false}'; }
}

function MS_findByPath(bin, path) {
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) {
            var f = MS_findByPath(it, path);
            if (f) return f;
        } else {
            var mp = "";
            try { mp = String(it.getMediaPath()); } catch (e) {}
            if (mp === path) return it;
        }
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

// SRT → 프로젝트로 가져와서 활성 시퀀스에 새 캡션 트랙 만들기
function MS_addCaptions(pathEnc) {
    try {
        var path = decodeURIComponent(pathEnc);
        var seq = app.project.activeSequence;
        if (!seq) return MS_fail("열려 있는 시퀀스가 없어요.");
        if (!new File(path).exists) return MS_fail("SRT 파일이 없어요: " + path);
        var bin = MS_getBin("monoSync 자막");
        app.project.importFiles([path], true, bin, false);
        var item = MS_findByPath(bin, path) || MS_findByPath(app.project.rootItem, path);
        if (!item) return MS_fail("SRT를 프로젝트로 가져오지 못했어요. 프로젝트 패널에서 직접 끌어다 놓아 주세요.");
        if (typeof seq.createCaptionTrack !== "function")
            return MS_fail("이 프리미어 버전은 스크립트로 캡션 트랙을 못 만들어요. 'monoSync 자막' 빈의 SRT를 타임라인에 끌어다 놓아 주세요.");
        var fmt;
        try { fmt = Sequence.CAPTION_FORMAT_SUBTITLE; } catch (eF) {}
        var r;
        if (fmt !== undefined) r = seq.createCaptionTrack(item, 0, fmt);
        else r = seq.createCaptionTrack(item, 0);
        return '{"ok":true,"result":' + MS_q(r) + '}';
    } catch (e) { return MS_fail("캡션 넣기 실패: " + e); }
}
