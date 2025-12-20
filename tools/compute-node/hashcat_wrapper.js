/*jshint esversion: 6 */
/*jshint node: true */

"use strict";

var fs = require('fs');
var os = require('os');
var aws = require('aws-sdk');
const { spawn } = require('child_process');
var apiClientFactory = require('aws-api-gateway-client').default;

// Performance logging flag - set to 1 to enable, 0 to disable
const PERF_LOGGING_ENABLED = process.env.PERF_LOGGING_ENABLED === '1' || process.env.PERF_LOGGING_ENABLED === undefined;
const START_TIME = Date.now();

function logPerf(taskName, status) {
	if (!PERF_LOGGING_ENABLED) return;
	const currentTime = Date.now();
	const elapsed = currentTime - START_TIME;
	const timestamp = new Date().toISOString();
	console.log(`[PERF] ${timestamp} | ${status} | ${taskName} | ${elapsed}ms`);
}

logPerf("Hashcat Wrapper Start", "START");

var region = process.env.REGION;
var primaryRegion = process.env.USERDATAREGION;
var keyspace = process.env.KEYSPACE || 1;
var apigateway = process.env.APIGATEWAY;
var manifestpath = process.env.ManifestPath;

var instance_id = process.env.INSTANCEID;
var instance_count = process.env.INSTANCECOUNT || 1;
var instance_number = process.env.INSTANCENUMBER || 1;
var userdata_bucket = process.env.USERDATA;

var manifest = JSON.parse(fs.readFileSync('/root/manifest.json'));
var s3 = new aws.S3({ region: primaryRegion });

// Extract campaign ID from manifestpath for session naming
// manifestpath format: {userid}/campaigns/{campaign_id}
var campaign_id = manifestpath.split('/')[2];

// Session name: campaign_id-instance_number (not instance_id!)
// This allows new instances to resume work from terminated instances
var session_name = `${campaign_id}-${instance_number}`;

console.log(`[SESSION] Campaign ID: ${campaign_id}`);
console.log(`[SESSION] Instance ID: ${instance_id} (physical instance)`);
console.log(`[SESSION] Instance Number: ${instance_number} (logical slot)`);
console.log(`[SESSION] Session Name: ${session_name} (restore files)`);

var apiClient = null;
var credentialsReady = 0;
var credFailureCount = 0;
var isShuttingDown = false;
var hashcatProcess = null;  // Store reference to hashcat child process

// Handle SIGTERM gracefully - backup restore files AND sync logs immediately
process.on('SIGTERM', async () => {
	console.log('[SHUTDOWN] Received SIGTERM signal, backing up restore files and logs...');
	isShuttingDown = true;
	try {
		// Tell hashcat to create checkpoint before we backup
		await triggerHashcatCheckpoint();
		await backupRestoreFiles();
		console.log('[SHUTDOWN] Restore files backed up successfully');

		// Sync logs to S3 before termination
		await syncLogsToS3();
		console.log('[SHUTDOWN] Logs synced successfully');
	} catch (err) {
		console.error('[SHUTDOWN] Failed to backup restore files or logs:', err);
	}
	process.exit(0);
});

// Handle SIGINT (Ctrl+C) gracefully as well
process.on('SIGINT', async () => {
	console.log('[SHUTDOWN] Received SIGINT signal, backing up restore files and logs...');
	isShuttingDown = true;
	try {
		// Tell hashcat to create checkpoint before we backup
		await triggerHashcatCheckpoint();
		await backupRestoreFiles();
		console.log('[SHUTDOWN] Restore files backed up successfully');

		// Sync logs to S3 before termination
		await syncLogsToS3();
		console.log('[SHUTDOWN] Logs synced successfully');
	} catch (err) {
		console.error('[SHUTDOWN] Failed to backup restore files or logs:', err);
	}
	process.exit(0);
});

