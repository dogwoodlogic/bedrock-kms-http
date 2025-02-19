/*!
 * Copyright (c) 2019-2021 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const {asyncHandler} = require('bedrock-express');
const {authorizeZcapInvocation} = require('@digitalbazaar/ezcap-express');
const bedrock = require('bedrock');
const BedrockKeystoreConfigStorage = require('./BedrockKeystoreConfigStorage');
const {
  defaultDocumentLoader: documentLoader,
  defaultModuleManager: moduleManager,
  keystores
} = require('bedrock-kms');
const {config, util: {BedrockError}} = bedrock;
const brZCapStorage = require('bedrock-zcap-storage');
const cors = require('cors');
const {
  createMiddleware: createOperationMiddleware,
  generateRandom
} = require('webkms-switch');
const helpers = require('./helpers');
const {meters} = require('bedrock-meter-usage-reporter');
const {validator: validate} = require('./validator');
const {
  postKeystoreBody,
  updateKeystoreConfigBody,
  postRevocationBody
} = require('../schemas/bedrock-kms-http');
const storage = new BedrockKeystoreConfigStorage();
const logger = require('./logger');

// configure usage aggregator for webkms meters
const SERVICE_TYPE = 'webkms';
meters.setAggregator({serviceType: SERVICE_TYPE, handler: _aggregateUsage});

bedrock.events.on('bedrock-express.configure.routes', app => {
  const cfg = config['kms-http'];

  // get storage cost for low-level primitives of keystores and keys as well
  // as higher-level revoked zcaps
  const storageCost = {
    ...config.kms.storageCost,
    ...cfg.storageCost
  };

  // WebKMS paths are fixed off of the base path per the spec
  const routes = {...cfg.routes};
  routes.keystores = `${routes.basePath}/keystores`;
  routes.keystore = `${routes.keystores}/:keystoreId`;
  routes.keys = `${routes.keystore}/keys`;
  routes.key = `${routes.keys}/:keyId`;
  routes.revocations = `${routes.keystore}/revocations/:zcapId`;

  // create handler for reporting successful operations
  async function reportOperationUsage({req}) {
    // do not wait for usage to be reported
    const {meterId: id} = req.webkms.keystore;
    meters.use({id, operations: 1}).catch(
      error => logger.error(`Meter (${id}) usage error.`, {error}));
  }

  // create middleware for handling KMS operations
  const handleOperation = createOperationMiddleware({
    storage, moduleManager, documentLoader,
    expectedHost: config.server.host,
    inspectCapabilityChain: helpers.inspectCapabilityChain,
    onSuccess: reportOperationUsage,
    onError
  });

  /* Note: CORS is used on all endpoints. This is safe because authorization
  uses HTTP signatures + capabilities, not cookies; CSRF is not possible. */

  // create a new keystore
  app.options(routes.keystores, cors());
  app.post(
    routes.keystores,
    cors(),
    validate({bodySchema: postKeystoreBody}),
    // meter must be checked for available usage and to obtain the meter's
    // controller prior to checking the zcap invocation (as the invocation
    // will use the meter's controller as the root controller for keystore
    // creation)
    asyncHandler(async (req, res, next) => {
      const {body: {meterCapability}} = req;
      const {meter, hasAvailable} = await meters.hasAvailable({
        meterCapability, resources: {storage: storageCost.keystore}
      });
      // store meter information on `req` and call next middleware
      req.meterCheck = {meter, hasAvailable};
      process.nextTick(next);
    }),
    // now that the meter information has been obtained, check zcap invocation
    _authorizeZcapInvocation({
      async getExpectedTarget({req}) {
        // use root keystore endpoint as expected target; controller will
        // be dynamically set according to the meter referenced by the meter
        // capability
        const expectedTarget = `https://${req.get('host')}${routes.keystores}`;
        return {expectedTarget};
      },
      async getRootController({req, rootInvocationTarget}) {
        const keystoreRoot = `https://${req.get('host')}${routes.keystores}`;
        if(rootInvocationTarget !== keystoreRoot) {
          throw new BedrockError(
            'The request URL does not match the root invocation target. ' +
            'Ensure that the capability is for the root keystores endpoint. ',
            'URLMismatchError', {
              // this error will be a `cause` in the onError handler below
              // this httpStatusCode is not operative
              httpStatusCode: 400,
              public: true,
              rootInvocationTarget,
              keystoreRoot
            });
        }
        // use meter's controller as the root controller for the keystore
        // creation endpoint
        return req.meterCheck.meter.controller;
      },
      onError
    }),
    asyncHandler(async (req, res) => {
      const {body: {meterCapability}, meterCheck: {hasAvailable}} = req;
      if(!hasAvailable) {
        // insufficient remaining storage
        throw new BedrockError('Permission denied.', 'NotAllowedError', {
          httpStatusCode: 403,
          public: true,
        });
      }

      // FIXME: this is a high-latency call -- consider adding the meter
      // in parallel with inserting the keystore, optimistically presuming it
      // will be added; we could decide that the case of a missing/invalid
      // meter is a possible state we have to deal in other cases anyway
      // https://github.com/digitalbazaar/bedrock-kms-http/issues/57

      // add meter
      const serviceType = SERVICE_TYPE;
      const {meter: {id: meterId}} = await meters.upsert(
        {meterCapability, serviceType});

      // create a keystore for the controller
      const random = await generateRandom();
      const id = helpers.getKeystoreId({req, localId: random, routes});
      const config = {id, meterId, ...req.body};
      delete config.meterCapability;
      const record = await keystores.insert({config});
      res.status(201).location(id).json(record.config);
    }));

  // update keystore config
  app.options(routes.keystore, cors());
  app.post(
    routes.keystore,
    cors(),
    validate({bodySchema: updateKeystoreConfigBody}),
    _authorizeZcapInvocation({
      getExpectedTarget: _getExpectedKeystoreTarget,
      onError
    }),
    asyncHandler(async (req, res) => {
      const {body: config} = req;
      const keystoreId = helpers.getKeystoreId(
        {req, localId: req.params.keystoreId, routes});
      if(keystoreId !== req.body.id) {
        throw new BedrockError(
          'Configuration "id" does not match.',
          'DataError', {
            httpStatusCode: 400,
            public: true,
            expected: keystoreId,
            actual: config.id
          });
      }

      /* Calls to update a keystore config are expected to be infrequent, so
      calling these async functions in serial acceptable as it is the cleanest
      implementation as it prevents unnecessary meter storage / fixing that
      would have to be dealt with later if the calls were optimistically
      performed in parallel instead. */

      // ensure keystore can be retrieved (IP check, etc.)
      const existingConfig = await storage.get({id: keystoreId, req});

      // add meter if a new capability was given
      let meterId;
      const {meterCapability} = config;
      if(meterCapability) {
        ({meter: {id: meterId}} = await meters.upsert(
          {meterCapability, serviceType: SERVICE_TYPE}));
      } else {
        ({meterId} = existingConfig);
      }

      // ensure `meterId` is set on config (using either existing one or new
      // one) -- use meter ID only not `meterCapability`
      config.meterId = meterId;
      delete config.meterCapability;

      // ensure `kmsModule` is set; if already set, allow `update` to proceed
      // as it will throw an error if it does not match the existing config
      if(!config.kmsModule) {
        config.kmsModule = existingConfig.kmsModule;
      }

      // the `update` API will not apply the change and will throw if
      // `config.sequence` is not valid, no need to check it here
      await keystores.update({config});

      res.json({success: true, config});
    }));

  // get a keystore config
  app.get(
    routes.keystore,
    cors(),
    _authorizeZcapInvocation({
      async getExpectedTarget({req}) {
        // expected target is the keystore itself
        const keystoreId = helpers.getKeystoreId(
          {req, localId: req.params.keystoreId, routes});
        // ensure keystore can be retrieved (do IP allow list checks, etc.)
        await storage.get({id: keystoreId, req});
        return {expectedTarget: keystoreId};
      },
      onError
    }),
    asyncHandler(async (req, res) => {
      const id = helpers.getKeystoreId(
        {req, localId: req.params.keystoreId, routes});
      const keystore = await storage.get({id, req});
      res.json(keystore);
    }));

  // invoke a generate key KMS operation to generate a new key
  app.options(routes.keys, cors());
  app.post(
    routes.keys,
    cors(),
    handleOperation);

  // invoke KMS operation on an existing key
  app.options(routes.key, cors());
  app.post(
    routes.key,
    cors(),
    handleOperation);

  // TODO: consider whether this should be exposed w/o authorization
  // https://github.com/digitalbazaar/bedrock-kms-http/issues/56

  // return a (public) key description
  app.get(
    routes.key,
    cors(),
    asyncHandler(async (req, res) => {
      const keystoreId = helpers.getKeystoreId(
        {req, localId: req.params.keystoreId, routes});
      const keyId = `${keystoreId}/keys/${req.params.keyId}`;
      const keystore = await storage.get({id: keystoreId, req});
      const moduleApi = await moduleManager.get({id: keystore.kmsModule});
      const keyDescription = moduleApi.getKeyDescription({keyId});
      res.json(keyDescription);
    }));

  // insert a revocation
  app.options(routes.revocations, cors());
  app.post(
    routes.revocations,
    cors(),
    validate({bodySchema: postRevocationBody}),
    _createGetDelegatorMiddleware({routes}),
    _authorizeZcapInvocation({
      async getExpectedTarget({req}) {
        const keystoreId = helpers.getKeystoreId(
          {req, localId: req.params.keystoreId, routes});
        // ensure keystore can be retrieved (do IP allow list checks, etc.)
        await storage.get({id: keystoreId, req});
        // allow target to be root keystore, main revocations endpoint, *or*
        // zcap-specific revocation endpoint; see
        // `_getRevocationRootController` for more details
        const revocations = `${keystoreId}/revocations`;
        const revokeZcap = `${revocations}/` +
          encodeURIComponent(req.params.zcapId);
        return {expectedTarget: [keystoreId, revocations, revokeZcap]};
      },
      getRootController: _getRevocationRootController,
      onError
    }),
    asyncHandler(async (req, res) => {
      const {body: capability, zcapRevocation: {delegator}} = req;

      // ensure that the invoker of the write capability is the delegator
      // of the capability to be revoked
      const invoker = req.zcap.controller || req.zcap.invoker;
      if(delegator !== invoker) {
        throw new BedrockError('Permission denied.', 'NotAllowedError');
      }

      // FIXME: brZCapStorage needs to support getting a count on stored
      // revocations -- and that count needs to be filtered based on a
      // particular meter
      // https://github.com/digitalbazaar/bedrock-kms-http/issues/55

      // record revocation
      await brZCapStorage.revocations.insert({delegator, capability});

      // meter revocation usage
      const keystoreId = helpers.getKeystoreId(
        {req, localId: req.params.keystoreId, routes});

      _reportRevocationUsage({keystoreId}).catch(
        error => logger.error(
          `Keystore (${keystoreId}) capability revocation meter ` +
          'usage error.', {error}));

      res.status(204).end();
    }));
});

