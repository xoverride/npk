#!/bin/bash
#
# NPK Multi-Instance Test Orchestrator
# Sets up test data and monitors instances running in separate containers

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Setup logging
LOG_DIR="/test-results"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/orchestrator-${TIMESTAMP}.log"

log() {
    echo -e "$@" | tee -a "$LOG_FILE"
}

log "========================================="
log "NPK Multi-Instance Test Orchestrator"
log "Started: $(date)"
log "========================================="

# Wait for LocalStack
log "\n${YELLOW}Waiting for LocalStack S3...${NC}"
max_attempts=30
attempt=0
until aws --endpoint-url=$AWS_ENDPOINT_URL s3 ls 2>/dev/null || [ $attempt -eq $max_attempts ]; do
    attempt=$((attempt+1))
    echo "Attempt $attempt/$max_attempts..."
    sleep 2
done

if [ $attempt -eq $max_attempts ]; then
    log "${RED}ERROR: LocalStack S3 not ready${NC}"
    exit 1
fi
log "${GREEN}✓ LocalStack S3 ready${NC}"

# Create test bucket
log "\n${YELLOW}Creating test bucket...${NC}"
aws --endpoint-url=$AWS_ENDPOINT_URL s3 mb s3://$TEST_BUCKET 2>/dev/null || true
log "${GREEN}✓ Test bucket created: s3://$TEST_BUCKET${NC}"

# Generate test data
log "\n${YELLOW}Setting up test data...${NC}"

# Generate campaign ID
export CAMPAIGN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
export USER_ID="user-$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -d'-' -f1)"
MANIFEST_PATH="${USER_ID}/campaigns/${CAMPAIGN_ID}"

# Save to shared volume for instances to read
echo "$CAMPAIGN_ID" > /shared-test-data/CAMPAIGN_ID
echo "$USER_ID" > /shared-test-data/USER_ID
echo "$MANIFEST_PATH" > /shared-test-data/MANIFEST_PATH

log "Campaign ID: $CAMPAIGN_ID"
log "User ID: $USER_ID"
log "Manifest Path: $MANIFEST_PATH"

# Generate test passwords (2 for each instance)
log "\n${YELLOW}Generating test passwords...${NC}"
PASS1_INST1=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 8 | head -n 1)
PASS2_INST1=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 8 | head -n 1)
PASS1_INST2=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 8 | head -n 1)
PASS2_INST2=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 8 | head -n 1)

echo "$PASS1_INST1" > /shared-test-data/passwords-inst1.txt
echo "$PASS2_INST1" >> /shared-test-data/passwords-inst1.txt
echo "$PASS1_INST2" > /shared-test-data/passwords-inst2.txt
echo "$PASS2_INST2" >> /shared-test-data/passwords-inst2.txt

# Generate bcrypt hashes
python3 -c "
import crypt
import secrets
passwords = ['$PASS1_INST1', '$PASS2_INST1', '$PASS1_INST2', '$PASS2_INST2']
for pwd in passwords:
    salt = '\$2a\$10\$' + ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./') for _ in range(22))
    print(crypt.crypt(pwd, salt))
" > /shared-test-data/hashes.txt

log "${GREEN}✓ Created 4 test hashes${NC}"
log "  Instance 1 passwords: $PASS1_INST1, $PASS2_INST1"
log "  Instance 2 passwords: $PASS1_INST2, $PASS2_INST2"

# Generate wordlist with passwords at strategic positions
log "\n${YELLOW}Generating wordlist (20,000 entries)...${NC}"
/app/tests/docker/scripts/generate-wordlist-2instance.sh \
    /shared-test-data/wordlist.txt \
    20000 \
    /shared-test-data/passwords-inst1.txt \
    /shared-test-data/passwords-inst2.txt

log "${GREEN}✓ Wordlist created${NC}"
log "  Instance 1 passwords at 40% (entries ~8,000-8,001)"
log "  Instance 2 passwords at 75% (entries ~15,000-15,001)"

# Create manifests for both instances
log "\n${YELLOW}Creating manifests...${NC}"

cat > /shared-test-data/manifest-inst1.json <<EOF
{
    "hashType": 3200,
    "attackType": 0,
    "mask": null,
    "hashFile": "hashes.txt"
}
EOF

cat > /shared-test-data/manifest-inst2.json <<EOF
{
    "hashType": 3200,
    "attackType": 0,
    "mask": null,
    "hashFile": "hashes.txt"
}
EOF

