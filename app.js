var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var https = require('https');
var url = require('url');
var express = require('express');
var builder = require('xmlbuilder');
var argparser = require('argparse').ArgumentParser;
var _ = require('underscore');
var Fiber = require('fibers');

var default_delivery_policy = {
  http: {
    defaultHealthyRetryPolicy: {
      minDelayTarget: 20,
      maxDelayTarget: 20,
      numRetries: 3,
      numMaxDelayRetries: 0,
      numNoDelayRetries: 0,
      numMinDelayRetries: 0,
      backoffFunction: 'linear',
    },
    defaultSicklyRetryPolicy: null,
    disableSubscriptionOverrides: false,
    defaultThrottlePolicy: {
      maxReceivesPerSecond: null
    },
  },
};

var parser = new argparser({description: 'Fake Simple Notification Service'});
parser.addArgument(['--port', '-p'], {help: 'The port number to use (default: 443)', type: 'int', defaultValue: 443});
parser.addArgument(['--region', '-r'], {help: 'The region used when creating topic ARNs (default: "us-east-1")', defaultValue: 'us-east-1'});
parser.addArgument(['--account-id', '-a'], {help: 'The AWS account ID used when creating topic ARNs (default: 123456789012)', type: 'int', defaultValue: 123456789012});
parser.addArgument(['--topic-limit', '-l'], {help: 'The limit of topics allowed (default: 100)', type: 'int', defaultValue: 100});
parser.addArgument(['--subscribe-hostname', '-s'], {help: 'The hostname used to form the subscription confirmation URL (default: localhost)', defaultValue: 'localhost'});
var args = parser.parseArgs();

var app = express();

app.configure(function(){
  app.use(express.logger('dev'));
  app.use(app.router);
});

var next_request = 0;
function get_request_id() {
  var string = ('00000000000' + next_request++);
  return 'f1db9c6a-1000-5f7f-802f-' + string.substr(string.length - 12);
}

function error(res, code) {
  var error_response = builder.create('ErrorResponse');
  error_response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var error = error_response.ele('Error');
  error.ele('Type', 'Sender');
  error.ele('Code', code);

  switch (code) {
    case 'InvalidAction':
      error.ele('Message', 'The action or operation requested is invalid.');
      res.statusCode = 400;
      break;

    case 'MissingAction':
      error.ele('Message', 'The request is missing an action or operation parameter.');
      res.statusCode = 400;
      break;

    case 'MissingParameter':
      error.ele('Message', 'An input parameter that is mandatory for processing the request is not supplied.');
      res.statusCode = 400;
      break;

    case 'InvalidParameter':
      error.ele('Message', 'An input parameter is invalid.');
      res.statusCode = 400;
      break;

    case 'TopicLimitExceeded':
      error.ele('Message', 'The maximum limit of topics has been exceeded.');
      res.statusCode = 403;
      break;

    case 'NotFound':
      error.ele('Message', 'The requested resource does not exist.');
      res.statusCode = 404;
      break;

    case 'Unimplemented':
      error.ele('Message', 'This functionality has not been implemented in Fake SNS yet.');

    default:
      throw new Error('Unknown error code "' + code + '"');
  }

  error_response.ele('RequestId', get_request_id());

  res.end(error_response.end({pretty: true, indent: '  '}));
}

function merge_policies(topic, subscription) {
  var topic_policy = {};

  if ('DeliveryPolicy' in topic && 'http' in topic.DeliveryPolicy)
    topic_policy = _.clone(topic.DeliveryPolicy.http);
  _.defaults(topic_policy, default_delivery_policy.http);

  var disable_overrides = topic_policy.disableSubscriptionOverrides;
  delete topic_policy.disableSubscriptionOverrides;
  topic_policy.healthyRetryPolicy = topic_policy.defaultHealthyRetryPolicy;
  delete topic_policy.defaultHealthyRetryPolicy;
  topic_policy.throttlePolicy = topic_policy.defaultThrottlePolicy;
  delete topic_policy.defaultThrottlePolicy;

  if (disable_overrides || !subscription)
    return topic_policy;

  var policy = _.clone(subscription.DeliveryPolicy || {});
  _.defaults(policy, topic_policy);

  return policy;
}

