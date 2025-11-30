'use strict';

const fs = require('fs');
const aws = require('aws-sdk');

const accountDetails = JSON.parse(fs.readFileSync('./accountDetails.json', 'ascii'));
const archs = Object.keys(accountDetails.families).reduce((acc, curr) => {
	Object.keys(accountDetails.families[curr].instances).forEach((instance) => {
		acc[instance] = accountDetails.families[curr].architecture || "x86_64";
	});

	return acc;
}, {});

const amis = Object.keys(accountDetails.families).reduce((acc, curr) => {
	Object.keys(accountDetails.families[curr].instances).forEach((instance) => {
		acc[instance] = accountDetails.families[curr].ami || false;
	});

	return acc;
}, {});

const owners = Object.keys(accountDetails.families).reduce((acc, curr) => {
	Object.keys(accountDetails.families[curr].instances).forEach((instance) => {
		acc[instance] = accountDetails.families[curr].owner || false;
	});

	return acc;
}, {});

const ddb = new aws.DynamoDB({ region: accountDetails.primaryRegion });
const s3 = new aws.S3({ region: accountDetails.primaryRegion });

let cb = "";
let origin = "";
let variables = {};

const cognito = new aws.CognitoIdentityServiceProvider({region: accountDetails.primaryRegion, apiVersion: "2016-04-18"});

