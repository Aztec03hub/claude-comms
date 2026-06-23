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
  ws_host: "0.0.0.0"       # MQTT WebSocket 9001 — KEEP 9001 (web client hardcodes it)
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
  api_base: "http://DESKTOP:9920"            # UI's /api + CSP target
  csp_extra_connect_src:                     # let the UI open the broker WS over tailscale
    - "ws://DESKTOP:9001"
    - "ws://DESKTOP:9001/mqtt"
  strict_cors: true
```

Replace `DESKTOP` with the real MagicDNS name. Restart: `claude-comms stop && claude-comms start`.

> Tighter option: bind to the desktop's Tailscale IP (e.g. `100.x.y.z`) instead of
> `0.0.0.0` so even the home LAN can't reach the services — only the tailnet.

## 3. Laptop
- **Web UI (any network):** browse to `http://DESKTOP:9921`. It works because the
  web client derives the broker URL from `window.location.hostname` → `DESKTOP` →
  `ws://DESKTOP:9001/mqtt` (that's why `ws_port` must stay 9001 and be in
  `csp_extra_connect_src`).
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
