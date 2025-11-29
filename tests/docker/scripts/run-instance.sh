#!/bin/bash
#
# NPK Instance Runner
# Runs a single hashcat instance in its own container

set -e

INSTANCE_NUM=$1

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "[INST-$INSTANCE_NUM] $@"
}

log "${BLUE}========================================${NC}"
log "${BLUE}NPK Instance $INSTANCE_NUM Starting${NC}"
log "${BLUE}========================================${NC}"

# Wait for orchestrator to complete setup
log "${YELLOW}Waiting for test data setup...${NC}"
while [ ! -f /shared-test-data/SETUP_COMPLETE ]; do
    sleep 1
done
log "${GREEN}✓ Test data ready${NC}"

# Read test configuration
export CAMPAIGN_ID=$(cat /shared-test-data/CAMPAIGN_ID)
export USER_ID=$(cat /shared-test-data/USER_ID)
export MANIFEST_PATH=$(cat /shared-test-data/MANIFEST_PATH)
export SESSION_NAME="${CAMPAIGN_ID}-${INSTANCE_NUM}"

# Set environment variables that hashcat_wrapper expects
export ManifestPath="$MANIFEST_PATH"   # Capital M - required by hashcat_wrapper.js
export CampaignId="$CAMPAIGN_ID"        # Capital C and I
export UserId="$USER_ID"                # Capital U and I

log "Campaign ID: $CAMPAIGN_ID"
log "User ID: $USER_ID"
log "Manifest Path: $MANIFEST_PATH"
log "Session Name: $SESSION_NAME"

# Create test version of hashcat_wrapper.js
log "${YELLOW}Preparing hashcat_wrapper...${NC}"
cp /app/hashcat_wrapper.js /test-data/hashcat_wrapper_test.js

# Patch for LocalStack
sed -i '/var s3 = new aws.S3/c\
var s3 = new aws.S3({\
  region: primaryRegion,\
  endpoint: process.env.S3_ENDPOINT || undefined,\
  s3ForcePathStyle: true\
});' /test-data/hashcat_wrapper_test.js

# Mock API Gateway
sed -i "s|var apiClientFactory = require('aws-api-gateway-client').default;|var apiClientFactory = { newClient: function() { return { invokeApi: function() { return Promise.resolve({ status: 200 }); } }; } };|" /test-data/hashcat_wrapper_test.js

# Remove --quiet flag for testing
if [ "$ENABLE_HASHCAT_OUTPUT" = "1" ]; then
  sed -i '/"--quiet",/d' /test-data/hashcat_wrapper_test.js
  log "Hashcat output: Enabled"
fi

log "${GREEN}✓ hashcat_wrapper_test.js ready${NC}"

# Copy test data to /root for hashcat_wrapper to use
mkdir -p /root/npk-wordlist
cp /shared-test-data/hashes.txt /root/hashes.txt
cp /shared-test-data/wordlist.txt /root/npk-wordlist/test-wordlist.txt
cp /shared-test-data/manifest-inst${INSTANCE_NUM}.json /root/manifest.json

log "${GREEN}✓ Test data copied to /root${NC}"

# Run hashcat wrapper
log "\n${BLUE}========================================${NC}"
log "${BLUE}Starting Hashcat (Instance $INSTANCE_NUM)${NC}"
log "${BLUE}========================================${NC}"

cd /test-data
exec node hashcat_wrapper_test.js
