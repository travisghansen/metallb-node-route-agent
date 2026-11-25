const fetch = require('node-fetch');
const { createInterface } = require('readline');

/**
 * parse a Retry-After header (delta-seconds or HTTP-date)
 *
 * @returns number|null milliseconds to wait
 */
function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

/**
 * A self-healing list+watch loop for a single k8s resource collection.
 *
 * Unlike k8s.Watch from @kubernetes/client-node this class:
 *  - owns the AbortController from the very start of the request, so a watch
 *    can be aborted even if the server has not sent any data yet
 *    (https://github.com/kubernetes-client/javascript/issues/2860)
 *  - guarantees at most 1 in-flight request per instance (a single loop
 *    awaits each connection before starting the next)
 *  - resumes from the last seen resourceVersion so reconnects do not replay
 *    every object as ADDED (and trigger a storm of reconciles)
 *  - requests bookmarks so an idle-but-healthy watch still sees periodic
 *    traffic, allowing a tight inactivity (dead peer) timeout
 *  - backs off with full jitter on consecutive failures, honoring
 *    Retry-After (ie: 429 from api priority and fairness) when present
 *
 * Callbacks:
 *  - onSync(items): invoked after every (re)list, when events may have been missed
 *  - onEvent(type, obj, watchObj): invoked for ADDED/MODIFIED/DELETED
 *  - onError(err): invoked for connection failures (informational)
 */
class ManagedWatch {
  constructor(kc, options = {}) {
    this.kc = kc;
    this.path = options.path;
    this.queryParams = options.queryParams || {};
    this.logger = options.logger;
    this.onSync = options.onSync || (() => {});
    this.onEvent = options.onEvent || (() => {});
    this.onError = options.onError || (() => {});

    // abort the connection if no data (including bookmarks) is received in this window
    this.inactivityTimeout = options.inactivityTimeout || 5 * 60 * 1000;
    // ask the server to cleanly close the watch periodically
    this.serverTimeoutSeconds = options.serverTimeoutSeconds || 10 * 60;
    this.minBackoff = options.minBackoff || 2000;
    this.maxBackoff = options.maxBackoff || 60 * 1000;

    this.resourceVersion = null;
    this.running = false;
    this.controller = null;
    this.lastActivity = null;
    this.failures = 0;
    this.sleepTimer = null;
    this.sleepResolve = null;
  }

  get name() {
    const qs = new URLSearchParams(this.queryParams).toString();
    return qs ? `${this.path}?${qs}` : this.path;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this._loop();
    return this.loopPromise;
  }

  stop() {
    this.running = false;
    if (this.controller) {
      this.controller.abort();
    }
    this._wake();
  }

  /**
   * force the current connection to be torn down and re-established
   */
  restart() {
    if (this.controller) {
      this.controller.abortReason = 'restart';
      this.controller.abort();
    }
  }

  async _loop() {
    while (this.running) {
      let retryAfter = null;
      try {
        if (!this.resourceVersion) {
          await this._list();
        }

        const gotData = await this._watchOnce();
        if (gotData) {
          this.failures = 0;
        }
      } catch (e) {
        if (!this.running) {
          break;
        }

        this.failures++;
        if (e && Number.isFinite(e.retryAfter)) {
          retryAfter = e.retryAfter;
        }
        if (e && e.expired) {
          // resourceVersion too old, relist immediately
          this.logger.info(`${this.name} resourceVersion expired, relisting`);
          this.resourceVersion = null;
          this.failures = 0;
          continue;
        }

        this.logger.warn(
          `${this.name} watch failure (attempt ${this.failures}): ${e}`
        );
        try {
          await this.onError(e);
        } catch (err) {
          this.logger.error(`${this.name} onError handler failed: ${err}`);
        }
      }

      if (!this.running) {
        break;
      }

      if (this.failures > 0) {
        const backoff = Math.min(
          this.maxBackoff,
          this.minBackoff * Math.pow(2, this.failures - 1)
        );
        // full jitter
        let wait = Math.floor(Math.random() * backoff);
        if (retryAfter !== null) {
          // the server asked us to wait, jitter on top so clients do not all
          // return at the same instant (capped to avoid absurd values)
          wait = Math.min(
            this.maxBackoff,
            Math.max(wait, retryAfter + Math.floor(Math.random() * 1000))
          );
        }
        this.logger.verbose(`${this.name} reconnecting in ${wait}ms`);
        await this._sleep(wait);
      }
    }

    this.logger.info(`${this.name} watch stopped`);
  }

  async _list() {
    const res = await this.kc.makeHttpRestRequest(
      this.path,
      'GET',
      Object.assign({}, this.queryParams)
    );

    if (!res || res.statusCode != 200) {
      const err = new Error(
        `list failed with status ${res && res.statusCode}: ${JSON.stringify(
          res && res.body
        )}`
      );
      err.statusCode = res && res.statusCode;
      err.retryAfter = parseRetryAfter(
        res && res.headers && res.headers['retry-after']
      );
      throw err;
    }

    // NOTE: not paginating, collections watched here are tiny
    const items = res.body.items || [];
    this.resourceVersion = res.body.metadata.resourceVersion;
    this.lastActivity = new Date();
    this.logger.verbose(
      `${this.name} listed ${items.length} items at resourceVersion ${this.resourceVersion}`
    );

    try {
      await this.onSync(items);
    } catch (e) {
      this.logger.error(`${this.name} onSync handler failed: ${e}`);
    }
  }

