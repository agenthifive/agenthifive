# AgentHiFive Development Makefile
# Usage: make <target>

COMPOSE := docker compose
TURBO   := pnpm turbo

.PHONY: help prereqs init reset-env up up-all down down-hard dev dev-ul dev-ul-stop dev-ul-logs dev-web dev-api dev-docs build \
        build-docs serve-docs migrate migrate-generate db-reset psql dummydata clean kill logs lint typecheck test

## Default target
help:
	@echo "AgentHiFive Development"
	@echo ""
	@echo "  make prereqs          Install prerequisites (nvm, Node.js 24, pnpm, Docker)"
	@echo "  make init             First-time setup (install, DB, migrations)"
	@echo "  make reset-env        Reset .env from .env.example (WARNING: deletes current .env)"
	@echo "  make dev              Start all dev servers (web + api)"
	@echo "  make dev-ul           Start dev servers in background (survives SSH disconnect)"
	@echo "  make dev-ul-stop      Stop background dev servers"
	@echo "  make dev-ul-logs      Tail background dev server logs"
	@echo "  make dev-web          Start only Next.js (port 3000)"
	@echo "  make dev-api          Start only Fastify (port 4000)"
	@echo "  make dev-docs         Start Docusaurus dev server (port 3001)"
	@echo ""
	@echo "  make up               Start infra (Postgres only)"
	@echo "  make up-all           Start infra (Postgres + Nginx)"
	@echo "  make down             Stop infra"
	@echo "  make down-hard        Stop infra + delete volumes"
	@echo "  make logs             Tail Docker logs"
	@echo ""
	@echo "  make build            Build all packages"
	@echo "  make build-docs       Build documentation site"
	@echo "  make serve-docs       Serve built docs locally"
	@echo "  make typecheck        Run TypeScript checks"
	@echo "  make lint             Run linter"
	@echo "  make test             Run tests"
	@echo ""
	@echo "  make migrate          Run DB migrations"
	@echo "  make migrate-generate Generate new migration"
	@echo "  make db-reset         Drop + recreate DB"
	@echo "  make psql             Connect to PostgreSQL shell"
	@echo "  make dummydata        Seed example data (OpenClaw agent + permission requests)"
	@echo ""
	@echo "  make clean            Remove all build artifacts + node_modules"
	@echo "  make kill             Stop everything (Docker + dev servers)"

## Install prerequisites (nvm, Node.js 24, pnpm, Docker)
prereqs:
	@echo "Checking prerequisites..."
	@# --- Docker ---
	@if command -v docker > /dev/null 2>&1; then \
		echo "✓ Docker $$(docker version --format '{{.Client.Version}}' 2>/dev/null || echo 'installed')"; \
	else \
		echo "Installing Docker..."; \
		curl -fsSL https://get.docker.com | sh; \
		sudo usermod -aG docker $$USER; \
		echo "✓ Docker installed"; \
		echo "  ⚠️  Log out and back in for Docker group membership to take effect"; \
	fi
	@# --- nvm + Node.js + pnpm (must run in one shell so nvm function is available) ---
	@export NVM_DIR="$${NVM_DIR:-$$HOME/.nvm}"; \
	if [ ! -s "$$NVM_DIR/nvm.sh" ]; then \
		echo "Installing nvm..."; \
		curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; \
		echo "✓ nvm installed"; \
	else \
		echo "✓ nvm already installed"; \
	fi; \
	. "$$NVM_DIR/nvm.sh"; \
	CURRENT_MAJOR=$$(node -v 2>/dev/null | cut -d. -f1 | tr -d v); \
	if [ -z "$$CURRENT_MAJOR" ] || [ "$$CURRENT_MAJOR" -lt 24 ]; then \
		echo "Installing Node.js 24 (current: $$(node -v 2>/dev/null || echo 'none'))..."; \
		nvm install 24; \
		nvm alias default 24; \
		echo "✓ Node.js $$(node -v) installed"; \
	else \
		echo "✓ Node.js $$(node -v)"; \
	fi; \
	corepack enable 2>/dev/null || true; \
	if command -v pnpm > /dev/null 2>&1; then \
		echo "✓ pnpm $$(pnpm -v)"; \
	else \
		echo "Installing pnpm via corepack..."; \
		corepack prepare pnpm@9 --activate; \
		echo "✓ pnpm $$(pnpm -v) installed"; \
	fi
	@echo ""
	@echo "✅ Prerequisites installed."
	@echo "   Open a new terminal (to load nvm), then run: make init"