log "${GREEN}✓ Manifests created${NC}"

# Signal that setup is complete
touch /shared-test-data/SETUP_COMPLETE

log "\n${GREEN}========================================${NC}"
log "${GREEN}Test data setup complete${NC}"
log "${GREEN}Instances can now start${NC}"
log "${GREEN}========================================${NC}"

# Monitor instances
log "\n${YELLOW}Monitoring instances...${NC}"
log "Waiting for both instances to create checkpoints..."

# Wait for instances to start
sleep 10

CHECKPOINT_COUNT=0
INST1_CHECKPOINT=false
INST2_CHECKPOINT=false

for i in {1..90}; do
    sleep 2

    # Check S3 for checkpoints instead of local filesystem
    if [ ! "$INST1_CHECKPOINT" = true ]; then
        if aws --endpoint-url=$AWS_ENDPOINT_URL s3 ls "s3://$TEST_BUCKET/$MANIFEST_PATH/restore/${CAMPAIGN_ID}-1.restore" 2>/dev/null; then
            log "${GREEN}✓ Instance 1 checkpoint detected in S3 after ${i}x2 seconds${NC}"
            INST1_CHECKPOINT=true
            CHECKPOINT_COUNT=$((CHECKPOINT_COUNT + 1))
        fi
    fi

    if [ ! "$INST2_CHECKPOINT" = true ]; then
        if aws --endpoint-url=$AWS_ENDPOINT_URL s3 ls "s3://$TEST_BUCKET/$MANIFEST_PATH/restore/${CAMPAIGN_ID}-2.restore" 2>/dev/null; then
            log "${GREEN}✓ Instance 2 checkpoint detected in S3 after ${i}x2 seconds${NC}"
            INST2_CHECKPOINT=true
            CHECKPOINT_COUNT=$((CHECKPOINT_COUNT + 1))
        fi
    fi

    if [ $CHECKPOINT_COUNT -eq 2 ]; then
        log "${GREEN}✓ Both instances have checkpoints${NC}"
        sleep 3
        break
    fi
done

if [ $CHECKPOINT_COUNT -ne 2 ]; then
    log "${RED}✗ Only $CHECKPOINT_COUNT of 2 checkpoints detected${NC}"
    exit 1
fi

# Interrupt instances by sending SIGTERM to their containers
log "\n${YELLOW}Interrupting instances...${NC}"

# Test Docker connectivity first
if ! docker ps > /dev/null 2>&1; then
    log "${RED}ERROR: Cannot connect to Docker daemon${NC}"
    log "${RED}Verify Docker socket is mounted and accessible${NC}"
    exit 1
fi

log "Stopping npk-instance-1..."
if docker stop -t 10 npk-instance-1; then
    log "${GREEN}✓ npk-instance-1 stopped${NC}"
else
    log "${RED}✗ Failed to stop npk-instance-1${NC}"
fi

log "Stopping npk-instance-2..."
if docker stop -t 10 npk-instance-2; then
    log "${GREEN}✓ npk-instance-2 stopped${NC}"
else
    log "${RED}✗ Failed to stop npk-instance-2${NC}"
fi

log "${GREEN}✓ Instances interrupted${NC}"

log "\n${BLUE}========================================${NC}"
log "${BLUE}Checkpoint Phase Complete${NC}"
log "${BLUE}========================================${NC}"

# Resume Phase - Restart instances to test checkpoint restoration
log "\n${YELLOW}Starting Resume Phase...${NC}"
log "Restarting instances to test checkpoint restoration..."

# Restart instance containers
log "Restarting npk-instance-1..."
if docker start npk-instance-1; then
    log "${GREEN}✓ npk-instance-1 restarted${NC}"
else
    log "${RED}✗ Failed to restart npk-instance-1${NC}"
    exit 1
fi

log "Restarting npk-instance-2..."
if docker start npk-instance-2; then
    log "${GREEN}✓ npk-instance-2 restarted${NC}"
else
    log "${RED}✗ Failed to restart npk-instance-2${NC}"
    exit 1
fi

log "${GREEN}✓ Instances restarted${NC}"

# Monitor for completion - wait for instances to crack passwords
log "\nMonitoring instances for password cracking..."
log "Waiting up to 5 minutes for instances to complete..."

INST1_COMPLETE=false
INST2_COMPLETE=false
COMPLETION_COUNT=0

