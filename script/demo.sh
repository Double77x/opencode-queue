# Regenerates the README demo GIF from a real OpenCode session.
#
# Requires vhs, ttyd, ffmpeg, node and a working OpenCode install with the plugin
# registered. The recording drives a real model, so point OpenCode at a cheap
# one before running it.
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
tasks=2

for bin in vhs ttyd ffmpeg opencode node; do
  command -v "$bin" >/dev/null || { echo "$bin not found on PATH" >&2; exit 1; }
done

rm -rf "$scratch"
mkdir -p "$scratch"
cd "$scratch"

# Start from a genuinely empty queue and a disarmed auto-run. A leftover
# autorun.json would make the first /queue-auto turn the run *off*, and the
# recording would then show "Auto-run off" while claiming to arm it.
rm -f .opencode/queue.json .opencode/autorun.json

# Create the session outside the recording, against a throwaway project so the
# capture never inherits another run's transcript. Typing "hi" into the TUI
# instead would put a model turn and its reasoning block in the GIF.
opencode run --standalone "Reply with exactly the word READY and nothing else." >/dev/null
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
Sleep 9s

Type "/queue-add"
Enter
Sleep 1200ms
Type "Reply with PONG"
Enter
Sleep 1200ms

Type "/queue-add"
Enter
Sleep 1200ms
Type "Reply with PONG again"
Enter
Sleep 2s

Type "/queue-auto"
Enter
Sleep 17s

Type "/queue-auto-status"
Enter
Sleep 2500ms
Enter
Sleep 2s
TAPE

vhs demo.tape >/dev/null

# The whole point of the capture is that the agent drains the queue on its own.
# Publish only if that actually happened, rather than shipping a GIF that shows
# a dead run. Auto-run went years without ever firing, and the tests could not
# see it, so check the real artefacts.
node -e '
const fs = require("node:fs");
const queue = JSON.parse(fs.readFileSync(".opencode/queue.json", "utf8"));
const arming = JSON.parse(fs.readFileSync(".opencode/autorun.json", "utf8"));
const fail = (why) => { console.error(`refusing to publish: ${why}`); process.exit(1); };
if (queue.length === 0) fail("the queue is empty");
if (queue.some((task) => task.status !== "done")) fail("a task was never completed");
if (arming.paused) fail("the run paused");
if (arming.used !== queue.length) fail(`expected ${queue.length} pushes, saw ${arming.used}`);
if (arming.activeID !== "") fail("a task is still active");
'

mkdir -p "$(dirname "$here/$out")"
# -ss 6.8 drops the shell prompt and the TUI splash. crop=1400:428 drops the
# bottom status bar only: the Add-a-task dialog opens at y~110 and toasts at
# y~22, so a taller crop would slice them.
ffmpeg -hide_banner -loglevel error -ss 6.8 -i demo.gif \
  -filter_complex "[0:v]crop=1400:428:0:0,fps=12,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 -y "$here/$out"

echo "wrote $out"