function send_message(options, callback) {
  var parsed = url.parse(options.subscription.endpoint);
  var msg_id = options.message_id;

  if (!msg_id)
    msg_id = get_request_id();

  var opts = {hostname: parsed.hostname, method: 'POST', path: parsed.path};
  if ('port' in parsed)
    opts.port = parsed.port;

  opts.headers = {
    'x-amz-sns-message-type': options.message_type,
    'x-amz-sns-message-id': msg_id,
    'x-amz-sns-topic-arn': options.topic.TopicArn,
    'x-amz-sns-subscription-arn': options.subscription.SubscriptionArn,
    'Content-Type': 'text/plain; charset=UTF-8',
    'User-Agent': 'Fake Amazon Simple Notification Service Agent',
  };

  var req = (parsed.protocol == 'http:' ? http : https).request(opts);
  req.setTimeout(15*1000);
  req.on('response', function(res) {
    callback(null, res);
  });
  req.on('error', callback);

  var body = {
    Type: options.message_type,
    MessageId: msg_id,
    TopicArn: options.topic.TopicArn,
    Timestamp: options.timestamp,
    SignatureVersion: '0',
    Signature: 'None',
    SigningCertURL: 'None',
  };

  if (options.message_type == 'SubscriptionConfirmation') {
    body.Token = options.token;
    body.Message = 'You have chosen to subscribe to the topic ' + options.topic.TopicArn + '.\nTo confirm the subscription, visit the SubscribeURL included in this message.';
    body.SubscribeURL = 'https://' + args.subscribe_hostname + ':' + args.port + '/?Action=ConfirmSubscription&TopicArn=' + options.topic.TopicArn + '&Token=' + options.token;
  } else if (options.message_type == 'Notification') {
    if (options.subject)
      body.Subject = options.subject;
    body.Message = options.message;
    body.UnsubscribeURL = 'https://' + args.subscribe_hostname + ':' + args.port + '/?Action=Unsubscribe&SubscriptionArn=' + options.subscription.SubscriptionArn;
  }

  req.end(JSON.stringify(body));
}

var topics = {};
var subscriptions = {};

