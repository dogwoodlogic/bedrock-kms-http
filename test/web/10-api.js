/*
 * Copyright (c) 2019-2020 Digital Bazaar, Inc. All rights reserved.
 */
import pMap from 'p-map';
import uuid from 'uuid-random';
import {CapabilityAgent, KeystoreAgent, KmsClient} from 'webkms-client';

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
        keystore = await _createKeystore({capabilityAgent});
      } catch(e) {
        err = e;
      }
      should.not.exist(err);

      // create kmsClient only required because we need to use httpsAgent
      // that accepts self-signed certs used in test suite
      const kmsClient = new KmsClient();
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
        err = e;
      }
      should.not.exist(err);
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
        const startTime = Date.now();
        let result;
        let err;
        try {
          result = await pMap(
            vData, data => hmac.sign({data}), {concurrency: 100});
        } catch(e) {
          err = e;
        }
        should.not.exist(err);
        should.exist(result);
        result.should.be.an('array');
        result.should.have.length(operationCount);
        const elapsedTime = Date.now() - startTime;
        // NOTE: reporter in karma does not report elapsed time for individual
        // tests, this logging is intentional
        console.log('ELAPSED TIME', elapsedTime);
      });
    }); // end bulk operations
  });
});

async function _createKeystore({capabilityAgent, referenceId}) {
  // create keystore
  const config = {
    sequence: 0,
    controller: capabilityAgent.id,
  };
  if(referenceId) {
    config.referenceId = referenceId;
  }
  return KmsClient.createKeystore({config});
}
