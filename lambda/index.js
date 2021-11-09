const AWS = require('aws-sdk');
const ddb = new AWS.DynamoDB();
const {
  CONNECTIONS_TABLE_NAME,
  MEETINGS_TABLE_NAME,
  ATTENDEES_TABLE_NAME,
  MESSAGES_TABLE_NAME
} = process.env;
const chime = new AWS.Chime({
  region: 'us-east-1'
}); // Must be in us-east-1
chime.endpoint = new AWS.Endpoint('https://service.chime.aws.amazon.com/console');

const oneDayFromNow = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
const strictVerify = true;

const response = {
  "statusCode": 200,
  "headers": {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,GET,PUT,POST",
    "Content-Type": "application/json"
  },
  "body": '',
  "isBase64Encoded": false
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0,
      v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const getMeeting = async (meetingTitle) => {
  const filter = {
    TableName: MEETINGS_TABLE_NAME,
    Key: {
      'Title': {
        S: meetingTitle
      },
    },
  };

  console.info("getMeeting > filter:", JSON.stringify(filter, null, 2));

  const result = await ddb.getItem(filter).promise();

  console.info("getMeeting > result:", JSON.stringify(result, null, 2));

  if (!result.Item) {
    return null;
  }
  const meetingData = JSON.parse(result.Item.Data.S);
  meetingData.PlaybackURL = result.Item.PlaybackURL.S;
  try {
    await chime.getMeeting({
      MeetingId: meetingData.Meeting.MeetingId
    }).promise();
  } catch (err) {
    console.info("getMeeting > try/catch:", JSON.stringify(err, null, 2));
    return null;
  }
  return meetingData;
};

const putMeeting = async (title, playbackURL, meetingInfo) => {
  await ddb.putItem({
    TableName: MEETINGS_TABLE_NAME,
    Item: {
      'Title': {
        S: title
      },
      'PlaybackURL': {
        S: playbackURL
      },
      'Data': {
        S: JSON.stringify(meetingInfo)
      },
      'TTL': {
        N: '' + oneDayFromNow
      }
    }
  }).promise();
};

const endMeeting = async (title) => {
  const meetingInfo = await getMeeting(title);

  try {
    await chime.deleteMeeting({
      MeetingId: meetingInfo.Meeting.MeetingId,
    }).promise();
  } catch (err) {
    console.info("endMeeting > try/catch:", JSON.stringify(err, null, 2));
    // return null;
  }

  const params = {
    TableName: MEETINGS_TABLE_NAME,
    Key: {
      'Title': {
        S: title
      },
    },
  };

  console.info("deleteMeeting > params:", JSON.stringify(params, null, 2));

  const result = await ddb.delete(params).promise();

  console.info("deleteMeeting > result:", JSON.stringify(result, null, 2));

  return result;
};

const getAttendee = async (title, attendeeId) => {
  const result = await ddb.getItem({
    TableName: ATTENDEES_TABLE_NAME,
    Key: {
      'AttendeeId': {
        S: `${title}/${attendeeId}`
      }
    }
  }).promise();
  if (!result.Item) {
    return 'Unknown';
  }
  return result.Item.Name.S;
};

const getAttendees = async (title) => {
  const filter = {
    TableName: ATTENDEES_TABLE_NAME,
    FilterExpression: "begins_with(AttendeeId, :title)",
    ExpressionAttributeValues: {
      ":title": {
        "S": `${title}`
      }
    }
  };

  console.info("getAttendees > filter:", JSON.stringify(filter, null, 2));

  const result = await ddb.scan(filter).promise();

  console.info("getAttendees > result:", JSON.stringify(result, null, 2));

  if (!result.Items) {
    return 'Unknown';
  }

  let filteredItems = [];
  let prop
  for (prop in result.Items) {
    filteredItems.push({
      AttendeeId: result.Items[prop].AttendeeId.S,
      Name: result.Items[prop].Name.S
    });
  }

  console.info("getAttendees > filteredItems:", JSON.stringify(filteredItems, null, 2));

  return filteredItems;
};

const putAttendee = async (title, attendeeId, name) => {
  await ddb.putItem({
    TableName: ATTENDEES_TABLE_NAME,
    Item: {
      'AttendeeId': {
        S: `${title}/${attendeeId}`
      },
      'Name': {
        S: name
      },
      'TTL': {
        N: '' + oneDayFromNow
      }
    }
  }).promise();
};

function simplifyTitle(title) {
  // Strip out most symbolic characters and whitespace and make case insensitive,
  // but preserve any Unicode characters outside of the ASCII range.
  return (title || '').replace(/[\s()!@#$%^&*`~_=+{}|\\;:'",.<>/?\[\]-]+/gu, '').toLowerCase() || null;
};

// Websocket

exports.authorize = async (event, context, callback) => {
  console.log('authorize event:', JSON.stringify(event, null, 2));

  const generatePolicy = (principalId, effect, resource, context) => {
    const authResponse = {};
    authResponse.principalId = principalId;
    if (effect && resource) {
      const policyDocument = {};
      policyDocument.Version = '2012-10-17';
      policyDocument.Statement = [];
      const statementOne = {};
      statementOne.Action = 'execute-api:Invoke';
      statementOne.Effect = effect;
      statementOne.Resource = resource;
      policyDocument.Statement[0] = statementOne;
      authResponse.policyDocument = policyDocument;
    }
    authResponse.context = context;
    return authResponse;
  };
  let passedAuthCheck = false;
  if (
    !!event.queryStringParameters.MeetingId &&
    !!event.queryStringParameters.AttendeeId &&
    !!event.queryStringParameters.JoinToken
  ) {
    try {
      let attendeeInfo = await chime
        .getAttendee({
          MeetingId: event.queryStringParameters.MeetingId,
          AttendeeId: event.queryStringParameters.AttendeeId
        })
        .promise();
      if (
        attendeeInfo.Attendee.JoinToken ===
        event.queryStringParameters.JoinToken
      ) {
        passedAuthCheck = true;
      } else if (strictVerify) {
        console.error('failed to authenticate with join token');
      } else {
        passedAuthCheck = true;
        console.warn(
          'failed to authenticate with join token (skipping due to strictVerify=false)'
        );
      }
    } catch (e) {
      if (strictVerify) {
        console.error(`failed to authenticate with join token: ${e.message}`);
      } else {
        passedAuthCheck = true;
        console.warn(
          `failed to authenticate with join token (skipping due to strictVerify=false): ${e.message}`
        );
      }
    }
  } else {
    console.error('missing MeetingId, AttendeeId, JoinToken parameters');
  }
  return generatePolicy(
    'me',
    passedAuthCheck ? 'Allow' : 'Deny',
    event.methodArn, {
      MeetingId: event.queryStringParameters.MeetingId,
      AttendeeId: event.queryStringParameters.AttendeeId
    }
  );
};

exports.onconnect = async event => {
  console.log('onconnect event:', JSON.stringify(event, null, 2));

  try {
    await ddb
      .putItem({
        TableName: process.env.CONNECTIONS_TABLE_NAME,
        Item: {
          MeetingId: {
            S: event.requestContext.authorizer.MeetingId
          },
          AttendeeId: {
            S: event.requestContext.authorizer.AttendeeId
          },
          ConnectionId: {
            S: event.requestContext.connectionId
          },
          TTL: {
            N: `${oneDayFromNow}`
          }
        }
      })
      .promise();
  } catch (err) {
    console.error(`error connecting: ${err.message}`);
    return {
      statusCode: 500,
      body: `Failed to connect: ${JSON.stringify(err)}`
    };
  }
  return {
    statusCode: 200,
    body: 'Connected.'
  };
};

exports.ondisconnect = async event => {
  console.log('ondisconnect event:', JSON.stringify(event, null, 2));
  let attendees = {};
  try {
    attendees = await ddb
      .query({
        ExpressionAttributeValues: {
          ':meetingId': {
            S: event.requestContext.authorizer.MeetingId
          }
        },
        KeyConditionExpression: 'MeetingId = :meetingId',
        ProjectionExpression: 'ConnectionId',
        TableName: CONNECTIONS_TABLE_NAME
      })
      .promise();
  } catch (e) {
    return {
      statusCode: 500,
      body: e.stack
    };
  }

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: `${event.requestContext.domainName}/${event.requestContext.stage}`
  });

  let postData = {};

  postData = {
    Type: 'disconnected',
    Sender: event.requestContext.authorizer.AttendeeId
  }

  const postCalls = attendees.Items.map(async connection => {
    const connectionId = connection.ConnectionId.S;
    try {
      await apigwManagementApi
        .postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify(postData)
        })
        .promise();
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`found stale connection, skipping ${connectionId}`);
      } else {
        console.error(
          `error posting to connection ${connectionId}: ${e.message}`
        );
      }
    }
  });

  try {
    await Promise.all(postCalls);
  } catch (e) {
    console.error(`failed to post: ${e.message}`);
    return {
      statusCode: 500,
      body: e.stack
    };
  }

  try {
    await ddb
      .deleteItem({
        TableName: process.env.CONNECTIONS_TABLE_NAME,
        Key: {
          MeetingId: {
            S: event.requestContext.authorizer.MeetingId
          },
          AttendeeId: {
            S: event.requestContext.authorizer.AttendeeId
          },
        },
      })
      .promise();
  } catch (err) {
    return {
      statusCode: 500,
      body: `Failed to disconnect: ${JSON.stringify(err)}`
    };
  }
  return {
    statusCode: 200,
    body: 'Disconnected.'
  };
};

