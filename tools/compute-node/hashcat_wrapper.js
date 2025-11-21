/*jshint esversion: 6 */
/*jshint node: true */

"use strict";

var fs = require('fs');
var os = require('os');
var aws = require('aws-sdk');
const { spawn } = require('child_process');
var apiClientFactory = require('aws-api-gateway-client').default;

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
		// Use session_name (campaign_id-instance_number) not instance_id
		// This allows new instances to resume work from old instances in same slot
		const restoreFile = `/root/${session_name}.restore`;
		const restorePosFile = `/root/${session_name}.restore.pos`;
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

		// Check if restore files exist in S3
		Promise.all([
			s3.headObject({ Bucket: userdata_bucket, Key: s3RestorePath }).promise().catch(() => null),
			s3.headObject({ Bucket: userdata_bucket, Key: s3RestorePosPath }).promise().catch(() => null)
		]).then(([restoreExists, restorePosExists]) => {
			if (restoreExists && restorePosExists) {
				console.log("[RESUME-CHECK] ✓ Restore files FOUND in S3!");
				console.log("[RESUME-CHECK] Restore file size:", restoreExists.ContentLength, "bytes");
				console.log("[RESUME-CHECK] Restore.pos file size:", restorePosExists.ContentLength, "bytes");
				console.log("[RESUME-CHECK] Last modified:", restoreExists.LastModified);
				console.log("[RESUME-CHECK] Downloading restore files...");

				// Download both restore files
				return Promise.all([
					s3.getObject({ Bucket: userdata_bucket, Key: s3RestorePath }).promise()
						.then(data => {
							fs.writeFileSync(restoreFile, data.Body);
							console.log("[RESUME-CHECK] ✓ Downloaded", s3RestorePath, "->", restoreFile);
							return data;
						}),
					s3.getObject({ Bucket: userdata_bucket, Key: s3RestorePosPath }).promise()
						.then(data => {
							fs.writeFileSync(restorePosFile, data.Body);
							console.log("[RESUME-CHECK] ✓ Downloaded", s3RestorePosPath, "->", restorePosFile);
							return data;
						})
				]).then(() => {
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
					return success(restoreParams);
				});
			} else {
				console.log("[RESUME-CHECK] ✗ No restore files found in S3");
				console.log("[RESUME-CHECK] This is a fresh start");
				console.log("[RESUME-CHECK] Will calculate keyspace and begin from start");
				console.log("[RESUME-CHECK] ========================================");
				return getKeyspace(params).then(success).catch(failure);
			}
		}).catch((err) => {
			console.error("[RESUME-CHECK] ERROR: Failed to check for restore files:", err);
			console.log("[RESUME-CHECK] FALLBACK: Proceeding with normal keyspace calculation");
			console.log("[RESUME-CHECK] ========================================");
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

				return success(params);
			} else {
				return failure(output);
			}
		});
	});
}

function backupRestoreFiles() {
	return new Promise((success, failure) => {
		const restoreFile = `/root/${session_name}.restore`;
		const restorePosFile = `/root/${session_name}.restore.pos`;
		const s3RestorePath = `${manifestpath}/restore/${session_name}.restore`;
		const s3RestorePosPath = `${manifestpath}/restore/${session_name}.restore.pos`;

		// Check if restore files exist locally
		if (!fs.existsSync(restoreFile) || !fs.existsSync(restorePosFile)) {
			// Don't log every time - only first time
			if (!backupRestoreFiles.loggedMissing) {
				console.log("[CHECKPOINT] No restore files to backup yet (hashcat hasn't created them)");
				backupRestoreFiles.loggedMissing = true;
			}
			return success(false);
		}

		// Reset the flag once files exist
		backupRestoreFiles.loggedMissing = false;

		const restoreStats = fs.statSync(restoreFile);
		const restorePosStats = fs.statSync(restorePosFile);

		console.log("[CHECKPOINT] Backing up restore files to S3...");
		console.log("[CHECKPOINT] Restore file size:", restoreStats.size, "bytes");
		console.log("[CHECKPOINT] Restore.pos file size:", restorePosStats.size, "bytes");

		Promise.all([
			s3.putObject({
				Bucket: userdata_bucket,
				Key: s3RestorePath,
				Body: fs.readFileSync(restoreFile)
			}).promise(),
			s3.putObject({
				Bucket: userdata_bucket,
				Key: s3RestorePosPath,
				Body: fs.readFileSync(restorePosFile)
			}).promise()
		]).then(() => {
			console.log("[CHECKPOINT] ✓ Restore files backed up successfully to S3");
			console.log("[CHECKPOINT] Location: s3://" + userdata_bucket + "/" + manifestpath + "/restore/");
			success(true);
		}).catch((err) => {
			console.error("[CHECKPOINT] ERROR: Failed to backup restore files:", err);
			failure(err);
		});
	});
}