exports.main = async function(event, context, callback) {

	console.log(JSON.stringify(event));

	// Hand off the callback function for later.
	cb = callback;

	// Get the available envvars into a usable format.
	variables = JSON.parse(JSON.stringify(process.env));
	variables.regions = JSON.parse(variables.regions);

	let promises = [];

	// Enumerate the subnets based on VPCs per region.
	try {
		variables.availabilityZones = {};

		for (const region of Object.keys(variables.regions)) {

			variables.availabilityZones[region] = {};

			const ec2 = new aws.EC2({region: region});

			promises.push(ec2.describeSubnets({
				Filters: [{
					Name: "vpc-id",
					Values: [variables.regions[region]]
				}]
			}).promise().then((data) => {
				data.Subnets.forEach((subnet) => {
					variables.availabilityZones[region][subnet.AvailabilityZone] = subnet.SubnetId;
				});
			}));
		}
	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to retrieve subnets for VPC: ${e}`);
	}

	let entity, UserPoolId, sub;

	try {

		console.log("Received event: " + JSON.stringify(event));

		// Hand off the origin, too. Fix for weird case
		origin = event?.headers?.origin ?? event?.headers?.Origin;

		var allowed_characters = /^[a-zA-Z0-9'"%\.\[\]\{\}\(\)\-\:\\\/\;\=\?\#\_+\s,!@#\$\^\*&]+$/;
		if (!allowed_characters.test(JSON.stringify(event))) {
			console.log("Request contains illegal characters");
			return respond(400, {}, "Request contains illegal characters", false);
		}

		if (event?.requestContext?.identity?.cognitoAuthenticationType != "authenticated") {
			console.log(`cognitoAuthenticationType ${event?.requestContext?.identity?.cognitoAuthenticationType} != "authenticated"`)
			return respond(401, {}, "Authentication Required", false);
		}

		entity = event.requestContext.identity.cognitoIdentityId;

		// Associate the user identity.
		[ UserPoolId,, sub ] = event?.requestContext?.identity?.cognitoAuthenticationProvider?.split('/')[2]?.split(':');

		if (!UserPoolId || !sub) {
			console.log(`UserPoolId or sub is missing from ${event?.requestContext?.identity?.cognitoAuthenticationProvider}`);
			respond(401, {}, "Authorization Required", false);
		}

	} catch (e) {
		console.log("Failed to process request.", e);
		return respond(500, {}, "Failed to process request.", false);
	}

	let user, email, Username;

	try {
		// Get the user based on 'sub'. This is needed when the IdP isn't Cognito itself.
		let userList = await cognito.listUsers({ UserPoolId, Filter: `sub = "${sub}"` }).promise();

		if (!userList.Users?.[0]?.Username) {
			console.log("Unable to find Cognito user from Subscriber ID.", e);
			return respond(500, {}, "Unable to find Cognito user from Subscriber ID.", false);
		}

		Username = userList.Users[0].Username;

		const user = await cognito.adminGetUser({ UserPoolId, Username }).promise();

		// Restructure UserAttributes as an k:v
		user.UserAttributes = user.UserAttributes.reduce((attrs, entry) => {
			attrs[entry.Name] = entry.Value

			return attrs;
		}, {});

		if (!user?.UserAttributes?.email) {
			return respond(401, {}, "Unable to obtain user properties.", false);
		}

		email = user.UserAttributes.email;
			
	} catch (e) {
		console.log(`Failed to retrieve subnets for VPC: ${e}`);
		return respond(500, {}, "Failed to retrieve subnets for VPC.", false);
	}

	console.log(event.pathParameters)

	const campaignId = event?.pathParameters?.campaign;

	// Get the campaign entry from DynamoDB, and manifest from S3.
	// * In parallel, to save, like, some milliseconds.

	let campaign, manifestObject, manifest;

	try {
		[campaign, manifestObject] = await Promise.all([
			ddb.query({
				ExpressionAttributeValues: {
					':id': {S: entity},
					':keyid': {S: `campaigns:${campaignId}`}
				},
				KeyConditionExpression: 'userid = :id and keyid = :keyid',
				TableName: "Campaigns"
			}).promise(),

			s3.getObject({
				Bucket: variables.userdata_bucket,
				Key: `${entity}/campaigns/${campaignId}/manifest.json`
			}).promise()
		]);

		manifest = JSON.parse(manifestObject.Body.toString('ascii'));
	} catch (e) {
		console.log("Failed to retrieve campaign details.", e);
		return respond(500, {}, "Failed to retrieve campaign details.", false);
	}

	// Check if this is a resume attempt by looking for restore files in S3
	// We don't rely on "resumable" flag - if restore files exist, we can resume!
	const campaignStatus = campaign.Items?.[0]?.status?.S;
	const isAvailable = campaignStatus == "AVAILABLE";
	const canAttemptResume = !isAvailable; // Any non-AVAILABLE campaign might have restore files

	if (!isAvailable && !canAttemptResume) {
		return respond(404, {}, "Campaign doesn't exist or is not in a valid status.", false);
	}

	// If campaign is not AVAILABLE, check for restore files to see if we can resume
	let resumeInstanceCount = manifest.instanceCount;
	let resumeMetadata = {};
	let isResume = false;

	if (canAttemptResume) {
		console.log(`[RESUME] Campaign ${campaignId} is not AVAILABLE, checking for restore files...`);
		console.log(`[RESUME] Current status: ${campaignStatus}`);
		console.log(`[RESUME] User: ${email}, Entity: ${entity}`);

		try {
			// List restore files in S3 to determine if we can resume
			const s3Path = `${entity}/campaigns/${campaignId}/restore/`;
			console.log(`[RESUME] Checking S3 for restore files at: s3://${variables.userdata_bucket}/${s3Path}`);

			const restoreFiles = await s3.listObjectsV2({
				Bucket: variables.userdata_bucket,
				Prefix: s3Path,
				MaxKeys: 1000
			}).promise();

			console.log(`[RESUME] Found ${restoreFiles.Contents?.length || 0} restore files in S3`);

			// Count unique instance IDs from restore files
			const instancesWithRestoreFiles = new Set();
			const restoreFileDetails = [];

			if (restoreFiles.Contents) {
				restoreFiles.Contents.forEach(file => {
					// Extract session pattern from filename like "campaign_id-1.restore"
					// Session pattern is: campaign_id-instance_number
					const match = file.Key.match(/\/([^\/]+)-(\d+)\.restore$/);
					if (match) {
						const sessionName = `${match[1]}-${match[2]}`;  // e.g., "campaign123-1"
						const instanceNumber = parseInt(match[2]);
						instancesWithRestoreFiles.add(sessionName);
						restoreFileDetails.push({
							sessionName: sessionName,
							instanceNumber: instanceNumber,
							size: file.Size,
							lastModified: file.LastModified.toISOString()
						});
						console.log(`[RESUME] Found restore file for instance slot ${instanceNumber} (${file.Size} bytes, modified ${file.LastModified.toISOString()})`);
					}
				});
			}

			resumeInstanceCount = instancesWithRestoreFiles.size;

			if (resumeInstanceCount === 0) {
				console.log("[RESUME] No restore files found - this is a fresh start, not a resume");
				return respond(400, {}, "No restore files found. Cannot resume campaign. Please create a new campaign instead.", false);
			}

			// We found restore files, so this IS a resume!
			isResume = true;
			console.log(`[RESUME] SUCCESS: Found restore files for ${resumeInstanceCount} instances`);
			console.log(`[RESUME] Original campaign had ${manifest.instanceCount} instances`);
			console.log(`[RESUME] ${manifest.instanceCount - resumeInstanceCount} instances already completed`);
			console.log(`[RESUME] Cost optimization: ${((1 - resumeInstanceCount / manifest.instanceCount) * 100).toFixed(1)}% fewer instances needed`);

			// Log interruption details if available
			if (campaign.Items[0].interrupted?.S) {
				console.log(`[RESUME] Interruption reason: ${campaign.Items[0].interrupted.S}`);
				console.log(`[RESUME] Interrupted at: ${new Date(campaign.Items[0].interruptionTime?.N * 1000 || 0).toISOString()}`);
			} else {
				console.log(`[RESUME] No interruption metadata (campaign may have been manually stopped or crashed)`);
			}

			// Store resume metadata for DynamoDB
			resumeMetadata = {
				originalInstanceCount: manifest.instanceCount,
				resumeInstanceCount: resumeInstanceCount,
				instancesCompleted: manifest.instanceCount - resumeInstanceCount,
				restoreFileCount: restoreFiles.Contents?.length || 0,
				restoreInstances: Array.from(instancesWithRestoreFiles),
				resumeTimestamp: Math.floor(Date.now() / 1000),
				s3RestorePath: s3Path
			};

			// Update manifest with adjusted instance count
			manifest.instanceCount = resumeInstanceCount;

			console.log(`[RESUME] Resume metadata:`, JSON.stringify(resumeMetadata, null, 2));

		} catch (listErr) {
			console.error("[RESUME] ERROR: Failed to check restore files:", listErr);
			console.log("[RESUME] FALLBACK: Using original instance count due to error");
			resumeInstanceCount = manifest.instanceCount;

			resumeMetadata = {
				error: listErr.message,
				fallbackUsed: true,
				originalInstanceCount: manifest.instanceCount,
				resumeInstanceCount: resumeInstanceCount
			};
		}
	}

	// Test whether the provided presigned URL is expired.
	// For resume operations, generate a fresh presigned URL

	if (!isResume) {
		let expires, duration;

		try {
			expires = /[^-]Expires=([\d]+)&/.exec(manifest.hashFileUrl)?.[1];

			if (!!!expires) {
				let date = /X-Amz-Date=([^&]+)&/.exec(manifest.hashFileUrl)?.[1];
				let seconds = /X-Amz-Expires=([\d]+)&/.exec(manifest.hashFileUrl)?.[1];

				date = new Date(Date.parse(date.replace(/(....)(..)(..T..)(..)/, "$1-$2-$3:$4:"))).getTime();

				expires = date + (seconds * 1000)
			}

			duration = expires - (new Date().getTime() / 1000);

			if (duration < 900) {
				return respond(400, {}, `hashFileUrl must be valid for at least 900 seconds, got ${Math.floor(duration)}`, false);
			}
		} catch (e) {
			console.log(e);
			return respond(400, {}, "Invalid hashFileUrl; missing expiration", false);
		}
	} else {
		console.log(`[RESUME] Generating fresh presigned URL for hash file`);

		// Generate a fresh presigned URL for the hash file stored in S3
		if (!manifest.hashFile) {
			return respond(400, {}, "Cannot resume: manifest is missing hashFile reference", false);
		}

		try {
			const hashFileKey = `${entity}/${manifest.hashFile}`;
			console.log(`[RESUME] Hash file location: s3://${variables.userdata_bucket}/${hashFileKey}`);

			// Generate presigned URL valid for 4 hours (14400 seconds)
			const freshUrl = s3.getSignedUrl('getObject', {
				Bucket: variables.userdata_bucket,
				Key: hashFileKey,
				Expires: 14400
			});

			manifest.hashFileUrl = freshUrl;
			console.log(`[RESUME] Generated fresh presigned URL (valid for 4 hours)`);

			// Update manifest.json in S3 with the fresh URL
			const manifestKey = `${entity}/campaigns/${campaignId}/manifest.json`;
			await s3.putObject({
				Bucket: variables.userdata_bucket,
				Key: manifestKey,
				Body: JSON.stringify(manifest),
				ContentType: 'application/json'
			}).promise();
			console.log(`[RESUME] Updated manifest.json in S3 with fresh hashFileUrl`);
		} catch (err) {
			console.error(`[RESUME] ERROR generating presigned URL:`, err);
			return respond(500, {}, `Failed to generate presigned URL for hash file: ${err.message}`, false);
		}
	}

	// Campaign is valid. Get AZ pricing and Image AMI
	// * Again in parallel, to save, like, some more milliseconds.

	const ec2 = new aws.EC2({region: manifest.region});
	let pricing, image;

	const imageFilters = [{
        Name: "virtualization-type",
        Values: ["hvm"]
    },{
    	Name: "root-device-type",
    	Values: ["ebs"]
    }];

	imageFilters.push({
    	Name: "architecture",
    	Values: [archs[manifest.instanceType]]
    });

    const defaultImageName = "Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023) *";

	imageFilters.push({
    	Name: "name",
    	Values: [amis[manifest.instanceType] || defaultImageName]
    });

    const defaultImageOwner = "898082745236";

	imageFilters.push({
    	Name: "owner-id",
    	Values: [owners[manifest.instanceType] || defaultImageOwner]
    });

    console.log(imageFilters);

	try {
		[pricing, image] = await Promise.all([
			ec2.describeSpotPriceHistory({
				EndTime: Math.round(Date.now() / 1000),
				ProductDescriptions: [ "Linux/UNIX (Amazon VPC)" ],
				InstanceTypes: [ manifest.instanceType ],
				StartTime: Math.round(Date.now() / 1000)
			}).promise(),

			ec2.describeImages({
				Filters: imageFilters
			}).promise()
		]);
	} catch (e) {
		console.log("Failed to retrieve price and image details.", e);
		return respond(500, {}, "Failed to retrieve price and image details.", false);
	}

	console.log(image);

	image = image.Images.reduce((newest, entry) => 
		entry.CreationDate > newest.CreationDate ? entry : newest
	, { CreationDate: '1980-01-01T00:00:00.000Z' });

	if (!!!image.ImageId) {
		console.log("Unable to find a suitable AMI.");
		return respond(500, {}, "Unable to find a suitable AMI.", false);
	}

	let spotFleetParams;

	try {

		// Calculate the necessary volume size

		const volumeSize = (Math.ceil(manifest.wordlistSize / 1073741824) * 2) + 1;
		console.log(`Wordlist is ${manifest.wordlistSize / 1073741824}GiB. Allocating ${volumeSize}GiB`);

		// Build a launchSpecification for each AZ in the target region.

		const instance_userdata = new Buffer.from(fs.readFileSync(__dirname + '/userdata.sh', 'utf-8')
			.replace("{{APIGATEWAY}}", process.env.apigateway))
			.toString('base64');

		const launchSpecificationTemplate = {
            ImageId: image.ImageId,
			KeyName: "npk-key",
			InstanceType: manifest.instanceType,
            NetworkInterfaces: [
                {
                    DeviceIndex: 0,
                    DeleteOnTermination: true,
                    AssociatePublicIpAddress: true
                }
            ],
            BlockDeviceMappings: [{
				DeviceName: '/dev/xvdb',
				Ebs: {
					DeleteOnTermination: true,
					Encrypted: false,
					VolumeSize: volumeSize,
					VolumeType: "gp2"
				}
			}],
            IamInstanceProfile: {
				Arn: variables.instanceProfile
			},
            TagSpecifications: [{
				ResourceType: "instance",
				Tags: [{
					Key: "MaxCost",
					Value: ((manifest.priceTarget < variables.campaign_max_price) ? manifest.priceTarget : variables.campaign_max_price).toString()
				}, {
					Key: "ManifestPath",
					Value: `${entity}/campaigns/${campaignId}`
				}]
			}],
            UserData: instance_userdata
        }

		/*const launchSpecificationTemplate = {
			IamInstanceProfile: {
				Arn: variables.instanceProfile
			},
			ImageId: image.ImageId,
			KeyName: "npk-key",
			InstanceType: manifest.instanceType,
			BlockDeviceMappings: [{
				DeviceName: '/dev/xvdb',
				Ebs: {
					DeleteOnTermination: true,
					Encrypted: false,
					VolumeSize: volumeSize,
					VolumeType: "gp2"
				}
			}],
			NetworkInterfaces: [{
				AssociatePublicIpAddress: true,
				DeviceIndex: 0,
				// SubnetId: Gets populated below.
			}],
			Placement: {
				// AvailabilityZone: Gets populated below.
			},
			TagSpecifications: [{
				ResourceType: "instance",
				Tags: [{
					Key: "MaxCost",
					Value: ((manifest.priceTarget < variables.campaign_max_price) ? manifest.priceTarget : variables.campaign_max_price).toString()
				}, {
					Key: "ManifestPath",
					Value: `${entity}/campaigns/${campaignId}`
				}]
			}],
			UserData: instance_userdata
		};*/

		// Create a copy of the launchSpecificationTemplate for each AvailabilityZone in the campaign's region.
		console.log(variables.availabilityZones)

		const launchSpecifications = Object.keys(variables.availabilityZones[manifest.region]).reduce((specs, entry) => {
			const az = JSON.parse(JSON.stringify(launchSpecificationTemplate)); // Have to deep-copy to avoid referential overrides.

			// az.Placement.AvailabilityZone = entry;
			az.NetworkInterfaces[0].SubnetId = variables.availabilityZones[manifest.region][entry];

			return specs.concat(az);
		}, []);

		// Get the average spot price across all AZs in the region.
		const spotPrice = pricing.SpotPriceHistory.reduce((average, entry) => average + (entry.SpotPrice / pricing.SpotPriceHistory.length), 0);
		const maxDuration = (Number(manifest.instanceDuration) < variables.campaign_max_price / spotPrice) ? Number(manifest.instanceDuration) : variables.campaign_max_price / spotPrice;

		console.log(`Setting Duration to ${maxDuration} (Spot average $${spotPrice} with limit of $${variables.campaign_max_price})`);

		spotFleetParams = {
			SpotFleetRequestConfig: {
				AllocationStrategy: "lowestPrice",
				IamFleetRole: variables.iamFleetRole,
				InstanceInterruptionBehavior: "terminate",
				LaunchSpecifications: launchSpecifications,
				SpotPrice: (manifest.priceTarget / (manifest.instanceCount * manifest.instanceDuration) * 2).toString(),
				TargetCapacity: manifest.instanceCount,
				ReplaceUnhealthyInstances: false,
				TerminateInstancesWithExpiration: true,
				Type: "request",
				ValidFrom: (new Date().getTime() / 1000),
				ValidUntil: (new Date().getTime() / 1000) + (maxDuration * 3600)
			}
		};

		console.log(JSON.stringify(spotFleetParams));
	} catch (e) {
		console.log("Failed to generate launch specifications.", e);
		return respond(500, {}, "Failed to generate launch specifications.", false);
	}

	let spotFleetRequest;

	try {
		spotFleetRequest = await ec2.requestSpotFleet(spotFleetParams).promise();
	} catch (e) {
		console.log("Failed to request spot fleet.", e);
		return respond(500, {}, "Failed to request spot fleet.", false);
	}

	// Campaign created successfully.

	console.log(`Successfully requested spot fleet ${spotFleetRequest.SpotFleetRequestId}`);

	try {
		const updateParams = aws.DynamoDB.Converter.marshall({
			active: true,
			status: "STARTING",
			spotFleetRequestId: spotFleetRequest.SpotFleetRequestId,
			startTime: Math.floor(new Date().getTime() / 1000),
			eventType: isResume ? "CampaignResumed" : "CampaignStarted",
			lastuntil: 0,
		});

		// Clear resume flags and add resume metadata when successfully resuming
		if (isResume) {
			updateParams.resumable = { BOOL: false };
			updateParams.interrupted = { NULL: true };
			updateParams.resumeMetadata = aws.DynamoDB.Converter.marshall(resumeMetadata);
			updateParams.resumeCount = { N: (campaign.Items[0].resumeCount?.N ? parseInt(campaign.Items[0].resumeCount.N) + 1 : 1).toString() };

			console.log(`[RESUME] SUCCESS: Campaign ${campaignId} resumed successfully`);
			console.log(`[RESUME] Spot Fleet ID: ${spotFleetRequest.SpotFleetRequestId}`);
			console.log(`[RESUME] Launching ${resumeInstanceCount} instances`);
			console.log(`[RESUME] Resume count: ${updateParams.resumeCount.N}`);
		}

		const updateCampaign = await ddb.updateItem({
			Key: {
				userid: {S: entity},
				keyid: {S: `campaigns:${campaignId}`}
			},
			TableName: "Campaigns",
			AttributeUpdates: Object.keys(updateParams).reduce((attrs, entry) => {
				attrs[entry] = {
					Action: "PUT",
					Value: updateParams[entry]
				};

				return attrs;
			}, {})

		}).promise();
	} catch (e) {
		console.log("Spot fleet submitted, but failed to mark Campaign as 'STARTING'. This is a catastrophic error.", e);
		return respond(500, {}, "Spot fleet submitted, but failed to mark Campaign as 'STARTING'. This is a catastrophic error.", false);
	}

	return respond(200, {}, { msg: "Campaign started successfully", campaignId: campaignId, spotFleetRequestId: spotFleetRequest.SpotFleetRequestId }, true);
}

function respond(statusCode, headers, body, success) {

	// Include terraform dns names as allowed origins, as well as localhost.
	const allowed_origins = [variables.www_dns_names, "https://localhost"];

	headers['Content-Type'] = 'text/plain';

	if (allowed_origins.indexOf(origin) !== false) {
		// Echo the origin back. I guess this is the best way to support multiple origins
		headers['Access-Control-Allow-Origin'] = origin;
	} else {
		console.log("Invalid origin received.", origin);
	}

	switch (typeof body) {
		case "string":
			body = { msg: body, success: success };
		break;

		case "object":
			body.success = success;
		break;
	}

	const response = {
		statusCode: statusCode,
		headers: headers,
		body: JSON.stringify(body),
	}

	console.log(JSON.stringify(response));

	cb(null, response);

	return Promise.resolve(body.msg);
}
