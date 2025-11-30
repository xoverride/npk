local cors_rule(origin) = {
	"allowed_headers": ["*"],
	"allowed_methods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
	"allowed_origins": [origin],
	"expose_headers": ["x-amz-meta-lines", "x-amz-meta-size", "x-amz-meta-type", "content-length", "ETag"],
	"max_age_seconds": 3000
};

local lifecycle_rule = {
	"id": "expire-restore-files",
	"enabled": true,
	"prefix": "*/campaigns/*/restore/",
	"expiration": {
		"days": 7
	}
};

local bucket(name, cors=null, lifecycle=true) =
	if std.type(cors) == "null" then
		if lifecycle then
			{ "bucket_prefix": name, "force_destroy": true, "lifecycle_rule": [lifecycle_rule] }
		else
			{ "bucket_prefix": name, "force_destroy": true }
	else
		if lifecycle then
			{ "bucket_prefix": name, "force_destroy": true, "cors_rule": cors, "lifecycle_rule": [lifecycle_rule] }
		else
			{ "bucket_prefix": name, "force_destroy": true, "cors_rule": cors };

{
	"cors_rule": cors_rule,
	"lifecycle_rule": lifecycle_rule,
	"bucket": bucket
}