async function _getRootController({
  req, rootCapabilityId, rootInvocationTarget
}) {
  const kmsBaseUrl = req.protocol + '://' + req.get('host') +
    config['kms-http'].routes.basePath;

  // get controller for the entire KMS
  if(rootInvocationTarget === kmsBaseUrl) {
    throw new Error(`Invalid root invocation target "${kmsBaseUrl}".`);
  }

  // get controller for an individual keystore
  let controller;
  try {
    ({controller} = await storage.get({id: rootInvocationTarget, req}));
  } catch(e) {
    if(e.type === 'NotFoundError') {
      const url = req.protocol + '://' + req.get('host') + req.url;
      throw new Error(
        `Invalid capability identifier "${rootCapabilityId}" ` +
        `for URL "${url}".`);
    }
    throw e;
  }
  return controller;
}

async function _getRevocationRootController({
  req, rootCapabilityId, rootInvocationTarget
}) {
  // if `revocations` is not in the root invocation target, then defer to
  // `getRootController` to try and provide the controller for a keystore
  if(!rootInvocationTarget.includes('/revocations/')) {
    return _getRootController({req, rootCapabilityId, rootInvocationTarget});
  }

  /* Note: If the invocation target is a zcap-specific revocation endpoint,
  we use the delegator of the zcap as the root controller for the target.

  This approach allows any party that has delegated a zcap to be able to send
  it for revocation. Subsequent code (in the revocation route handler) will
  confirm that the delegation is proper and the zcap from which it was
  delegated has not itself been revoked.

  To be clear, if the delegation chain is:

  root -> A -> B

  Then the delegator of B may invoke a root zcap: `urn:zcap:root:<ID of B>`
  with a target of `<keystoreId>/revocations/<ID of B>`. As long as `A` has not
  also been revoked, then `B` will be revoked and stored as a revocation until
  `B` expires. */

  // ensure the `rootInvocationTarget` matches the request URL (i.e., that
  // the caller POSTed a zcap with an ID that matches up with the URL to
  // which they POSTed); this is not a security issue if this check is not
  // performed, however, it can help clients debug errors on their end
  const requestUrl = `${req.protocol}://${req.get('host')}${req.url}`;
  if(rootInvocationTarget !== requestUrl) {
    throw new BedrockError(
      'The request URL does not match the root invocation target. Ensure ' +
      'that the capability is sent to a URL that includes its ID.',
      'URLMismatchError', {
        // this error will be a `cause` in the onError handler below
        // this httpStatusCode is not operative
        httpStatusCode: 400,
        public: true,
        rootInvocationTarget,
        requestUrl
      });
  }

  // presume `getDelegator` middleware already called
  return req.zcapRevocation.delegator;
}

