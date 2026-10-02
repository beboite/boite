# Security

## Reporting a vulnerability

Use
[GitHub's private vulnerability reporting](https://github.com/beboite/boite/security/advisories/new).
Do not report vulnerabilities in public issues, pull requests or discussions.

Include the affected version or commit, platform, reproduction steps and what
an attacker gains. Describe tokens, pairing links, session identifiers and
conversation content without including their real values.

Maintainers respond in the advisory. They publish it with the fix once a release
includes that fix.

## Supported versions

boite is in beta. Only the latest release and the `main` branch receive security
fixes. The next nightly build includes those fixes.

## Scope

In scope:

- the core's RPC server: the core token, the origin check and the owner versus
  paired-device permissions in `packages/core/src/access.ts`;
- pairing links, device session tokens and their revocation;
- isolation between accounts, projects and connected machines;
- the process launcher, its Job Objects and resource caps;
- the desktop shell, its installer and the server image.

Out of scope:

- vulnerabilities in the agent CLIs and SDKs themselves (Claude Code, Codex,
  OpenCode, Antigravity, Grok, pi). Report those to their vendors;
- actions an agent takes with the permissions the owner granted it;
- attacks that already require the owner's core token or an owner session.
