/*
 * Copyright (c) 2019-2021 Digital Bazaar, Inc. All rights reserved.
 */

/* eslint-disable max-len */
const {
  documentLoaderFactory,
  contexts,
} = require('@transmute/jsonld-document-loader');
const didContext = require('did-context');
const {CONTEXT_URL} = require('zcap-context');
const {Ed25519Signature2020} = require('@digitalbazaar/ed25519-signature-2020');

const data = {};
module.exports = data;

const zcaps = data.zcaps = {};
data.documentLoader = documentLoaderFactory.pluginFactory
  .build({
    contexts: {
      ...contexts.W3C_Verifiable_Credentials,
      'https://w3id.org/security/suites/ed25519-2020/v1':
        Ed25519Signature2020.CONTEXT
    }
  })
  .addContext({
    [didContext.constants.DID_CONTEXT_URL]: didContext
      .contexts.get('https://www.w3.org/ns/did/v1')
  })
  .buildDocumentLoader();

const zcap0 = {
  '@context': CONTEXT_URL,
  id: 'urn:zcap:z19vWhR8EsNbWqvazp5bg6BTu',
  controller: 'did:key:z6Mkkt1BWYLPAAXwYBwyVHAZkL94tgT8QbQv2SUxeW1U3DaG',
  referenceId: 'did:key:z6MkkrtV7wnBpXKBtiZjxaSghCo8ttb5kZUJTk8bEwTTTYvg#z6MkkrtV7wnBpXKBtiZjxaSghCo8ttb5kZUJTk8bEwTTTYvg-key-capabilityInvocation',
  allowedAction: 'sign',
  invocationTarget: {
    id: 'https://bedrock.localhost:18443/kms/keystores/z1AAWWM7Zd4YyyV3NfaCqFuzQ/keys/z19wxodgv1UhrToQMvSxGhQG6',
    type: 'Ed25519VerificationKey2020',
    verificationMethod: 'did:key:z6MkkrtV7wnBpXKBtiZjxaSghCo8ttb5kZUJTk8bEwTTTYvg#z6MkkrtV7wnBpXKBtiZjxaSghCo8ttb5kZUJTk8bEwTTTYvg'
  },
  invoker: 'did:key:z6MkfV83MxASJKXim3eBPoLCDiWDseYUaW84qbVF9k3ngdfg#z6MkfV83MxASJKXim3eBPoLCDiWDseYUaW84qbVF9k3ngdfg',
  parentCapability: 'https://bedrock.localhost:18443/kms/keystores/z1AAWWM7Zd4YyyV3NfaCqFuzQ/keys/z19wxodgv1UhrToQMvSxGhQG6',
  proof: {
    type: 'Ed25519Signature2020',
    created: '2020-02-27T21:22:48Z',
    verificationMethod: 'did:key:z6MkkrtV7wnBpXKBtiZjxaSghCo8ttb5kZUJTk8bEwTTTYvg#z6MkkrtV7wnBpXKBtiZjxaSghCo8ttb5kZUJTk8bEwTTTYvg',
    proofPurpose: 'capabilityDelegation',
    capabilityChain: [
      'https://bedrock.localhost:18443/kms/keystores/z1AAWWM7Zd4YyyV3NfaCqFuzQ/keys/z19wxodgv1UhrToQMvSxGhQG6'
    ],
    jws: 'eyJhbGciOiJFZERTQSIsImI2NCI6ZmFsc2UsImNyaXQiOlsiYjY0Il19..bWt6_Q65omg8rE44a_1dzWFGcFQbUrVqZ_hnAqIKlWSQ1HpTSV6OyhAQfBlVhPCsrVplqC8oVEJmp4UWqy6gCw'
  }
};

zcaps.zero = zcap0;