function confirm_subscription(req, res) {
  if (!('TopicArn' in req.query && 'Token' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.TopicArn in topics))
    return error(res, 'NotFound');

  var topic = topics[req.query.TopicArn];

  if (!(req.query.Token in topic.unconfirmed))
    return error(res, 'NotFound');

  var unconfirmed = topic.unconfirmed[req.query.Token];
  topic.subscriptions[unconfirmed.arn] = {SubscriptionArn: unconfirmed.arn, TopicArn: topic.TopicArn, Owner: args.account_id, ConfirmationWasAuthenticated: false, protocol: unconfirmed.protocol, endpoint: unconfirmed.endpoint};
  subscriptions[unconfirmed.arn] = topic;
  delete topic.unconfirmed[req.query.Token];

  var response = builder.create('ConfirmSubscriptionResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('ConfirmSubscriptionResult');
  result.ele('SubscriptionArn', unconfirmed.arn);
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function create_topic(req, res) {
  function response(topic_arn) {
    var response = builder.create('CreateTopicResponse');
    response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
    var result = response.ele('CreateTopicResult');
    result.ele('TopicArn', topic_arn);
    var metadata = response.ele('ResponseMetadata');
    metadata.ele('RequestId', get_request_id());

    res.end(response.end({pretty: true, indent: '  '}));
  }

  if (!('Name' in req.query))
    return error(res, 'MissingParameter');

  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(req.query.Name))
    return error(res, 'InvalidParameter');

  var arn = 'arn:aws:sns:' + args.region + ':' + args.account_id + ':' + req.query.Name;

  if (arn in topics)
    return response(arn);

  if (Object.keys(topics).length >= args.topic_limit)
    return error(res, 'TopicLimitExceeded');

  topics[arn] = {TopicArn: arn, subscriptions: {}, unconfirmed: {}};
  response(topics[arn].TopicArn);
}

function delete_topic(req, res) {
  if (!('TopicArn' in req.query))
    return error(res, 'MissingParameter');

  delete topics[req.query.TopicArn];

  var response = builder.create('DeleteTopicResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function get_subscription_attributes(req, res) {
  if (!('SubscriptionArn' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.SubscriptionArn in subscriptions))
    return error(res, 'NotFound');

  var topic = subscriptions[req.query.SubscriptionArn];
  var subscription = topic[req.query.SubscriptionArn];

  var response = builder.create('GetSubscriptionAttributesResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('GetSubscriptionAttributesResult');
  var attributes = result.ele('Attributes');

  for (var key in subscription) {
    /* Public API attribute keys are CamelCase, others are internal */
    if (!/^[A-Z]/.test(key))
      continue;

    entry = attributes.ele('entry');
    entry.ele('key', key);
  
    if (key == 'DeliveryPolicy')
      entry.ele('value', JSON.stringify(topic[key]));
    else
      entry.ele('value', topic[key]);
  }

  entry = attributes.ele('entry');
  entry.ele('key', 'EffectiveDeliveryPolicy');
  entry.ele('value', JSON.stringify(merge_policies(topic, subscription)));

  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function get_topic_attributes(req, res) {
  if (!('TopicArn' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.TopicArn in topics))
    return error(res, 'NotFound');

  var topic = topics[req.query.TopicArn];

  var response = builder.create('GetTopicAttributesResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('GetTopicAttributesResult');
  var attributes = result.ele('Attributes');

  var entry = attributes.ele('entry');
  entry.ele('key', 'Owner');
  entry.ele('value', args.account_id.toString());

  for (var key in topic) {
    /* Public API attribute keys are CamelCase, others are internal */
    if (!/^[A-Z]/.test(key))
      continue;

    entry = attributes.ele('entry');
    entry.ele('key', key);

    if (key == 'DeliveryPolicy')
      entry.ele('value', JSON.stringify(topic[key]));
    else
      entry.ele('value', topic[key]);
  }

  entry = attributes.ele('entry');
  entry.ele('key', 'EffectiveDeliveryPolicy');
  var policy = _.clone(topic.DeliveryPolicy || {});
  _.defaults(policy, default_delivery_policy);
  entry.ele('value', JSON.stringify(policy));

  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function list_subscriptions(req, res) {
  var start = 0;
  if ('NextToken' in req.query) {
    start = parseInt(req.query.NextToken);
    if (start === NaN)
      return error(res, 'InvalidParameter');
  }

  var response = builder.create('ListSubscriptionsResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('ListSubscriptionsResult');
  var subscriptions_element = response.ele('Subscriptions');

  var arns = Object.keys(subscriptions);
  for (var i = 0; i < 100 && start + i < arns.length; i++) {
    var arn = arns[start + i];
    var topic = subscriptions[arn];
    var subscription = topic.subscriptions[arn];

    var member = subscriptions_element.ele('member');
    member.ele('TopicArn', subscription.TopicArn);
    member.ele('Protocol', subscription.protocol);
    member.ele('SubscriptionArn', arn);
    member.ele('Owner', subscription.Owner);
    member.ele('Endpoint', subscription.endpoint);
  }

  if (start + 100 < arns.length)
    result.ele('NextToken', (start + 100).toString());

  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function list_subscriptions_by_topic(req, res) {
  if (!('TopicArn' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.TopicArn in topics))
    return error(res, 'NotFound');

  var topic = topics[req.query.TopicArn];

  var start = 0;
  if ('NextToken' in req.query) {
    start = parseInt(req.query.NextToken);
    if (start === NaN)
      return error(res, 'InvalidParameter');
  }

  var response = builder.create('ListSubscriptionsByTopicResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('ListSubscriptionsByTopicResult');
  var subscriptions_element = response.ele('Subscriptions');

  var arns = Object.Keys(topic.subscriptions);
  for (var i = 0; i < 100 && start + i < arns.length; i++) {
    var arn = arns[start + i];
    var subscription = topic.subscriptions[arn];

    var member = subscriptions_element.ele('member');
    member.ele('TopicArn', subscription.TopicArn);
    member.ele('Protocol', subscription.protocol);
    member.ele('SubscriptionArn', arn);
    member.ele('Owner', subscription.Owner);
    member.ele('Endpoint', subscription.endpoint);
  }

  if (start + 100 < arns.length)
    result.ele('NextToken', (start + 100).toString());

  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function list_topics(req, res) {
  var start = 0;
  if ('NextToken' in req.query) {
    start = parseInt(req.query.NextToken);
    if (start === NaN)
      return error(res, 'InvalidParameter');
  }

  var response = builder.create('ListTopicsResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('ListTopicsResult');
  var topics_element = response.ele('Topics');

  var arns = Object.keys(topics);
  for (var i = 0; i < 100 && start + i < arns.length; i++) {
    var arn = arns[start + i];
    
    var member = topics_element.ele('member');
    member.ele('TopicArn', arn);
  }

  if (start + 100 < arns.length)
    result.ele('NextToken', (start + 100).toString());

  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function publish_http(opts, callback) {
  var policy = merge_policies(opts.topic, opts.subscription).healthyRetryPolicy;

  new Fiber(function() {
    var fiber = Fiber.current;

    var retries = policy.numNoDelayRetries + policy.numMinDelayRetries + policy.numRetries + policy.numMaxDelayRetries;
    for (var i = 0; i <= retries; i++) {
      send_message(opts, function(err, res) {
        if (err) {
          console.log('Failed to publish message for topic ' + opts.topic.TopicArn + ' to endpoint ' + opts.subscription.endpoint + ': ' + err);
          fiber.run(false);
        } else
          fiber.run(res.statusCode >= 200 && res.statusCode < 500);
      });
      var success = Fiber.yield();

      if (success)
        return callback();

      var delay;
      if (i < policy.numNoDelayRetries)
        delay = 0;
      else if (i < policy.numNoDelayRetries + policy.numMinDelayRetries)
        delay = policy.minDelayTarget;
      else if (i < policy.numNoDelayRetries + policy.numMinDelayRetries + policy.numRetries) {
        delay = policy.minDelayTarget;

        if (policy.numRetries > 1) {
          var d = policy.maxDelayTarget - policy.minDelayTarget;
          var step = i - policy.numNoDelayRetries + policy.numMinDelayRetries;

          switch (policy.backoffFunction) {
            case 'arithmetic':
              delay += d * step * (step + 1) / ((policy.numRetries - 1) * policy.numRetries);
              break;

            case 'geometric': /* FIXME: Not sure how to calculate this one off the top of my head, Exponential is good enough */
            case 'exponential':
              delay += d * (Math.pow(2, step) - 1) / (Math.pow(2, policy.numRetries - 1) - 1);
              break;

            /* We shouldn't have anything else other than 'linear', but best to be safe */
            default:
              delay += d * step / (policy.numRetries - 1);
              break;
          }
        }
      } else
        delay = policy.maxDelayTarget;

      setTimeout(function() {
        fiber.run();
      }, delay * 1000);
      Fiber.yield();
    }

    callback(new Error('Failed to send message for topic ' + opts.topics.TopicArn + ' to HTTP(s) endpoint ' + opts.subscription.endpoint));
  }).run();
}

function publish(req, res) {
  if (!('Message' in req.query && 'TopicArn' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.TopicArn in topics))
    return error(res, 'NotFound');

  var topic = topics[req.query.TopicArn];

  var message = req.query.Message;

  if ('MessageStructure' in req.query) {
    if (req.query.MessageStructure == 'json') {
      try {
        message = JSON.parse(message);
      } catch (e) {
        return error(res, 'InvalidParameter');
      }

      if (!('default' in message))
        return error(res, 'InvalidParameter');
    } else
      return error(res, 'InvalidParameter');
  }

  var subject;
  if ('Subject' in req.query) {
    subject = req.query.Subject;

    /* We should also check for only valid ASCII characters, but meh */
    if (subject.length > 100)
      return error(res, 'InvalidParameter');
  }

  var msg_id = get_request_id();

  var opts = {
    topic: topic,
    message_type: 'Notification',
    message_id: msg_id,
    subject: subject,
    message: message,
    timestamp: new Date().toISOString(),
  };

  for (var arn in topic.subscriptions) {
    opts.subscription = topic.subscriptions[arn];
    publish_http(opts);
  }

  var response = builder.create('PublishResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var result = response.ele('PublishResult');
  result.ele('MessageId', msg_id);
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function set_subscription_attributes(req, res) {
  if (!('SubscriptionArn' in req.query && 'AttributeName' in req.query && 'AttributeValue' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.SubscriptionArn in subscriptions))
    return error(res, 'NotFound');

  var topic = subscriptions[req.query.SubscriptionArn];
  var subscription = topic[req.query.SubscriptionArn];

  if (req.query.AttributeName != 'DeliveryPolicy')
    return error(res, 'InvalidParameter');

  try {
    subscription.DeliveryPolicy = JSON.parse(req.query.AttributeValue);
  } catch (e) {
    return error(res, 'InvalidParameter');
  }

  var response = builder.create('SetSubscriptionAttributesResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function set_topic_attributes(req, res) {
  if (!('TopicArn' in req.query && 'AttributeName' in req.query && 'AttributeValue' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.TopicArn in topics))
    return error(res, 'NotFound');

  var topic = topics[req.query.TopicArn];

  switch (req.query.AttributeName) {
    case 'Policy':
      /* We don't do access policies, so we just check that the value is valid JSON */
      try {
        JSON.parse(req.query.AttributeValue);
      } catch (e) {
        return error(res, 'InvalidParameter');
      }
      break;

    case 'DisplayName':
      if (req.query.AttributeValue.length > 100)
        return error(res, 'InvalidParameter');

      topic.DisplayName = req.query.AttributeValue;
      break;

    case 'DeliveryPolicy':
      try {
        topic.DeliveryPolicy = JSON.parse(req.query.AttributeValue);
      } catch (e) {
        return error(res, 'InvalidParameter');
      }
      break;

    default:
      return error(res, 'InvalidParameter');
  }

  var response = builder.create('SetTopicAttributesResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function subscribe(req, res) {
  if (!('TopicArn' in req.query && 'Protocol' in req.query && 'Endpoint' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.TopicArn in topics))
    return error(res, 'NotFound');

  var topic = topics[req.query.TopicArn];

  switch (req.query.Protocol) {
    case 'http':
    case 'https':
      var parsed = url.parse(req.query.Endpoint);
      if (parsed.protocol != req.query.Protocol + ':')
        return error(res, 'InvalidParameter');

      var subscription = {SubscriptionArn: topic.TopicArn + ':' + get_request_id(), endpoint: req.query.Endpoint};
      var token = crypto.randomBytes(128).toString('hex');

      var opts = {
        subscription: subscription,
        topic: topic,
        token: token,
        message_type: 'SubscriptionConfirmation',
        timestamp: new Date().toISOString(),
      };

      publish_http(opts, function(err) {
        if (err)
          console.log('Failed to send subscription confirmation for topic ' + topic.TopicArn + ' to endpoint ' + req.query.Endpoint + ': ' + err);
        else
          topic.unconfirmed[token] = {arn: subscription.SubscriptionArn, protocol: req.query.Protocol, endpoint: req.query.Endpoint};
      });
      break;

    case 'email':
    case 'email-json':
      /* Simple email regex from http://www.regular-expressions.info/email.html */
      if (!/[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/.test(req.query.Endpoint))
        return error(res, 'InvalidParameter');
      return error(res, 'Unimplemented');

    case 'sms':
    case 'sqs':
      return error(res, 'Unimplemented');
  }

  var response = builder.create('SubscribeResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

function unsubscribe(req, res) {
  if (!('SubscriptionArn' in req.query))
    return error(res, 'MissingParameter');

  if (!(req.query.SubscriptionArn in subscriptions))
    return err(res, 'NotFound');

  var topic = subscriptions[req.query.SubscriptionArn];
  delete subscriptions[req.query.SubscriptionArn];
  delete topic.subscriptions[req.query.SubscriptionArn];

  var response = builder.create('UnsubscribeResponse');
  response.att('xmlns', 'http://sns.amazonaws.com/doc/2010-03-31/');
  var metadata = response.ele('ResponseMetadata');
  metadata.ele('RequestId', get_request_id());

  res.end(response.end({pretty: true, indent: '  '}));
}

app.get('/', function(req, res) {
  if (!('Action' in req.query))
    return error(res, 'MissingAction');

  switch (req.query.Action) {
    case 'ConfirmSubscription':
      confirm_subscription(req, res);
      break;

    case 'CreateTopic':
      create_topic(req, res);
      break;

    case 'DeleteTopic':
      delete_topic(req, res);
      break;

    case 'GetSubscriptionAttributes':
      get_subscription_attributes(req, res);
      break;

    case 'GetTopicAttributes':
      get_topic_attributes(req, res);
      break;

    case 'ListSubscriptions':
      list_subscriptions(req, res);
      break;

    case 'ListSubscriptionsByTopic':
      list_subscriptions_by_topic(req, res);
      break;

    case 'ListTopics':
      list_topics(req, res);
      break;

    case 'Publish':
      publish(req, res);
      break;

    case 'SetSubscriptionAttributes':
      set_subscription_attributes(req, res);
      break;

    case 'SetTopicAttributes':
      set_topic_attributes(req, res);
      break;

    case 'Subscribe':
      subscribe(req, res);
      break;

    case 'Unsubscribe':
      unsubscribe(req, res);
      break;

    case 'AddPermission':
    case 'RemovePermission':
      error(res, 'Unimplemented');
      break;

    default:
      error(res, 'InvalidAction');
      break;
  }
});

var https_options = {};
https_options.cert = fs.readFileSync('ssl.crt');
https_options.key = fs.readFileSync('ssl.key');

var server = https.createServer(https_options, app);
server.listen(args.port, function() {
  console.log('Fake SNS listening on port ' + args.port);
});
