# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentHiFive, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@agenthifive.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide an initial assessment within 5 business days.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Security Practices

- All credentials encrypted at rest with AES-256-GCM
- JWT-based authentication with short-lived tokens (5-minute TTL)
- Workspace-scoped data isolation enforced at JWT level
- SSRF protection on all outbound proxy requests
- Rate limiting at both IP and agent policy levels
- Comprehensive audit logging for all vault operations
- No raw SQL — all queries via Drizzle ORM to prevent injection
