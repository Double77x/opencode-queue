# Regenerates the README demo GIF from a real OpenCode session.
#
# Requires vhs and ttyd on PATH:
#   https://github.com/charmbracelet/vhs
#   https://github.com/tsl0922/ttyd
#
# The recording drives the actual TUI, so it needs a working OpenCode install
# and a scratch directory that has no local plugin shim in it.
#
#   ./script/demo.sh [output.gif]

set -euo pipefail

out="${1:-docs/demo.gif}"
scratch="${TMPDIR:-/tmp}/opencode-queue-demo"
here="$(cd "$(dirname "$0")/.." && pwd)"

command -v vhs >/dev/null || { echo "vhs not found" >&2; exit 1; }
command -v ttyd >/dev/null || { echo "ttyd not found" >&2; exit 1; }

rm -rf "$scratch"
mkdir -p "$scratch"

cat > "$scratch/demo.tape" <<'TAPE'
Output demo.gif
Set Width 1500
Set Height 850
Set FontSize 14
Set TypingSpeed 30ms
Set Padding 8
Set CursorBlink false
Set Framerate 30

Hide
Type "clear"
Enter
Type "opencode"
Enter
Show
Sleep 11s

# A session has to exist before queue commands do anything.
Type "hi"
Enter
Wait+Screen@90s /tok.s/
Sleep 3s

Type "/queue-add"
Enter
Sleep 2s
Type "Document the queue store locking model"
Enter
Sleep 2s

Type "/queue-add"
Enter
Sleep 2s
Type "Add a regression test for the file watcher"
Enter
Sleep 3s

Type "/queue-list"
Enter
Sleep 3s

Type "/queue-done"
Enter
Sleep 2s
Enter
Sleep 3s

Type "/queue-auto"
Enter
Sleep 3s
Type "/queue-auto-status"
Enter
Sleep 3s
Enter
Sleep 2s
TAPE

(cd "$scratch" && vhs demo.tape >/dev/null)

mkdir -p "$(dirname "$here/$out")"
if command -v ffmpeg >/dev/null; then
  ffmpeg -hide_banner -loglevel error -i "$scratch/demo.gif" \
    -vf "fps=12,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
    -loop 0 -y "$here/$out"
else
  cp "$scratch/demo.gif" "$here/$out"
fi

echo "wrote $out"
