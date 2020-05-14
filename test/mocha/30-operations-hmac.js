/*
 * Copyright (c) 2019-2020 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const {util: {uuid}} = require('bedrock');
const brHttpsAgent = require('bedrock-https-agent');
const {CapabilityAgent, KeystoreAgent, KmsClient} = require('webkms-client');
const helpers = require('./helpers');
// TextEncoder is not a global in node 10
const {TextEncoder} = require('util');

const KMS_MODULE = 'ssm-v1';

describe('bedrock-kms-http HMAC operations', () => {
  describe('Sha256HmacKey2019', () => {
    let hmac;
    before(async () => {
      const secret = ' b07e6b31-d910-438e-9a5f-08d945a5f676';
      const handle = 'testKey1';

      const capabilityAgent = await CapabilityAgent
        .fromSecret({secret, handle});

      let err;
      let keystore;
      try {
        keystore = await helpers.createKeystore({capabilityAgent});
      } catch(e) {
        err = e;
      }
      assertNoError(err);

      // create kmsClient only required because we need to use httpsAgent
      // that accepts self-signed certs used in test suite
      const {httpsAgent} = brHttpsAgent;
      const kmsClient = new KmsClient({httpsAgent});
      const keystoreAgent = new KeystoreAgent({
        capabilityAgent,
        keystore,
        kmsClient
      });
      hmac = await keystoreAgent.generateKey({
        kmsModule: KMS_MODULE,
        type: 'hmac',
      });
    });
    it('successfully signs', async () => {
      const data = new TextEncoder('utf-8').encode('hello');
      let err;
      let result;
      try {
        result = await hmac.sign({data});
      } catch(e) {
        err = err;
      }
      assertNoError(err);
      should.exist(result);
      result.should.be.a('string');
    });

    describe('bulk operations', () => {
      const operationCount = 10000;
      const vData = [];
      before(async () => {
        for(let i = 0; i < operationCount; ++i) {
          let v = '';
          for(let n = 0; n < 100; ++n) {
            v += uuid();
          }
          vData.push(new TextEncoder('utf-8').encode(v));
        }
      });
      it(`performs ${operationCount} signatures`, async function() {
        this.timeout(0);
        const promises = [];
        for(let i = 0; i < operationCount; ++i) {
          promises.push(hmac.sign({data: vData[i]}));
        }
        let result;
        let err;
        try {
          result = await Promise.all(promises);
        } catch(e) {
          err = e;
        }
        assertNoError(err);
        should.exist(result);
        result.should.be.an('array');
        result.should.have.length(operationCount);
      });
    }); // end bulk operations
  });
});