// Handle SIGUSR1 for spot interruption 2-minute warning
// This gives us 2 full minutes to backup instead of just 30 seconds at SIGTERM
process.on('SIGUSR1', async () => {
	console.log('[SPOT-WARNING] ============================================');
	console.log('[SPOT-WARNING] Received 2-minute spot interruption warning!');
	console.log('[SPOT-WARNING] Backing up restore files and logs immediately...');
	console.log('[SPOT-WARNING] ============================================');
	try {
		// DON'T trigger checkpoint - hashcat auto-checkpoints periodically
		// Triggering checkpoint with 'c' would cause hashcat to quit
		// Instead, backup existing restore file and let hashcat continue working
		// At SIGTERM (2 mins later), we'll trigger checkpoint for fresh backup
		await backupRestoreFiles();
		console.log('[SPOT-WARNING] Restore files backed up successfully');

		// Sync logs to S3 during 2-minute warning window
		await syncLogsToS3();
		console.log('[SPOT-WARNING] Logs synced successfully');

		console.log('[SPOT-WARNING] Hashcat will continue working until termination');
		console.log('[SPOT-WARNING] Final checkpoint will be created at SIGTERM');
	} catch (err) {
		console.error('[SPOT-WARNING] Failed to backup restore files or logs:', err);
	}
	// DON'T exit - continue running until SIGTERM
});

var getCredentials = function() {
	return new Promise((success, failure) => {
		aws.config.getCredentials(function(err) {
			if (err) {
				credFailureCount++;
				console.log("Error retrieving credentials:" + err);

				if (credFailureCount < 5) {
					console.log("Retrying");
					return getCredentials();
				} else {
					logPerf("AWS Credentials Retrieval", "FAILED");
					return Project.reject('Failure retrieving credentials.')
				}
			}

			credentialsReady = 1;

			apiClient = apiClientFactory.newClient({
				invokeUrl: "https://" + apigateway + "/v1/statusreport/",
				accessKey: aws.config.credentials.accessKeyId,
				secretKey: aws.config.credentials.secretAccessKey,
				sessionToken: aws.config.credentials.sessionToken,
				region: primaryRegion
			});

			setTimeout(getCredentials, 600);

			return success(true);
		});
	});
};

function getHashcatParams(manifest) {

	var params = [
		"--quiet",
		"-O",
		"-o",
		"/potfiles/cracked_hashes-" + instance_id + ".txt",
		"--outfile-check-dir",
		"/potfiles/",
		"--outfile-check-timer",
		"30",
		"-w",
		"4",
		"-m",
		manifest.hashType,
		"-a",
		manifest.attackType,
		"--status",
		"--status-json",
		"--status-timer",
		"30",
		"--session",
		session_name  // Use campaign_id-instance_number, not instance_id!
	];

	if (manifest.manualArguments) {
		console.log("Adding manual arguments:", manifest.manualArguments.split(" "));
		params = params.concat(manifest.manualArguments.split(" "));
	}

	if (manifest.attackType == 0) {
		fs.readdirSync('/root/npk-rules/').forEach(function(e) {
			params.push("-r");
			params.push("/root/npk-rules/" + e);
		});
	}

	params.push("/root/hashes.txt");

	if ([0,6].indexOf(manifest.attackType) >= 0) {
		params.push("/root/npk-wordlist/" + fs.readdirSync("/root/npk-wordlist/")[0]);
	}

	if ([3,6].indexOf(manifest.attackType) >= 0) {
		if (manifest.manualMask) {
			params.push(manifest.manualMask);
		} else {
			params.push(manifest.mask);
		}
	}

	return checkForRestore(params);
}