async function _aggregateUsage({meter, signal} = {}) {
  const {id: meterId} = meter;
  const [usage, revocationCount] = await Promise.all([
    keystores.getStorageUsage({meterId, signal}),
    // FIXME: get zcap revocation count associated with this meter
    // https://github.com/digitalbazaar/bedrock-kms-http/issues/55
    0
  ]);

  // sum keystore storage and revocation storage
  const {storageCost} = config['kms-http'];
  usage.storage += revocationCount * storageCost.revocation;

  return usage;
}

function _authorizeZcapInvocation({
  getExpectedTarget, getRootController = _getRootController,
  expectedAction, onError
} = {}) {
  return authorizeZcapInvocation({
    expectedHost: config.server.host,
    getRootController,
    documentLoader,
    getExpectedTarget,
    expectedAction,
    logger,
    onError,
  });
}

function _createGetDelegatorMiddleware({routes}) {
  return asyncHandler(async function getDelegator(req, res, next) {
    // verify CapabilityDelegation before storing zcap
    const {body: capability} = req;
    const host = req.get('host');

    const keystoreId = helpers.getKeystoreId(
      {req, localId: req.params.keystoreId, routes});

    let delegator;
    try {
      const results = await helpers.verifyDelegation(
        {keystoreId, host, capability});
      ({delegator} = results[0].purposeResult);
      delegator = delegator.id || delegator;
    } catch(e) {
      throw new BedrockError(
        'The provided capability delegation is invalid.',
        'DataError', {
          httpStatusCode: 400,
          public: true,
          message: e.message
        }, e);
    }

    req.zcapRevocation = {delegator};

    // proceed to next middleware on next tick to prevent subsequent
    // middleware from potentially throwing here
    process.nextTick(next);
  });
}

