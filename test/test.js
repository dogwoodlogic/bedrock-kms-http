/*
 * Copyright (c) 2019-2021 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
require('bedrock-https-agent');
require('bedrock-kms-http');
require('bedrock-meter');
require('bedrock-security-context');
require('bedrock-meter');
const {handlers} = require('bedrock-meter-http');
// this is responsible for providing the `ssm-v1` key store
require('bedrock-ssm-mongodb');

require('bedrock-test');
require('bedrock-karma');

bedrock.events.on('bedrock.init', async () => {
  /* Handlers need to be added before `bedrock.start` is called. These are
  no-op handlers to enable meter usage without restriction */
  handlers.setCreateHandler({handler: ({}) => {}});
  handlers.setUpdateHandler({handler: ({}) => {}});
  handlers.setRemoveHandler({handler: () => {}});
  handlers.setUseHandler({handler: () => {}});
});

bedrock.start();
