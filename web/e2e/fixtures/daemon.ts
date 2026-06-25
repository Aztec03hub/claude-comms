// daemon.ts — per-test-file claude-comms daemon spawner + teardown.
//
// Architecture spec: v0.4.3 Phase 1, Option B (per-test-file fixture).
// Each scenario gets:
//   - an isolated $HOME pointing at /tmp/cc-e2e-<id>
//   - a fully populated ~/.claude-comms/{config.yaml,registry.db,logs,conversations,artifacts}
//   - dedicated ports for MCP (REST API), web UI, MQTT TCP, MQTT WebSocket
//
// IMPORTANT: the CLI does NOT expose --port-mcp / --port-web / --data-dir flags
// (verified in src/claude_comms/cli.py). All daemon paths are derived from
// Path.home(), so we override HOME on the spawned process to redirect every
// path. Ports come from config.yaml.

import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

// Resolve repo paths relative to this fixture file. Works under ESM (no __dirname).
// daemon.ts lives at web/e2e/fixtures/daemon.ts; repo root is 3 levels up; the
// Python package source dir is at <repo>/src.
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(FIXTURE_DIR, '..', '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');

export interface DaemonPorts {
  mcp: number;       // claude-comms REST API + MCP HTTP
  web: number;       // static web UI (Starlette)
  mqttTcp: number;   // EmbeddedBroker MQTT/TCP
  mqttWs: number;    // EmbeddedBroker MQTT/WebSocket
}

export interface DaemonHandle {
  proc: ChildProcess;
  ports: DaemonPorts;
  home: string;
  dataDir: string;
  identity: { key: string; name: string; type: 'human' | 'claude' };
  /** URL of the web UI (static bundle). Browser navigates here via page.goto(). */
  baseURL: string;
  /** URL of the MCP/API server. Use for direct `fetch` smoke tests. */
  apiURL: string;
  stop: () => Promise<void>;
}

// Port budget.
//
// EVERY port is slot-scoped so N daemons run side by side (workers > 1).
//
// The MQTT ports used to be PINNED to 1883 / 9001 because the web UI was
// believed to hardcode `ws://${hostname}:9001/mqtt`. That pin is now OBSOLETE:
// the single-origin refactor (PRs #23-26) moved the browser's broker connection
// to a same-origin `/mqtt` WebSocket bridged onto the daemon's WEB port. The
// daemon advertises `broker_ws_same_origin: true` via /api/capabilities, so
// mqtt-store's `resolveBrokerUrl()` connects to `ws://<page-host>:<web-port>/mqtt`
// — NOT a hardcoded 9001. The daemon still BINDS a broker TCP listener
// (broker.port) and a broker WS listener (broker.ws_port) for its own internal
// MQTT client + non-web (TUI/MCP/doctor) clients, so both must still get a
// unique, slot-scoped port to avoid cross-worker collisions; the browser path
// never touches them.
//
// Each slot reserves a contiguous 10-port window (mcp .. mqttWs use offsets
// 0..3), so slots never overlap.
const PORT_BASE = {
  mcp: 9930,
  web: 9931,
  mqttTcp: 9932,
  mqttWs: 9933,
};

