'use strict';

const aws = require("aws-sdk");
const settings = JSON.parse(JSON.stringify(process.env));

exports.main = async function (event, context, callback) {
	console.log(JSON.stringify(event));
	if (event['detail-type'] != "EC2 Spot Instance Interruption Warning") {
		console.log(`[!] Wrong event type received. Got: ${event['detail-type']}`);
		return callback("Wrong event type received");
	}

	if (!event.region || !event.detail?.['instance-id']) {
		console.log(`[!] Event is missing critical details.`);
		return callback("Event is missing critical details");
	}

	let instance, instanceId;

	try {
		instanceId = event.detail['instance-id'];

		console.log(`[+] Caught interruption event for instance ${instanceId}`);

		const ec2 = new aws.EC2({ region: event.region });

		// Get details for the instance to be terminated:
		instance = await ec2.describeInstances({
			Filters: [{
				Name: "instance-id",
				Values: [ instanceId ]
			}]
		}).promise();

		instance = instance.Reservations[0].Instances[0];

		// Convert the tags from entries to a map.
		instance.Tags = instance.Tags.reduce((tags, tag) => {
			tags[tag.Key] = tag.Value;

			return tags;
		}, {});
	} catch (e) {
		console.log(`[!] Failed to retrieve instance details. ${e}`);
		return callback("Failed to retrieve instance details");
	}

	let user, campaignId;
	
	try {
		// Pull the campaign from the ManifestPath tag
		if (!instance.Tags?.ManifestPath || instance.Tags.ManifestPath.indexOf('/campaigns/') < 0) {
			console.log(`[!] Instance tag 'ManifestPath' is invalid. Got tags: ${JSON.stringify(instance.Tags)}`);
			return callback("Instance tag 'ManifestPath' is invalid");
		}

		[user, campaignId] = instance.Tags.ManifestPath.split('/campaigns/');

		// Update that campaign details
		const ddb = new aws.DynamoDB({ region: settings.region });

		const interruptionTime = Math.floor(Date.now() / 1000);

		console.log(`[RESUME-PREP] Spot interruption detected for campaign ${campaignId}`);
		console.log(`[RESUME-PREP] User: ${user}`);
		console.log(`[RESUME-PREP] Instance: ${instanceId}`);
		console.log(`[RESUME-PREP] Interruption time: ${new Date(interruptionTime * 1000).toISOString()}`);
		console.log(`[RESUME-PREP] Region: ${event.region}`);
		console.log(`[RESUME-PREP] Instance action: ${JSON.stringify(event.detail)}`);
		console.log(`[RESUME-PREP] Marking campaign as resumable`);

		await ddb.updateItem({
			Key: {
				userid: { S: user },
				keyid: { S: `campaigns:${campaignId}` }
			},
			TableName: "Campaigns",
			AttributeUpdates: {
				interrupted: {
					Action: "PUT",
					Value: { S: "Spot Interruption" }
				},
				resumable: {
					Action: "PUT",
					Value: { BOOL: true }
				},
				interruptedInstance: {
					Action: "PUT",
					Value: { S: instanceId }
				},
				interruptionTime: {
					Action: "PUT",
					Value: { N: interruptionTime.toString() }
				},
				interruptionRegion: {
					Action: "PUT",
					Value: { S: event.region }
				}
			}
		}).promise();

		console.log(`[RESUME-PREP] Campaign ${campaignId} marked as resumable`);

		// NEW: Trigger immediate restore file backup using SSM
		// This gives us the full 2-minute window instead of just 30 seconds at SIGTERM
		console.log(`[RESUME-PREP] Triggering immediate restore file backup via SSM...`);

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

			console.log(`[RESUME-PREP] SSM command sent successfully: ${ssmCommand.Command.CommandId}`);
			console.log(`[RESUME-PREP] Instance has 2 minutes to backup restore files before termination`);
		} catch (ssmErr) {
			// Don't fail the lambda if SSM fails - SIGTERM handler will still catch it
			console.error(`[RESUME-PREP] WARNING: Failed to send SSM command: ${ssmErr}`);
			console.log(`[RESUME-PREP] Backup will still occur via SIGTERM handler (30s window)`);
		}

		console.log(`[RESUME-PREP] Campaign ${campaignId} marked as resumable - restore files should be in S3`);
	} catch (e) {
		console.log(`[!] Failed to mark instance as interrupted. ${e}`);
		return callback("Failed to mark instance as interrupted");
	}

	console.log(`[+] Marked campaign ${campaignId} as interrupted.`);
}