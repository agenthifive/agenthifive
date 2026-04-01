# AgentHiFive Integration Testing Makefile
# Fully containerized environment -- FE, BE, DB, Nginx all in Docker

COMPOSE := docker compose

.PHONY: up down down-hard clean test e2e logs rebuild

## Start full stack
up:
	cp -n .env.example .env || true
	$(COMPOSE) up -d --build
	@echo "Waiting for services to be healthy..."
	@$(COMPOSE) exec postgres pg_isready -U agenthifive > /dev/null 2>&1 || sleep 5
	@echo "Integration environment ready."

## Stop (includes e2e profile so echo/runner containers are also removed)
down:
	$(COMPOSE) --profile e2e down

## Clean slate -- remove volumes, networks, orphans
down-hard: clean
clean:
	$(COMPOSE) --profile e2e down --volumes --remove-orphans

## Run integration tests against running stack
test:
	$(COMPOSE) exec api pnpm test:integration

## Tail logs
logs:
	$(COMPOSE) logs -f

## Run E2E agent auth + vault integration tests
## Only starts services needed: postgres, web, api, echo (skips docs, nginx)
e2e:
	cp -n .env.example .env || true
	$(COMPOSE) --profile e2e up -d --build postgres web api echo
	$(COMPOSE) --profile e2e run --rm e2e-runner
	@echo "E2E tests complete."

## Force rebuild and restart
rebuild:
	$(COMPOSE) --profile e2e down --volumes --remove-orphans
	$(COMPOSE) up -d --build --force-recreate
