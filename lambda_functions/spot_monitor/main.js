"use strict";

const fs = require('fs');
const aws 	= require('aws-sdk');
const settings = JSON.parse(JSON.stringify(process.env));
settings.regions = JSON.parse(settings.regions);

const accountDetails = JSON.parse(fs.readFileSync('./accountDetails.json', 'ascii'));

aws.config.apiVersions = {
	dynamodb: 	'2012-08-10'
};

aws.config.update({region: settings.region});

const db = new aws.DynamoDB();

exports.main = async function(event, context, callback) {

	let spotFleets = {};
	let promises = [];

	// Enumerate spot fleet requests and histories across all regions.
	try {

		for (const region of Object.keys(settings.regions)) {
			const ec2 = new aws.EC2({region: region});

			promises.push(ec2.describeSpotFleetRequests({}).promise().then(async (data) => {

				for (let config of data.SpotFleetRequestConfigs) {
					// Skip fleets more than a day old, since some history items can expire before the fleet does.
					if (new Date(config.CreateTime).getTime() < new Date().getTime() - (1000 * 60 * 60 * 24)) {
						console.log(`[-] ${config.SpotFleetRequestId} created more than a day ago. Skipping.`);
						continue;
					}

					const history = await getSpotRequestHistory(ec2, config.SpotFleetRequestId);

					spotFleets[config.SpotFleetRequestId] = {
						...config,
						region,
						history,
						instances: {},
						price: 0
					};
				};
			}));
		};

		await Promise.all(promises);

		if (!Object.keys(spotFleets).length) {
			return callback(null, "[*] No spot fleets to process.");
		} else {
			console.log(`[+] Found ${Object.keys(spotFleets).length} SFRs to process.`);
		}

	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to retreive spot fleets and history: ${e}`);
	}

	promises = [];

	// Enumerate spot instances from all regions, and associate them with their SFRs.
	try {
		Object.keys(settings.regions).forEach(function(region) {
			const ec2 = new aws.EC2({region: region});

			promises.push(ec2.describeSpotInstanceRequests({}).promise().then((data) => {
				data.SpotInstanceRequests.forEach(function(request) {
					request.Tags = request.Tags.reduce((tags, tag) => {
						tags[tag.Key] = tag.Value;

						return tags;
					}, {});

					if (!request.Tags['aws:ec2spot:fleet-request-id']) {
						console.log(`[-] Instance ${request.InstanceId} has no SFR ID.`);
						console.log(request.Tags);
						return false
					}

					const sfr = request.Tags['aws:ec2spot:fleet-request-id'];

					spotFleets[sfr].instances[request.InstanceId] = {
						Status: {
							Code: request.Status.Code,
							Message: request.Status.Message
						},
						State: request.State
					}
				});

				return true;
			}));
		});

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to retreive spot instance statuses: ${e}`);
	}

	promises = [];

	try {
		Object.keys(spotFleets).forEach((fleetId) => {
			const fleet = spotFleets[fleetId];

			const instanceCount = Object.keys(fleet.instances).length;

			if (!instanceCount) {
				console.log(`[-] Found 0 instances for ${fleetId}`);
			} else {
				console.log(`[+] Found ${instanceCount} instances for ${fleetId}`);
			}

			const hasOpenInstances = Object.keys(fleet.instances).reduce((state, instanceId) => {
				const instance = fleet.instances[instanceId];

				if (['open', 'active'].indexOf(instance.State) > -1 ) {
					return true;
				}

				return state;
			}, false);

			if (!hasOpenInstances) {
				console.log(`[+] Fleet ${fleetId} with status ${fleet.SpotFleetRequestState} has open instances: ${hasOpenInstances}.`);
			}

			if (!!instanceCount && !hasOpenInstances && !/cancelled/.test(fleet.SpotFleetRequestState)) {
				const ec2 = new aws.EC2({region: fleet.region});

				promises.push(ec2.cancelSpotFleetRequests({
					TerminateInstances: true,
					SpotFleetRequestIds: [fleetId]
				}).promise().then((data) => {
					console.log(`[+] Cancelled ${fleetId} due to all instance requests being closed.`);
				}, (e) => {
					console.log(`[-] Unable to cancel ${fleetId} due to all instance requests being closed.`, e);
				}));
			}
		});
	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to handle exhausted campaigns: ${e}`);
	}

	promises = [];
	const spotPrices = {};

	// Get spot instance events, along with price history for each instance type found.
	try {

		// Iterate over the identified SFRs and remove any that are cancelled and empty.
		spotFleets = Object.keys(spotFleets).reduce((fleets, fleetId) => {
			const fleet = spotFleets[fleetId];

			if (!!fleet.instances.length && /cancelled/.test(fleet.SpotFleetRequestState)) {
				console.log(`[-] Cancelled fleet [${fleet.SpotFleetRequestId}] has no instance statuses.`);
				return fleets;
			}

			if (/cancelled/.test(fleet.SpotFleetRequestState)) {
				const fleetState = (fleet.SpotFleetRequestState == "cancelled") ? "COMPLETED" : "STOPPING";

				// Check if this was a capacity termination (should be resumable)
				const wasCapacityTerminated = checkForCapacityTermination(fleet);

				// NEW: Check if instances completed work before fleet was cancelled
				const allInstancesCompletedWork = checkIfInstancesCompletedWork(fleet);

				const updateData = {
					active: false,
					spotRequestHistory: fleet.history,
					spotRequestStatus: fleet.instances,
					status: fleetState
				};

				// Only mark as resumable if:
				// 1. Fleet had capacity issues AND
				// 2. Instances did NOT complete their work
				if (wasCapacityTerminated && !allInstancesCompletedWork) {
					console.log(`[CAPACITY-LOSS] Fleet ${fleet.SpotFleetRequestId} was terminated due to capacity issues`);
					console.log(`[CAPACITY-LOSS] Reason: ${wasCapacityTerminated.reason}`);
					console.log(`[CAPACITY-LOSS] Instances did not complete work - marking as resumable`);

					updateData.resumable = true;
					updateData.interrupted = "Capacity Loss";
					updateData.interruptionTime = Math.floor(Date.now() / 1000);
					updateData.interruptionReason = wasCapacityTerminated.reason;
					updateData.interruptionDetails = wasCapacityTerminated.details;
				} else if (wasCapacityTerminated && allInstancesCompletedWork) {
					console.log(`[CAPACITY-LOSS] Fleet ${fleet.SpotFleetRequestId} had capacity issues BUT instances completed work`);
					console.log(`[CAPACITY-LOSS] All instances terminated gracefully - NOT marking as resumable`);
					console.log(`[CAPACITY-LOSS] This was a fleet-level config issue after work finished`);
				}

				promises.push(editCampaignViaRequestId(fleet.SpotFleetRequestId, updateData).then((data) => {
					if (wasCapacityTerminated && !allInstancesCompletedWork) {
						console.log(`[CAPACITY-LOSS] Campaign ${fleet.SpotFleetRequestId} marked as resumable - restore files should be in S3`);
					} else if (wasCapacityTerminated && allInstancesCompletedWork) {
						console.log(`[+] Campaign ${fleet.SpotFleetRequestId} completed work despite fleet capacity issues - marked as ${fleetState}`);
					} else {
						console.log(`[+] Marked campaign of ${fleet.SpotFleetRequestId} as ${fleetState}`);
					}
				}, (e) => {
					console.log(`[!] Failed attempting to update ${promiseDetails.fleets[fleetId].SpotFleetRequestId}`);
				}));

				if (fleet.SpotFleetRequestState == "cancelled") {
					return fleets;
				}
			}

			if (!!fleet.instances.length) {
				console.log(`[!] Fleet [${fleet.SpotFleetRequestId}] with status [${fleet.SpotFleetRequestState}] has no instance statuses.`);
			}

			// Loop over 'instanceChange' events to record the start and stop time of given instances.
			fleet.history.forEach((historyRecord) => {
				if (historyRecord.EventType != "instanceChange") {
					return false;
				}

				const event = JSON.parse(historyRecord.EventInformation.EventDescription);

				if (!historyRecord?.EventInformation?.InstanceId) {
					return false;
				}

				const instanceId = historyRecord.EventInformation.InstanceId;

				if (!fleet.instances[instanceId]) {
					// This can happen when nodes are new. Be lenient.
					return false;
				}

				// Create the basic record, to be populated based on event status.
				if (!fleet.instances[instanceId].history) {

					fleet.instances[instanceId].instanceType = event.instanceType;
					fleet.instances[instanceId].image = event.image;
					fleet.instances[instanceId].availabilityZone = event.availabilityZone;
					fleet.instances[instanceId].ProductDescriptions = event.ProductDescriptions;

					fleet.instances[instanceId].history = {
						startTime: 0,
						endTime: new Date().getTime() / 1000
					}
				}

				// Set record details based on event type.
				// NOTE: historyRecord.Timestamp is already in seconds (converted at line 818)
				switch (historyRecord.EventInformation.EventSubType) {
					case "launched":
						// Timestamp is already in seconds, use it directly
						fleet.instances[instanceId].history.startTime = historyRecord.Timestamp;
						console.log(`[DEBUG-PRICE] Instance ${instanceId} launched:`);
						console.log(`[DEBUG-PRICE]   Raw Timestamp (seconds): ${historyRecord.Timestamp}`);
						console.log(`[DEBUG-PRICE]   Stored as seconds: ${fleet.instances[instanceId].history.startTime}`);
					break;

					case "terminated":
						// Timestamp is already in seconds, use it directly
						fleet.instances[instanceId].history.endTime = historyRecord.Timestamp;
						console.log(`[DEBUG-PRICE] Instance ${instanceId} terminated:`);
						console.log(`[DEBUG-PRICE]   Raw Timestamp (seconds): ${historyRecord.Timestamp}`);
						console.log(`[DEBUG-PRICE]   Stored as seconds: ${fleet.instances[instanceId].history.endTime}`);
					break;
				}

				// Retrieve spot price history based on region and instance type.
				const spotKey = fleet.region + ":" + event.instanceType;

				// Skip remaining processing if it's already been requested.
				if (!!spotPrices[spotKey]) {
					return false;
				}

				spotPrices[spotKey] = {};

				const ec2 = new aws.EC2({region: fleet.region});
				promises.push(ec2.describeSpotPriceHistory({
					InstanceTypes: [event.instanceType],
					ProductDescriptions: ["Linux/UNIX (Amazon VPC)"],

					// Default to retrieving the last two days' spot prices.
					StartTime: (new Date().getTime() / 1000) - (60 * 60 * 48)
				}).promise().then((data) => {

					data.SpotPriceHistory.forEach(function(spotHistoryItem) {
						const az = spotHistoryItem.AvailabilityZone;
						const dateKey = new Date(spotHistoryItem.Timestamp).getTime();

						if (!spotPrices[spotKey][az]) {
							spotPrices[spotKey][az] = {};
						}

						spotPrices[spotKey][az][dateKey] = spotHistoryItem.SpotPrice;
					});
				}));
			});

			fleets[fleetId] = fleet;
			return fleets;
		}, {});

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to get instance history and prices: ${e}`);
	}

	promises = [];

	// Promises are all done. Let's calculate the instance costs, and roll them up to the fleet.
	try {

		console.log(spotPrices);

		Object.keys(spotFleets).forEach((fleetId) => {
			const fleet = spotFleets[fleetId];

			let badInstance = false;
			Object.keys(fleet.instances).forEach((instanceId) => {
				const instance = fleet.instances[instanceId];

				const prices = spotPrices?.[fleet.region + ':' + instance.instanceType]?.[instance.availabilityZone];

				if (!!!prices) {
					badInstance = true;
					return false;
				}

				prices[new Date().getTime()] = prices[Object.keys(prices).slice(-1)];

				const timestamps = Object.keys(prices).sort(function(a, b) { return a - b; });

				let accCost = 0;
				let accSeconds = 0;

				if (instance.history.startTime == 0) {
					badInstance = true;
					return false;
				}

				// DEBUG: Log raw times from database
				console.log(`[DEBUG-PRICE] Instance ${instanceId}:`);
				console.log(`[DEBUG-PRICE]   startTime (seconds from DB): ${instance.history.startTime}`);
				console.log(`[DEBUG-PRICE]   endTime (seconds from DB): ${instance.history.endTime}`);
				console.log(`[DEBUG-PRICE]   duration (seconds): ${instance.history.endTime - instance.history.startTime}`);

				// Convert to milliseconds to match price timestamp format
				let duration = (instance.history.endTime - instance.history.startTime) * 1000;

				// This isn't a thing anymore. Fun times.
				//duration = (duration < 3600) ? 3600 : duration;

				// Convert to milliseconds to match price timestamp format
				let tempStartTime = instance.history.startTime * 1000;

				console.log(`[DEBUG-PRICE]   duration (milliseconds): ${duration}`);
				console.log(`[DEBUG-PRICE]   tempStartTime (milliseconds): ${tempStartTime}`);
				console.log(`[DEBUG-PRICE]   First price timestamp: ${timestamps[0]}`);
				console.log(`[DEBUG-PRICE]   Last price timestamp: ${timestamps[timestamps.length - 1]}`);
				console.log(`[DEBUG-PRICE]   Number of price points: ${timestamps.length}`);

				// console.log("duration: " + duration);
				let iterationCount = 0;
				timestamps.forEach(function(e) {
					// console.log("Checking against time: " + e)
					if (e <= tempStartTime || accSeconds >= duration) {
						return true;
					}

					iterationCount++;
					// Price per millisecond (hourly rate / 3600000)
					var ppms = prices[e] / 3600000;
					var mseconds = e - tempStartTime;

					// DEBUG: Log first few iterations
					if (iterationCount <= 3) {
						console.log(`[DEBUG-PRICE]   Iteration ${iterationCount}:`);
						console.log(`[DEBUG-PRICE]     price timestamp e: ${e}`);
						console.log(`[DEBUG-PRICE]     tempStartTime: ${tempStartTime}`);
						console.log(`[DEBUG-PRICE]     mseconds (e - tempStartTime): ${mseconds}`);
						console.log(`[DEBUG-PRICE]     hourly price: $${prices[e]}`);
						console.log(`[DEBUG-PRICE]     ppms (price/3600000): ${ppms}`);
					}

					if (accSeconds + mseconds > duration) {
						const originalMseconds = mseconds;
						mseconds -= (accSeconds + mseconds - duration);
						if (iterationCount <= 3) {
							console.log(`[DEBUG-PRICE]     mseconds capped from ${originalMseconds} to ${mseconds} (duration limit)`);
						}
					}

					const costThisSegment = mseconds * ppms;
					if (iterationCount <= 3) {
						console.log(`[DEBUG-PRICE]     cost this segment: $${costThisSegment.toFixed(6)}`);
					}

					accCost += costThisSegment;
					accSeconds += mseconds;

					tempStartTime += mseconds;
				});

				console.log(`[*] Instance ${instanceId} up for ${(accSeconds / 1000).toFixed(2)} seconds; estimated cost $${accCost.toFixed(4)}`);
				console.log(`[DEBUG-PRICE]   Total iterations: ${iterationCount}`);
				console.log(`[DEBUG-PRICE]   Final accCost: $${accCost.toFixed(6)}`);
				console.log(`[DEBUG-PRICE]   Final accSeconds: ${accSeconds} ms (${(accSeconds/1000).toFixed(2)} seconds)`);

				instance.price = accCost;
				fleet.price += accCost;
				console.log(`[DEBUG-PRICE]   Fleet ${fleetId} running total: $${fleet.price.toFixed(6)}`);
			});

			// Skip the fleet if an instance has partially truncated history.
			if (badInstance) {
				console.log(`[!] SFR ${fleetId} has incomplete instance history. Skipping update.`);
				return false;
			}

			const tags = {};
			fleet.SpotFleetRequestConfig.LaunchSpecifications[0].TagSpecifications.forEach((tagspec) => {
				tagspec.Tags.forEach(function(tag) {
					tags[tag.Key] = tag.Value;
				});
			});

			const ec2 = new aws.EC2({region: fleet.region});
			const fleetState = (/cancelled/.test(fleet.SpotFleetRequestState)) ? "STOPPING" : "RUNNING";

			console.log(`[DEBUG-PRICE] ===== FINAL FLEET PRICE =====`);
			console.log(`[DEBUG-PRICE] Fleet ${fleetId} - Total instances: ${Object.keys(fleet.instances).length}`);
			console.log(`[DEBUG-PRICE] Fleet ${fleetId} - Final fleet.price: $${fleet.price.toFixed(6)}`);
			console.log(`[DEBUG-PRICE] Fleet ${fleetId} - Writing to DB as 'currentFleetPrice': $${fleet.price}`);
			console.log(`[DEBUG-PRICE] Fleet ${fleetId} - MaxCost tag: $${tags.MaxCost}`);
			console.log(`[DEBUG-PRICE] Fleet ${fleetId} - campaign_max_price: $${settings.campaign_max_price}`);
			console.log(`[DEBUG-PRICE] ==============================`);

			promises.push(editCampaignViaRequestId(fleetId, {
				active: true,
				currentFleetPrice: fleet.price,  // Current fleet's cost only (not accumulated)
				spotRequestHistory: fleet.history,
				spotRequestStatus: fleet.instances,
				status: fleetState
			}).then((data) => {
				console.log(`[+] Updated price of fleet ${fleetId}: $${fleet.price.toFixed(2)}`);
				console.log(`[DEBUG-PRICE] Database update successful for fleet ${fleetId}`);
			}, (e) => {
				console.log(`[!] Failed attempting to update price for ${fleetId}`);
				console.log(`[DEBUG-PRICE] Database update FAILED for fleet ${fleetId}: ${e}`);
			}));

			if (fleet.price > parseFloat(tags.MaxCost) || fleet.price > parseFloat(settings.campaign_max_price)) {
				console.log("Fleet " + fleetId + " costs exceed limits; terminating.");

				promises.push(ec2.cancelSpotFleetRequests({
					TerminateInstances: true,
					SpotFleetRequestIds: [fleetId]
				}).promise().then((data) => {
					console.log(`Successfully terminated ${fleetId}`);
					return Promise.resolve();
				}, (e) => {
					console.log(e);
					return criticalAlert(`Failed to terminate fleet ${fleetId} with cost $${fleet.price}`);
				}));
			}

			if (fleet.price > parseFloat(tags.MaxCost) * 1.1 || fleet.price > parseFloat(settings.campaign_max_price) * 1.1) {
				console.log("Fleet " + fleetId + " costs CRITICALLY exceed limits (" + fleet.price + "); terminating and raising critical alert.");
				promises.push(criticalAlert("SFR " + fleetId + " current price is: " + fleet.price + "; Terminating."));

				promises.push(ec2.cancelSpotFleetRequests({
					TerminateInstances: true,
					SpotFleetRequestIds: [fleetId]
				}).promise().then((data) => {
					console.log(`Successfully terminated ${fleetId}`);
					return Promise.resolve();
				}, (e) => {
					return criticalAlert(`Failed to terminate fleet ${fleetId} with cost $${fleet.price}`);
				}));
			}
		});

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to update spot instance costs: ${e}`);
	}

	return callback(null, `[+] Reviewed [${Object.keys(spotFleets).length}] SFRs.`);
};

function criticalAlert(message) {
	return new Promise((success, failure) => {
		var sns = new aws.SNS({apiVersion: '2010-03-31', region: 'us-west-2'});

		sns.publish({
			Message: "NPK CriticalAlert: " + message,
			Subject: "NPK CriticalAlert",
			TopicArn: settings.critical_events_sns_topic
		}, function (err, data) {
			if (err) {
				console.log('CRITICAL ALERT FAILURE: ' + err);
				return failure(err);
			}

			console.log('CRITICAL ALERT: ' + message);
			return success(data);
		});
	});
};

function editCampaign(entity, campaign, values) {
	return new Promise((success, failure) => {
		values = aws.DynamoDB.Converter.marshall(values);

		Object.keys(values).forEach(function(e) {
			values[e] = {
				Action: "PUT",
				Value: values[e]
			};
		});

		var ddbParams = {
			Key: {
				userid: {S: entity},
				keyid: {S: "campaigns:" + campaign}
			},
			TableName: "Campaigns",
			AttributeUpdates: values
		};

		// console.log(JSON.stringify(ddbParams));

		db.updateItem(ddbParams, function (err, data) {
			if (err) {
				return failure(err);
			}

			return success(true);
		});
	});
}

function editCampaignViaRequestId(spotFleetRequestId, values) {
	return new Promise((success, failure) => {
		console.log(`[DEBUG-PRICE] editCampaignViaRequestId called for fleet: ${spotFleetRequestId}`);
		if (values.currentFleetPrice !== undefined) {
			console.log(`[DEBUG-PRICE]   Writing currentFleetPrice: $${values.currentFleetPrice}`);
		}

		db.query({
			ExpressionAttributeValues: {
				':s': {S: spotFleetRequestId}
			},
			KeyConditionExpression: 'spotFleetRequestId = :s',
			IndexName: "SpotFleetRequests",
			TableName: "Campaigns"
		}, function (err, data) {
			if (err) {
				return failure(cb("Error querying SpotFleetRequest table: " + err));
			}

			if (data.Items.length < 1) {
				console.log(`[DEBUG-PRICE]   No campaign found for fleet ${spotFleetRequestId}`);
				return success(null);
			}

			data = aws.DynamoDB.Converter.unmarshall(data.Items[0]);
			console.log("[+] Found campaign " + data.keyid.split(':').slice(1));
			console.log(`[DEBUG-PRICE]   Existing accumulatedPrice: $${data.accumulatedPrice || 0}`);
			console.log(`[DEBUG-PRICE]   Existing price: $${data.price || 0}`);
			console.log(`[DEBUG-PRICE]   Existing currentFleetPrice: $${data.currentFleetPrice || 0}`);


		// Check if campaign was already completed before marking as interrupted
		if (values.interrupted && values.interrupted === "Capacity Loss") {
			// Debug: Log campaign state before check
			console.log(`[COMPLETION-CHECK] Campaign ${data.keyid}:`);
			console.log(`[COMPLETION-CHECK]   progress: ${data.progress}`);
			console.log(`[COMPLETION-CHECK]   status: ${data.status}`);
			console.log(`[COMPLETION-CHECK]   nodes: ${data.nodes ? JSON.stringify(Object.keys(data.nodes)) : 'null'}`);

			const alreadyCompleted = (
				data.progress === 100 ||
				data.status === 'COMPLETED' ||
				(data.nodes && Object.values(data.nodes).every(n => n.status === 'COMPLETED'))
			);

			console.log(`[COMPLETION-CHECK]   alreadyCompleted: ${alreadyCompleted}`);

			if (alreadyCompleted) {
				console.log(`[+] Campaign ${data.keyid} was already completed before termination`);
				console.log(`[+] Not marking as interrupted - work was finished`);

				// Remove interrupted fields from update
				delete values.interrupted;
				delete values.resumable;
				delete values.interruptionTime;
				delete values.interruptionReason;
				delete values.interruptionDetails;
			} else {
				console.log(`[COMPLETION-CHECK] Campaign is NOT complete, marking as resumable`);
			}
		}
			editCampaign(data.userid, data.keyid.split(':').slice(1), values).then((updates) => {
				success(updates);
			});
		});
	});
}

function checkForCapacityTermination(fleet) {
	// Check fleet history for capacity-related termination reasons
	const capacityIndicators = [
		'instance-terminated-no-capacity',
		'instance-terminated-capacity-oversubscribed',
		'instance-terminated-launch-group-constraint',
		'no-capacity',
		'capacity-oversubscribed',
		'InsufficientInstanceCapacity',
		'Server.InsufficientInstanceCapacity'
	];

	let capacityLoss = null;

	// Check spot request status messages
	Object.keys(fleet.instances).forEach((instanceId) => {
		const instance = fleet.instances[instanceId];

		if (instance.Status && instance.Status.Message) {
			const message = instance.Status.Message;

			capacityIndicators.forEach((indicator) => {
				if (message.includes(indicator)) {
					capacityLoss = {
						reason: indicator,
						details: message,
						instanceId: instanceId,
						code: instance.Status.Code
					};

					console.log(`[CAPACITY-LOSS] Instance ${instanceId} terminated: ${message}`);
				}
			});
		}
	});

	// Check fleet history for capacity events
	if (!capacityLoss) {
		fleet.history.forEach((record) => {
			if (record.EventType === 'instanceChange' && record.EventInformation.EventSubType === 'terminated') {
				const desc = record.EventInformation.EventDescription;

				if (desc && typeof desc === 'string') {
					const descObj = JSON.parse(desc);

					if (descObj.reason) {
						capacityIndicators.forEach((indicator) => {
							if (descObj.reason.includes(indicator)) {
								capacityLoss = {
									reason: descObj.reason,
									details: desc,
									instanceId: record.EventInformation.InstanceId,
									timestamp: record.Timestamp
								};

								console.log(`[CAPACITY-LOSS] Instance ${record.EventInformation.InstanceId} terminated at ${record.Timestamp}: ${descObj.reason}`);
							}
						});
					}
				}
			}

			// Check for launchSpecUnusable events
			if (record.EventType === 'information' && record.EventInformation.EventSubType === 'launchSpecUnusable') {
				const desc = record.EventInformation.EventDescription;

				if (!capacityLoss) {
					capacityLoss = {
						reason: 'Launch spec unusable',
						details: desc,
						timestamp: record.Timestamp
					};

					console.log(`[CAPACITY-LOSS] Launch spec unusable: ${desc}`);
				}
			}

			// Check for spot request closed due to capacity
			if (record.EventType === 'spotInstanceRequestChange' && record.EventInformation.EventSubType === 'closed') {
				const desc = record.EventInformation.EventDescription;

				if (desc && typeof desc === 'string') {
					try {
						const descObj = JSON.parse(desc);

						if (descObj.reason) {
							capacityIndicators.forEach((indicator) => {
								if (descObj.reason.includes(indicator)) {
									capacityLoss = {
										reason: descObj.reason,
										details: desc,
										bidId: descObj.bidId,
										timestamp: record.Timestamp
									};

									console.log(`[CAPACITY-LOSS] Spot request closed: ${descObj.reason}`);
								}
							});
						}
					} catch (e) {
						// Ignore JSON parse errors
					}
				}
			}
		});
	}

	return capacityLoss;
}

function checkIfInstancesCompletedWork(fleet) {
	// Check if all instances completed their work before fleet was cancelled
	// This distinguishes between:
	// 1. Instances interrupted mid-work (need resume)
	// 2. Instances finished work, then fleet cancelled for config reasons (don't need resume)

	const instances = Object.keys(fleet.instances);

	if (instances.length === 0) {
		console.log(`[INSTANCE-CHECK] No instances found - assuming no work completed`);
		return false;
	}

	let allTerminated = true;
	let hasSpotInterruptions = false;
	let gracefulTerminations = 0;

	instances.forEach((instanceId) => {
		const instance = fleet.instances[instanceId];

		// Check if instance is still running
		if (['open', 'active'].indexOf(instance.State) > -1) {
			console.log(`[INSTANCE-CHECK] Instance ${instanceId} still in state: ${instance.State}`);
			allTerminated = false;
		}

		// Check for spot interruption indicators
		if (instance.Status && instance.Status.Message) {
			const spotInterruptionIndicators = [
				'spot-instance-termination',
				'instance-terminated-by-price',
				'instance-terminated-by-user',
				'marked-for-termination',
				'instance-stopped-by-user'
			];

			spotInterruptionIndicators.forEach((indicator) => {
				if (instance.Status.Message.includes(indicator)) {
					console.log(`[INSTANCE-CHECK] Instance ${instanceId} was spot-interrupted: ${instance.Status.Message}`);
					hasSpotInterruptions = true;
				}
			});
		}

		// Check if instance terminated gracefully (completed work and powered off)
		if (instance.State === 'terminated' || instance.State === 'closed') {
			gracefulTerminations++;
		}
	});

	const totalInstances = instances.length;
	const allInstancesTerminatedGracefully = (gracefulTerminations === totalInstances);

	console.log(`[INSTANCE-CHECK] Summary for fleet ${fleet.SpotFleetRequestId}:`);
	console.log(`[INSTANCE-CHECK]   Total instances: ${totalInstances}`);
	console.log(`[INSTANCE-CHECK]   Graceful terminations: ${gracefulTerminations}`);
	console.log(`[INSTANCE-CHECK]   All terminated: ${allTerminated}`);
	console.log(`[INSTANCE-CHECK]   Has spot interruptions: ${hasSpotInterruptions}`);
	console.log(`[INSTANCE-CHECK]   All completed work: ${allInstancesTerminatedGracefully && !hasSpotInterruptions}`);

	// Instances completed work if:
	// 1. All instances terminated gracefully AND
	// 2. No spot interruption indicators found
	return allInstancesTerminatedGracefully && !hasSpotInterruptions;
}

function getSpotRequestHistory(ec2, sfr, nextToken = null) {
	let history = [];

	return ec2.describeSpotFleetRequestHistory({
		SpotFleetRequestId: sfr,
		StartTime: "1970-01-01T00:00:00Z",
		NextToken: nextToken
	}).promise().then((data) => {

		history = history.concat(data.HistoryRecords);

		if (data.hasOwnProperty('NextToken')) {
			return getSpotRequestHistory(ec2, sfr, data.NextToken);
		}

		history = history.map((entry) => {
			entry.Timestamp = new Date(entry.Timestamp).getTime() / 1000;

			return entry
		});

		return history;
	});
}