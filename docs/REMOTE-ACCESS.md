# Remote access: host on the desktop, use from anywhere (Tailscale)

Goal: the always-on **desktop** (ethernet) hosts the claude-comms daemon (MQTT
broker + MCP + web UI); the **laptop** uses it — chat, web UI, and Claude Code MCP
— from **any** network, with no public exposure.

Recommended transport: **Tailscale** (mesh VPN / WireGuard). It gives each device
a stable `100.x` IP + MagicDNS name, traverses NAT (no Xfinity port-forwarding, no
dynamic-IP/DDNS, no CGNAT issues), is encrypted, and is reachable only by *your*
devices. Cloudflare Tunnel (public URL) and port-forwarding (insecure + dynamic
IP) are worse fits here.

claude-comms binds `127.0.0.1` by default, so the only work is (1) install
Tailscale and (2) a few config keys. No code changes.

## 0. Runbook for a Claude doing this setup

If you are a Claude Code instance executing this for Phil, follow this exactly.
Make **surgical** edits — never rewrite `config.yaml` wholesale (it holds Phil's
identity key + other settings). Confirm with Phil before `claude-comms stop`.

1. **Which machine am I on?** The HOST is the desktop (always-on ethernet); the
   CLIENT is the laptop. `hostname` + ask Phil if unsure. Do the HOST steps on the
   desktop, the CLIENT steps on the laptop.
2. **Tailscale up + resolve the desktop name.** Ensure Tailscale is installed and
   `tailscale status` works (if not, tell Phil to install it and run
   `tailscale up`). Get the desktop's MagicDNS name:
   `tailscale status --json` → `.Self.DNSName` (strip the trailing dot), e.g.
   `desktop.tailnetXXXX.ts.net`. Call this `DESKTOP`. (Fallback: `tailscale ip -4`
   for the `100.x` IP — works too, just less memorable.)
3. **HOST (desktop):**
   a. Install the client kit: `bash tools/comms-client-kit/install.sh`.
   b. Surgically edit `~/.claude-comms/config.yaml` to the §2 values below
      (only those keys; leave `identity` and everything else intact). Set a real
      `broker.auth.password` (or export `CLAUDE_COMMS_PASSWORD`).
   c. Restart: confirm with Phil, then `claude-comms stop && claude-comms start`.
   d. Verify it's listening on all interfaces:
      `ss -tlnp | grep -E ':(1883|9001|9920|9921)'` → each should show `0.0.0.0`
      (or the tailscale IP), not `127.0.0.1`.
4. **CLIENT (laptop):** ensure Tailscale is up, then do §3 — write the project
   `.mcp.json` pointing at `DESKTOP`, and verify with the §5 checks.
5. **Report** the `DESKTOP` name, the web UI URL, and the verification results back
   to Phil.

## 1. Tailscale (both machines)
- Install Tailscale on the desktop and the laptop; log into the same tailnet.
- Note the desktop's MagicDNS name, e.g. `desktop.tailnetXXXX.ts.net` (used below
  as `DESKTOP`). Enable MagicDNS in the Tailscale admin console.
- The desktop is the host (always on ethernet); the laptop is a client.

## 2. Desktop `~/.claude-comms/config.yaml`
Bind the services so the Tailscale interface can reach them, turn on auth, and
allow the web UI (served over Tailscale) to reach the broker WS + API:

```yaml
broker:
  mode: "host"
  host: "0.0.0.0"          # MQTT TCP 1883 on all interfaces (incl. tailscale)
  port: 1883
  ws_host: "0.0.0.0"       # MQTT WebSocket 9001 on all interfaces (the default)
  ws_port: 9001
  auth:
    enabled: true          # network-reachable now — require credentials
    username: "comms-user"
    password: "<set a strong password, or use CLAUDE_COMMS_PASSWORD env>"
mcp:
  host: "0.0.0.0"          # MCP/REST 9920
  port: 9920
web:
  enabled: true
  host: "0.0.0.0"          # web UI 9921
  port: 9921
  api_base: "http://DESKTOP:9920"            # canonical REST/CSP origin for remote browsers
  csp_extra_connect_src:                     # let the UI open the broker WS over tailscale
    - "ws://DESKTOP:9001"
    - "ws://DESKTOP:9001/mqtt"
  strict_cors: true
```

Replace `DESKTOP` with the real MagicDNS name. Restart: `claude-comms stop && claude-comms start`.

