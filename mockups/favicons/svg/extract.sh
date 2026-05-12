#!/usr/bin/env bash
# Extract each <symbol id="sym-NN"> from ../index.html into its own
# standalone SVG file. Each output file inlines the shared <defs>
# gradients so it's self-contained.
#
# Usage: bash extract.sh
# Output: 01-pulse-bubble.svg, 02-signal-arc.svg, ... 25-campfire.svg
set -euo pipefail

cd "$(dirname "$0")"
SRC="../index.html"

names=(
  "01-pulse-bubble" "02-signal-arc" "03-broadcast-tower" "04-wave-stack"
  "05-sealed-envelope" "06-two-node-link" "07-mesh-triad" "08-facing-chevrons"
  "09-exchange-arrows" "10-bridge" "11-forge-c" "12-double-c"
  "13-dot-c-dot" "14-stamped-c" "15-constellation" "16-hub-spoke"
  "17-orbit-nodes" "18-mesh-dots" "19-ember-hex" "20-cleft-chevron"
  "21-prism-spark" "22-iris-aperture" "23-forge-spark" "24-anvil-mark"
  "25-campfire"
)

# Shared <defs> block (gradients). Inlined into every output so the
# file works standalone in any browser, favicon pipeline, or RIFE-free tool.
read -r -d '' DEFS <<'EOF' || true
  <defs>
    <linearGradient id="g-ember-vert" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="1" stop-color="#d97706"/>
    </linearGradient>
    <linearGradient id="g-ember-diag" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="1" stop-color="#b45309"/>
    </linearGradient>
    <radialGradient id="g-ember-glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="0.6" stop-color="#f59e0b"/>
      <stop offset="1" stop-color="#92400e"/>
    </radialGradient>
    <radialGradient id="g-ember-flare" cx="0.5" cy="0.55" r="0.55">
      <stop offset="0" stop-color="#fef3c7"/>
      <stop offset="0.35" stop-color="#fbbf24"/>
      <stop offset="0.75" stop-color="#d97706"/>
      <stop offset="1" stop-color="#7c2d12"/>
    </radialGradient>
  </defs>
EOF

for i in "${!names[@]}"; do
  idx=$(printf "%02d" "$((i+1))")
  outfile="${names[$i]}.svg"
  # Pull just the inner <path>/<rect>/<circle>/<g>/<ellipse> tags of <symbol id="sym-NN">
  body=$(awk -v id="sym-${idx}" '
    $0 ~ "<symbol id=\""id"\"" { capture=1; next }
    capture && $0 ~ "</symbol>" { capture=0 }
    capture { print }
  ' "$SRC")
  cat > "$outfile" <<EOF2
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
${DEFS}
${body}
</svg>
EOF2
done

echo "Wrote ${#names[@]} SVGs."