function checkForRestore(params) {
	return new Promise((success, failure) => {
		logPerf("Restore File Check", "START");
		// Use session_name (campaign_id-instance_number) not instance_id
		// This allows new instances to resume work from old instances in same slot
		// Note: Modern hashcat creates restore files in its installation directory
		const restoreFile = `/root/hashcat/${session_name}.restore`;
		const restorePosFile = `/root/hashcat/${session_name}.restore.pos`;
		const s3RestorePath = `${manifestpath}/restore/${session_name}.restore`;
		const s3RestorePosPath = `${manifestpath}/restore/${session_name}.restore.pos`;

		console.log("[RESUME-CHECK] ========================================");
		console.log("[RESUME-CHECK] Checking for restore files to resume job");
		console.log("[RESUME-CHECK] Physical Instance ID:", instance_id);
		console.log("[RESUME-CHECK] Logical Instance Number:", instance_number, "of", instance_count);
		console.log("[RESUME-CHECK] Session Name:", session_name, "(used for restore files)");
		console.log("[RESUME-CHECK] S3 Bucket:", userdata_bucket);
		console.log("[RESUME-CHECK] S3 Restore Path:", s3RestorePath);
		console.log("[RESUME-CHECK] ========================================");

		// Check if restore files exist in S3 (.pos file is optional)
		Promise.all([
			s3.headObject({ Bucket: userdata_bucket, Key: s3RestorePath }).promise().catch(() => null),
			s3.headObject({ Bucket: userdata_bucket, Key: s3RestorePosPath }).promise().catch(() => null)
		]).then(([restoreExists, restorePosExists]) => {
			if (restoreExists) {
				console.log("[RESUME-CHECK] ✓ Restore files FOUND in S3!");
				console.log("[RESUME-CHECK] Restore file size:", restoreExists.ContentLength, "bytes");
				if (restorePosExists) {
					console.log("[RESUME-CHECK] Restore.pos file size:", restorePosExists.ContentLength, "bytes");
				} else {
					console.log("[RESUME-CHECK] Restore.pos file not found (optional)");
				}
				console.log("[RESUME-CHECK] Last modified:", restoreExists.LastModified);
				console.log("[RESUME-CHECK] Downloading restore files...");

				// Download restore file, and .pos file if it exists
				const downloads = [
					s3.getObject({ Bucket: userdata_bucket, Key: s3RestorePath }).promise()
						.then(data => {
							fs.writeFileSync(restoreFile, data.Body);
							console.log("[RESUME-CHECK] ✓ Downloaded", s3RestorePath, "->", restoreFile);
							return data;
						})
				];

				if (restorePosExists) {
					downloads.push(
						s3.getObject({ Bucket: userdata_bucket, Key: s3RestorePosPath }).promise()
							.then(data => {
								fs.writeFileSync(restorePosFile, data.Body);
								console.log("[RESUME-CHECK] ✓ Downloaded", s3RestorePosPath, "->", restorePosFile);
								return data;
							})
					);
				}

				return Promise.all(downloads).then(() => {
					console.log("[RESUME-CHECK] ========================================");
					console.log("[RESUME-CHECK] RESUME MODE ENABLED");
					console.log("[RESUME-CHECK] Hashcat will resume from checkpoint");
					console.log("[RESUME-CHECK] ========================================");
					console.log("[RESUME-CHECK] IMPORTANT: Restore only needs --session and --restore");
					console.log("[RESUME-CHECK] All other parameters are stored in .restore file");
					console.log("[RESUME-CHECK] Discarding all other params (hash type, attack mode, etc.)");
					console.log("[RESUME-CHECK] ========================================");

					// CRITICAL: When restoring, hashcat ONLY accepts:
					// --restore and --session <name>
					// All other parameters (hash type, attack mode, files, etc.)
					// are stored in the .restore file and must NOT be provided
					// Order matters: --restore BEFORE --session
					const restoreParams = [
						"--restore",
						"--session",
						session_name
					];

					console.log("[RESUME-CHECK] Final restore params:", restoreParams);
					logPerf("Restore File Check", "DONE");
					return success(restoreParams);
				});
			} else {
				console.log("[RESUME-CHECK] ✗ No restore files found in S3");
				console.log("[RESUME-CHECK] This is a fresh start");
				console.log("[RESUME-CHECK] Will calculate keyspace and begin from start");
				console.log("[RESUME-CHECK] ========================================");
				logPerf("Restore File Check", "DONE");
				return getKeyspace(params).then(success).catch(failure);
			}
		}).catch((err) => {
			console.error("[RESUME-CHECK] ERROR: Failed to check for restore files:", err);
			console.log("[RESUME-CHECK] FALLBACK: Proceeding with normal keyspace calculation");
			console.log("[RESUME-CHECK] ========================================");
			logPerf("Restore File Check", "FAILED");
			// If there's an error, just proceed with normal keyspace calculation
			return getKeyspace(params).then(success).catch(failure);
		});
	});
}