  /**
   * run a single watch connection to completion
   *
   * @returns boolean true if any data was received
   */
  async _watchOnce() {
    const cluster = this.kc.getCurrentCluster();
    const url = new URL(cluster.server + this.path);
    for (const [key, val] of Object.entries(this.queryParams)) {
      url.searchParams.set(key, String(val));
    }
    url.searchParams.set('watch', 'true');
    url.searchParams.set('allowWatchBookmarks', 'true');
    url.searchParams.set('resourceVersion', this.resourceVersion);
    // randomize to avoid all watches reconnecting in lockstep
    url.searchParams.set(
      'timeoutSeconds',
      String(
        Math.floor(this.serverTimeoutSeconds * (0.75 + Math.random() * 0.25))
      )
    );

    const requestInit = await this.kc.applyToFetchOptions({});
    const controller = new AbortController();
    this.controller = controller;
    requestInit.signal = controller.signal;
    requestInit.method = 'GET';

    let gotData = false;
    let inactivityTimer = null;
    const armInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        controller.abortReason = 'inactivity';
        this.logger.warn(
          `${this.name} no activity in ${this.inactivityTimeout}ms, aborting watch`
        );
        controller.abort();
      }, this.inactivityTimeout);
    };

    // armed *before* the request so a server that never responds is still caught
    armInactivityTimer();

    this.logger.verbose(
      `${this.name} starting watch at resourceVersion ${this.resourceVersion}`
    );

    let response;
    try {
      response = await fetch(url.toString(), requestInit);

      if (response.status === 410) {
        const err = new Error('Gone');
        err.expired = true;
        throw err;
      }

      if (response.status !== 200) {
        const err = new Error(
          `watch failed with status ${
            response.status
          }: ${await response.text()}`
        );
        err.statusCode = response.status;
        err.retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        throw err;
      }

      if (requestInit.agent && requestInit.agent.sockets) {
        for (const socket of Object.values(requestInit.agent.sockets).flat()) {
          if (socket) {
            socket.setKeepAlive(true, 30 * 1000);
          }
        }
      }

      await new Promise((resolve, reject) => {
        const body = response.body;
        const lines = createInterface({ input: body, crlfDelay: Infinity });
        let settled = false;
        const finish = err => {
          if (settled) {
            return;
          }
          settled = true;
          lines.close();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        };

        body.on('error', finish);
        lines.on('error', finish);
        body.on('end', () => finish());
        body.on('close', () => finish());
        lines.on('close', () => finish());

        lines.on('line', line => {
          if (!line) {
            return;
          }
          let data;
          try {
            data = JSON.parse(line);
          } catch (e) {
            this.logger.warn(`${this.name} unparsable watch line: ${e}`);
            return;
          }

          gotData = true;
          this.lastActivity = new Date();
          armInactivityTimer();

          const rv =
            data.object && data.object.metadata
              ? data.object.metadata.resourceVersion
              : null;

          switch (data.type) {
            case 'BOOKMARK':
              if (rv) {
                this.resourceVersion = rv;
              }
              this.logger.debug(`${this.name} bookmarked: ${rv}`);
              return;
            case 'ERROR': {
              const status = data.object || {};
              const err = new Error(
                `watch error event: ${status.code} ${status.reason} ${status.message}`
              );
              if (status.code == 410) {
                err.expired = true;
              }
              finish(err);
              controller.abort();
              return;
            }
            default:
              if (rv) {
                this.resourceVersion = rv;
              }
              Promise.resolve()
                .then(() => this.onEvent(data.type, data.object, data))
                .catch(e => {
                  this.logger.error(
                    `${this.name} onEvent handler failed: ${e}`
                  );
                });
          }
        });
      });
    } catch (e) {
      if (!this.running) {
        return gotData;
      }
      switch (controller.abortReason) {
        case 'inactivity':
          throw new Error('aborted due to inactivity');
        case 'restart':
          // reconnect without counting as a failure
          return gotData;
      }
      throw e;
    } finally {
      clearTimeout(inactivityTimer);
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (
        requestInit.agent &&
        typeof requestInit.agent.destroy === 'function'
      ) {
        requestInit.agent.destroy();
      }
      if (this.controller === controller) {
        this.controller = null;
      }
    }

    this.logger.verbose(`${this.name} watch closed by server`);
    if (!gotData) {
      // a server closing immediately with no data is suspicious, back off
      this.failures++;
    }
    return gotData;
  }

  _sleep(ms) {
    return new Promise(resolve => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(resolve, ms);
    }).finally(() => {
      this.sleepTimer = null;
      this.sleepResolve = null;
    });
  }

  _wake() {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepResolve();
    }
  }
}

module.exports.ManagedWatch = ManagedWatch;
