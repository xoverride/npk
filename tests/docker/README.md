# NPK Hashcat Restore Functionality - End-to-End Docker Tests

This directory contains a complete Docker-based testing environment for the NPK Hashcat restore/resume functionality.

## Overview

The test environment simulates the complete restore workflow:

1. **Fresh Start** - Hashcat begins a new job
2. **Checkpoint Creation** - Restore files are created and backed up to S3
3. **Spot Interruption** - Instance is terminated mid-job
4. **Resume** - New instance downloads restore files and resumes
5. **Cleanup** - Successful completion cleans up restore files

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Docker Environment                   │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────────┐          ┌──────────────────┐    │
│  │   LocalStack     │          │  NPK Test        │    │
│  │   (Mock S3)      │◄────────►│  Container       │    │
│  │                  │          │                  │    │
│  │  Port: 4566      │          │  - Hashcat       │    │
│  │                  │          │  - Node.js       │    │
│  └──────────────────┘          │  - Test Scripts  │    │
│                                 └──────────────────┘    │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

## Components

### 1. LocalStack
- **Purpose**: Mocks AWS S3 for local testing
- **Port**: 4566
- **Services**: S3 only
- **Initialization**: Auto-creates test bucket

### 2. NPK Test Container
- **Base**: Ubuntu 22.04
- **Includes**:
  - Hashcat 6.2.6
  - Node.js 18.x
  - AWS CLI
  - Test scripts and fixtures

### 3. Test Scripts

#### `run-e2e-tests.sh`
Main test orchestrator that runs all test scenarios:
- Creates test data (hashes, wordlists, manifests)
- Simulates full restore cycle
- Verifies S3 operations
- Tests cleanup functionality

#### `test-restore-resume.js`
Tests the restore file download and resume logic:
- Checks for restore files in S3
- Downloads restore files locally
- Verifies file integrity

#### `test-cleanup.js`
Tests cleanup after successful completion:
- Deletes local restore files
- Removes S3 restore files
- Verifies cleanup success

## Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- 2GB free disk space
- 1GB free RAM

## Quick Start

### 1. Build and Run Tests

```bash
cd tests/docker
docker-compose up --build
```

### 2. Run Tests Only (No Rebuild)

```bash
docker-compose up
```

### 3. Run in Detached Mode

```bash
docker-compose up -d
docker-compose logs -f npk-restore-test
```

### 4. Clean Up

```bash
docker-compose down -v
```

## Test Scenarios

### Scenario 1: Full Restore Cycle

**Steps:**
1. Start hashcat with fresh parameters
2. Create mock restore files
3. Upload restore files to S3
4. Simulate spot interruption (delete local files)
5. Download restore files from S3
6. Verify resume readiness

**Expected Output:**
```
✓ Hashcat created restore file
✓ Mock restore files created
✓ Restore files uploaded to S3
✓ Local restore files deleted (simulating interruption)
✓ Restore file found in S3
✓ Downloaded restore files
✓ SUCCESS: Restore files ready for resume
```

### Scenario 2: Cleanup on Success

**Steps:**
1. Verify restore files exist
2. Delete local restore files
3. Delete S3 restore files
4. Verify complete cleanup

**Expected Output:**
```
✓ Deleted local: /root/campaign456-1.restore
✓ Deleted local: /root/campaign456-1.restore.pos
✓ Deleted S3: user123/campaigns/campaign456/restore/campaign456-1.restore
✓ Deleted S3: user123/campaigns/campaign456/restore/campaign456-1.restore.pos
✓ SUCCESS: Cleanup completed
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_ENDPOINT_URL` | `http://localstack:4566` | LocalStack S3 endpoint |
| `TEST_BUCKET` | `npk-test-bucket` | S3 bucket for testing |
| `MANIFEST_PATH` | `user123/campaigns/campaign456` | Campaign path in S3 |
| `SESSION_NAME` | `campaign456-1` | Hashcat session name |
| `INSTANCEID` | `i-test-instance-1` | Mock instance ID |
| `INSTANCENUMBER` | `1` | Instance number |
| `INSTANCECOUNT` | `1` | Total instance count |

## Directory Structure

```
tests/docker/
├── docker-compose.yml           # Docker Compose configuration
├── Dockerfile                   # Test environment image
├── README.md                    # This file
├── localstack-init/            # LocalStack initialization scripts
│   └── 01-create-bucket.sh    # S3 bucket creation
├── scripts/                     # Test scripts
│   └── run-e2e-tests.sh       # Main test orchestrator
├── test-data/                   # Generated during tests
│   ├── hashcat_wrapper_test.js
│   ├── test-restore-resume.js
│   └── test-cleanup.js
└── test-results/                # Test output logs
    └── test1a.log
```

