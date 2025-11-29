#!/bin/bash

# Standalone multi-instance test script
# Usage: ./run-multi-instance-test.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================"
echo -e "NPK Multi-Instance Test (Standalone)"
echo -e "========================================${NC}"

# Set environment to run only multi-instance test
export TEST_SCENARIO=multi-instance

# Run test
exec /app/tests/docker/scripts/run-e2e-tests.sh