exports.sendmessage = async event => {
  // console.log('sendmessage event:', JSON.stringify(event, null, 2));

  let attendees = {};
  try {
    attendees = await ddb
      .query({
        ExpressionAttributeValues: {
          ':meetingId': {
            S: event.requestContext.authorizer.MeetingId
          }
        },
        KeyConditionExpression: 'MeetingId = :meetingId',
        ProjectionExpression: 'ConnectionId',
        TableName: CONNECTIONS_TABLE_NAME
      })
      .promise();
  } catch (e) {
    return {
      statusCode: 500,
      body: e.stack
    };
  }
  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: `${event.requestContext.domainName}/${event.requestContext.stage}`
  });

  let messageType = JSON.parse(event.body).type;

  // const postData = JSON.parse(event.body).data;
  let postData = {};
  if (messageType === 'sendmessage') {
    const messageId = uuid();
    const currentTime = Date.now();

    postData = {
      'MessageId': messageId,
      'Data': JSON.parse(event.body).data,
      'Sender': JSON.parse(event.body).sender,
      'Content': JSON.parse(event.body).content,
      'Time': currentTime.toString(),
      'Vote': [],
      'Type': 'sendmessage'
    };

    await ddb.putItem({
      TableName: MESSAGES_TABLE_NAME,
      Item: {
        'MessageId': {
          S: messageId
        },
        'MeetingId': {
          S: event.requestContext.authorizer.MeetingId
        },
        'Data': {
          S: JSON.parse(event.body).data
        },
        'Sender': {
          S: JSON.parse(event.body).sender
        },
        'Content': {
          S: JSON.parse(event.body).content
        },
        'Time': {
          N: currentTime.toString()
        },
        'Vote': {
          S: '[]'
        }
      }
    }).promise();

  } else if (messageType === 'upvote') {
    try {
      const result = await ddb.getItem({
        TableName: MESSAGES_TABLE_NAME,
        Key: {
          'MessageId': {
            S: `${JSON.parse(event.body).id}`
          }
        }
      }).promise();

      if (result) {
        let voteObject = JSON.parse(result.Item.Vote.S);
        let existing = false;
        if (voteObject.length == 0) {
          voteObject = [{
            sender: JSON.parse(event.body).sender
          }];
        } else {
          voteObject.map(vote => {
            if (vote.sender === JSON.parse(event.body).sender) existing = true;
          });

          if (!existing) {
            voteObject.push({
              sender: JSON.parse(event.body).sender
            });
          }
        }

        if (!existing) {
          const result = await ddb.updateItem({
            TableName: MESSAGES_TABLE_NAME,
            Key: {
              'MessageId': {
                S: `${JSON.parse(event.body).id}`
              }
            },
            UpdateExpression: "set Vote = :r",
            ExpressionAttributeValues: {
              ":r": {
                S: JSON.stringify(voteObject)
              }
            }
          }).promise();

          postData = {
            'MessageId': JSON.parse(event.body).id,
            'Vote': voteObject,
            'Type': 'upvote'
          };
        }
      }

    } catch (e) {
      console.error(e);
      return {
        statusCode: 500,
        body: e.stack
      };
    }

  } else if (messageType === 'deletemessage') {
    await ddb
      .deleteItem({
        TableName: MESSAGES_TABLE_NAME,
        Key: {
          'MessageId': {
            S: `${JSON.parse(event.body).id}`
          }
        },
      })
      .promise();

    postData = {
      'MessageId': JSON.parse(event.body).id,
      'Type': 'deletemessage'
    };
  } else if (messageType === 'getall') {
    try {
      const filter = {
        TableName: MESSAGES_TABLE_NAME,
        FilterExpression: "MeetingId = :meetingId",
        ExpressionAttributeValues: {
          ":meetingId": {
            S: event.requestContext.authorizer.MeetingId
          }
        }
      };

      const messages = await ddb.scan(filter).promise();
      postDataMessages = [];
      messages.Items.map(message => {
        postDataMessages.push({
          MessageId: message.MessageId.S,
          Content: message.Content.S,
          Time: message.Time.S,
          Sender: message.Sender.S,
          Vote: JSON.parse(message.Vote.S)
        })
      })

      postData = {
        Type: 'getall',
        messages: postDataMessages
      }
    } catch (e) {
      console.error(e);
      return {
        statusCode: 500,
        body: e.stack
      };
    }

  } else if (messageType === 'raisehand') {
    postData = {
      Type: 'raisehand',
      Data: JSON.parse(event.body).data,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'downhand') {
    postData = {
      Type: 'downhand',
      Data: JSON.parse(event.body).attendeeId,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'muteremote') {
    postData = {
      Type: 'muteremote',
      Data: JSON.parse(event.body).attendeeId,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'removeremote') {
    postData = {
      Type: 'removeremote',
      Data: JSON.parse(event.body).attendeeId,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'makehost') {
    postData = {
      Type: 'makehost',
      Data: JSON.parse(event.body).attendeeId,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'gotolive') {
    const result = await ddb.getItem({
      TableName: MEETINGS_TABLE_NAME,
      Key: {
        'Title': {
          S: `${JSON.parse(event.body).title}`
        }
      }
    }).promise();

    if (result) {
      // if(result.Item.Live) {
      await ddb.updateItem({
        TableName: MEETINGS_TABLE_NAME,
        Key: {
          'Title': {
            S: `${JSON.parse(event.body).title}`
          }
        },
        UpdateExpression: "set Live = :r",
        ExpressionAttributeValues: {
          ":r": {
            S: "True"
          }
        }
      }).promise();

      postData = {
        'Title': JSON.parse(event.body).title,
        'Host': event.requestContext.authorizer.AttendeeId,
        'Type': 'gotolive'
      };
      // }

    }
  } else if (messageType === 'getlivestatus') {
    const result = await ddb.getItem({
      TableName: MEETINGS_TABLE_NAME,
      Key: {
        'Title': {
          S: `${JSON.parse(event.body).title}`
        }
      }
    }).promise();

    if (result) {
      try {
        if (result.Item.Live.S === 'True') {
          postData = {
            'status': true,
            'Type': 'getlivestatus'
          };
        } else {
          postData = {
            'status': false,
            'Type': 'getlivestatus'
          };
        }
      } catch (e) {
        postData = {
          'status': false,
          'Type': 'getlivestatus'
        };
      }

    } else {
      postData = {
        'status': false,
        'Type': 'getlivestatus'
      };
    }
  } else if (messageType === 'beforepart') {
    postData = {
      Type: 'beforepart',
      Name: JSON.parse(event.body).name,
      isVideoChat: JSON.parse(event.body).isVideoChat,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'showableparts') {
    postData = {
      Type: 'showableparts',
      showableparts: JSON.parse(event.body).showableparts,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'overflow') {
    postData = {
      Type: 'overflow',
      overflowId: JSON.parse(event.body).overflowId,
      status: JSON.parse(event.body).status,
      Sender: event.requestContext.authorizer.AttendeeId
    }
  } else if (messageType === 'updateroominfo') {
    const result = await ddb.getItem({
      TableName: MEETINGS_TABLE_NAME,
      Key: {
        'Title': {
          S: `${JSON.parse(event.body).title}`
        }
      }
    }).promise();

    if (result) {
      if (result.Item.Live) {
        await ddb.updateItem({
          TableName: MEETINGS_TABLE_NAME,
          Key: {
            'Title': {
              S: `${JSON.parse(event.body).title}`
            }
          },
          UpdateExpression: "set TotalUsers = :t, HostUsers = :h, VideoUsers = :v, ObsUsers = :o",
          ExpressionAttributeValues: {
            ":t": {
              S: `${JSON.parse(event.body).all}`
            },
            ":h": {
              S: `${JSON.parse(event.body).hosts}`
            },
            ":v": {
              S: `${JSON.parse(event.body).videos}`
            },
            ":o": {
              S: `${JSON.parse(event.body).parts}`
            }
          }
        }).promise();

      }

    }

    return;
  }

  const postCalls = attendees.Items.map(async connection => {
    const connectionId = connection.ConnectionId.S;
    try {
      await apigwManagementApi
        .postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify(postData)
        })
        .promise();
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`found stale connection, skipping ${connectionId}`);
      } else {
        console.error(
          `error posting to connection ${connectionId}: ${e.message}`
        );
      }
    }
  });
  try {
    await Promise.all(postCalls);
  } catch (e) {
    console.error(`failed to post: ${e.message}`);
    return {
      statusCode: 500,
      body: e.stack
    };
  }
  return {
    statusCode: 200,
    body: 'Data sent.'
  };



};

// API

exports.createMeeting = async (event, context, callback) => {
  console.log("createMeeting event:", JSON.stringify(event, null, 2));

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    console.log("createMeeting event > parse payload:", JSON.stringify(err, null, 2));
    response.statusCode = 500;
    response.body = JSON.stringify(err);
    callback(null, response);
    return;
  }


  if (!payload || !payload.title) {
    console.log("createMeeting event > missing required field: Must provide title");
    response.statusCode = 400;
    response.body = "Must provide title";
    callback(null, response);
    return;
  }
  const title = simplifyTitle(payload.title);
  const region = payload.region || 'us-east-1';
  let meetingInfo = await getMeeting(title);
  if (!meetingInfo) {
    const request = {
      ClientRequestToken: uuid(),
      MediaRegion: region
    };
    console.info('createMeeting event > Creating new meeting: ' + JSON.stringify(request, null, 2));
    meetingInfo = await chime.createMeeting(request).promise();
    await putMeeting(title, meetingInfo);
  }

  const joinInfo = {
    JoinInfo: {
      Title: title,
      Meeting: meetingInfo.Meeting,
    },
  };

  response.statusCode = 201;
  response.body = JSON.stringify(joinInfo, '', 2);

  console.info("createMeeting event > response:", JSON.stringify(response, null, 2));

  callback(null, response);
};

exports.join = async (event, context, callback) => {
  console.log("join event:", JSON.stringify(event, null, 2));

  let payload;

  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    console.log("join event > parse payload:", JSON.stringify(err, null, 2));
    response.statusCode = 500;
    response.body = JSON.stringify(err);
    callback(null, response);
    return;
  }

  if (!payload || !payload.title || !payload.name) {
    console.log("join > missing required fields: Must provide title and name");
    response.statusCode = 400;
    response.body = "Must provide title and name";
    callback(null, response);
    return;
  }

  if (payload.role === 'host' && !payload.playbackURL) {
    console.log("join > missing required field: Must provide playbackURL");
    response.statusCode = 400;
    response.body = "Must provide playbackURL";
    callback(null, response);
    return;
  }

  const title = simplifyTitle(payload.title);
  const name = payload.name;
  const region = payload.region || 'us-east-1';
  let meetingInfo = await getMeeting(title);

  // If meeting does not exist and role equal to "host" then create meeting room
  if (!meetingInfo && payload.role === 'host') {
    const request = {
      ClientRequestToken: uuid(),
      MediaRegion: region
    };
    console.info('join event > Creating new meeting: ' + JSON.stringify(request, null, 2));
    meetingInfo = await chime.createMeeting(request).promise();
    meetingInfo.PlaybackURL = payload.playbackURL;
    await putMeeting(title, payload.playbackURL, meetingInfo);
  }

  console.info("join event > meetingInfo:", JSON.stringify(meetingInfo, null, 2));

  console.info('join event > Adding new attendee');
  const attendeeInfo = (await chime.createAttendee({
    MeetingId: meetingInfo.Meeting.MeetingId,
    ExternalUserId: uuid(),
  }).promise());

  console.info("join event > attendeeInfo:", JSON.stringify(attendeeInfo, null, 2));

  putAttendee(title, attendeeInfo.Attendee.AttendeeId, name);

  const joinInfo = {
    JoinInfo: {
      Title: title,
      PlaybackURL: meetingInfo.PlaybackURL,
      Meeting: meetingInfo.Meeting,
      Attendee: attendeeInfo.Attendee
    },
  };

  console.info("join event > joinInfo:", JSON.stringify(joinInfo, null, 2));

  response.statusCode = 200;
  response.body = JSON.stringify(joinInfo, '', 2);

  console.info("join event > response:", JSON.stringify(response, null, 2));

  callback(null, response);
};