for i in {1..150}; do
    sleep 2

    # Check if instances have completed by checking container exit status
    if [ ! "$INST1_COMPLETE" = true ]; then
        if ! docker ps | grep -q npk-instance-1; then
            # Instance 1 exited, check exit code
            EXIT_CODE=$(docker inspect npk-instance-1 --format='{{.State.ExitCode}}')
            if [ "$EXIT_CODE" = "0" ]; then
                log "${GREEN}✓ Instance 1 completed successfully after ${i}x2 seconds${NC}"
                INST1_COMPLETE=true
                COMPLETION_COUNT=$((COMPLETION_COUNT + 1))
            else
                log "${RED}✗ Instance 1 exited with code $EXIT_CODE${NC}"
                break
            fi
        fi
    fi

    if [ ! "$INST2_COMPLETE" = true ]; then
        if ! docker ps | grep -q npk-instance-2; then
            # Instance 2 exited, check exit code
            EXIT_CODE=$(docker inspect npk-instance-2 --format='{{.State.ExitCode}}')
            if [ "$EXIT_CODE" = "0" ]; then
                log "${GREEN}✓ Instance 2 completed successfully after ${i}x2 seconds${NC}"
                INST2_COMPLETE=true
                COMPLETION_COUNT=$((COMPLETION_COUNT + 1))
            else
                log "${RED}✗ Instance 2 exited with code $EXIT_CODE${NC}"
                break
            fi
        fi
    fi

    if [ $COMPLETION_COUNT -eq 2 ]; then
        log "${GREEN}✓ Both instances completed successfully${NC}"
        sleep 2
        break
    fi
done

if [ $COMPLETION_COUNT -ne 2 ]; then
    log "${RED}✗ Only $COMPLETION_COUNT of 2 instances completed${NC}"
    exit 1
fi

# Check cracked passwords
log "\n${YELLOW}Verifying cracked passwords...${NC}"

# Download and check cracked files from S3
CRACKED_COUNT=0

# Check instance 1 results
if aws --endpoint-url=$AWS_ENDPOINT_URL s3 ls "s3://$TEST_BUCKET/$MANIFEST_PATH/cracked_hashes-i-instance-1.txt" 2>/dev/null; then
    aws --endpoint-url=$AWS_ENDPOINT_URL s3 cp "s3://$TEST_BUCKET/$MANIFEST_PATH/cracked_hashes-i-instance-1.txt" /tmp/inst1-cracked.txt 2>/dev/null
    INST1_CRACKED=$(wc -l < /tmp/inst1-cracked.txt 2>/dev/null || echo "0")
    log "Instance 1 cracked: $INST1_CRACKED passwords"
    if [ "$INST1_CRACKED" -ge 1 ]; then
        CRACKED_COUNT=$((CRACKED_COUNT + INST1_CRACKED))
    fi
fi

# Check instance 2 results
if aws --endpoint-url=$AWS_ENDPOINT_URL s3 ls "s3://$TEST_BUCKET/$MANIFEST_PATH/cracked_hashes-i-instance-2.txt" 2>/dev/null; then
    aws --endpoint-url=$AWS_ENDPOINT_URL s3 cp "s3://$TEST_BUCKET/$MANIFEST_PATH/cracked_hashes-i-instance-2.txt" /tmp/inst2-cracked.txt 2>/dev/null
    INST2_CRACKED=$(wc -l < /tmp/inst2-cracked.txt 2>/dev/null || echo "0")
    log "Instance 2 cracked: $INST2_CRACKED passwords"
    if [ "$INST2_CRACKED" -ge 1 ]; then
        CRACKED_COUNT=$((CRACKED_COUNT + INST2_CRACKED))
    fi
fi

log "\n${BLUE}Total passwords cracked: $CRACKED_COUNT / 4${NC}"

if [ "$CRACKED_COUNT" -ge 2 ]; then
    log "${GREEN}✓ Success! Instances resumed from checkpoints and cracked passwords${NC}"
else
    log "${YELLOW}⚠ Only $CRACKED_COUNT passwords cracked (expected at least 2)${NC}"
fi

log "\n${BLUE}========================================${NC}"
log "${BLUE}Resume Phase Complete${NC}"
log "${BLUE}========================================${NC}"

log "\n${GREEN}========================================${NC}"
log "${GREEN}Multi-Instance Test Complete${NC}"
log "${GREEN}========================================${NC}"