export function portsForSlot(slot: number): DaemonPorts {
  return {
    mcp: PORT_BASE.mcp + slot * 10,
    web: PORT_BASE.web + slot * 10,
    mqttTcp: PORT_BASE.mqttTcp + slot * 10,
    mqttWs: PORT_BASE.mqttWs + slot * 10,
  };
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function waitForPortFreeOrTaken(port: number, taken: boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const free = await isPortFree(port);
    if (free !== taken) return;  // want taken=true => wait until !free
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for port ${port} to become ${taken ? 'in-use' : 'free'}`);
}

export interface IdentitySeed {
  key: string;      // 8 hex chars
  name: string;     // display name
  type: 'human' | 'claude';
}

export interface ConfigOptions {
  identity: IdentitySeed;
  ports: DaemonPorts;
}

/**
 * Write a complete config.yaml that overrides every default Phil's daemon
 * uses. This is the daemon's identity + auth + ports + data-dir surface.
 * Auth is disabled to avoid MQTT credentials dance during E2E.
 */
function buildConfigYaml(opts: ConfigOptions): string {
  const { identity, ports } = opts;
  return [
    'identity:',
    `  key: "${identity.key}"`,
    `  name: "${identity.name}"`,
    `  type: "${identity.type}"`,
    'broker:',
    '  mode: "host"',
    '  host: "127.0.0.1"',
    `  port: ${ports.mqttTcp}`,
    '  ws_host: "127.0.0.1"',
    `  ws_port: ${ports.mqttWs}`,
    '  auth:',
    '    enabled: false',
    '    username: "comms-user"',
    '    password: "e2e-password"',
    'mcp:',
    '  host: "127.0.0.1"',
    `  port: ${ports.mcp}`,
    '  auto_join:',
    '    - "general"',
    'web:',
    '  enabled: true',
    '  host: "127.0.0.1"',
    `  port: ${ports.web}`,
    // Tell the bundled UI to call the MCP/API server cross-port. The web server
    // hosts only static assets; all /api/* routes live on the MCP server.
    // This triggers reverse-proxy mode (POST /api/artifacts disabled) which
    // is fine for read-mostly E2E scenarios. Scenarios that exercise that
    // POST should override `web.api_base` to null and run a same-port web+API.
    `  api_base: "http://127.0.0.1:${ports.mcp}"`,
    '  strict_cors: true',
    '  markdown_render_enabled: true',
    // Single-origin: the browser connects to ws://<web-host>:<web-port>/mqtt
    // (same origin as the page), which CSP connect-src 'self' already permits,
    // so no broker-WS-port whitelist is needed. We still whitelist the slot's
    // own broker WS port defensively for any legacy/cached bundle that derives
    // ws://host:<ws_port>/mqtt from the advertised broker_ws_port.
    '  csp_extra_connect_src:',
    `    - "ws://127.0.0.1:${ports.mqttWs}"`,
    `    - "ws://127.0.0.1:${ports.mqttWs}/mqtt"`,
    `    - "ws://localhost:${ports.mqttWs}"`,
    `    - "ws://localhost:${ports.mqttWs}/mqtt"`,
    'notifications:',
    '  hook_enabled: false',
    '  sound_enabled: false',
    'presence:',
    '  connection_ttl_seconds: 180',
    '  sweep_interval_seconds: 30',
    'logging:',
    '  format: "both"',
    '  max_messages_replay: 1000',
    'default_conversation: "general"',
    '',
  ].join('\n');
}

export interface SpawnDaemonOptions {
  slot: number;                 // port-allocation slot (0, 1, 2, ...)
  identity: IdentitySeed;       // identity for the daemon-owner
  seed: (home: string) => Promise<void>;  // populate registry.db + meta.json + .jsonl BEFORE start
  startupTimeoutMs?: number;
}

const READY_MARKER = 'Daemon running';

/**
 * Spawn a claude-comms daemon in an isolated $HOME with seeded test data.
 * Returns a handle with stop() that SIGTERMs the process and cleans up.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonHandle> {
  const ports = portsForSlot(opts.slot);
  const startupTimeoutMs = opts.startupTimeoutMs ?? 20000;

  // Verify ports are free before we try to bind. All ports are slot-scoped,
  // so a collision here means a stale e2e daemon (or another process) is
  // squatting on this slot's window — not a pinned-port conflict.
  for (const p of [ports.mcp, ports.web, ports.mqttTcp, ports.mqttWs]) {
    if (!(await isPortFree(p))) {
      throw new Error(
        `E2E port ${p} (slot ${opts.slot}) is already in use. ` +
        `Check for stale e2e daemons (pkill -f 'claude-comms start').`
      );
    }
  }

  // Allocate the isolated HOME.
  const home = await mkdtemp(join(tmpdir(), 'cc-e2e-'));
  const dataDir = join(home, '.claude-comms');
  await mkdir(join(dataDir, 'logs'), { recursive: true });
  await mkdir(join(dataDir, 'conversations'), { recursive: true });
  await mkdir(join(dataDir, 'artifacts'), { recursive: true });

  // Write config.yaml BEFORE seeding (so seedData.ts can read identity if needed).
  const configYaml = buildConfigYaml({ identity: opts.identity, ports });
  await writeFile(join(dataDir, 'config.yaml'), configYaml, { mode: 0o600 });

  // Caller seeds registry.db + conv/<name>/meta.json + logs/<name>.jsonl files.
  await opts.seed(home);

  // Spawn the daemon. HOME override is the critical knob — every Path.home()
  // call inside the daemon now lands inside our isolated tree.
  //
  // We use the installed `claude-comms` shell wrapper (e.g. ~/.local/bin/) so
  // the tests run against the same entry point Phil uses. Override via
  // CC_E2E_DAEMON_CMD if a different binary is needed (e.g. CI).
  const cmd = process.env.CC_E2E_DAEMON_CMD || 'claude-comms';

  // Because we override HOME, Python no longer auto-discovers the user's
  // ~/.local/lib/python3.X/site-packages directory (site.USER_SITE recomputes
  // off HOME) and the editable .pth file pointing at the repo src dir is
  // therefore not processed. Preserve module resolution by explicitly listing
  // BOTH the user site-packages AND the repo src dir on PYTHONPATH.
  //
  // CC_E2E_PYTHONPATH overrides for non-editable installs (e.g. wheel-only
  // CI environment) where the .pth is absent.
  const realHome = process.env.HOME || '';
  const repoSrc = process.env.CC_E2E_REPO_SRC || REPO_SRC;
  const defaultPythonPath = [
    repoSrc,
    `${realHome}/.local/lib/python3.12/site-packages`,
    `${realHome}/.local/lib/python3.13/site-packages`,
    `${realHome}/.local/lib/python3.11/site-packages`,
    '/usr/local/lib/python3.12/dist-packages',
    '/usr/lib/python3/dist-packages',
  ].filter(Boolean).join(':');
  const pythonPath = process.env.CC_E2E_PYTHONPATH || defaultPythonPath;

  const proc = spawn(cmd, ['start'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      // Belt-and-braces in case any code path reads XDG/USERPROFILE on this host.
      XDG_CONFIG_HOME: join(home, '.config'),
      USERPROFILE: home,
      // No password needed when broker.auth.enabled=false, but set anyway.
      CLAUDE_COMMS_PASSWORD: 'e2e-password',
      // Force stdout to be unbuffered so we can detect the ready marker quickly.
      PYTHONUNBUFFERED: '1',
      // Preserve module resolution despite HOME override.
      PYTHONPATH: pythonPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Capture output for diagnostics + ready detection.
  const logLines: string[] = [];
  const ready: Promise<void> = new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      reject(new Error(
        `Daemon failed to emit "${READY_MARKER}" within ${startupTimeoutMs}ms. ` +
        `Last output:\n${logLines.slice(-30).join('')}`
      ));
    }, startupTimeoutMs);

    const onLine = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      logLines.push(text);
      if (!resolved && text.includes(READY_MARKER)) {
        resolved = true;
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on('data', onLine);
    proc.stderr?.on('data', onLine);
    proc.once('exit', (code, signal) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(
          `Daemon exited early (code=${code}, signal=${signal}). ` +
          `Output:\n${logLines.join('')}`
        ));
      }
    });
  });

  await ready;

  // Also wait for the web port to actually be listening before returning —
  // the "Daemon running" marker is printed AFTER all servers are started,
  // but a 50ms grace makes flakes vanish on slow machines.
  await waitForPortFreeOrTaken(ports.web, true, 5000);

  const baseURL = `http://127.0.0.1:${ports.web}`;
  const apiURL = `http://127.0.0.1:${ports.mcp}`;
  const stop = async (): Promise<void> => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
      // Give it 5s to flush meta.json + close MQTT cleanly.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Wipe the isolated data dir. Each scenario starts from a clean slate.
    await rm(home, { recursive: true, force: true });
  };

  return {
    proc,
    ports,
    home,
    dataDir,
    identity: opts.identity,
    baseURL,
    apiURL,
    stop,
  };
}
