fakeSNS
========

Locally hosted reimplementation of AWS Simple Notification Service for HTTP(S) endpoints

## Caveats
* There is no authentication, signature verification, or proper signing of subscription confirmations
* Because there is no authentication, all topics and subscriptions are assumed to be owned by a predetermined account ID
* Permissions are unimplemented
* Only the `http` and `https` endpoints are implemented

## Usage
* Installation: `npm install -g fake_sns`
* Start: `$ fake_sns`
* Options:
 * `--port PORT, -p PORT`: The port number to use (default: 443)
 * `--region REGION, -r REGION`: The region used when creating topic ARNs (default: "us-east-1")
 * `--account-id ACCOUNT_ID, -a ACCOUNT_ID`: The AWS account ID used when creating topic ARNs (default: 123456789012)
 * `--topic-limit TOPIC_LIMIT, -l TOPIC_LIMIT`: The limit of topics allowed (default: 100)
 * `--subscribe-hostname SUBSCRIBE_HOSTNAME, -s SUBSCRIBE_HOSTNAME`: The hostname used to form the subscription confirmation URL (default: localhost)
