# NPK Restore Functionality - Docker E2E Testing Quick Start

## ✅ Complete Docker Test Environment Created!

This directory contains a production-ready Docker environment for testing the NPK Hashcat restore/resume functionality end-to-end.

## 🚀 Quick Start (3 Simple Steps)

### 1. Navigate to Test Directory

```bash
cd tests/docker
```

### 2. Run Tests

```bash
docker-compose up --build
```

### 3. View Results

Tests will run automatically and show results:
- ✅ **GREEN** = All tests passed
- ❌ **RED** = Tests failed (check logs)

## 📋 What Gets Tested

### Test Scenario 1: Fresh Start & Checkpoint
- ✅ Starts hashcat with no previous state
- ✅ Generates dynamic Campaign ID (UUID v4)
- ✅ Calculates keyspace using actual hashcat logic
- ✅ Applies `--skip` and `--limit` parameters correctly
- ✅ Creates restore/checkpoint files
- ✅ Backs up restore files to S3 (LocalStack)

### Test Scenario 2: Resume from S3
- ✅ Simulates spot instance interruption
- ✅ Deletes local restore files
- ✅ Downloads restore files from S3
- ✅ Verifies resume readiness
- ✅ Confirms hashcat can resume with `--restore --session`

### Test Scenario 3: Cleanup on Success
- ✅ Deletes local restore files
- ✅ Removes S3 restore files
- ✅ Verifies complete cleanup

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│         Docker Test Environment              │
├─────────────────────────────────────────────┤
│                                               │
│  ┌──────────────┐      ┌──────────────┐    │
│  │  LocalStack  │◄────►│  NPK Test    │    │
│  │  (Mock S3)   │      │  Container   │    │
│  │              │      │              │    │
│  │  Port: 4566  │      │  - Hashcat   │    │
│  │              │      │  - Node.js   │    │
│  └──────────────┘      │  - AWS CLI   │    │
│                         │  - Tests     │    │
│                         └──────────────┘    │
│                                               │
└─────────────────────────────────────────────┘
```

## 📊 Test Data

### Dynamic Generation
- **Campaign ID**: UUID v4 (e.g., `f47ac10b-58cc-4372-a567-0e02b2c3d479`)
- **User ID**: Random (e.g., `user-a3c5d7e9`)
- **Session Name**: `${CAMPAIGN_ID}-${INSTANCE_NUMBER}`

### Wordlist Strategy
- **Size**: 50,000 entries
- **Correct Passwords**: Placed at 80-90% of list
- **Purpose**: Ensures hashcat runs long enough to create checkpoints
- **Total Keyspace**: `wordlist_size × hash_count = 50,000 × 8 = 400,000`

### Keyspace Calculation
Follows actual `hashcat_wrapper.js` logic:
```javascript
keyspace = wordlist_size * hash_count
limit = ceil(keyspace / instance_count)
skip = limit * (instance_number - 1)
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMPAIGN_ID` | Auto-generated UUID v4 | Campaign identifier |
| `USER_ID` | Auto-generated | User identifier |
| `SESSION_NAME` | `${CAMPAIGN_ID}-1` | Hashcat session name |
| `INSTANCENUMBER` | `1` | Instance number (1-based) |
| `INSTANCECOUNT` | `1` | Total instances |
| `AWS_ENDPOINT_URL` | `http://localstack:4566` | LocalStack endpoint |

### Customization

```bash
# Run with multiple instances
docker-compose run --rm \
  -e INSTANCENUMBER=2 \
  -e INSTANCECOUNT=5 \
  npk-restore-test

# Use larger wordlist
docker-compose run --rm \
  -e WORDLIST_SIZE=100000 \
  npk-restore-test
```

## 📝 Files Created

```
tests/docker/
├── docker-compose.yml              # Orchestration
├── Dockerfile                      # Test environment
├── README.md                       # Detailed documentation
├── QUICKSTART.md                   # This file
├── localstack-init/
│   └── 01-create-bucket.sh        # S3 setup
├── scripts/
│   ├── run-e2e-tests.sh           # Main test orchestrator
│   └── generate-wordlist.sh       # Large wordlist generator
└── test-results/                   # Output logs (created at runtime)
```

