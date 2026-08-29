'use strict';

var expect = require('chai').expect,
    verifier = require('../../.planning/quick/260829-vnb-fix-first-pass-browser-failures-in-rende/verify_ci');

function acceptedShape() {
  return {
    run: {id: 7, head_sha: 'a'.repeat(40), path: '.github/workflows/core-integration.yml', event: 'push', head_branch: 'inf/phase-01-trustworthy-baseline', run_attempt: 1, status: 'completed', conclusion: 'success'},
    jobs: [{name: 'Browser suite 3/4', conclusion: 'success'}],
    artifacts: [{name: 'flake-report-shard-3', expired: false}],
    report: [],
    workflow: 'TEST_RETRIES: \'0\'\nname: Upload flake report\nif: always()',
  };
}

describe('quick vnb CI verifier', function(){
  it('accepts only the exact all-green first-attempt shape', function(){
    expect(verifier.validate(acceptedShape())).to.equal(true);
  });

  ['head_sha', 'path', 'event'].forEach(function(field){
    it('rejects wrong ' + field, function(){
      var value = acceptedShape();
      value.run[field] = 'wrong';
      expect(function(){ verifier.validate(value); }).to.throw('CI recovery verification failed');
    });
  });

  it('rejects reruns, failed shard jobs, absent artifacts, and retry records', function(){
    [
      function(value){ value.run.run_attempt = 2; },
      function(value){ value.jobs[0].conclusion = 'failure'; },
      function(value){ value.artifacts = []; },
      function(value){ value.report = [{contour: 'integration-batch-retry'}]; },
    ].forEach(function(mutate){
      var value = acceptedShape();
      mutate(value);
      expect(function(){ verifier.validate(value); }).to.throw('CI recovery verification failed');
    });
  });
});
