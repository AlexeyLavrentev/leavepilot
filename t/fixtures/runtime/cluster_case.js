'use strict';

const cluster = require('node:cluster');
const Module = require('node:module');

if (cluster.isPrimary) {
  const forbidden = /(?:^|\/)(?:app\.js|withSession\.js|team_view_cache\.js|runtime_startup\.js|runtime_shutdown\.js|scheduler\/|model\/db\/)/;
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (forbidden.test(resolved)) {
      throw new Error(`primary_import_forbidden:${resolved}`);
    }
    return originalLoad.apply(this, arguments);
  };
  cluster.on('message', (worker, message) => {
    if (message && message.type === 'test-server-ready') {
      process.send({type: 'cluster-ready', pid: worker.process.pid, workerId: worker.id});
    }
  });
  process.on('message', message => {
    if (message && message.type === 'kill-worker') {
      const worker = cluster.workers[message.workerId];
      if (worker) { worker.process.kill('SIGKILL'); }
    }
  });
} else {
  const http = require('node:http');
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function(event, request, response) {
    if (event === 'request') {
      response.setHeader('X-Test-Worker-Pid', String(process.pid));
    }
    return originalEmit.apply(this, arguments);
  };
}

require('../../../bin/wwww_cluster');
