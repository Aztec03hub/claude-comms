# Security Policy

## Status

`claude-comms` is in **alpha** (PyPI classifier `Development Status :: 3 - Alpha`). It has not undergone independent security review. Use accordingly.

## Threat Model

The MCP server and embedded MQTT broker bind to `127.0.0.1` by default. **The loopback bind is the primary security boundary.** There is currently no authentication layer on the MCP server, and the embedded broker does not enforce ACLs.

If you choose to expose the daemon beyond loopback (for example over a Tailscale network), you are responsible for:

- placing it behind an authenticated reverse proxy
- enforcing TLS termination
- enforcing per-user authorization
- rate limiting

## Known Limitations

- No authentication on the MCP tool surface
- No rate limiting
- Single-process embedded MQTT broker (amqtt), not designed for multi-tenant production load
- No external broker support yet
- amqtt does not bridge its TCP (`:1883`) and WebSocket (`:9001`) listeners; use WebSocket for all clients

## Reporting a Vulnerability

Please report security issues via [GitHub Security Advisories](https://github.com/Aztec03hub/claude-comms/security/advisories) on this repository, or by email to `plafaydev@gmail.com`. Please do not open a public issue for a security report.

I aim to respond within one week. I cannot promise an SLA; this is a single-contributor alpha project.
