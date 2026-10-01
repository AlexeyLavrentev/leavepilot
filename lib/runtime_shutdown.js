'use strict';

const logger = require('./middleware/request_logger');

function safeErrorDetails(error) {
  if (!error) { return undefined; }
  const cause = error.parent || error.original || error.cause;
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(value)
    ? value : undefined;
  return {
    name: safe(error.name) || 'Error',
    code: safe(error.code) || safe(cause && cause.code),
    stage: safe(error.startupStage),
  };
}

function settleBy(promise, deadlineAt) {
  const settled = Promise.resolve(promise).then(
    value => ({status: 'fulfilled', value}),
    error => ({status: 'rejected', error})
  );
  const remaining = Math.max(0, deadlineAt - Date.now());
  if (remaining === 0) { return Promise.resolve({status: 'timeout'}); }
  let timer;
  return Promise.race([
    settled,
    new Promise(resolve => { timer = setTimeout(() => resolve({status: 'timeout'}), remaining); }),
  ]).finally(() => clearTimeout(timer));
}

function createShutdownCoordinator(options) {
  const opts = options || {};
  // Existing total stop envelope, preserved from the pre-phase default. The
  // last 20 percent is reserved for forced disposal: a real stalled request
  // hit the 8000 ms drain boundary, finished forced closure inside the tail
  // and exited 8025 ms after the signal with the required nonzero code
  // (see t/fixtures/verify/runtime_timings.json lifecycle.policy).
  const timeoutMs = opts.timeoutMs === undefined ? 10000 : opts.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('shutdown timeoutMs must be a finite positive number');
  }
  let shutdownPromise;
  let requestedCode;

  return function shutdown(reason, error, exitCode) {
    if (shutdownPromise) {
      if (requestedCode === 0 && exitCode !== undefined && exitCode !== 0) {
        requestedCode = exitCode;
        logger.error(reason, error ? {error: safeErrorDetails(error)} : {});
      }
      return shutdownPromise;
    }
    requestedCode = exitCode === undefined ? 1 : exitCode;
    let resolveShutdown;
    shutdownPromise = new Promise(resolve => { resolveShutdown = resolve; });
    const startedAt = Date.now();
    const drainAt = startedAt + Math.floor(timeoutMs * 0.8);
    const deadlineAt = startedAt + timeoutMs;
    let incomplete = false;
    let finished = false;
    let timer = null;
    let server;
    let lifecycle;
    let db;
    let schedulers;
    let cache;
    let idleCloseTimer;

    const report = (phase, category, cause) => {
      incomplete = true;
      logger.error('shutdown_incomplete', {
        phase,
        category,
        error: safeErrorDetails(cause),
      });
    };
    const forceHttp = () => {
      if (server && typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); }
        catch (closeError) { report('http', 'force_failed', closeError); }
      }
      if (opts.getSockets) {
        for (const socket of opts.getSockets()) {
          try { socket.destroy(); }
          catch (closeError) { report('http', 'socket_destroy_failed', closeError); }
        }
      }
    };
    const finish = () => {
      if (finished) { return; }
      finished = true;
      clearTimeout(timer);
      clearInterval(idleCloseTimer);
      const code = incomplete && requestedCode === 0 ? 1 : requestedCode;
      try { opts.exit(code); }
      finally { resolveShutdown(true); }
    };

    try {
      if (opts.onTerminalStart) { opts.onTerminalStart(); }
      server = opts.getServer ? opts.getServer() : opts.server;
      lifecycle = opts.getSessionLifecycle ? opts.getSessionLifecycle() : opts.sessionLifecycle;
      db = opts.getDb ? opts.getDb() : opts.db;
      schedulers = opts.getSchedulers ? opts.getSchedulers() : opts.schedulers;
      cache = opts.getCache ? opts.getCache() : opts.cache;
      (requestedCode === 0 ? logger.info : logger.error)(reason,
        error ? {error: safeErrorDetails(error)} : {});
    } catch (startError) {
      report('start', 'failed', startError);
      finish();
      return shutdownPromise;
    }

    // This timer is independent of every close Promise. Even a library that
    // never settles cannot turn a forced termination into a successful exit.
    timer = setTimeout(() => {
      report('total', 'deadline');
      forceHttp();
      if (lifecycle && typeof lifecycle.forceClose === 'function') {
        try { Promise.resolve(lifecycle.forceClose()).catch(() => {}); }
        catch { /* terminal exit still takes precedence */ }
      }
      if (cache && typeof cache.forceClose === 'function') {
        try { Promise.resolve(cache.forceClose()).catch(() => {}); }
        catch { /* terminal exit still takes precedence */ }
      }
      finish();
    }, timeoutMs);

    const closeResource = async (resource, phase, until) => {
      if (!resource || typeof resource.close !== 'function' || finished) { return; }
      const result = await settleBy(Promise.resolve().then(() => resource.close()), until);
      if (result.status === 'fulfilled') { return; }
      report(phase, result.status, result.error);
      if (typeof resource.forceClose === 'function') {
        const forced = await settleBy(Promise.resolve().then(() => resource.forceClose()),
          Math.min(deadlineAt, Date.now() + Math.max(1, Math.floor(timeoutMs * 0.1))));
        if (forced.status !== 'fulfilled') {
          report(phase, `force_${forced.status}`, forced.error);
        }
      }
    };

    void (async () => {
      try {
        let closed;
        if (server && typeof server.close === 'function') {
          closed = new Promise((resolve, reject) => {
            try {
              server.close(closeError => closeError ? reject(closeError) : resolve());
              if (typeof server.closeIdleConnections === 'function') {
                server.closeIdleConnections();
                idleCloseTimer = setInterval(() => {
                  try { server.closeIdleConnections(); }
                  catch (closeError) {
                    clearInterval(idleCloseTimer);
                    report('http', 'idle_close_failed', closeError);
                  }
                }, 20);
              }
            } catch (closeError) { reject(closeError); }
          });
        }
        // Stop future jobs as soon as admission closes. An awaitable stop
        // also represents the active job's lock-release work before SQL closes.
        const stops = Array.isArray(schedulers) ? schedulers.map(({handle}) => {
          if (!handle || typeof handle.stop !== 'function') { return Promise.resolve(); }
          return Promise.resolve().then(() => handle.stop());
        }) : [];
        if (closed) {
          const result = await settleBy(closed, drainAt);
          clearInterval(idleCloseTimer);
          if (result.status !== 'fulfilled') {
            report('http', result.status, result.error);
            forceHttp();
            await settleBy(closed, Math.min(deadlineAt,
              Date.now() + Math.max(1, Math.floor(timeoutMs * 0.05))));
          }
        }
        if (stops.length > 0) {
          const results = await settleBy(Promise.allSettled(stops), drainAt);
          if (results.status !== 'fulfilled') {
            report('scheduler', results.status, results.error);
          } else {
            for (const result of results.value) {
              if (result.status === 'rejected') {
                report('scheduler', 'rejected', result.reason);
              }
            }
          }
        }
        await closeResource(lifecycle, 'session_store', incomplete
          ? deadlineAt - Math.floor(timeoutMs * 0.1) : drainAt);
        await closeResource(cache, 'cache', incomplete
          ? deadlineAt - Math.floor(timeoutMs * 0.1) : drainAt);
        await closeResource(db, 'sql', incomplete ? deadlineAt : drainAt);
      } catch (closeError) {
        report('cleanup', 'failed', closeError);
      } finally { finish(); }
    })();
    return shutdownPromise;
  };
}

function installProcessHandlers(options) {
  const shutdown = options.shutdown || createShutdownCoordinator(Object.assign({
    exit: code => { process.exitCode = code; },
  }, options));
  let cleanupAttached = false;
  const handlers = {};
  const invoke = (reason, error, code) => {
    const closing = shutdown(reason, error, code);
    if (!cleanupAttached) {
      cleanupAttached = true;
      const removeHandlers = () => {
        for (const [event, handler] of Object.entries(handlers)) {
          process.removeListener(event, handler);
        }
      };
      Promise.resolve(closing).then(removeHandlers, removeHandlers);
    }
  };
  handlers.uncaughtException = error => { invoke('uncaught_exception', error, 1); };
  handlers.unhandledRejection = error => { invoke('unhandled_rejection', error, 1); };
  handlers.SIGTERM = () => { invoke('sigterm', null, 0); };
  handlers.SIGINT = () => { invoke('sigint', null, 0); };
  for (const [event, handler] of Object.entries(handlers)) {
    process.on(event, handler);
  }
  return shutdown;
}

module.exports = {createShutdownCoordinator, installProcessHandlers};