async function _getExpectedKeystoreTarget({req}) {
  // ensure the `configId` matches the request URL (i.e., that the caller
  // POSTed a config with an ID that matches up with the URL to which they
  // POSTed); this is not a security issue if this check is not performed,
  // however, it can help clients debug errors on their end
  const {body: {id: configId}} = req;
  const requestUrl = `${req.protocol}://${req.get('host')}${req.url}`;
  if(configId !== requestUrl) {
    throw new BedrockError(
      'The request URL does not match the configuration ID.',
      'URLMismatchError', {
        // this error will be a `cause` in the onError handler below
        // this httpStatusCode is not operative
        httpStatusCode: 400,
        public: true,
        configId,
        requestUrl,
      });
  }
  return {expectedTarget: configId};
}

function onError({error}) {
  // cause must be a public BedrockError to be surfaced to the HTTP client
  let cause;
  if(error instanceof BedrockError) {
    cause = error;
  } else {
    cause = new BedrockError(
      error.message,
      error.name || 'NotAllowedError', {
        ...error.details,
        public: true,
      });
  }
  throw new BedrockError(
    'Authorization error.', 'NotAllowedError', {
      httpStatusCode: 403,
      public: true,
    }, cause);
}

async function _reportRevocationUsage({keystoreId}) {
  // intentionally do not check request restrictions (req: false); this is
  // only called from the revocations endpoint where zcaps are being revoked;
  // the keystore is not being accessed
  const keystore = await storage.get({id: keystoreId, req: false});
  await meters.use({id: keystore.meterId, operations: 1});
}
