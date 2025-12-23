# Log Sync to S3 - Error Handling Analysis

**Date:** 2025-12-23
**Purpose:** Verify that logs are synced to S3 even when errors or exceptions occur

## Executive Summary

✅ **GOOD NEWS:** The codebase has robust error handling for log sync operations.
⚠️ **MINOR GAPS FOUND:** Some error paths could benefit from additional safeguards.

## Key Files Analyzed

1. **tools/compute-node/hashcat_wrapper.js** - Main hashcat wrapper with log sync
2. **templates/userdata.tpl** - Instance initialization script with cleanup handlers
3. **lambda_functions/spot_monitor/main.js** - Fleet monitoring (no direct log sync)
4. **lambda_functions/spot_interrupt_catcher/main.js** - Spot interruption handler

---

## Analysis by File

### 1. hashcat_wrapper.js - PRIMARY LOG SYNC LOCATION

#### ✅ GOOD: Signal Handlers with Log Sync

**Lines 95-130: SIGTERM and SIGINT handlers**
```javascript
process.on('SIGTERM', async () => {
    try {
        await triggerHashcatCheckpoint();
        await backupRestoreFiles();
        await syncLogsToS3();  // ✅ Logs synced on termination
        console.log('[SHUTDOWN] Logs synced successfully');
    } catch (err) {
        console.error('[SHUTDOWN] Failed to backup restore files or logs:', err);
    }
    process.exit(0);
});
```

**Lines 134-156: SIGUSR1 handler (2-minute spot warning)**
```javascript
process.on('SIGUSR1', async () => {
    try {
        await backupRestoreFiles();
        await syncLogsToS3();  // ✅ Logs synced during 2-min warning
        console.log('[SPOT-WARNING] Logs synced successfully');
    } catch (err) {
        console.error('[SPOT-WARNING] Failed to backup restore files or logs:', err);
    }
    // ✅ DON'T exit - continue until SIGTERM
});
```

**Lines 580-622: syncLogsToS3() function**
```javascript
function syncLogsToS3() {
    return new Promise((success, failure) => {
        try {
            // Flush stdout/stderr buffers
            if (process.stdout && typeof process.stdout._handle?.flushSync === 'function') {
                process.stdout._handle.flushSync();
            }
            if (process.stderr && typeof process.stderr._handle?.flushSync === 'function') {
                process.stderr._handle.flushSync();
            }

            // Flush filesystem buffers
            execSync('sync', { stdio: 'inherit' });

            // Wait for flush to complete
            setTimeout(() => {
                const syncCommand = `aws --region ${primaryRegion} s3 sync /potfiles/ s3://${userdata_bucket}/${manifestpath}/potfiles/ --include "*${instance_id}*"`;

                try {
                    execSync(syncCommand, { stdio: 'inherit' });
                    console.log("[LOG-SYNC] ✓ Logs synced successfully to S3");
                    success(true);
                } catch (err) {
                    console.error("[LOG-SYNC] ERROR: Failed to sync logs to S3:", err);
                    failure(err);  // ✅ Error is caught and logged
                }
            }, 2000);
        } catch (err) {
            console.error("[LOG-SYNC] ERROR: Failed to flush logs:", err);
            failure(err);  // ✅ Error is caught and logged
        }
    });
}
```

#### ✅ GOOD: Hashcat Exit Handler

**Lines 713-755: Hashcat process exit handler**
```javascript
hashcat.on('exit', function(code, signal) {
    if (code > -1) {
        // Success case
        cleanupRestoreFiles().then(() => {
            return success(sendFinished(true));  // ✅ sendFinished syncs all_cracked_hashes.txt
        }).catch(() => {
            return success(sendFinished(true));  // ✅ Still calls sendFinished even on cleanup error
        });
    } else {
        // Error case
        backupRestoreFiles().then(() => {
            return success(sendFinished(false));  // ✅ Syncs logs even on error
        }).catch(() => {
            return success(sendFinished(false));  // ✅ Still calls sendFinished even on backup error
        });
    }
});
```

**Lines 852-890: sendFinished() function**
```javascript
var sendFinished = function (completed) {
    // Read all cracked_hashes files
    const recoveredHashes = [
        ...new Set(fs.readdirSync("/potfiles")
            .filter(f => /^cracked_hashes-/.test(f))
            .reduce((a, c) =>
                a.concat(fs.readFileSync(`/potfiles/${c}`, "ascii").trim().split("\n")),
                []
            )
        )
    ];

    // Write consolidated file
    fs.writeFileSync('/potfiles/all_cracked_hashes.txt', recoveredHashes.join("\n"));

    // ✅ This file gets synced by cron job and final sync in userdata.tpl

    apiClient.invokeApi(nodeParams, nodeTemplate, "POST", {}, {
        completed,
        recoveredHashes: recoveredHashes.length
    }).then(() => {
        console.log("Node marked as complete.");
        success(true);
    }).catch((err) => {
        console.error(err.response.data);
        failure(false);  // ✅ Failure doesn't prevent file sync
    });
};
```

#### ⚠️ POTENTIAL GAP: Unhandled Promise Rejections

**Lines 892-914: Main execution chain**
```javascript
getCredentials().then((data) => {
    return getHashcatParams(manifest)
}, (e) => {
    console.log("Fatal error retrieving credentials.", e);
    process.exit();  // ⚠️ EXIT WITHOUT LOG SYNC
}).then((params) => {
    return runHashcat(params);
}, (e) => {
    console.log("Fatal error determining keyspace.", e);
    process.exit();  // ⚠️ EXIT WITHOUT LOG SYNC
}).then((data) => {
    console.log("Final update delivered.");
    process.exit();  // ⚠️ EXIT WITHOUT LOG SYNC
}, (e) => {
    console.log("Error delivering final update.", e);
    process.exit();  // ⚠️ EXIT WITHOUT LOG SYNC
});
```

**RISK:** If credentials fail or keyspace calculation fails, the process exits without syncing logs.

---

### 2. userdata.tpl - INSTANCE INITIALIZATION SCRIPT

#### ✅ GOOD: Trap Handler for Signals

**Lines 8-29: cleanup_and_sync_logs() trap handler**
```bash
cleanup_and_sync_logs() {
    echo "[SHUTDOWN] Received termination signal, syncing logs to S3..."

    # Flush filesystem buffers
    sync
    sleep 2

    # Final log sync
    if [ -n "$USERDATA" ] && [ -n "$USERDATAREGION" ] && [ -n "$ManifestPath" ] && [ -n "$INSTANCEID" ]; then
        aws --region $USERDATAREGION s3 sync /potfiles/ s3://$USERDATA/$ManifestPath/potfiles/ --exclude "*.log" --include "*${INSTANCEID}*" --include "*benchmark-results*" --include "all_cracked_hashes.txt"
        echo "[SHUTDOWN] Logs synced successfully"
    fi

    echo "[SHUTDOWN] Cleanup complete, exiting..."
    exit 0
}

