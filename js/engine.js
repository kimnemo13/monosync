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
  var fs = req("fs"), path = req("path"), os = req("os"), cp = req("child_process"), crypto = req("crypto");

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
    tools: tools, transcribe: transcribe, cancel: cancel, clearCache: clearCache,
    writeText: writeText, readText: readText, clipRead: clipRead, clipWrite: clipWrite, dataDir: DATA, home: HOME, path: path
  };
})();