var readOutput = function(output) {

	try {
		var status = JSON.parse(output);
	} catch (e) {
		return false;
	}
		
	// console.log("Found status report in output");
	// console.log(status);

	var hashrate = 0;
	var performance = {};
	status.devices.forEach(function(device) {
		hashrate += device.speed;
		performance[device.device_id] = device.speed;
	});

	console.log(((status.progress[0] / status.progress[1]) * 100).toFixed(2) + "% finished @ " + hashrate.toLocaleString() + "H/s");

	return sendStatusUpdate({
		startTime: status.time_start,
		estimatedEndTime: status.estimated_stop,
		hashRate: hashrate,
		progress: ((status.progress[0] / status.progress[1]) * 100).toFixed(2),
		hashes: status.recovered_hashes[1],
		recoveredHashes: status.recovered_hashes[0],
		recoveredPercentage: ((status.recovered_hashes[0] / status.recovered_hashes[1]) * 100).toFixed(2),
		rejectedPercentage: ((status.rejected / status.progress[0]) * 100).toFixed(2),
		performance: performance
	});
};

function getKeyspace(params) {
	return new Promise((success, failure) => {
		logPerf("Keyspace Calculation", "START");
		console.log("Determining keyspace...");

		// replaces the hashfile with '--keyspace'
		var keyspaceIndex = params.indexOf("/root/hashes.txt") - params.length;
		params.splice(keyspaceIndex, 1, "--keyspace");

		const hashcat = spawn("/root/hashcat/hashcat.bin", params, {
			name: 'xterm-color',
			cols: 80,
			rows: 30,
			cwd: process.env.HOME,
			env: process.env
		});

		var output = "";
		hashcat.stdout.on('data', function(data) {
			console.log("1> " + data.toString().replace("\n", ""));
			output += data;
		});

		hashcat.stderr.on('data', function(data) {
			console.log("2> " + data);
		});

		hashcat.on('exit', function(code, signal) {

			console.log(" ");
			output = output.split("\n").splice(-2, 1);

			if (output / 1 == output) {
				var limit = Math.ceil(output / instance_count);
				var skip = limit * (instance_number - 1);

				console.log("Got keyspace [ " + output.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,') + " ].");
				console.log("As node [ " + instance_number + " ] of [ " + instance_count + " ] I'll skip [ " + skip.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,') + " ]." );

				//Put the hashfile back.
				params.splice(keyspaceIndex, 1, "/root/hashes.txt");

				if (instance_count > 1) {
					params.splice(keyspaceIndex, 0, "--skip");
					params.splice(keyspaceIndex, 0, skip);
				}

				if (instance_number != instance_count) {
					params.splice(keyspaceIndex, 0, "--limit");
					params.splice(keyspaceIndex, 0, limit);
				}

				logPerf("Keyspace Calculation", "DONE");
				return success(params);
			} else {
				logPerf("Keyspace Calculation", "FAILED");
				return failure(output);
			}
		});
	});
}

function triggerHashcatCheckpoint() {
	return new Promise((success) => {
		if (!hashcatProcess || hashcatProcess.killed) {
			console.log("[CHECKPOINT] Hashcat process not running, skipping checkpoint trigger");
			return success(false);
		}

		try {
			console.log("[CHECKPOINT] Sending 'c' to hashcat to trigger checkpoint save...");
			// Send 'c' key to hashcat stdin to trigger checkpoint quit
			// Hashcat will update restore file before quitting
			hashcatProcess.stdin.write('c');

			// Wait 3 seconds for hashcat to update restore file
			// This gives hashcat time to write the checkpoint
			setTimeout(() => {
				console.log("[CHECKPOINT] Hashcat should have updated restore file");
				success(true);
			}, 3000);
		} catch (err) {
			console.error("[CHECKPOINT] Failed to send checkpoint signal to hashcat:", err);
			success(false);
		}
	});
}

function backupRestoreFiles() {
	return new Promise((success, failure) => {
		// Note: Modern hashcat creates restore files in its installation directory
		const restoreFile = `/root/hashcat/${session_name}.restore`;
		const restorePosFile = `/root/hashcat/${session_name}.restore.pos`;
		const s3RestorePath = `${manifestpath}/restore/${session_name}.restore`;
		const s3RestorePosPath = `${manifestpath}/restore/${session_name}.restore.pos`;

		// Check if restore file exists locally (.pos file is optional)
		if (!fs.existsSync(restoreFile)) {
			// Don't log every time - only first time
			if (!backupRestoreFiles.loggedMissing) {
				console.log("[CHECKPOINT] No restore file to backup yet (hashcat hasn't created it)");
				backupRestoreFiles.loggedMissing = true;
			}
			return success(false);
		}

		// Reset the flag once file exists
		backupRestoreFiles.loggedMissing = false;

		const restoreStats = fs.statSync(restoreFile);
		const hasRestorePos = fs.existsSync(restorePosFile);

		console.log("[CHECKPOINT] Backing up restore files to S3...");
		console.log("[CHECKPOINT] Restore file size:", restoreStats.size, "bytes");
		if (hasRestorePos) {
			const restorePosStats = fs.statSync(restorePosFile);
			console.log("[CHECKPOINT] Restore.pos file size:", restorePosStats.size, "bytes");
		} else {
			console.log("[CHECKPOINT] Restore.pos file not present (optional for this attack type)");
		}

		// Build upload promises - .pos file is optional
		const uploads = [
			s3.putObject({
				Bucket: userdata_bucket,
				Key: s3RestorePath,
				Body: fs.readFileSync(restoreFile)
			}).promise()
		];

		if (hasRestorePos) {
			uploads.push(
				s3.putObject({
					Bucket: userdata_bucket,
					Key: s3RestorePosPath,
					Body: fs.readFileSync(restorePosFile)
				}).promise()
			);
		}

		Promise.all(uploads).then(() => {
			console.log("[CHECKPOINT] ✓ Restore files backed up successfully to S3");
			console.log("[CHECKPOINT] Location: s3://" + userdata_bucket + "/" + manifestpath + "/restore/");
			success(true);
		}).catch((err) => {
			console.error("[CHECKPOINT] ERROR: Failed to backup restore files:", err);
			failure(err);
		});
	});
}

function syncLogsToS3() {
	return new Promise((success, failure) => {
		const { execSync } = require('child_process');

		console.log("[LOG-SYNC] Flushing logs to disk before S3 upload...");

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

			// Give filesystem a moment to complete the flush
			setTimeout(() => {
				console.log("[LOG-SYNC] Syncing logs to S3...");

				// Sync the output log and any cracked hashes to S3
				// Note: all_cracked_hashes.txt only exists after sendFinished() runs
				// During shutdown signals, only sync per-instance files
				const syncCommand = `aws --region ${primaryRegion} s3 sync /potfiles/ s3://${userdata_bucket}/${manifestpath}/potfiles/ --include "*${instance_id}*"`;

				try {
					execSync(syncCommand, { stdio: 'inherit' });
					console.log("[LOG-SYNC] ✓ Logs synced successfully to S3");
					console.log("[LOG-SYNC] Location: s3://" + userdata_bucket + "/" + manifestpath + "/potfiles/");
					success(true);
				} catch (err) {
					console.error("[LOG-SYNC] ERROR: Failed to sync logs to S3:", err);
					failure(err);
				}
			}, 2000);
		} catch (err) {
			console.error("[LOG-SYNC] ERROR: Failed to flush logs:", err);
			failure(err);
		}
	});
}

function runHashcat(params) {
	return new Promise((success, failure) => {
		logPerf("Hashcat Execution", "START");
		console.log("\n\nEverything looks good. Starting hashcat...");
		console.log("Hashcat command: /root/hashcat/hashcat.bin", params.join(' '));

		hashcatProcess = spawn("/root/hashcat/hashcat.bin", params, {
			name: 'xterm-color',
			cols: 80,
			rows: 30,
			cwd: process.env.HOME,
			env: process.env
		});

		const hashcat = hashcatProcess;  // Alias for backward compatibility

		// Watch restore files for changes and backup when they change
		// Note: Modern hashcat creates restore files in its installation directory
		const restoreFile = `/root/hashcat/${session_name}.restore`;
		const restorePosFile = `/root/hashcat/${session_name}.restore.pos`;
		let backupTimeout = null;
		let isWatching = true;

		const debouncedBackup = () => {
			if (backupTimeout) {
				clearTimeout(backupTimeout);
			}
			backupTimeout = setTimeout(() => {
				if (isWatching) {
					// Check if restore file exists (.pos file is optional)
					if (fs.existsSync(restoreFile)) {
						backupRestoreFiles().catch((err) => {
							console.log("Failed to backup restore files:", err);
						});
					} else {
						console.log("[CHECKPOINT] Waiting for restore file to be created...");
					}
				}
			}, 2000); // Debounce: wait 2 seconds after last change
		};

		// Use fs.watchFile() which handles non-existent files gracefully
		// This polls the filesystem every 2 seconds
		console.log("Setting up restore file watchers...");

		fs.watchFile(restoreFile, { interval: 2000 }, (curr, prev) => {
			// File exists when size > 0, and has been modified when mtime changes
			if (curr.size > 0 && curr.mtime > prev.mtime && isWatching) {
				console.log(`Restore file changed (size: ${curr.size} bytes), backing up...`);
				debouncedBackup();
			}
		});

		fs.watchFile(restorePosFile, { interval: 2000 }, (curr, prev) => {
			// File exists when size > 0, and has been modified when mtime changes
			if (curr.size > 0 && curr.mtime > prev.mtime && isWatching) {
				console.log(`Restore position file changed (size: ${curr.size} bytes), backing up...`);
				debouncedBackup();
			}
		});

		console.log("Restore file watchers initialized (fs.watchFile with 2s interval)");
		console.log("  - Watches:", restoreFile);
		console.log("  - Watches:", restorePosFile);

		var output = "";
		hashcat.stdout.on('data', function(data) {
			// Try to parse as JSON status, if not JSON then log as regular output
			const dataStr = data.toString();
			const parsedStatus = readOutput(dataStr);

			if (!parsedStatus) {
				// Not JSON status - log as regular hashcat output
				const lines = dataStr.trim().split('\n');
				lines.forEach(line => {
					if (line.trim()) {
						console.log("[HASHCAT] " + line);
					}
				});
			}

			output += dataStr;
			output = output.split("\n").pop();
		});

		hashcat.stderr.on('data', function(data) {
			console.log("Hashcat stderr: " + data);
		});

		hashcat.on('exit', function(code, signal) {
			// Stop watching and clean up watchers
			isWatching = false;
			if (backupTimeout) clearTimeout(backupTimeout);

			// Cleanup fs.watchFile() watchers
			try {
				fs.unwatchFile(restoreFile);
				fs.unwatchFile(restorePosFile);
				console.log("Restore file watchers stopped");
			} catch (e) {
				// Ignore cleanup errors
			}

			/* 	Only treating negative numbers as actual errors, based on:
				https://github.com/hashcat/hashcat/blob/master/docs/status_codes.txt	*/

			if (code > -1) {
				console.log("\n\nCracking job exited successfully.\n");
				logPerf("Hashcat Execution", "DONE");
				// Clean up restore files on successful completion
				cleanupRestoreFiles().then(() => {
					return success(sendFinished(true));
				}).catch(() => {
					return success(sendFinished(true));
				});
			} else {
				console.log("\n\nDied with code " + code + " and signal " + signal + "\n");
				if (output.length > 0) {
					console.log("Dying words:");
					console.log(output);
				}
				console.log("\n\n");

				logPerf("Hashcat Execution", "FAILED");
				// Backup restore files one final time on error
				backupRestoreFiles().then(() => {
					return success(sendFinished(false));
				}).catch(() => {
					return success(sendFinished(false));
				});
			}
		});
	});
}

function cleanupRestoreFiles() {
	return new Promise((success, failure) => {
		// Note: Modern hashcat creates restore files in its installation directory
		const restoreFile = `/root/hashcat/${session_name}.restore`;
		const restorePosFile = `/root/hashcat/${session_name}.restore.pos`;
		const s3RestorePath = `${manifestpath}/restore/${session_name}.restore`;
		const s3RestorePosPath = `${manifestpath}/restore/${session_name}.restore.pos`;

		console.log("[CLEANUP] ========================================");
		console.log("[CLEANUP] Hashcat job completed successfully");
		console.log("[CLEANUP] Cleaning up restore files (no longer needed)");
		console.log("[CLEANUP] ========================================");

		// Delete local restore files (.pos file is optional)
		try {
			if (fs.existsSync(restoreFile)) {
				fs.unlinkSync(restoreFile);
				console.log("[CLEANUP] ✓ Deleted local restore file:", restoreFile);
			}
			if (fs.existsSync(restorePosFile)) {
				fs.unlinkSync(restorePosFile);
				console.log("[CLEANUP] ✓ Deleted local restore.pos file:", restorePosFile);
			}
		} catch (err) {
			console.log("[CLEANUP] Error deleting local restore files:", err);
		}

		// Delete S3 restore files (.pos file is optional)
		console.log("[CLEANUP] Deleting restore files from S3...");
		console.log("[CLEANUP] S3 bucket:", userdata_bucket);
		console.log("[CLEANUP] S3 paths:", s3RestorePath, s3RestorePosPath);

		// Delete main restore file with proper error handling
		const deletePromises = [
			s3.deleteObject({ Bucket: userdata_bucket, Key: s3RestorePath }).promise()
				.then(() => {
					console.log("[CLEANUP] ✓ Deleted restore file:", s3RestorePath);
					return true;
				})
				.catch((err) => {
					console.error("[CLEANUP] ✗ Failed to delete restore file:", s3RestorePath);
					console.error("[CLEANUP] Error code:", err.code);
					console.error("[CLEANUP] Error message:", err.message);
					console.error("[CLEANUP] Full error:", JSON.stringify(err, null, 2));
					return false;
				})
		];

		// Delete .pos file if it exists (optional, don't fail if missing)
		deletePromises.push(
			s3.deleteObject({ Bucket: userdata_bucket, Key: s3RestorePosPath }).promise()
				.then(() => {
					console.log("[CLEANUP] ✓ Deleted restore.pos file:", s3RestorePosPath);
					return true;
				})
				.catch((err) => {
					// .pos file is optional, only log if it's not a "not found" error
					if (err.code !== 'NoSuchKey' && err.code !== 'NotFound') {
						console.error("[CLEANUP] ✗ Failed to delete restore.pos file:", s3RestorePosPath);
						console.error("[CLEANUP] Error code:", err.code);
						console.error("[CLEANUP] Error message:", err.message);
					}
					return false;
				})
		);

		Promise.all(deletePromises).then((results) => {
			const mainFileDeleted = results[0];
			if (mainFileDeleted) {
				console.log("[CLEANUP] ✓ S3 restore files deleted successfully");
				console.log("[CLEANUP] Job complete - all restore files removed");
				console.log("[CLEANUP] ========================================");
				success(true);
			} else {
				console.log("[CLEANUP] ⚠ Failed to delete main restore file");
				console.log("[CLEANUP] Files may need manual cleanup");
				console.log("[CLEANUP] Check IAM permissions for s3:DeleteObject on this bucket");
				console.log("[CLEANUP] ========================================");
				// Still call success() because hashcat job is done, just cleanup failed
				success(false);
			}
		}).catch((err) => {
			console.error("[CLEANUP] Unexpected error during cleanup:", err);
			failure(err);
		});
	});
}

var sendStatusUpdate = function (body) {
	var pathTemplate = "{userid}/{campaign}/{instance_id}/{action}";
	var pathParams = {
		userid: manifestpath.split('/')[0],
		campaign: manifestpath.split('/')[2],
		instance_id: instance_id,
		action: 'performance'
	};

	return new Promise((success, failure) => {
		if (credentialsReady == 0) {
			console.log("Can't deliver status update. Credentials aren't ready.");
			return failure(false);
		}

		apiClient.invokeApi(pathParams, pathTemplate, "POST", {}, body).then(function(result) {
			console.log("Status update sent.");
			success(true);
		}).catch(function(err) {
			// console.error(err.response.statusCode);
			console.log("Error sending status update to API Gateway");
			console.error(err);
			failure(false);
		});
	});
};

var sendFinished = function (completed) {
	var nodeTemplate = "{userid}/{campaign}/{instance_id}/{action}";
	var nodeParams = {
		userid: manifestpath.split('/')[0],
		campaign: manifestpath.split('/')[2],
		instance_id: instance_id,
		action: 'done'
	};

	return new Promise((success, failure) => {
		if (credentialsReady == 0) {
			console.log("Can't deliver status update. Credentials aren't ready.");
			return failure(false);
		}

		const recoveredHashes = [
			...new Set(fs.readdirSync("/potfiles")
				.filter(f => /^cracked_hashes-/.test(f))
				.reduce((a, c) => 
					a.concat(fs.readFileSync(`/potfiles/${c}`, "ascii").trim().split("\n")),
					[]
				)
			)
		];

		console.log(`Got [${recoveredHashes.length}] hashes from all files.`)

		fs.writeFileSync('/potfiles/all_cracked_hashes.txt', recoveredHashes.join("\n"));

		apiClient.invokeApi(nodeParams, nodeTemplate, "POST", {}, { completed, recoveredHashes: recoveredHashes.length }).then(function(result) {
			console.log("Node marked as complete.");
			success(true);
		}).catch(function(err) {
			// console.error(err.response.statusCode);
			console.error(err.response.data);
			failure(false);
		});
	});
};

getCredentials().then((data) => {
	console.log('Credentials loaded');
	logPerf("Hashcat Parameter Build", "START");
	return getHashcatParams(manifest)
}, (e) => {
	console.log("Fatal error retrieving credentials.", e);
	process.exit();
}).then((params) => {
	console.log('Hashcat parameters:', params)
	logPerf("Hashcat Parameter Build", "DONE");
	return runHashcat(params);
}, (e) => {
	console.log("Fatal error determining keyspace.", e);
	process.exit();
}).then((data) => {
	console.log("Final update delivered.");
	logPerf("Hashcat Wrapper Complete", "DONE");
	process.exit();
}, (e) => {
	console.log("Error delivering final update.", e);
	logPerf("Hashcat Wrapper Complete", "FAILED");
	process.exit();
});