# Register trap handlers
trap cleanup_and_sync_logs SIGTERM SIGINT
```

**✅ This catches ANY termination signal, including:**
- Spot instance interruptions
- Manual terminations
- Ctrl+C (SIGINT)

#### ✅ GOOD: Cron Jobs for Periodic Sync

**Lines 66-72: Crontab setup**
```bash
# Every minute: Download cracked hashes from other instances
echo "* * * * * root aws --region $USERDATAREGION s3 sync s3://$USERDATA/$ManifestPath/potfiles/ /potfiles/ --exclude \"*.log\" --exclude \"*benchmark-results*\"" >> /etc/crontab

# Every minute: Upload this instance's cracked hashes
echo "* * * * * root aws --region $USERDATAREGION s3 sync /potfiles/ s3://$USERDATA/$ManifestPath/potfiles/ --exclude \"*\" --include \"*${INSTANCEID}*\" --include \"*benchmark-results*\"" >> /etc/crontab
```

**✅ Logs are synced every minute, regardless of errors in the main process.**

#### ✅ GOOD: Final Sync Before Poweroff

**Lines 332-344: Final sync after hashcat completes**
```bash
# Flush all buffered output to disk
echo "[*] Flushing logs to disk before final sync..."
sync
sleep 3

# Final sync
aws --region $USERDATAREGION s3 sync /potfiles/ s3://$USERDATA/$ManifestPath/potfiles/ --exclude "*.log" --include "*${INSTANCEID}*" --include "*benchmark-results*" --include "all_cracked_hashes.txt"