exports.attendee = async (event, context, callback) => {
  console.log("attendee event:", JSON.stringify(event, null, 2));

  if (!event.queryStringParameters.title || !event.queryStringParameters.attendeeId) {
    console.log("attendee event > missing required fields: Must provide title and attendeeId");
    response.statusCode = 400;
    response.body = "Must provide title and attendeeId";
    callback(null, response);
    return;
  }

  const title = simplifyTitle(event.queryStringParameters.title);
  const attendeeId = event.queryStringParameters.attendeeId;
  const attendeeInfo = {
    AttendeeInfo: {
      AttendeeId: attendeeId,
      Name: await getAttendee(title, attendeeId)
    }
  };

  response.statusCode = 200;
  response.body = JSON.stringify(attendeeInfo, '', 2);

  console.info("attendee event > response:", JSON.stringify(response, null, 2));

  callback(null, response);
};

exports.attendees = async (event, context, callback) => {
  console.log("attendees event:", JSON.stringify(event, null, 2));

  if (!event.queryStringParameters.title) {
    console.log("attendees event > missing required fields: Must provide title");
    response.statusCode = 400;
    response.body = "Must provide title";
    callback(null, response);
    return;
  }

  const title = simplifyTitle(event.queryStringParameters.title);
  const attendeeInfo = await getAttendees(title);

  response.statusCode = 200;
  response.body = JSON.stringify(attendeeInfo, '', 2);

  console.info("attendees event > response:", JSON.stringify(response, null, 2));

  callback(null, response);
};

