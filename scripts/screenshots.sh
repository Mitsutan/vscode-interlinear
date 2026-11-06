#!/usr/bin/env bash
# README 用のスクリーンショットを撮り、images/screenshot-*.png に置く。
# 仮想ディスプレイ（Xvfb）で統合テストのスクリーンショットのモードを動かし、準備ができるたびに画面を撮る。
#
#   INTERLINEAR_E2E_ENDPOINT=http://127.0.0.1:18080 bash scripts/screenshots.sh
#
# 起動中の llama-server（実モデル）が要る。xvfb-run、ImageMagick、xdotool、日本語のフォントも要る
# （DEVELOPMENT.md の「Dev Container で統合テストを動かす準備」）。
set -euo pipefail

WIDTH=1600
HEIGHT=1000

if [ -z "${INTERLINEAR_E2E_ENDPOINT:-}" ]; then
  echo '使い方: INTERLINEAR_E2E_ENDPOINT=<llama-server の URL> bash scripts/screenshots.sh' >&2
  exit 2
fi
# 仮想ディスプレイの中で、このスクリプトを実行し直す
if [ -z "${INTERLINEAR_IN_XVFB:-}" ]; then
  exec env INTERLINEAR_IN_XVFB=1 xvfb-run -a -s "-screen 0 ${WIDTH}x${HEIGHT}x24" bash "$0" "$@"
fi

cd "$(dirname "$0")/.."
work=$(mktemp -d)
echo "作業ディレクトリ: $work"
node esbuild.mjs --tests > /dev/null
INTERLINEAR_SCREENSHOT_DIR="$work" node test/integration/run.ts > "$work/run.log" 2>&1 &
test_pid=$!

# ウィンドウマネージャーがないので VS Code の「最大化」は効かない。画面いっぱいに広げる
xdotool search --sync --onlyvisible --name 'Visual Studio Code' windowmove 0 0 windowsize "$WIDTH" "$HEIGHT" > /dev/null 2>&1 &
resize_pid=$!

while kill -0 "$test_pid" 2> /dev/null; do
  for ready in "$work"/ready-*; do
    [ -e "$ready" ] || continue
    name=${ready#"$work"/ready-}
    [ -e "$work/$name.png" ] && continue
    # 書き終わってから名前を変える。テストは <名前>.png ができたら次に進むため
    import -window root "$work/$name.tmp.png"
    mv "$work/$name.tmp.png" "$work/$name.png"
    echo "撮影: $name"
  done
  sleep 0.5
done
kill "$resize_pid" 2> /dev/null || true

status=0
wait "$test_pid" || status=$?
grep -E '✔|✖|passed' "$work/run.log" || true
if [ "$status" -ne 0 ]; then
  echo "テストが失敗した（ログ: $work/run.log）" >&2
  exit "$status"
fi

# タイトルバー（開発用のウィンドウであることが表示される）とステータスバーを、境界線ごと切り落とす。
# 高さは VS Code 1.145 の既定のもの。VS Code の見た目が変わったら測り直す
TITLE_BAR=36
STATUS_BAR=33
for shot in "$work"/readme-*.png; do
  out="images/screenshot-${shot##*/readme-}"
  magick "$shot" -crop "${WIDTH}x$((HEIGHT - TITLE_BAR - STATUS_BAR))+0+${TITLE_BAR}" +repage -strip "PNG24:$out"
  echo "$out"
done
