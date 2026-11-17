/* monoSync — 자동 업데이트 / 이전 버전으로 되돌리기
 * GitHub 저장소(kimnemo13/monosync)의 version.json을 확인해 새 버전이면 파일을 받아 패널을 다시 불러온다.
 * - 버전마다 GitHub 브랜치(release-1.0.4 등)가 있어서, 원하는 옛 버전을 골라 그대로 설치할 수도 있다.
 * - 옛 버전을 고르면 "버전 고정"이 걸려 자동 업데이트가 멈춘다. (최신으로 돌아가면 다시 켜짐)
 * - 사용자 설정 파일(ms-settings.json)은 절대 건드리지 않는다.
 * - 사용 통계·데이터 전송 없음. GitHub에 버전 확인만 한다.
 */
(function () {
  "use strict";
  var req = (window.cep_node && window.cep_node.require) || window.require;
  if (!req) return;
  var https = req("https"), fs = req("fs"), path = req("path");

  var DEFAULT_REPO = "kimnemo13/monosync", BRANCH = "main";
  var AUTO_KEY = "monosync.autoUpdate", PIN_KEY = "monosync.pinnedVersion";
  var PROTECT = /^(ms-settings\.json|version\.json)$/;

  function extensionRoot() {
    var p = decodeURI(window.__adobe_cep__.getSystemPath("extension"));
    return path.normalize(p.replace(/^file:\/\//, ""));
  }
  var ROOT = extensionRoot();

  function readLocal() {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, "version.json"), "utf8")); }
    catch (e) { return { version: "1.0.0", repo: DEFAULT_REPO, files: [] }; }
  }
  function getRepo() { return (readLocal().repo || DEFAULT_REPO).trim(); }
  function isAuto() { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch (e) { return true; } }
  function setAuto(v) { try { localStorage.setItem(AUTO_KEY, v ? "1" : "0"); } catch (e) {} }
  function pinned() { try { return localStorage.getItem(PIN_KEY) || ""; } catch (e) { return ""; } }
  function setPinned(v) { try { if (v) localStorage.setItem(PIN_KEY, v); else localStorage.removeItem(PIN_KEY); } catch (e) {} }

  function get(url, asJson, redirects) {
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      var r = https.get(url, { headers: { "User-Agent": "monosync-Updater", "Accept": "application/vnd.github+json" } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(get(res.headers.location, asJson, redirects + 1));
        }
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          var buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " (" + url.split("?")[0] + ")"));
          if (!asJson) return resolve(buf);
          try { resolve(JSON.parse(buf.toString("utf8"))); } catch (e) { reject(new Error("JSON 해석 실패")); }
        });
      });
      r.setTimeout(20000, function () { r.destroy(new Error("시간 초과")); });
      r.on("error", reject);
    });
  }

  function cmp(a, b) { // a>b:1, a<b:-1
    var x = String(a).replace(/^v/, "").split(".").map(Number), y = String(b).replace(/^v/, "").split(".").map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  function safeRel(p) {
    if (typeof p !== "string" || !p || path.isAbsolute(p) || p.indexOf("..") !== -1) return false;
    return !PROTECT.test(p);
  }

  // ref(커밋 SHA 또는 태그)의 파일들을 받아 설치
  function installRef(repo, ref, onMsg) {
    return get("https://raw.githubusercontent.com/" + repo + "/" + ref + "/version.json", true).then(function (remote) {
      var files = (remote.files || []).filter(safeRel);
      var got = {}, n = 0;
      onMsg("v" + remote.version + " 받는 중… (0/" + files.length + ")");
      // 전부 받은 뒤에 한꺼번에 쓴다 (중간에 실패하면 아무것도 안 바뀜)
      return files.reduce(function (p, f) {
        return p.then(function () {
          return get("https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + f.split("/").map(encodeURIComponent).join("/"), false)
            .then(function (buf) { got[f] = buf; n++; onMsg("v" + remote.version + " 받는 중… (" + n + "/" + files.length + ")"); });
        });
      }, Promise.resolve()).then(function () {
        var needsRestart = false;
        Object.keys(got).forEach(function (f) {
          var dst = path.join(ROOT, f);
          if (f === "CSXS/manifest.xml") {
            try { if (!fs.readFileSync(dst).equals(got[f])) needsRestart = true; } catch (e) { needsRestart = true; }
          }
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.writeFileSync(dst, got[f]);
          if (/\.command$/.test(f)) { try { fs.chmodSync(dst, 493); } catch (e) {} }
        });
        remote.repo = remote.repo || repo;
        fs.writeFileSync(path.join(ROOT, "version.json"), JSON.stringify(remote, null, 2));
        return { status: "updated", version: remote.version, notes: remote.notes || "", needsRestart: needsRestart };
      });
    });
  }

  // 최신 버전 확인 → 새 버전이면 설치. 반환 {status: "none"|"updated"|"pinned", version}
  function check(onMsg, force) {
    onMsg = onMsg || function () {};
    var repo = getRepo(), local = readLocal();
    if (pinned() && !force) return Promise.resolve({ status: "pinned", version: local.version });
    var sha;
    return get("https://api.github.com/repos/" + repo + "/commits/" + BRANCH, true)
      .then(function (c) {
        sha = c.sha;
        return get("https://raw.githubusercontent.com/" + repo + "/" + sha + "/version.json", true);
      })
      .then(function (remote) {
        if (cmp(remote.version, local.version) <= 0) return { status: "none", version: local.version };
        return installRef(repo, sha, onMsg).then(function (r) { setPinned(""); return r; });
      });
  }

  // 버전 목록 (최신순) — GitHub의 release-1.0.4 같은 브랜치가 버전 하나씩. 결과는 "v1.0.4" 형태
  function listVersions() {
    return get("https://api.github.com/repos/" + getRepo() + "/branches?per_page=100", true).then(function (brs) {
      return (brs || []).map(function (b) { var m = /^release-(\d+\.\d+\.\d+)$/.exec(b.name); return m ? "v" + m[1] : null; })
        .filter(function (n) { return !!n; })
        .sort(function (a, b) { return cmp(b, a); });
    });
  }

  // 특정 버전 설치 ("v1.0.3" → release-1.0.3 브랜치). 최신 버전이 아니면 버전 고정(자동 업데이트 멈춤)
  function installVersion(ver, isLatest, onMsg) {
    var ref = "release-" + String(ver).replace(/^v/, "");
    return installRef(getRepo(), ref, onMsg || function () {}).then(function (r) {
      setPinned(isLatest ? "" : r.version);
      return r;
    });
  }

  window.MSUpdater = {
    check: check, listVersions: listVersions, installVersion: installVersion,
    isAuto: isAuto, setAuto: setAuto, pinned: pinned, setPinned: setPinned,
    localVersion: function () { return readLocal().version; }, repo: getRepo
  };
})();