exports.roomusers = async (event, context, callback) => {
  if (!event.queryStringParameters.title) {
    console.log("attendees event > missing required fields: Must provide title");
    response.statusCode = 400;
    response.body = "Must provide title";
    callback(null, response);
    return;
  }

  const title = simplifyTitle(event.queryStringParameters.title);
  const result = await ddb.getItem({
    TableName: MEETINGS_TABLE_NAME,
    Key: {
      'Title': {
        S: `${title}`
      }
    }
  }).promise();

  console.log(JSON.stringify(result));


  response.statusCode = 200;
  if (result.Item) {
    if (result.Item.Live.S === 'True') {
      const roomuserinfo = {
        total: result.Item.TotalUsers.S,
        hosts: result.Item.HostUsers.S,
        videos: result.Item.VideoUsers.S,
        parts: result.Item.ObsUsers.S,
      }
      response.body = JSON.stringify(roomuserinfo);
    } else {
      const errordata = {
        error: 'This session is ended!'
      }
      response.body = JSON.stringify(errordata);
    }
  } else {
    const errordata = {
      error: 'This session is not created!'
    }
    response.body = JSON.stringify(errordata);
  }


  callback(null, response);
}

exports.end = async (event, context, callback) => {
  console.log("end event:", JSON.stringify(event, null, 2));

  if (!event.queryStringParameters.title) {
    console.log("end event > missing required fields: Must provide title");
    response.statusCode = 400;
    response.body = "Must provide title";
    callback(null, response);
    return;
  }

  const title = simplifyTitle(event.queryStringParameters.title);

  response.statusCode = 200;
  response.body = JSON.stringify(endMeeting(title));

  console.info("end event > response:", JSON.stringify(response, null, 2));

  callback(null, response);
};