## Debugging

### View LocalStack Logs

```bash
docker-compose logs -f localstack
```

### View Test Logs

```bash
docker-compose logs -f npk-restore-test
```

### Interactive Shell

```bash
docker-compose run --rm npk-restore-test /bin/bash
```

### Check S3 Bucket Contents

```bash
docker-compose exec localstack awslocal s3 ls s3://npk-test-bucket --recursive
```

### Manual Test Run

```bash
docker-compose run --rm npk-restore-test /app/tests/docker/scripts/run-e2e-tests.sh
```

## Troubleshooting

### Issue: LocalStack Not Ready

**Symptom**: Tests fail with "LocalStack S3 not ready"

**Solution**:
```bash
# Increase wait time in docker-compose.yml healthcheck
# Or wait longer before starting tests
```

### Issue: Permission Denied on Scripts

**Symptom**: `/bin/bash: permission denied`

**Solution**:
```bash
chmod +x tests/docker/scripts/*.sh
chmod +x tests/docker/localstack-init/*.sh
```

### Issue: Port Conflicts

**Symptom**: "Port 4566 is already in use"

**Solution**:
```bash
# Stop other LocalStack instances
docker ps | grep localstack
docker stop <container-id>

# Or change ports in docker-compose.yml
```

### Issue: Out of Disk Space

**Symptom**: "no space left on device"

**Solution**:
```bash
# Clean up Docker resources
docker system prune -a
docker volume prune
```

## Test Output Interpretation

### Success Output

```
========================================
Test Results Summary
========================================

Test Scenario 1: Full Restore Cycle
  ✓ PASSED

Test Scenario 2: Cleanup on Success
  ✓ PASSED

========================================
ALL TESTS PASSED ✓
========================================
```

### Failure Output

```
✗ ERROR: Restore files not found locally
========================================
SOME TESTS FAILED ✗
========================================
```

## Performance Benchmarks

Expected test execution times:

| Test | Duration | Description |
|------|----------|-------------|
| LocalStack Startup | 10-15s | S3 service initialization |
| Test Environment Setup | 5-10s | Container startup |
| Scenario 1 | 5-10s | Full restore cycle |
| Scenario 2 | 2-5s | Cleanup test |
| **Total** | **22-40s** | Complete test suite |

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: E2E Restore Tests

on: [push, pull_request]

jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run E2E Tests
        run: |
          cd tests/docker
          docker-compose up --build --abort-on-container-exit
      - name: Check Results
        run: |
          docker-compose logs npk-restore-test | grep "ALL TESTS PASSED"
```

### GitLab CI Example

```yaml
e2e-restore-tests:
  image: docker:latest
  services:
    - docker:dind
  script:
    - cd tests/docker
    - docker-compose up --build --abort-on-container-exit
    - docker-compose logs npk-restore-test | grep "ALL TESTS PASSED"
```

## Advanced Usage

### Run Specific Test Scenario

```bash
# Run only restore cycle test
docker-compose run --rm npk-restore-test node /test-data/test-restore-resume.js

# Run only cleanup test
docker-compose run --rm npk-restore-test node /test-data/test-cleanup.js
```

### Custom Test Configuration

```bash
# Override environment variables
docker-compose run --rm \
  -e INSTANCENUMBER=2 \
  -e INSTANCECOUNT=5 \
  npk-restore-test /app/tests/docker/scripts/run-e2e-tests.sh
```

### Persistent Test Data

```bash
# Mount custom test data
docker-compose run --rm \
  -v $(pwd)/custom-data:/custom-data \
  npk-restore-test /bin/bash
```

## Contributing

When adding new test scenarios:

1. Create test script in `scripts/`
2. Add scenario to `run-e2e-tests.sh`
3. Update this README
4. Test locally with Docker Compose
5. Ensure tests are idempotent

## References

- [Hashcat Documentation](https://hashcat.net/wiki/)
- [LocalStack Documentation](https://docs.localstack.cloud/)
- [AWS SDK v3 Documentation](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
- [NPK Restore Feature Docs](../../docs/RESTORE_FEATURE.md)

## License

MIT License - Same as NPK project

## Support

For issues or questions:
- Open an issue on GitHub
- Check existing test logs in `test-results/`
- Review LocalStack logs for S3 errors
