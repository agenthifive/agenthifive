#!/bin/bash
set -e

# Source nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Navigate to api directory
cd "$(dirname "$0")"

echo "========================================"
echo "AgentHiFive API Test Suite"
echo "========================================"
echo ""

# Step 1: Start test database
echo "📦 Starting test database..."
docker compose -f docker-compose.test.yml up -d --wait

if [ $? -ne 0 ]; then
  echo "❌ Failed to start test database"
  exit 1
fi

echo "✅ Test database ready on port 5433"
echo ""

# Step 2: Set test database URL
export DATABASE_URL="postgresql://test:test_password@localhost:5433/agenthifive_test"
echo "🔧 Using test database: $DATABASE_URL"
echo ""

# Step 3: Run migrations
echo "🔄 Running database migrations..."
pnpm migrate-push --force 2>&1 | grep -v "drizzle-kit" | grep -v "Reading config" || true

if [ $? -ne 0 ]; then
  echo "❌ Failed to run migrations"
  exit 1
fi

echo "✅ Migrations applied"
echo ""

# Step 4: Run tests
echo "🧪 Running tests..."
echo ""
node --experimental-test-module-mocks --import tsx --test --test-force-exit --test-concurrency=1 'src/__tests__/**/*.test.ts' 2>&1

TEST_EXIT_CODE=$?

echo ""
echo "========================================"
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo "✅ All tests passed!"
else
  echo "❌ Some tests failed (exit code: $TEST_EXIT_CODE)"
fi
echo "========================================"
echo ""
echo "💡 Test database is still running. To stop it:"
echo "   pnpm test:db:down"
echo ""
echo "💡 To reset test database:"
echo "   pnpm test:db:reset"
echo ""

exit $TEST_EXIT_CODE