## 🐛 Troubleshooting

### Tests Fail: "LocalStack not ready"
```bash
# Wait longer or increase healthcheck retries in docker-compose.yml
```

### Tests Fail: "Permission denied"
```bash
chmod +x tests/docker/scripts/*.sh
chmod +x tests/docker/localstack-init/*.sh
```

### Need to Debug
```bash
# Interactive shell
docker-compose run --rm npk-restore-test /bin/bash

# View logs
docker-compose logs -f localstack
docker-compose logs -f npk-restore-test

# Check S3 contents
docker-compose exec localstack awslocal s3 ls --recursive
```

### Clean Everything
```bash
docker-compose down -v
docker system prune -a
```

## ⏱️ Expected Runtime

- **LocalStack Startup**: 10-15 seconds
- **Test Environment Build**: 2-5 minutes (first time)
- **Test Execution**: 30-60 seconds
- **Total (first run)**: ~3-6 minutes
- **Total (subsequent)**: ~45-75 seconds

## ✨ Features

### ✅ Production-Ready
- Mimics actual NPK restore workflow
- Uses real hashcat binary
- Tests with LocalStack (AWS S3 compatible)
- Follows actual keyspace calculation logic

### ✅ Dynamic Testing
- UUID v4 for campaign IDs
- Random user IDs
- Calculated skip/limit values
- Large wordlists for realistic timing

### ✅ Comprehensive Coverage
- Fresh start (no restore files)
- Checkpoint creation and backup
- Spot interruption simulation
- Resume from S3
- Cleanup verification

### ✅ Easy to Run
- Single command: `docker-compose up`
- No manual setup required
- Automatic cleanup
- Clear pass/fail output

## 📚 Additional Documentation

- **README.md**: Detailed documentation, architecture, debugging
- **../../docs/RESTORE_FEATURE.md**: Feature overview and design
- **../../docs/HASHCAT_RESTORE_BEHAVIOR.md**: Hashcat checkpoint details

## 🎯 Success Criteria

All tests pass when you see:

```
========================================
Test Results Summary
========================================

Configuration:
  Campaign ID: f47ac10b-58cc-4372-a567-0e02b2c3d479
  User ID: user-a3c5d7e9
  Session: f47ac10b-58cc-4372-a567-0e02b2c3d479-1
  Keyspace: 400,000
  Instance 1/1

Test Scenario 1: Fresh Start & Checkpoint
  ✓ PASSED

Test Scenario 2: Resume from S3
  ✓ PASSED

Test Scenario 3: Cleanup on Success
  ✓ PASSED

========================================
ALL TESTS PASSED ✓
========================================
```

## 🔄 Integration with CI/CD

### GitHub Actions
```yaml
- name: Run E2E Restore Tests
  run: |
    cd tests/docker
    docker-compose up --build --abort-on-container-exit
```

### GitLab CI
```yaml
e2e-tests:
  script:
    - cd tests/docker
    - docker-compose up --build --abort-on-container-exit
```

## 🤝 Contributing

When modifying tests:

1. Update test scripts in `scripts/`
2. Run locally with `docker-compose up`
3. Verify all 3 scenarios pass
4. Update documentation
5. Commit changes

## 📞 Support

- Check logs: `docker-compose logs`
- Review README.md for detailed troubleshooting
- Verify LocalStack is healthy: `curl http://localhost:4566/_localstack/health`

## ⚡ Pro Tips

1. **Speed up builds**: Use `docker-compose up` without `--build` after first run
2. **Debug failures**: Add `set -x` to test scripts for verbose output
3. **Test specific scenarios**: Run individual test scripts directly
4. **Clean state**: Use `docker-compose down -v` between runs

---

**Ready to test?** Run `docker-compose up --build` and watch the tests pass! ✅
