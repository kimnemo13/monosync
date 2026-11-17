#!/bin/bash
# ============================================================
#  monoSync 설치 (macOS)
#  실행: 터미널에  bash  입력 → 한 칸 띄우고 → 이 파일을 끌어다 놓고 → Enter
#  하는 일
#   1) Homebrew 확인(없으면 설치 — 맥 비밀번호를 물어볼 수 있어요)
#   2) ffmpeg, whisper-cpp(음성 인식) 설치
#   3) 음성 인식 모델 받기 (약 570MB, 처음 한 번만)
#   4) 패널을 프리미어 확장 폴더로 복사 + 서명 안 된 확장 허용
#  다시 실행해도 안전해요(이미 있는 건 건너뜀). 업데이트는 패널이 GitHub에서 자동으로 받아요.
# ============================================================
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DST_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
DST="$DST_ROOT/com.monostudio.monosync"
DATA="$HOME/Library/Application Support/monoSync"
MODEL_NAME="ggml-large-v3-turbo-q5_0.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"

echo ""
echo "=== monoSync 설치 ==="

# 1) Homebrew
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "[1/4] Homebrew가 없어서 설치합니다. 맥 로그인 비밀번호를 물어보면 입력하세요(입력해도 화면엔 안 보여요)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
command -v brew >/dev/null 2>&1 || { echo "Homebrew 설치에 실패했어요. https://brew.sh 안내대로 설치한 뒤 다시 실행해 주세요."; exit 1; }
echo "[1/4] Homebrew 확인 완료"

# 2) ffmpeg / whisper-cpp
for pkg in ffmpeg whisper-cpp; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then echo "      $pkg 이미 있음"
  else echo "      $pkg 설치 중… (몇 분 걸릴 수 있어요)"; brew install "$pkg"; fi
done
BIN="$(brew --prefix)/bin"
if [ ! -x "$BIN/whisper-cli" ] && [ ! -x "$BIN/whisper-cpp" ]; then
  echo "whisper-cli를 찾지 못했어요. 'brew reinstall whisper-cpp' 후 다시 실행해 주세요."; exit 1
fi
echo "[2/4] ffmpeg · whisper 준비 완료"

# 3) 모델
mkdir -p "$DATA/models"
M="$DATA/models/$MODEL_NAME"
if [ -s "$M" ] && [ "$(stat -f%z "$M")" -gt 500000000 ]; then
  echo "[3/4] 음성 인식 모델 이미 있음"
else
  echo "[3/4] 음성 인식 모델 받는 중 (약 570MB)…"
  curl -L --fail -C - --progress-bar -o "$M.part" "$MODEL_URL"
  mv "$M.part" "$M"
  echo "      모델 저장 → $M"
fi

# 4) 확장 복사 설치
if pgrep -xq "Adobe Premiere Pro" 2>/dev/null || pgrep -fq "Adobe Premiere Pro.app" 2>/dev/null; then
  echo "※ 프리미어가 켜져 있어요. 설치가 끝나면 프리미어를 완전히 종료(⌘Q)했다가 다시 켜 주세요."
fi
KEEP="$(mktemp -d)"
[ -e "$DST/ms-settings.json" ] && cp -L "$DST/ms-settings.json" "$KEEP/" 2>/dev/null || true
mkdir -p "$DST_ROOT"
if [ -L "$DST" ]; then rm -f "$DST"; else rm -rf "$DST"; fi
mkdir -p "$DST"
rsync -a --exclude '.git' --exclude '.DS_Store' "$SRC/" "$DST/"
cp -p "$KEEP"/* "$DST/" 2>/dev/null || true
rm -rf "$KEEP"
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true
for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
killall cfprefsd 2>/dev/null || true
echo "[4/4] 패널 설치 완료 → $DST"

VER="$(grep -o '"version": *"[^"]*"' "$DST/version.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
echo ""
echo "✅ monoSync v$VER 설치 완료"
echo "   1) 프리미어를 완전히 종료(⌘Q)했다가 다시 켜세요."
echo "   2) 창(Window) > 확장명(Extensions) > monoSync"
echo ""
