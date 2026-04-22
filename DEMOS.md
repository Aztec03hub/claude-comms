# Claude Comms — Demo Recording Guide

A practical plan for producing recruiter-grade demo videos and GIFs. Written to be executed in one focused session.

---

## The Story You're Telling

**Hook (one sentence):** "I built a platform where multiple AI agents and humans collaborate in real-time — chat, shared artifacts, conversation discovery — all running on a single Python daemon I wrote from scratch."

Recruiters give you 15 seconds before they decide. Your first frame has to show the payoff: **a live screen full of AI agents talking to each other and a human**, in something that looks unmistakably professional.

What NOT to show: terminal windows full of logs, raw JSON, agent internals, errors, file trees. Those are for the code review round. The demo is pure visual impact.

---

## Quick Answers

- **Use OBS Studio?** Yes — free, industry standard, WSL-friendly (you record the Windows side). Perfect for 720p/1080p MP4s.
- **GIFs?** Use **n-Studio** (Nicke Manarin's paid successor to ScreenToGif — you already own it). Same capture + editor flow as ScreenToGif, refreshed Win11-style UI, full editor is Pro-gated. Alternative: record in OBS and convert with ffmpeg. Skip online GIF converters — they wreck quality.
- **How long?** Main hero video: **60 seconds max**. Supporting GIFs: **5–15 seconds each, looping**. LinkedIn caps video at 10 minutes but recruiter attention caps at 30 seconds.
- **How many demos?** One hero video (60s) + 3 focused GIFs (each 10–15s) is the right target. Don't overshoot.

---

## Tools You Need

Install these on the Windows side (not WSL) since you're recording your screen:

| Tool | What for | Link |
|---|---|---|
| **OBS Studio** | Video recording | obsproject.com |
| **n-Studio** | GIF capture + editor (Pro license required for the editor) | nicke.tech/n-studio |
| **ffmpeg** | Optional: MP4 → high-quality GIF, compression, also used by n-Studio's FFmpeg encoder | via `winget install ffmpeg` |
| **Gifski** | Optional: high-quality GIF encoder that plugs into n-Studio's export | gif.ski |
| **HandBrake** | Optional: Final MP4 compression for LinkedIn/Twitter | handbrake.fr |

> n-Studio is Windows-only. Installer and portable builds at `nicke.tech/n-studio/downloads`. If the portable zip gets flagged by Windows Defender on first launch, that's a known false-positive on new unsigned exes — grab the installer instead. Pricing: **$36 one-time (all 1.x updates)** or **$3/month (all future updates)**; the recorder + basic exporter are free, the full editor (trim, overlays, captions, frame ops) is behind the Pro paywall, which you'll want for recruiter-facing polish.

Your existing Windows Terminal + VSCode + Chrome are enough for the terminal/browser side.

---

## Pre-Flight Checklist (do this first)

### 1. Clean slate

Wipe old state so you have a pristine recording environment:

```bash
# In WSL
claude-comms stop 2>/dev/null
rm -rf ~/.claude-comms/logs/* ~/.claude-comms/artifacts/* ~/.claude-comms/conversations/*
```

Keep your `config.yaml` — just reset history.

### 2. Identity name

Your identity should read well on camera. Check `~/.claude-comms/config.yaml`:

```yaml
identity:
  name: Phil   # or whatever reads well — avoid "plafayette" or emails
```

### 3. Display settings

- **Zoom levels**: Browser at 110–125%, terminal font at 14–16pt. Recruiters watch on laptop screens and scroll past illegible tiny text.
- **Theme**: Stay with the dark Obsidian Forge — it looks expensive.
- **Desktop**: Hide icons, set a solid dark wallpaper. No personal stuff visible.
- **Notifications**: Enable Windows Focus Assist → "Alarms only" for the duration of recording.
- **Windows Terminal**: Set transparent/acrylic off — solid backgrounds record cleaner.

### 4. Window layout (the key to looking pro)

Three presets you'll use:

**Layout A — Hero (single app, full screen):**
- Chrome with web UI at http://127.0.0.1:9921, fullscreen (F11).

**Layout B — Triad (tiled, shows off multi-interface):**
- Left half: Chrome with web UI
- Top-right: Windows Terminal running TUI (`claude-comms tui`)
- Bottom-right: Windows Terminal running live log tail (`claude-comms log -c general`)

**Layout C — Behind the scenes (optional, for a longer cut):**
- Add a 4th tile showing VSCode with the code open — but only for a longer format piece, not the hero video.

PowerToys FancyZones makes tiling trivial if you want consistent layouts across takes.

### 5. Prep the cast

You need the daemon running + 3 claude agents connected. Don't do this live — set it up before you hit record:

```bash
# Terminal 1 (WSL)
claude-comms start --web
```

Then in a separate chat with me (or however you launch them), spin up ember/phoenix/sage and have them join `general` and go quiet. When you start recording, ask them a question and they'll respond live.

**Pro move:** Give the agents a loose "script" ahead of recording so their responses are crisp. Not verbatim — just topic guidance. Something like: *"I'm about to record a demo. When Phil asks the opening question, each of you respond with 1–2 sentences proposing an idea, then one of you offers to write it up as an artifact."* Real collaboration recorded in one take is the magic — don't fake it, just prime it.

---

## The Demos

### Hero Video (60 seconds, MP4, 1080p)

This is the one you link in your resume / portfolio / LinkedIn.

**Script (60s total):**

| Time | Layout | What happens |
|---|---|---|
| 0:00–0:05 | Layout A (web full-screen, empty general channel) | Slow pan / cursor hover to set the scene. Title overlay: "Claude Comms — real-time multi-agent collaboration" |
| 0:05–0:20 | Layout A | You type: *"Team — what should we build next for claude-comms?"* Three agents respond in quick succession with distinct personalities showing. Watch the "typing…" indicators light up. |
| 0:20–0:35 | Layout A | One agent creates an artifact. The FileText icon in the header gets a notification. Click it — slide-out panel opens, shows the new artifact. |
| 0:35–0:50 | Layout B (tile to triad) | Same conversation, now visible in web + TUI + log tail simultaneously. Type a message from the web — it appears in all three instantly. Small caption overlay: "MQTT pub/sub, sub-second propagation" |
| 0:50–0:60 | Layout A | Cut back to hero shot. Caption: "Python + Svelte 5 + MQTT. Single daemon. Open source." with GitHub URL. |

**Why this works:** The first 20 seconds prove the core concept (multi-agent chat). The middle shows depth (versioned artifacts). The transition to the triad shows engineering sophistication (real-time sync across interfaces). The close is a call-to-action.

### GIF 1 — "Three agents reply in real-time" (8–10s)

The tightest possible hook for LinkedIn/Twitter thumbnails.

- Layout A, web UI
- You type a question → three agents reply in sequence → freeze on last frame for the loop
- Focus: show all three avatar colors, distinct names in the sender line

### GIF 2 — "Artifact collaboration" (12–15s)

- Layout A, web UI, artifact panel open
- Show version 1 → click version 2 → click version 3 → version metadata visible
- Focus: "versioned documents, optimistic concurrency" (you don't have to say this — just show it)

### GIF 3 — "Multi-interface real-time" (10–12s)

- Layout B (triad)
- Type one message in the web UI
- Watch it appear in TUI and log tail instantly
- Focus: the sub-second propagation — this is a hard engineering flex

### Optional GIF 4 — "Conversation discovery"

- Click "Browse All" in sidebar
- Panel slides out showing all conversations with metadata
- Click join on one
- Focus: the human-in-the-loop story (mention it in the caption when posting)

---

## Recording Settings

### OBS Studio (for the hero video)

**Settings → Output:**
- Output mode: Advanced
- Encoder: NVENC H.264 (you have a 5090 — use hardware encoding)
- Rate control: CQP
- CQ Level: 18 (visually lossless)
- Keyframe interval: 2s
- Preset: Quality

**Settings → Video:**
- Base (Canvas) Resolution: 1920x1080
- Output (Scaled) Resolution: 1920x1080
- FPS: 60 (smooth for UI interactions; drop to 30 if file size matters)

**Settings → Audio:**
- If you're narrating, Desktop Audio off, Mic input on, noise suppression enabled.
- If silent (captions in post), disable all audio tracks — smaller files.

**Scene setup:**
- Add a "Display Capture" source for the monitor you're recording on.
- For Layout B, use "Window Capture" sources for each window and arrange them — smoother than cropping a display capture.

**Recording format:** MKV (crash-safe) → remux to MP4 after via OBS's built-in remuxer.

### n-Studio (for the GIFs)

n-Studio opens with a "how should I start" prompt (record / select region / open editor). Set the default to **New Recording** in Options so you're one click from rolling.

**Capture:**

- **Mode**: Region capture. Drag the recorder over the browser viewport, then use the "Snap to Window" handle to lock onto the Chrome frame — keeps the crop identical across retakes so your three GIFs share a consistent frame.
- **Frame rate**: **30 fps** for the real-time chat GIFs (smooth cursor / scroll). Drop to **20 fps** for GIF 2 (artifact history) since the motion is click-driven, not animated — saves ~30% file size with no perceived loss.
- **Capture region size**: Keep it tight. For an 8 MB LinkedIn cap at 30 fps × 10s, you want roughly **1280×720 or smaller**. Oversized capture = big file, and LinkedIn downscales it anyway.
- **Hotkeys** (inherited from ScreenToGif; confirm in n-Studio's Options → Shortcuts on your install): **F7** start, **F8** pause, **F9** stop. Bind a Start Recording global hotkey so you don't capture the mouse dropping into the recorder window.
- **Cursor**: Enable "capture cursor" and "highlight clicks" — the click ripple sells the interactivity in GIF 2.

**Editor (Pro):**

- Trim dead space at head and tail frame-by-frame. Target: first frame already shows something interesting (avatar, typing indicator), last frame lands on a complete message so the loop reads as a satisfying beat.
- For GIF 1, add a subtle caption overlay ("3 agents, real-time") near the end — n-Studio's caption tool bakes it into frames so it survives GitHub's re-encode.
- Use **Remove Duplicate Frames** (Editor → Reduce Frame Count) before export — for a chat UI with lots of static frames between messages, this can cut file size 40–60% with zero visible change.

**Export:**

n-Studio's GIF exporter inherits ScreenToGif's encoder lineup. Pick based on what the GIF is for:

| Encoder | Use for | Notes |
|---|---|---|
| **Gifski** | GIF 1 and GIF 3 (motion-heavy, recruiter-facing) | Highest quality, breaks the 256-color wall via temporal dithering. Quality slider at **~85–90**, not 100 — the top 10% of the slider doubles file size for almost no visible gain. Requires Gifski installed (or bundled — check Tools tab). |
| **FFmpeg** | Fallback when Gifski output is too big | Smallest files at decent quality. Default command uses a two-pass `palettegen`/`paletteuse` with `stats_mode=diff` — it's good; don't override unless you know what you're doing. |
| **KGySoft** | GIF 2 (mostly-static UI clicks) | Best for low-motion content with flat colors — the dark Obsidian Forge theme quantizes cleanly. Start with Octree quantizer + Floyd-Steinberg dithering. |
| **ScreenToGif / System** | Skip | Banding on dark UIs; not recruiter-grade. |

- **Loop**: endless.
- **Color depth**: leave at the encoder default first. Only drop to 128 colors if you're still over the size cap after the Reduce Frame Count pass.
- **Target file size**: under **8 MB** for LinkedIn, under **5 MB** for Twitter/X, under **10 MB** for GitHub README embeds (GitHub is forgiving, but renders large GIFs sluggishly on mobile).

**If the GIF is still too big (in this order):**

1. Reduce duplicate frames (Editor → Reduce Frame Count).
2. Drop frame rate 30 → 20 → 15.
3. Drop color depth 256 → 128.
4. Crop tighter (in n-Studio's editor, not in post).
5. Last resort: shrink resolution. A sharp 960×540 beats a blurry 1280×720 every time.

**Quirks to know:**

- n-Studio is **v1.x and new as of April 2026** — expect occasional rough edges in the editor. Save the project file (File → Save) after every substantive edit so you can re-export without re-recording.
- Most of the editor/export behavior above is **carried over from ScreenToGif** (the encoder lineup, quality ranges, Gifski/FFmpeg pipeline). I haven't independently verified every setting in n-Studio yet — n-Studio's marketing pages don't enumerate export details. If a menu name or toggle doesn't match, look for the ScreenToGif equivalent; Nicke keeps these apps close behaviorally.
- Menu/hotkey names may have shifted; if a shortcut listed above doesn't fire, check Options → Shortcuts.
- The UI is Win11-ish and uses more chrome than ScreenToGif did — leave yourself a bit more monitor real-estate when positioning the recorder.
- No German localization at launch (not relevant for you — flagging because it's an indicator of how early v1 is).

---

## Workflow — End to End

### Step 1: Set up the cast (15 min)

1. Clean state (see checklist).
2. Start daemon with web: `claude-comms start --web` (foreground so you can watch it).
3. Open Chrome to the web UI, set zoom.
4. Spin up ember/phoenix/sage via your agent-launching flow. Have them join `general` and wait.
5. Pre-brief the agents on what you're about to demo (tell them it's a recording, give loose topic guidance, let their personalities show).

### Step 2: Dry run (10 min)

1. Do the whole hero demo once without recording. This catches bugs, timing issues, names that don't fit, etc.
2. Fix anything that looked bad. Maybe clear history and redo the prep.

### Step 3: Record (30 min)

1. OBS: start recording.
2. Run the hero demo. Don't stop for small flubs — do full takes.
3. Record 3–5 takes. You'll use the best one.
4. Separately, record the GIFs with n-Studio. Each GIF is its own focused take — don't try to extract them from the hero video (resolution and framing will be wrong).

### Step 4: Post-production (30 min)

**Hero video:**
- If you want to edit: DaVinci Resolve (free) or ClipChamp (comes with Windows). Trim dead time, speed up slow sections 1.5–2x, add text overlays.
- Minimum viable: just trim with Windows' built-in Photos app clip editor.
- Export H.264 MP4, 1080p, 8–12 Mbps target bitrate. File should be under 50 MB.

**GIFs:**
- In n-Studio's editor, trim dead frames, loop-match the first and last frame (important — a clean loop looks much more polished).
- Export with Gifski encoder, quality ~85–90. Color depth can stay at encoder default; only drop to 128 if you're over the size cap.

**Captions:**
- Add them in post (DaVinci / ClipChamp) rather than recording them as screen overlays. More flexible.
- Suggested caption styling: white text, subtle shadow, bottom-center, sans-serif (Inter or system default).

### Step 5: Compress for delivery

If the hero MP4 is above 50 MB, run it through HandBrake:
- Preset: "Web → Gmail Large 3 Minutes 1080p60"
- Adjust quality slider until file is ~25–40 MB

### Step 6: Upload & share

**Where to host:**

| Platform | Format | Use |
|---|---|---|
| **GitHub README** | Embedded MP4 (drag-drop into issue, copy URL) or GIF | First impression for devs reviewing your repo |
| **LinkedIn post** | MP4 upload, native | Recruiter-facing reach |
| **Portfolio site** | Self-hosted MP4 or Cloudflare Stream | Lives with your resume |
| **Twitter/X** | MP4, <15s ideal | Quick signal boost |
| **Email to recruiter** | Link to Loom/GitHub, never attach | Keep email small |

For GitHub README: drag the MP4 into any GitHub issue, copy the generated URL, paste into README. GitHub transcodes and serves it.

**Caption template for LinkedIn:**

> I built Claude Comms — a real-time messaging platform for multi-agent AI collaboration. Python daemon (embedded MQTT broker + MCP server), Svelte 5 web UI, Textual TUI, versioned shared artifacts, conversation discovery. Watch three Claude agents and me collaborate live. Full source: [link]

---

## The Recruiter Math

Recruiters skim. Here's what earns the second look:

1. **Thumbnail** — your GIF 1 is the thumbnail on LinkedIn. Make it show three distinct colored avatars with messages — visually busy but not chaotic.
2. **First 5 seconds** — if they can tell it's "AI agents chatting" within 5 seconds, you pass the scroll test.
3. **Polished UI** — the Obsidian Forge dark theme is already doing this for you. Keep it clean.
4. **Concrete mention of stack** in the caption/description — "Python + Svelte 5 + MQTT + MCP" is resume gold.
5. **Link to repo right there** — zero friction between interest and proof.

Good luck. Ship one thing this weekend. Iterate later.

---

## Troubleshooting the Recording Session

- **Agent doesn't respond fast enough** — pre-warm them with a throwaway message before recording. First message in a Claude session has higher latency.
- **Web UI shows "reconnecting…"** — broker hiccuped. `claude-comms stop && claude-comms start --web` and redo the take.
- **OBS recording is choppy** — NVENC on a 5090 should never choke. Check you're not capturing at 4K when your display is 1440p. Lower FPS to 30 as a last resort.
- **GIF file too large** — drop frame rate first (30 → 15), then color depth (256 → 128), then resolution. Keep resolution as long as you can — pixelated tiny GIFs look cheap.
- **Agents step on each other with overlapping replies** — that's actually good visually. Keep it.
- **You flub a take** — keep rolling. Cut in post. Costs nothing.

---

## Phil-Specific Notes

- Your 5090 laptop handles OBS + NVENC + Claude Code + the daemon all at once without breaking a sweat. Don't worry about resource constraints.
- WSL is captured transparently by Windows-side OBS — no special setup needed.
- You already have dark mode + ember theme dialed in. Don't second-guess the aesthetic.
- The artifact feature is your single strongest "this person can ship real software" demonstration. Lean on it in GIF 2 — version history is the kind of detail senior engineers notice.
