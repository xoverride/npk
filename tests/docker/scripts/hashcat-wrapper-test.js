#!/usr/bin/env node
/*
 * Test Wrapper for hashcat_wrapper.js
 * Uses the REAL production code with minimal mocking for LocalStack
 */

const Module = require('module');
const originalRequire = Module.prototype.require;

// Mock AWS SDK v2 to use LocalStack
Module.prototype.require = function(id) {
    if (id === 'aws-sdk') {
        const AWS = originalRequire.apply(this, arguments);

        // Configure to use LocalStack
        AWS.config.update({
            endpoint: process.env.S3_ENDPOINT,
            s3ForcePathStyle: true,
            accessKeyId: 'test',
            secretAccessKey: 'test',
            region: 'us-east-1'
        });

        return AWS;
    }

    // Mock API Gateway client
    if (id === 'aws-api-gateway-client') {
        return {
            default: {
                newClient: () => ({
                    invokeApi: () => Promise.resolve({ status: 200 })
                })
            }
        };
    }

    return originalRequire.apply(this, arguments);
};

// Load and run the ACTUAL production code
require('/app/hashcat_wrapper.js');
