#!/bin/bash

# Initialize S3 bucket for NPK testing
echo "Initializing LocalStack S3 for NPK testing..."

# Wait for LocalStack to be fully ready
sleep 2

# Create test bucket
awslocal s3 mb s3://npk-test-bucket 2>/dev/null || echo "Bucket already exists"

# List buckets to verify
awslocal s3 ls

echo "LocalStack S3 initialization complete"
