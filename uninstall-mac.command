#!/bin/bash
# monoSync 제거 (macOS) — 패널과 모델·캐시를 지웁니다. ffmpeg·whisper-cpp(Homebrew)는 다른 곳에서도 쓸 수 있어 그대로 둡니다.
#   지우려면:  brew uninstall whisper-cpp ffmpeg
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.monostudio.monosync"
rm -rf "$HOME/Library/Application Support/monoSync"
echo "✅ monoSync를 제거했어요. 프리미어를 다시 켜면 메뉴에서 사라져요."