> **The client is origin-aware (no baked hosts).** As of the robust-broker-URL
> change, the web client derives BOTH its REST base and its broker WS URL from
> the page origin (`window.location`), so the same daemon works from every
> origin it's served at:
> - **Desktop**, page `http://localhost:9921` → REST `http://localhost:9920`,
>   broker `ws://localhost:9001/mqtt`. The `api_base` meta hint is **ignored
>   here** because its host (`DESKTOP`) differs from the page host — this is
>   what prevents the desktop hairpin (`net::ERR_CONNECTION_TIMED_OUT` from a
>   host trying to reach its own tailnet IP). The daemon always allows the
>   loopback broker WS in CSP, so localhost access just works.
> - **Laptop**, page `http://DESKTOP:9921` → REST `http://DESKTOP:9920`, broker
>   `ws://DESKTOP:9001/mqtt` (the daemon also *advertises* the broker WS URL via
>   `/api/capabilities`, derived from `api_base`/external host).
> - **HTTPS via `tailscale serve`** (§7) → same-origin `wss://DESKTOP/mqtt`,
>   no explicit port, no mixed content.

> Tighter option: bind to the desktop's Tailscale IP (e.g. `100.x.y.z`) instead of
> `0.0.0.0` so even the home LAN can't reach the services — only the tailnet.

## 3. Laptop
- **Web UI (any network):** browse to `http://DESKTOP:9921`. The web client
  derives the broker URL from the page origin (and prefers the daemon-advertised
  `broker_ws_url` from `/api/capabilities`) → `ws://DESKTOP:9001/mqtt`. Keep
  `ws_port: 9001` in `csp_extra_connect_src` so the WS origin is allowed.
- **Claude Code MCP:** point the project's `.mcp.json` at the desktop:
  ```json
  {"mcpServers": {"claude-comms": {"type": "http", "url": "http://DESKTOP:9920/mcp"}}}
  ```
  Then `/comms-join` / `/comms-team` on the laptop drive the desktop's daemon.

## 4. Security notes
- Tailscale already authenticates devices + encrypts traffic; broker `auth` is
  defense-in-depth. Use Tailscale ACLs to scope which devices may reach the host.
- `0.0.0.0` + Tailscale exposes the services to your LAN **and** tailnet, never the
  public internet (no ports are forwarded on the router). Bind to the Tailscale IP
  to drop LAN exposure too.
- The web UI's broker WS is plain `ws://` (not `wss://`) — fine inside the
  encrypted tailnet; do not expose 9001 publicly.

## 5. Quick verification
From the laptop (on cellular/another wifi, Tailscale up):
- `curl -fsS http://DESKTOP:9920/api/capabilities` → JSON (daemon reachable).
- Open `http://DESKTOP:9921` → web UI loads and the channel populates (broker WS
  connected). If the UI loads but no messages flow, check `csp_extra_connect_src`
  contains the exact `ws://DESKTOP:9001` origin.

## 6. Troubleshooting (Windows + WSL host) — real gotchas

These are the things that actually bit a Windows-desktop-hosting-via-WSL setup:

- **Ports time out from the laptop but `ping <tailscale-ip>` works.** The host is
  reachable but nothing is accepting on the daemon ports. Causes, in order:
  1. **Daemon running inside WSL on the desktop** → its ports live in the WSL VM,
     not on the Windows host's Tailscale interface. Fix: enable **WSL mirrored
     networking** — add to `C:\Users\<you>\.wslconfig`:
     `[wsl2]` / `networkingMode=mirrored`, then `wsl --shutdown` and reopen WSL.
     Then bind `0.0.0.0` (§2). (Alternative: `netsh interface portproxy`.)
  2. **The daemon isn't running.** `wsl --shutdown` kills it; it does NOT
     auto-restart. After any WSL restart/reboot, run `claude-comms start` again
     (consider an autostart). Verify locally on the desktop:
     `curl http://localhost:9920/api/capabilities`.
  3. **Windows Defender Firewall** blocking inbound. PowerShell as admin:
     `New-NetFirewallRule -DisplayName "claude-comms" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9920,9921,9001,1883`
