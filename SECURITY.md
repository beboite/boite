# Security

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/beboite/boite/security/advisories/new).
Do not open a public issue, pull request or discussion for them.

Include the affected version or commit, the platform, the steps to reproduce and
what an attacker gains. Remove real tokens, pairing links, session identifiers
and conversation content from the report; describe them instead.

The maintainers answer in the advisory, and a fix is published with the advisory
once a release carries it.

## Supported versions

boite is in beta. Only the latest release and the `main` branch receive security
fixes. Nightly builds get the fix from the next nightly.

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
