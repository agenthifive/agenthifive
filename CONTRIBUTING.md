# Contributing to AgentHiFive

Thank you for your interest in contributing to AgentHiFive! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/agenthifive.git`
3. Install prerequisites: `make prereqs`
4. Set up the development environment: `make init`
5. Start development: `make dev`

## Development Workflow

1. Create a feature branch from `main`: `git checkout -b feat/your-feature`
2. Make your changes
3. Run quality checks: `make lint && make typecheck`
4. Run tests: `make test`
5. Commit your changes with a clear message
6. Push to your fork and open a Pull Request

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation if you change API behavior
- Ensure all CI checks pass before requesting review
- Write clear commit messages explaining **why**, not just what

## Code Style

- TypeScript strict mode everywhere
- Files and directories: `kebab-case`
- Variables: `camelCase`, Types: `PascalCase`
- Database tables: `snake_case` with prefix (`t_`, `d_`, `l_`, `r_`)
- No raw SQL — use Drizzle ORM operators
- Zod schemas in `packages/contracts`, not in route files

## Testing

We use `node:test` with real PostgreSQL (Docker). See the [testing section](CLAUDE.md#testing) in CLAUDE.md for patterns and gotchas.

```bash
make test                    # Full suite
cd apps/api && bash run-tests.sh   # API tests only
```

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
- Include reproduction steps for bugs
- Check existing issues before creating a new one

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