- **Web UI loads but says "Server unreachable / channels unavailable" or "failed
  to fetch" when setting your name.** That's **CORS**: the web UI (`:9921`) calls
  the API (`:9920`) cross-origin, and the API must allow the web origin. This
  daemon auto-allows the web origin derived from `web.api_base`'s host + web port,
  so **setting `api_base` to your Tailscale host (§2) fixes it**. For any *other*
  origin (e.g. a second name/IP), add it to `web.extra_cors_origins`. (You can
  confirm the bug from the laptop: `curl -D - -H "Origin: http://DESKTOP:9921" http://DESKTOP:9920/api/conversations`
  — a healthy response includes `access-control-allow-origin`.)
- **The web UI shows "(unset)" instead of your name.** Web identity is
  **per-browser** (stored in that browser's localStorage), not from the daemon's
  config identity. The UI auto-loads the daemon identity from `/api/identity` —
  but only if CORS works (fix the point above first). Each device/browser is its
  own participant; set your Display Name per browser, or it stays the local key.
- **On the desktop, `http://localhost:9921` loops on "Reconnecting to broker".**
  When the daemon runs in **WSL2**, `localhost` on the Windows browser does NOT
  reach an in-WSL **loopback** broker bind — only the Tailscale/LAN host does.
  Two things make localhost work now: (1) the broker WS binds `0.0.0.0` by
  default (confirm with `ss -tlnp | grep 9001` → `0.0.0.0:9001`), and (2) the
  daemon always allows the loopback broker WS in CSP. If it still loops, you are
  almost certainly hitting WSL2 networking, not CSP — enable **mirrored
  networking** (above) or just use the **Tailscale/LAN host** the daemon
  advertises (`http://DESKTOP:9921`), which the client picks up from
  `/api/capabilities`. The browser console names the exact URL it's attempting
  (e.g. `Reconnecting to broker (ws://localhost:9001/mqtt)...`).
- **On the desktop, REST fails with `net::ERR_CONNECTION_TIMED_OUT` to your own
  Tailscale name.** A host can't reach its own tailnet IP (no hairpin). The
  client no longer bakes the `api_base` host when you load the page from a
  *different* host: loading `http://localhost:9921` derives REST as
  `http://localhost:9920` and ignores the `DESKTOP` `api_base` meta hint. So
  **the desktop must use `localhost`, not its own Tailscale hostname.** (The
  `api_base` hint is still honored on the laptop, where the page host *is*
  `DESKTOP`.)

## 7. HTTPS via `tailscale serve` (secure-context features, single origin)

Plain `http://DESKTOP:9921` works inside the tailnet, but browsers treat it as
an **insecure context**, so clipboard, notifications, and Web Crypto are
disabled on the laptop (they ARE enabled on the desktop because `localhost` is
always a secure context). To get all secure-context features on remote devices,
serve the UI over HTTPS on the MagicDNS name with `tailscale serve`, putting the
web UI and the broker WS on **one origin** (no mixed content, no extra ports):

```bash
# On the DESKTOP. Verified against Tailscale Serve docs (CLI as of 2025/2026:
# tailscale serve v1.7x+; --https, --set-path, --bg are stable).

# 1) Web UI at the root path, HTTPS on 443.
tailscale serve --bg --https=443 http://127.0.0.1:9921

# 2) Broker WebSocket at /mqtt on the SAME HTTPS origin.
#    The broker's WS listener is on 9001; serve proxies WebSocket upgrades.
tailscale serve --bg --https=443 --set-path=/mqtt http://127.0.0.1:9001

# Confirm the mounts:
tailscale serve status
```

Then browse to `https://DESKTOP/` from the laptop. The client detects the HTTPS
origin and connects the broker to **`wss://DESKTOP/mqtt`** (same origin, no
explicit port) — handled by the same-origin branch of the broker-URL resolver.
REST is same-origin (`/api/*`) over HTTPS as well.

Notes:
- **Local stays plain HTTP.** The desktop still uses `http://localhost:9921`
  (already a secure context); do not route the desktop through its own
  `tailscale serve` origin — that would hairpin.
- **No mixed content.** Because both the page and the WS are `https`/`wss` on
  one origin, there is no `ws://`-from-`https://` block.
- **CORS/CSP.** Same-origin requests need no cross-origin allow-listing; the
  daemon's CSP `'self'` covers same-origin `wss`. Keep the direct `:9921`/`:9001`
  config too if you also want the non-HTTPS path to keep working.
- If your `tailscale serve` build differs, run `tailscale serve --help` — older
  builds used `tailscale serve https / <target>` positional syntax; `--set-path`
  + `--bg` is the current form.