# Sync restore files
aws --region $USERDATAREGION s3 sync /root/hashcat/ s3://$USERDATA/$ManifestPath/restore/ --exclude "*" --include "${SESSIONPATTERN}.restore" --include "${SESSIONPATTERN}.restore.pos"
```

#### ⚠️ POTENTIAL GAP: Script Errors Before Trap Setup

**Lines 1-29: Early script execution**
```bash
#! /bin/bash
cd /root/
# ... script setup ...
trap cleanup_and_sync_logs SIGTERM SIGINT  # Line 29
```

**RISK:** If the script crashes or exits before line 29, the trap handler is never registered.

---

### 3. spot_interrupt_catcher/main.js - SPOT INTERRUPTION HANDLER

#### ✅ GOOD: Triggers Log Sync via SSM

**Lines 105-133: SSM command to trigger backup**
```javascript
try {
    const ssm = new aws.SSM({ region: event.region });

    const ssmCommand = await ssm.sendCommand({
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [instanceId],
        Comment: `Spot interruption: backup restore files for campaign ${campaignId}`,
        Parameters: {
            commands: [
                '# Send SIGUSR1 to hashcat_wrapper to trigger immediate backup',
                'pkill -SIGUSR1 -f hashcat_wrapper.js',
                'echo "[SPOT-WARNING] Sent SIGUSR1 signal to hashcat_wrapper for immediate backup"'
            ]
        },
        TimeoutSeconds: 30,
        MaxConcurrency: '1',
        MaxErrors: '0'
    }).promise();

    console.log(`[RESUME-PREP] SSM command sent successfully`);
} catch (ssmErr) {
    // ✅ Don't fail the lambda if SSM fails - SIGTERM handler will still catch it
    console.error(`[RESUME-PREP] WARNING: Failed to send SSM command: ${ssmErr}`);
    console.log(`[RESUME-PREP] Backup will still occur via SIGTERM handler (30s window)`);
}
```

**✅ Even if SSM fails, the SIGTERM handler in hashcat_wrapper.js will still sync logs.**

---

## Summary of Findings

### ✅ STRONG PROTECTIONS IN PLACE

1. **Signal handlers:** SIGTERM, SIGINT, SIGUSR1 all trigger log sync
2. **Cron jobs:** Logs synced every minute automatically
3. **Final sync:** Explicit sync after hashcat completes
4. **Spot interruption:** 2-minute warning triggers early log sync
5. **Error handling:** catch blocks log errors and attempt sync anyway
6. **Graceful degradation:** Multiple fallback mechanisms

### ⚠️ IDENTIFIED GAPS

1. **hashcat_wrapper.js early exits (Lines 892-914)**
   - Credential failures, keyspace errors exit WITHOUT log sync
   - **Impact:** Medium - rare case, but logs could be lost
   - **Mitigation:** Cron jobs will have synced logs up to last minute

2. **userdata.tpl trap setup timing (Line 29)**
   - Script crashes before trap setup won't sync logs
   - **Impact:** Low - very early in script, before logs are written
   - **Mitigation:** CloudWatch captures cloud-init-output.log

3. **syncLogsToS3() promise rejection (Lines 580-622)**
   - If sync fails, promise rejects but signal handlers exit anyway
   - **Impact:** Low - error is logged, cron jobs provide redundancy
   - **Mitigation:** Already has retry logic via cron

---

## Recommendations

### 🔧 RECOMMENDED FIX #1: Add process-level error handler

**File:** tools/compute-node/hashcat_wrapper.js
**Location:** Add at top of file after line 157

```javascript
// Global error handlers - ensure log sync on any unhandled error
process.on('uncaughtException', async (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    try {
        await syncLogsToS3();
        console.log('[FATAL] Logs synced before crash');
    } catch (e) {
        console.error('[FATAL] Failed to sync logs:', e);
    }
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
    try {
        await syncLogsToS3();
        console.log('[FATAL] Logs synced before crash');
    } catch (e) {
        console.error('[FATAL] Failed to sync logs:', e);
    }
    process.exit(1);
});
```

### 🔧 RECOMMENDED FIX #2: Wrap early exits with log sync

**File:** tools/compute-node/hashcat_wrapper.js
**Location:** Lines 892-914

```javascript
// Add helper function
async function exitWithLogSync(code, message) {
    console.log(message);
    try {
        await syncLogsToS3();
        console.log('[EXIT] Logs synced before exit');
    } catch (e) {
        console.error('[EXIT] Failed to sync logs:', e);
    }
    process.exit(code);
}

// Replace process.exit() calls
getCredentials().then((data) => {
    return getHashcatParams(manifest)
}, async (e) => {
    await exitWithLogSync(1, "Fatal error retrieving credentials. " + e);
}).then((params) => {
    return runHashcat(params);
}, async (e) => {
    await exitWithLogSync(1, "Fatal error determining keyspace. " + e);
}).then((data) => {
    console.log("Final update delivered.");
    process.exit();
}, async (e) => {
    await exitWithLogSync(1, "Error delivering final update. " + e);
});
```

### 🔧 OPTIONAL FIX #3: Move trap setup earlier

**File:** templates/userdata.tpl
**Location:** Move trap setup to line 3

```bash
#! /bin/bash

# IMPORTANT: Set up trap handler FIRST before any operations
cleanup_and_sync_logs() {
    # ... existing handler ...
}
trap cleanup_and_sync_logs SIGTERM SIGINT EXIT

# Now proceed with the rest of the script
cd /root/
# ... rest of script ...
```

---

## Conclusion

**Overall Assessment:** ✅ **GOOD**

The codebase has **strong error handling** for log sync operations:
- Multiple redundant sync mechanisms (signals, cron, final sync)
- Error logging and graceful degradation
- 2-minute spot warning provides early sync opportunity

**Minor gaps exist** but are mitigated by:
- Cron jobs syncing every minute
- CloudWatch capturing instance logs
- Signal handlers catching most termination scenarios

**Recommended actions:**
1. Implement RECOMMENDED FIX #1 (process-level error handlers) - **HIGH PRIORITY**
2. Implement RECOMMENDED FIX #2 (early exit log sync) - **MEDIUM PRIORITY**
3. Consider OPTIONAL FIX #3 (earlier trap setup) - **LOW PRIORITY**

These fixes will provide **defense-in-depth** and ensure logs are synced in virtually all error scenarios.