function runHashcat(params) {
	return new Promise((success, failure) => {
		console.log("\n\nEverything looks good. Starting hashcat...");
		console.log("Hashcat command: /root/hashcat/hashcat.bin", params.join(' '));

		const hashcat = spawn("/root/hashcat/hashcat.bin", params, {
			name: 'xterm-color',
			cols: 80,
			rows: 30,
			cwd: process.env.HOME,
			env: process.env
		});

		// Watch restore files for changes and backup when they change
		const restoreFile = `/root/${session_name}.restore`;
		const restorePosFile = `/root/${session_name}.restore.pos`;
		let backupTimeout = null;
		let isWatching = true;

		const debouncedBackup = () => {
			if (backupTimeout) {
				clearTimeout(backupTimeout);
			}
			backupTimeout = setTimeout(() => {
				if (isWatching) {
					backupRestoreFiles().catch((err) => {
						console.log("Failed to backup restore files:", err);
					});
				}
			}, 2000); // Debounce: wait 2 seconds after last change
		};

		try {
			const restoreWatcher = fs.watch(restoreFile, (eventType, filename) => {
				if (eventType === 'change') {
					console.log(`Restore file changed, backing up...`);
					debouncedBackup();
				}
			});

			const restorePosWatcher = fs.watch(restorePosFile, (eventType, filename) => {
				if (eventType === 'change') {
					console.log(`Restore position file changed, backing up...`);
					debouncedBackup();
				}
			});

			// Store watchers to close them later
			hashcat.restoreWatcher = restoreWatcher;
			hashcat.restorePosWatcher = restorePosWatcher;
		} catch (err) {
			// Restore files don't exist yet, will be created by hashcat
			console.log("Restore files not yet created, will watch once created");
			// Fallback to periodic check every 30 seconds
			const checkInterval = setInterval(() => {
				if (fs.existsSync(restoreFile) && fs.existsSync(restorePosFile)) {
					clearInterval(checkInterval);
					try {
						const restoreWatcher = fs.watch(restoreFile, (eventType) => {
							if (eventType === 'change' && isWatching) {
								console.log(`Restore file changed, backing up...`);
								debouncedBackup();
							}
						});
						const restorePosWatcher = fs.watch(restorePosFile, (eventType) => {
							if (eventType === 'change' && isWatching) {
								console.log(`Restore position file changed, backing up...`);
								debouncedBackup();
							}
						});
						hashcat.restoreWatcher = restoreWatcher;
						hashcat.restorePosWatcher = restorePosWatcher;
						console.log("Restore file watchers initialized");
					} catch (watchErr) {
						console.log("Error setting up file watchers:", watchErr);
					}
				}
			}, 30000);
			hashcat.checkInterval = checkInterval;
		}

		var output = "";
		hashcat.stdout.on('data', function(data) {
			readOutput(data);
			output += data;
			output = output.split("\n").pop();
		});

		hashcat.stderr.on('data', function(data) {
			console.log("Hashcat stderr: " + data);
		});

		hashcat.on('exit', function(code, signal) {
			// Stop watching and clean up watchers
			isWatching = false;
			if (backupTimeout) clearTimeout(backupTimeout);
			if (hashcat.checkInterval) clearInterval(hashcat.checkInterval);
			if (hashcat.restoreWatcher) {
				try {
					hashcat.restoreWatcher.close();
				} catch (e) { /* ignore */ }
			}
			if (hashcat.restorePosWatcher) {
				try {
					hashcat.restorePosWatcher.close();
				} catch (e) { /* ignore */ }
			}

			/* 	Only treating negative numbers as actual errors, based on:
				https://github.com/hashcat/hashcat/blob/master/docs/status_codes.txt	*/

			if (code > -1) {
				console.log("\n\nCracking job exited successfully.\n");
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
		const restoreFile = `/root/${session_name}.restore`;
		const restorePosFile = `/root/${session_name}.restore.pos`;
		const s3RestorePath = `${manifestpath}/restore/${session_name}.restore`;
		const s3RestorePosPath = `${manifestpath}/restore/${session_name}.restore.pos`;

		console.log("Cleaning up restore files...");

		// Delete local restore files
		try {
			if (fs.existsSync(restoreFile)) fs.unlinkSync(restoreFile);
			if (fs.existsSync(restorePosFile)) fs.unlinkSync(restorePosFile);
		} catch (err) {
			console.log("Error deleting local restore files:", err);
		}

		// Delete S3 restore files
		Promise.all([
			s3.deleteObject({ Bucket: userdata_bucket, Key: s3RestorePath }).promise().catch(() => {}),
			s3.deleteObject({ Bucket: userdata_bucket, Key: s3RestorePosPath }).promise().catch(() => {})
		]).then(() => {
			console.log("Restore files cleaned up successfully.");
			success(true);
		}).catch((err) => {
			console.log("Error cleaning up S3 restore files:", err);
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
	return getHashcatParams(manifest)
}, (e) => {
	console.log("Fatal error retrieving credentials.", e);
	process.exit();
}).then((params) => {
	console.log('Hashcat parameters:', params)
	return runHashcat(params);
}, (e) => {
	console.log("Fatal error determining keyspace.", e);
	process.exit();
}).then((data) => {	
	console.log("Final update delivered.");
	process.exit();
}, (e) => {
	console.log("Error delivering final update.", e);
	process.exit();
});