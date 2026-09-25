# Regenerates the README demo GIF from a real OpenCode session.
#
# Requires vhs, ttyd, ffmpeg and a working OpenCode install with the plugin
# registered. It spends one real model turn to create the session, so point
# OPENCODE at a cheap model before running it.
#
#   ./script/demo.sh [output.gif]
#
# Recording against a checkout of this repo loads the plugin twice, because the
# local dev shim and the installed copy both register. Record from a scratch
# directory instead, which is what this script does.

set -euo pipefail

out="${1:-docs/demo.gif}"
here="$(cd "$(dirname "$0")/.." && pwd)"
scratch="${TMPDIR:-/tmp}/opencode-queue-demo"

for bin in vhs ttyd ffmpeg opencode; do
  command -v "$bin" >/dev/null || { echo "$bin not found on PATH" >&2; exit 1; }
done

rm -rf "$scratch"
mkdir -p "$scratch"
cd "$scratch"

# Start from a genuinely empty queue and a disarmed auto-run. A leftover
# autorun.json would make the first /queue-auto turn the run *off*, and the
# recording would then show "Auto-run off" while claiming to arm it.
rm -f .opencode/queue.json .opencode/autorun.json

# Create the session outside the recording. Doing it here rather than by typing
# "hi" into the TUI keeps the model's turn, and its reasoning block, out of the
# GIF, and removes ~15s of dead time.
opencode run "Reply with exactly the word READY and nothing else." >/dev/null
session="$(opencode session list | head -n1 | awk '{print $1}')"
[ -n "$session" ] || { echo "could not determine session id" >&2; exit 1; }

cat > demo.tape <<TAPE
Output demo.gif
Set Width 1400
Set Height 450
Set FontSize 13
Set TypingSpeed 20ms
Set Padding 0
Set CursorBlink false
Set Framerate 30

Hide
Type "opencode --session $session"
Enter
Show
Sleep 8s

Type "/queue-add"
Enter
Sleep 1200ms
Type "Document the queue store locking model"
Enter
Sleep 1200ms

Type "/queue-add"
Enter
Sleep 1200ms
Type "Add a regression test for the file watcher"
Enter
Sleep 2s

Type "/queue-list"
Enter
Sleep 2s

Type "/queue-done"
Enter
Sleep 1200ms
Enter
Sleep 2s

Type "/queue-auto"
Enter
Sleep 2s

Type "/queue-auto-status"
Enter
Sleep 2s
Enter
Sleep 1500ms
TAPE

vhs demo.tape >/dev/null

# Fail loudly if the run did not actually arm, rather than shipping a GIF that
# contradicts itself.
[ -f .opencode/autorun.json ] || {
  echo "auto-run was not armed during the recording; refusing to publish" >&2
  exit 1
}

mkdir -p "$(dirname "$here/$out")"
# -ss 6.8 drops the shell prompt and the TUI splash. crop=1400:428 drops the
# bottom status bar only: the Add-a-task dialog opens at y~110 and toasts at
# y~22, so a taller crop would slice them.
ffmpeg -hide_banner -loglevel error -ss 6.8 -i demo.gif \
  -filter_complex "[0:v]crop=1400:428:0:0,fps=12,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 -y "$here/$out"

echo "wrote $out"