## First-time setup
init:
	@echo "Setting up environment..."
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "✓ Created .env from .env.example"; \
	else \
		echo "✓ .env already exists (preserved your credentials)"; \
	fi
	@if [ ! -L apps/web/.env ]; then \
		ln -sf ../../.env apps/web/.env; \
		echo "✓ Created apps/web/.env symlink"; \
	else \
		echo "✓ apps/web/.env symlink already exists"; \
	fi
	@echo ""
	pnpm install --force
	$(TURBO) build --filter='./packages/*'
	$(COMPOSE) up -d postgres
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(COMPOSE) exec postgres pg_isready -U agenthifive > /dev/null 2>&1; do sleep 1; done
	@echo "Resetting database (dropping and recreating)..."
	@echo "Terminating active database connections..."
	-$(COMPOSE) exec postgres psql -U agenthifive -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'agenthifive' AND pid <> pg_backend_pid();" > /dev/null 2>&1
	$(COMPOSE) exec postgres dropdb -U agenthifive --if-exists agenthifive
	$(COMPOSE) exec postgres createdb -U agenthifive agenthifive
	@echo "Running migrations..."
	pnpm --filter @agenthifive/api run migrate
	@echo ""
	@echo "✅ Setup complete! Run 'make dev' to start development."
	@echo "💡 Tip: Run 'make dummydata' to seed example agent permission requests."

## Reset environment file (WARNING: deletes your .env!)
reset-env:
	@echo "⚠️  This will DELETE your current .env and reset from .env.example"
	@read -p "Are you sure? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		rm -f .env; \
		cp .env.example .env; \
		if [ ! -L apps/web/.env ]; then \
			ln -sf ../../.env apps/web/.env; \
		fi; \
		echo "✓ Reset .env from .env.example"; \
	else \
		echo "Cancelled."; \
	fi

## Infrastructure
up:
	$(COMPOSE) up -d postgres

up-all:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

down-hard:
	$(COMPOSE) down --volumes --remove-orphans

## App services (run natively for HMR + debugging)
dev:
	$(TURBO) dev

dev-ul:
	@echo "Starting dev servers in background..."
	@bash -c 'set -m; nohup $(TURBO) dev > .dev.log 2>&1 & echo $$! > .dev.pid; disown'
	@echo "✓ Dev servers started (PID: $$(cat .dev.pid))"
	@echo "  Logs: make dev-ul-logs"
	@echo "  Stop: make dev-ul-stop"

dev-ul-stop:
	@if [ -f .dev.pid ]; then \
		PID=$$(cat .dev.pid); \
		if kill -0 $$PID 2>/dev/null; then \
			PIDS=$$(pstree -p $$PID | grep -oP '\(\d+\)' | tr -d '()' | tr '\n' ' '); \
			kill $$PIDS 2>/dev/null; \
			sleep 0.5; \
			for p in $$PIDS; do kill -0 $$p 2>/dev/null && kill -9 $$p 2>/dev/null; done; \
			echo "✓ Stopped dev servers ($$PID) and all children"; \
		else \
			echo "Dev servers not running (stale PID: $$PID)"; \
		fi; \
		rm -f .dev.pid; \
	else \
		echo "No .dev.pid file found — trying to find turbo dev processes..."; \
		pkill -f "turbo.*dev" 2>/dev/null && echo "✓ Killed turbo dev processes" || echo "No turbo dev processes found"; \
	fi

dev-ul-logs:
	@if [ -f .dev.log ]; then \
		tail -f .dev.log; \
	else \
		echo "No .dev.log file found — run 'make dev-ul' first"; \
	fi

dev-web:
	$(TURBO) dev --filter=@agenthifive/web

dev-api:
	$(TURBO) dev --filter=@agenthifive/api

dev-docs:
	$(TURBO) dev --filter=@agenthifive/docs

## Build
build:
	$(TURBO) build

build-docs:
	$(TURBO) build --filter=@agenthifive/docs

serve-docs:
	pnpm --filter @agenthifive/docs serve

## Database
migrate:
	pnpm --filter @agenthifive/api run migrate

migrate-generate:
	pnpm --filter @agenthifive/api run migrate-generate

db-reset:
	@echo "Terminating active database connections..."
	-$(COMPOSE) exec postgres psql -U agenthifive -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'agenthifive' AND pid <> pg_backend_pid();" > /dev/null 2>&1
	$(COMPOSE) exec postgres dropdb -U agenthifive --if-exists agenthifive
	$(COMPOSE) exec postgres createdb -U agenthifive agenthifive
	pnpm --filter @agenthifive/api run migrate

psql:
	$(COMPOSE) exec postgres psql -U agenthifive -d agenthifive

dummydata:
	@echo "🌱 Seeding example data for all workspaces..."
	cd apps/api && pnpm exec tsx --env-file=../../.env src/db/seed-agent-permission-requests.ts
	@echo "✅ Dummy data seeded! Each workspace now has an OpenClaw agent with 4 permission requests."

## Quality
lint:
	$(TURBO) lint

typecheck:
	$(TURBO) typecheck

test:
	$(TURBO) test

## Logs
logs:
	$(COMPOSE) logs -f

## Cleanup
clean:
	$(COMPOSE) down --volumes --remove-orphans
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/.next apps/*/dist packages/*/dist
	rm -rf .turbo apps/*/.turbo packages/*/.turbo

kill:
	$(COMPOSE) down --volumes --remove-orphans
	-pkill -f "next dev" 2>/dev/null || true
	-pkill -f "tsx watch" 2>/dev/null || true
