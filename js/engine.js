/* monoSync — 음성 인식 실행 (Node.js, 패널 안에서 돌아감)
 *   1) ffmpeg로 클립 구간의 소리만 16kHz 모노 wav로 뽑기
 *   2) whisper-cli(whisper.cpp)로 단어 단위 받아쓰기 (-ml 1 -sow → 단어마다 시간)
 *   3) 결과를 캐시해서, 자막 텍스트만 고쳐 다시 맞출 때는 즉시 끝나게
 * 인터넷 전송 없음 — 전부 이 맥 안에서 처리.
 */
(function () {
  "use strict";
  var req = (window.cep_node && window.cep_node.require) || window.require;
  if (!req) return;
  var fs = req("fs"), path = req("path"), os = req("os"), cp = req("child_process"), crypto = req("crypto"), zlib = req("zlib");

  var HOME = os.homedir();
  var DATA = path.join(HOME, "Library", "Application Support", "monoSync");
  var MODELS = path.join(DATA, "models");
  var CACHE = path.join(DATA, "cache");
  var BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
  var PREFERRED = ["ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo-q8_0.bin", "ggml-large-v3-turbo.bin", "ggml-large-v3.bin", "ggml-medium.bin", "ggml-small.bin"];

  function which(names) {
    for (var d = 0; d < BIN_DIRS.length; d++) for (var n = 0; n < names.length; n++) {
      var p = path.join(BIN_DIRS[d], names[n]);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
    }
    return "";
  }

  function listModels() {
    try { return fs.readdirSync(MODELS).filter(function (f) { return /^ggml-.*\.bin$/.test(f); }); } catch (e) { return []; }
  }

  function tools(preferModel) {
    var models = listModels(), model = "";
    if (preferModel && models.indexOf(preferModel) >= 0) model = preferModel;
    for (var i = 0; !model && i < PREFERRED.length; i++) if (models.indexOf(PREFERRED[i]) >= 0) model = PREFERRED[i];
    if (!model && models.length) model = models[0];
    return {
      ffmpeg: which(["ffmpeg"]),
      whisper: which(["whisper-cli", "whisper-cpp", "whisper"]),
      model: model ? path.join(MODELS, model) : "",
      models: models, modelDir: MODELS
    };
  }

  function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

  function run(bin, args, onLine) {
    return new Promise(function (resolve, reject) {
      var env = Object.assign({}, process.env, { PATH: BIN_DIRS.join(":") + ":" + (process.env.PATH || "") });
      var ch = cp.spawn(bin, args, { env: env });
      var err = "", buf = "";
      function feed(chunk) {
        buf += chunk.toString("utf8");
        var parts = buf.split(/\r?\n|\r/); buf = parts.pop();
        parts.forEach(function (l) { if (onLine) onLine(l); });
      }
      ch.stdout.on("data", feed);
      ch.stderr.on("data", function (c) { err += c.toString("utf8"); if (err.length > 20000) err = err.slice(-20000); feed(c); });
      ch.on("error", reject);
      ch.on("close", function (code) {
        if (code === 0) resolve();
        else reject(new Error(path.basename(bin) + " 실패(코드 " + code + ")\n" + err.split("\n").slice(-8).join("\n")));
      });
      run.current = ch;
    });
  }

  function cancel() { try { if (run.current) run.current.kill("SIGTERM"); } catch (e) {} }

  // 클립 하나 받아쓰기 → whisper JSON. onProgress(0~1, 문구)
  function transcribe(clip, lang, preferModel, onProgress) {
    var t = tools(preferModel);
    if (!t.ffmpeg) return Promise.reject(new Error("ffmpeg가 없어요. install-mac.command를 다시 실행해 주세요."));
    if (!t.whisper) return Promise.reject(new Error("whisper-cli가 없어요. install-mac.command를 다시 실행해 주세요."));
    if (!t.model) return Promise.reject(new Error("음성 인식 모델이 없어요. install-mac.command를 다시 실행해 주세요."));
    if (!clip.path || !fs.existsSync(clip.path)) return Promise.reject(new Error("원본 파일을 찾을 수 없어요: " + (clip.path || clip.name)));
    var st = fs.statSync(clip.path);
    var dur = Math.max(0.1, clip.outPoint - clip.inPoint);
    var key = crypto.createHash("sha1").update([clip.path, st.size, st.mtimeMs, clip.inPoint.toFixed(3), dur.toFixed(3), lang, path.basename(t.model), "v1"].join("|")).digest("hex").slice(0, 20);
    mkdirp(CACHE);
    var base = path.join(CACHE, key), jsonPath = base + ".json", wav = base + ".wav";
    if (fs.existsSync(jsonPath)) {
      try { onProgress(1, "저장해 둔 인식 결과 사용"); return Promise.resolve(JSON.parse(fs.readFileSync(jsonPath, "utf8"))); } catch (e) {}
    }
    onProgress(0, "소리 뽑는 중…");
    return run(t.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", clip.inPoint.toFixed(3), "-t", dur.toFixed(3), "-i", clip.path,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav])
      .then(function () {
        onProgress(0.02, "대사 듣는 중… 0%");
        var args = ["-m", t.model, "-f", wav, "-oj", "-of", base, "-ml", "1", "-sow", "-pp"];
        if (lang && lang !== "auto") args.push("-l", lang); else args.push("-l", "auto");
        var heard = "";
        return run(t.whisper, args, function (line) {
          var m = /progress\s*=\s*(\d+)%/.exec(line);
          if (m) onProgress(0.02 + 0.98 * (+m[1]) / 100, "대사 듣는 중… " + m[1] + "%" + (heard ? " · " + heard : ""));
          var s = /^\[\d\d:\d\d:\d\d\.\d+ --> [^\]]+\]\s*(.*)$/.exec(line);
          if (s && s[1]) { heard = (heard + s[1]).slice(-24); }
        });
      })
      .then(function () {
        try { fs.unlinkSync(wav); } catch (e) {}
        var txt = fs.readFileSync(jsonPath, "utf8");
        return JSON.parse(txt);
      }, function (e) { try { fs.unlinkSync(wav); } catch (e2) {} throw e; });
  }

  // ---------- 자막 템플릿(.mogrt) 목록 ----------
  // 프리미어 '로컬 템플릿 폴더'(내보내기 대상으로 고르면 여기 저장됨)와 monoSync 템플릿 폴더를 훑는다.
  var TPL_DIRS = [
    path.join(HOME, "Library", "Application Support", "Adobe", "Common", "Motion Graphics Templates"),
    path.join(DATA, "templates")
  ];
  var THUMBS = path.join(DATA, "thumbs");
  function listTemplates(extra) {
    var out = [], seen = {};
    function add(p) {
      if (seen[p]) return;
      try { var st = fs.statSync(p); if (!st.isFile()) return; seen[p] = 1; out.push({ path: p, name: path.basename(p).replace(/\.mogrt$/i, ""), mtime: st.mtimeMs }); } catch (e) {}
    }
    function walk(dir, depth) {
      var ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      ents.forEach(function (d) {
        var p = path.join(dir, d.name);
        if (d.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (/\.mogrt$/i.test(d.name)) add(p);
      });
    }
    TPL_DIRS.forEach(function (d) { walk(d, 0); });
    (extra || []).forEach(function (p) { if (p) add(p); });
    return out.sort(function (a, b) { return b.mtime - a.mtime; });
  }
  // 템플릿 안의 미리보기 그림(thumb.png)을 꺼내 캐시 → file 경로. 없으면 ""
  function templateThumb(p, cb) {
    try {
      var st = fs.statSync(p);
      var key = crypto.createHash("sha1").update(p + "|" + st.mtimeMs).digest("hex").slice(0, 16);
      var out = path.join(THUMBS, key + ".png");
      if (fs.existsSync(out)) return cb(out);
      mkdirp(THUMBS);
      cp.execFile("/usr/bin/unzip", ["-p", p, "thumb.png"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, function (err, buf) {
        if (err || !buf || buf.length < 100) return cb("");
        try { fs.writeFileSync(out, buf); cb(out); } catch (e) { cb(""); }
      });
    } catch (e) { cb(""); }
  }
  function openTemplateFolder() {
    var d = TPL_DIRS[0]; mkdirp(d);
    cp.execFile("/usr/bin/open", [d], function () {});
  }

  // ---------- 자막 줄마다 템플릿 만들기 ----------
  // 프리미어로 만든 템플릿은 올린 뒤 스크립트로 글자를 바꿀 수 없어서(값이 이진 형식이라 첫 0바이트에서 잘림),
  // 줄마다 글자가 이미 들어간 .mogrt를 만들어 올린다.
  //   .mogrt(zip) = definition.json + project.prgraphic(zip ⊃ gzip된 .prproj XML) + 미리보기
  //   글자는 .prproj 안 Source Text 값(base64 이진)의 맨 끝 문자열: [u32 길이][UTF-8][0][패딩], 맨 앞 u32 = 본문 길이(전체-12)
  function utf8(s) { return Buffer.from(s, "utf8"); }
  function rewriteTextBinary(buf, oldText, newText) {
    var ob = utf8(oldText), nb = utf8(newText);
    var i = buf.lastIndexOf(ob);
    if (i < 16) throw new Error("템플릿 안에서 원래 글자를 찾지 못했어요.");
    if (buf.readUInt32LE(i - 4) !== ob.length) throw new Error("템플릿 글자 구조가 예상과 달라요(길이).");
    var after = i + ob.length;
    if (Math.ceil((after + 1) / 4) * 4 !== buf.length || buf[after] !== 0) throw new Error("템플릿 글자 구조가 예상과 달라요(끝 위치).");
    if (buf.readUInt32LE(0) !== buf.length - 12 || buf.readUInt32LE(8) !== 0x11223344) throw new Error("템플릿 글자 구조가 예상과 달라요(머리말).");
    var head = Buffer.from(buf.slice(0, i - 4));
    var len = Buffer.alloc(4); len.writeUInt32LE(nb.length, 0);
    var end = (i + nb.length + 1), total = Math.ceil(end / 4) * 4;
    var out = Buffer.concat([head, len, nb, Buffer.alloc(total - end + 1)]);
    out.writeUInt32LE(out.length - 12, 0);
    return out;
  }
  function xmlEsc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function uuid() { var h = crypto.randomBytes(16).toString("hex"); return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32); }
  var baseCache = {};
  function loadBase(mogrt) {
    var st = fs.statSync(mogrt), key = crypto.createHash("sha1").update(mogrt + "|" + st.size + "|" + st.mtimeMs).digest("hex").slice(0, 12);
    if (baseCache[key]) return baseCache[key];
    var dir = path.join(DATA, "tplbase", key);
    if (!fs.existsSync(path.join(dir, "ok"))) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      mkdirp(path.join(dir, "m")); mkdirp(path.join(dir, "p"));
      cp.execFileSync("/usr/bin/unzip", ["-o", "-q", mogrt, "-d", path.join(dir, "m")]);
      cp.execFileSync("/usr/bin/unzip", ["-o", "-q", path.join(dir, "m", "project.prgraphic"), "-d", path.join(dir, "p")]);
      fs.writeFileSync(path.join(dir, "ok"), "1");
    }
    var def = JSON.parse(fs.readFileSync(path.join(dir, "m", "definition.json"), "utf8"));
    var ctl = (def.clientControls || []).filter(function (c) { return c.type === 6; })[0];
    if (!ctl) throw new Error("템플릿에 글자 칸이 없어요.");
    var oldText = ctl.value.strDB[0].str;
    var pj = fs.readdirSync(path.join(dir, "p")).filter(function (f) { return /\.prproj$/i.test(f); })[0];
    if (!pj) throw new Error("템플릿 안에 프로젝트가 없어요.");
    var xml = zlib.gunzipSync(fs.readFileSync(path.join(dir, "p", pj))).toString("utf8");
    // 원래 글자가 든 이진 값 찾기
    var re = /<StartKeyframeValue Encoding="base64"([^>]*)>([^<]+)<\/StartKeyframeValue>/g, m, hit = null, ob = utf8(oldText);
    while ((m = re.exec(xml)) !== null) {
      var b = Buffer.from(m[2].trim(), "base64");
      if (b.indexOf(ob) >= 0) { hit = { start: m.index, end: m.index + m[0].length, attrs: m[1], bin: b }; break; }
    }
    if (!hit) throw new Error("템플릿 안에서 글자 값을 찾지 못했어요.");
    rewriteTextBinary(hit.bin, oldText, "확인");                  // 구조 검사(예상과 다르면 여기서 멈춤)
    baseCache[key] = { dir: dir, def: def, oldText: oldText, pj: pj, xml: xml, hit: hit };
    return baseCache[key];
  }
  // text 한 줄짜리 .mogrt 만들기 → 경로
  //   opt.keepText: 글자는 그대로 두고 ID만 바꿈(진단용) / 바꾸는 것: 글자 값, 레이어 이름, 정의의 글자, capsuleID, 시퀀스 ID(정의·프로젝트 양쪽 똑같이)
  function makeLineTemplate(mogrt, text, outDir, n, opt) {
    opt = opt || {};
    var B = loadBase(mogrt), t = opt.keepText ? B.oldText : String(text).replace(/\r\n?|\n/g, "\r");
    var xml = B.xml;
    if (!opt.keepText) {
      var bin = rewriteTextBinary(B.hit.bin, B.oldText, t);
      var attrs = opt.keepHash ? B.hit.attrs : B.hit.attrs.replace(/\s*BinaryHash="[^"]*"/, "");   // 내용이 바뀌었으니 이전 해시는 뺌(시험: keepHash면 그대로)
      xml = xml.slice(0, B.hit.start) + '<StartKeyframeValue Encoding="base64"' + attrs + ">" + bin.toString("base64") + "</StartKeyframeValue>" + xml.slice(B.hit.end);
      xml = xml.split("<InstanceName>" + xmlEsc(B.oldText) + "</InstanceName>").join("<InstanceName>" + xmlEsc(t.replace(/\r/g, " ")) + "</InstanceName>");
    }
    var def = JSON.parse(JSON.stringify(B.def));
    def.capsuleID = uuid();
    var seqId = null; try { seqId = def.sourceInfoLocalized.en_US.id; } catch (e) {}
    if (seqId && xml.indexOf(seqId) >= 0) {                        // 템플릿 안 시퀀스 ID — 양쪽을 똑같이 바꿔야 연결이 유지됨
      var nid = uuid();
      xml = xml.split(seqId).join(nid);
      Object.keys(def.sourceInfoLocalized).forEach(function (lc) { if (def.sourceInfoLocalized[lc].id === seqId) def.sourceInfoLocalized[lc].id = nid; });
    }
    def.clientControls.forEach(function (c) { if (c.type === 6 && c.value && c.value.strDB) c.value.strDB.forEach(function (x) { x.str = t; }); });
    var work = path.join(outDir, "w" + n);
    mkdirp(path.join(work, "p"));
    fs.writeFileSync(path.join(work, "p", B.pj), zlib.gzipSync(Buffer.from(xml, "utf8")));
    fs.writeFileSync(path.join(work, "definition.json"), JSON.stringify(def));
    cp.execFileSync("/usr/bin/zip", ["-X", "-q", "-j", path.join(work, "project.prgraphic"), path.join(work, "p", B.pj)]);
    var out = path.join(outDir, (opt.keepText ? "same" : opt.tag || "line") + (n < 10 ? "00" : n < 100 ? "0" : "") + n + ".mogrt");
    try { fs.unlinkSync(out); } catch (e) {}
    var files = [];                                                  // 원본과 같은 순서·구성
    if (fs.existsSync(path.join(B.dir, "m", "thumb.mp4"))) files.push(path.join(B.dir, "m", "thumb.mp4"));
    files.push(path.join(work, "project.prgraphic"), path.join(work, "definition.json"));
    if (fs.existsSync(path.join(B.dir, "m", "thumb.png"))) files.push(path.join(B.dir, "m", "thumb.png"));
    cp.execFileSync("/usr/bin/zip", ["-X", "-q", "-j", out].concat(files));
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
    return out;
  }
  function newGenDir() {
    var root = path.join(DATA, "gen");
    try {                                                       // 이틀 지난 것 정리
      fs.readdirSync(root).forEach(function (d) {
        var p = path.join(root, d);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86400000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
      });
    } catch (e) {}
    var d = path.join(root, String(Date.now())); mkdirp(d); return d;
  }

  // ---------- 음성 트랙 전체 받아쓰기 ----------
  // clips: [{path,start,end,inPoint,outPoint,speed}] (타임라인 순)
  // 클립 소리를 0.4초 틈을 두고 이어 붙여 whisper를 한 번만 돌리고, 단어 시간을 타임라인 시간으로 되돌린다.
  var SR = 16000, GAP = 0.4;
  function atempoChain(sp) {
    var f = [];
    while (sp > 2.0) { f.push("atempo=2.0"); sp /= 2.0; }
    while (sp < 0.5) { f.push("atempo=0.5"); sp /= 0.5; }
    if (Math.abs(sp - 1) > 1e-3) f.push("atempo=" + sp.toFixed(4));
    return f.join(",");
  }
  function extractPCM(ffmpeg, c, out) {
    var spd = c.speed || 1;
    var srcDur = Math.max(0.05, (c.end - c.start) * spd);        // 타임라인 길이 × 속도 = 원본에서 쓰는 길이
    var args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", c.inPoint.toFixed(3), "-t", srcDur.toFixed(3), "-i", c.path, "-vn"];
    var af = atempoChain(spd);
    if (af) args.push("-af", af);
    args.push("-ac", "1", "-ar", String(SR), "-f", "s16le", "-c:a", "pcm_s16le", out);
    return run(ffmpeg, args);
  }
  function wavHeader(bytes) {
    var h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
    h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
    return h;
  }
  function transcribeTrack(clips, lang, preferModel, onProgress) {
    var t = tools(preferModel);
    if (!t.ffmpeg) return Promise.reject(new Error("ffmpeg가 없어요. install-mac.command를 다시 실행해 주세요."));
    if (!t.whisper) return Promise.reject(new Error("whisper-cli가 없어요. install-mac.command를 다시 실행해 주세요."));
    if (!t.model) return Promise.reject(new Error("음성 인식 모델이 없어요. install-mac.command를 다시 실행해 주세요."));
    for (var i = 0; i < clips.length; i++) {
      if (clips[i].reversed) return Promise.reject(new Error("거꾸로 재생한 음성 클립은 못 들어요: " + clips[i].name));
      if (!fs.existsSync(clips[i].path)) return Promise.reject(new Error("원본 파일을 찾을 수 없어요: " + clips[i].path));
    }
    var sig = clips.map(function (c) {
      var st = fs.statSync(c.path);
      return [c.path, st.size, st.mtimeMs, c.start.toFixed(3), c.end.toFixed(3), c.inPoint.toFixed(3), (c.speed || 1).toFixed(3)].join(",");
    }).join(";");
    var key = crypto.createHash("sha1").update([sig, lang, path.basename(t.model), "track-v1"].join("|")).digest("hex").slice(0, 20);
    mkdirp(CACHE);
    var base = path.join(CACHE, key), jsonPath = base + ".json", mapPath = base + ".map.json", wav = base + ".wav";
    if (fs.existsSync(jsonPath) && fs.existsSync(mapPath)) {
      try {
        onProgress(1, "저장해 둔 인식 결과 사용");
        return Promise.resolve({ json: JSON.parse(fs.readFileSync(jsonPath, "utf8")), map: JSON.parse(fs.readFileSync(mapPath, "utf8")) });
      } catch (e) {}
    }
    var parts = [], map = [], pos = 0, n = clips.length;
    var chain = Promise.resolve();
    clips.forEach(function (c, k) {
      chain = chain.then(function () {
        if (transcribeTrack.cancelled) throw new Error("중지했어요.");
        onProgress(0.1 * k / n, "음성 클립 모으는 중… (" + (k + 1) + "/" + n + ")");
        var pcm = base + "." + k + ".pcm";
        return extractPCM(t.ffmpeg, c, pcm).then(function () {
          var buf = fs.readFileSync(pcm); try { fs.unlinkSync(pcm); } catch (e) {}
          var sec = buf.length / 2 / SR;
          map.push({ pos: pos, len: sec, start: c.start });
          parts.push(buf); pos += sec;
          var gap = Buffer.alloc(Math.round(GAP * SR) * 2);         // 클립 사이 무음
          parts.push(gap); pos += GAP;
        });
      });
    });
    return chain.then(function () {
      var body = Buffer.concat(parts);
      fs.writeFileSync(wav, Buffer.concat([wavHeader(body.length), body]));
      onProgress(0.1, "대사 듣는 중… 0% (음성 " + Math.round(pos) + "초)");
      var args = ["-m", t.model, "-f", wav, "-oj", "-of", base, "-ml", "1", "-sow", "-pp", "-l", lang || "auto"];
      var heard = "";
      return run(t.whisper, args, function (line) {
        var m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m) onProgress(0.1 + 0.9 * (+m[1]) / 100, "대사 듣는 중… " + m[1] + "%" + (heard ? " · " + heard : ""));
        var s = /^\[\d\d:\d\d:\d\d\.\d+ --> [^\]]+\]\s*(.*)$/.exec(line);
        if (s && s[1]) heard = (heard + s[1]).slice(-24);
      });
    }).then(function () {
      try { fs.unlinkSync(wav); } catch (e) {}
      fs.writeFileSync(mapPath, JSON.stringify(map));
      return { json: JSON.parse(fs.readFileSync(jsonPath, "utf8")), map: map };
    }, function (e) { try { fs.unlinkSync(wav); } catch (e2) {} throw e; });
  }
  // 이어 붙인 오디오 위치(초) → 타임라인 초
  function mapTime(map, p) {
    var best = map[0];
    for (var i = 0; i < map.length; i++) { if (map[i].pos <= p + 1e-6) best = map[i]; else break; }
    if (!best) return p;
    return best.start + Math.max(0, Math.min(p - best.pos, best.len));
  }
  function wordsFromTrack(res) {
    var tr = (res.json && res.json.transcription) || [], out = [];
    for (var i = 0; i < tr.length; i++) {
      var tx = tr[i].text || "";
      if (/^\s*[\[(].*[\])]\s*$/.test(tx)) continue;              // [음악] (웃음)
      var a = tr[i].offsets.from / 1000, b = tr[i].offsets.to / 1000;
      var t0 = mapTime(res.map, a), t1 = mapTime(res.map, Math.max(a, b - 0.001));
      out.push({ t0: t0, t1: Math.max(t1, t0 + 0.02), text: tx });
    }
    return out;
  }

  function clearCache() {
    try { fs.readdirSync(CACHE).forEach(function (f) { try { fs.unlinkSync(path.join(CACHE, f)); } catch (e) {} }); } catch (e) {}
  }

  // 맥 클립보드 (프리미어 패널 안에서는 브라우저 클립보드가 막혀 있어 pbcopy/pbpaste 사용)
  var CLIP_ENV = Object.assign({}, process.env, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
  function clipRead() {
    try { return cp.execFileSync("/usr/bin/pbpaste", [], { env: CLIP_ENV }).toString("utf8"); } catch (e) { return ""; }
  }
  function clipWrite(text) {
    try { cp.execFileSync("/usr/bin/pbcopy", [], { env: CLIP_ENV, input: Buffer.from(String(text), "utf8") }); return true; } catch (e) { return false; }
  }

  function writeText(file, text) { mkdirp(path.dirname(file)); fs.writeFileSync(file, text, "utf8"); return file; }
  function readText(file) { return fs.readFileSync(file, "utf8"); }

  window.MSEngine = {
    journal: function (o) {      // 싱크 진행 기록 — 프리미어가 꺼져도 다음에 어디서 멈췄는지 알 수 있게
      try { mkdirp(DATA); if (o === null) fs.unlinkSync(path.join(DATA, "sync-journal.json")); else fs.writeFileSync(path.join(DATA, "sync-journal.json"), JSON.stringify(o)); } catch (e) {}
    },
    readJournal: function () { try { return JSON.parse(fs.readFileSync(path.join(DATA, "sync-journal.json"), "utf8")); } catch (e) { return null; } },
    templateText: function (mogrt) { return loadBase(mogrt).oldText; },
    makeLineTemplate: makeLineTemplate, newGenDir: newGenDir, rewriteTextBinary: rewriteTextBinary, loadBase: loadBase,
    fileExists: function (p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
    listTemplates: listTemplates, templateThumb: templateThumb, openTemplateFolder: openTemplateFolder,
    tools: tools, transcribe: transcribe, transcribeTrack: transcribeTrack, wordsFromTrack: wordsFromTrack, mapTime: mapTime,
    cancel: function () { transcribeTrack.cancelled = true; cancel(); }, resetCancel: function () { transcribeTrack.cancelled = false; }, clearCache: clearCache,
    writeText: writeText, readText: readText, clipRead: clipRead, clipWrite: clipWrite, dataDir: DATA, home: HOME, path: path
  };
})();
