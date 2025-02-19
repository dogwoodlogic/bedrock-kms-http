/*!
 * Copyright (c) 2019-2021 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const brZCapStorage = require('bedrock-zcap-storage');
const {CapabilityDelegation} = require('@digitalbazaar/zcapld');
const {CONTEXT_URL: ZCAP_CONTEXT_URL} = require('zcap-context');
const {
  defaultDocumentLoader,
  keystores
} = require('bedrock-kms');
const forwarded = require('forwarded');
const jsigs = require('jsonld-signatures');
const {Ed25519Signature2020} = require('@digitalbazaar/ed25519-signature-2020');
const {extendContextLoader} = jsigs;
const {Netmask} = require('netmask');

const ZCAP_ROOT_PREFIX = 'urn:zcap:root:';

exports.getKeystoreId = ({host, req, localId, routes}) => {
  if(!host) {
    host = req.get('host');
  }
  return `https://${host}${routes.keystores}/${localId}`;
};

exports.inspectCapabilityChain = async ({
  capabilityChain, capabilityChainMeta
}) => {
  // collect the capability IDs and delegators for the capabilities in the chain
  const capabilities = [];
  for(const [i, capability] of capabilityChain.entries()) {
    const [{purposeResult}] = capabilityChainMeta[i].verifyResult.results;
    if(purposeResult && purposeResult.delegator) {
      capabilities.push({
        capabilityId: capability.id,
        delegator: purposeResult.delegator.id,
      });
    }
  }
  const revoked = await brZCapStorage.revocations.isRevoked({capabilities});

  if(revoked) {
    return {
      valid: false,
      error: new Error(
        'One or more capabilities in the chain have been revoked.')
    };
  }

  return {valid: true};
};

exports.verifyDelegation = async ({keystoreId, capability}) => {
  const {verified, error, results} = await jsigs.verify(capability, {
    suite: new Ed25519Signature2020(),
    purpose: new CapabilityDelegation({
      allowTargetAttenuation: true,
      expectedRootCapability:
        `${ZCAP_ROOT_PREFIX}${encodeURIComponent(keystoreId)}`,
      inspectCapabilityChain: exports.inspectCapabilityChain,
      suite: new Ed25519Signature2020()
    }),
    documentLoader: _createDocumentLoader({keystoreId})
  });
  if(!verified) {
    throw error;
  }
  return results;
};

exports.verifyRequestIp = ({keystoreConfig, req}) => {
  const {ipAllowList} = keystoreConfig;
  if(!ipAllowList) {
    return {verified: true};
  }

  // the first IP in the sourceAddresses array will *always* be the IP
  // reported by Express.js via `req.connection.remoteAddress`. Any additional
  // IPs will be from the `x-forwarded-for` header.
  const sourceAddresses = forwarded(req);

  // ipAllowList is an array of CIDRs
  for(const cidr of ipAllowList) {
    const netmask = new Netmask(cidr);
    for(const address of sourceAddresses) {
      if(netmask.contains(address)) {
        return {verified: true};
      }
    }
  }

  return {verified: false};
};

function _createDocumentLoader({keystoreId}) {
  return extendContextLoader(async url => {
    // generate root zcap for keystore
    if(url.startsWith(ZCAP_ROOT_PREFIX) &&
      decodeURIComponent(url.substr(ZCAP_ROOT_PREFIX.length)) === keystoreId) {
      return {
        contextUrl: null,
        documentUrl: url,
        document: await _generateRootCapability({keystoreId})
      };
    }
    return defaultDocumentLoader(url);
  });
}

async function _generateRootCapability({keystoreId}) {
  const {config: keystore} = await keystores.get({id: keystoreId});
  return {
    '@context': ZCAP_CONTEXT_URL,
    id: `${ZCAP_ROOT_PREFIX}${encodeURIComponent(keystoreId)}`,
    controller: keystore.controller,
    invocationTarget: keystoreId
  };
}
