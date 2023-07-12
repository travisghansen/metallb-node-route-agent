const _ = require('lodash');
const k8s = require('@kubernetes/client-node');
const LRU = require('lru-cache');
const queryString = require('query-string');
const request = require('request');
const URI = require('uri-js');

const FAILURE_CACHE_TIME = 5 * 60 * 1000; // 5 minutes
const SUCCESS_CACHE_TIME = 1 * 60 * 60 * 1000; // 1 hour

class KubeConfig extends k8s.KubeConfig {
  constructor() {
    super(...arguments);
    this.discoveryCache = new LRU({
      ttl: SUCCESS_CACHE_TIME,
      ttlAutopurge: true
    });
  }

  /**
   * creates a new watch instance
   */
  createWatch() {
    return new k8s.Watch(this);
  }

  /**
   * get all items of a particular resoure/list
   *
   * @param {*} endpoint
   * @param {*} payload
   * @returns
   */
  async getAll(endpoint, payload) {
    const items = [];
    let res;
    let c;
    do {
      c = _.get(res, 'body.metadata.continue');
      if (c) {
        payload['continue'] = c;
      }
      res = await this.makeHttpRestRequest(endpoint, 'GET', payload);
      items.push(...res.body.items);
    } while (res.body.metadata.continue);

    return items;
  }

  async getCurrentResourceVersion(endpoint) {
    const res = await this.makeHttpRestRequest(endpoint, 'GET', { limit: 1 });
    if (res.statusCode == 200) {
      return res.body.metadata.resourceVersion;
    }
  }

  // https://github.com/kubernetes-client/python/blob/master/kubernetes/docs/V1LabelSelector.md
  async assertLabelSelector(apiObj, labelSelector) {
    // An empty label selector matches all objects. A null label selector matches no objects.
    if (labelSelector === null) {
      return false;
    }

    let objLabels;
    objLabels = apiObj.metadata.labels || {};

    //objLabels = {};
    if (labelSelector.matchLabels) {
      for (const property in labelSelector.matchLabels) {
        //console.log(
        //  `comparing ${objLabels[property]} == ${labelSelector.matchLabels[property]}`
        //);
        if (objLabels[property] != labelSelector.matchLabels[property]) {
          return false;
        }
      }
    }

    //objLabels = {};
    if (labelSelector.matchExpressions) {
      let i = 0;
      do {
        let matchExpression = labelSelector.matchExpressions[i];
        if (matchExpression.key) {
          if (matchExpression.operator) {
            switch (matchExpression.operator) {
              case 'In':
                if (
                  !matchExpression.values.includes(
                    objLabels[matchExpression.key]
                  )
                ) {
                  return false;
                }
                break;
              case 'NotIn':
                if (
                  matchExpression.values.includes(
                    objLabels[matchExpression.key]
                  )
                ) {
                  return false;
                }
                break;
              case 'Exists':
                if (!Object.keys(objLabels).includes(matchExpression.key)) {
                  return false;
                }
                break;
              case 'DoesNotExist':
                if (Object.keys(objLabels).includes(matchExpression.key)) {
                  return false;
                }
                break;
              default:
                throw new Error(`unkown operator ${matchExpression.operator}`);
            }
          }
        }
        i++;
      } while (i < labelSelector.matchExpressions.length);
    }

    return true;
  }

  /**
   *
   * Make an HTTP request to the k8s api
   *
   * @param {*} endpoint
   * @param {*} method
   * @param {*} payload
   * @returns
   */
  async makeHttpRestRequest(endpoint, method, payload) {
    const kc = this;
    return new Promise((resolve, reject) => {
      method = method || 'GET';
      const options = {
        method: method.toUpperCase(),
        url: `${kc.getCurrentCluster().server}${endpoint}`,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'metallb-node-route-agent',
          'Content-Type': 'application/json'
        },
        json: true
        //agentOptions: {
        //  rejectUnauthorized: false
        //}
      };

      kc.applyToRequest(options);

      if (options.method.includes('PATCH')) {
        /**
         * https://github.com/kubernetes/community/blob/master/contributors/devel/api-conventions.md#patch-operations
         * https://github.com/kubernetes/community/blob/master/contributors/devel/strategic-merge-patch.md
         *
         * Content-Type: application/json-patch+json
         * Content-Type: application/merge-patch+json
         * Content-Type: application/strategic-merge-patch+json
         */
        switch (options.method) {
          case 'PATCH-JSON':
            options['headers']['Content-Type'] = 'application/json-patch+json';
            break;
          case 'PATCH-STRATEGIC-MERGE':
            options['headers']['Content-Type'] =
              'application/strategic-merge-patch+json';
            break;
          case 'PATCH':
          case 'PATCH-MERGE':
          default:
            options['headers']['Content-Type'] = 'application/merge-patch+json';
            break;
        }

        options.method = 'PATCH';
      }

      switch (options.method.toUpperCase()) {
        case 'GET':
          options.qs = payload;
          break;
        default:
          options.body = payload;
          break;
      }

      request(options, function (err, res, body) {
        body;
        if (err) {
          reject(err);
        }
        resolve(res);
      });
    });
  }

  /**
   * Given a URI, remove parts of the path that equal 'watch'
   * and also remove any 'watch' parameters from the query string
   *
   * @param {*} uri
   */
  buildWatchlessURI(uri) {
    const suri = URI.parse(URI.normalize(uri));
    const path = suri.path;
    const query = suri.query;

    const pathParts = path.split('/');
    const pathPartsWithoutWatch = pathParts.filter(item => {
      if (item.toLowerCase() != 'watch') {
        return true;
      }
      return false;
    });

    const squery = queryString.parse(query);
    delete squery['watch'];

    const newPath = pathPartsWithoutWatch.join('/');
    const newUri = URI.serialize({
      path: newPath,
      query: queryString.stringify(squery)
    });

    return newUri;
  }

  async getAPIGroups() {
    let res;
    let cacheKey = '__APIGroups';
    res = this.discoveryCache.get(cacheKey);
    if (res === undefined) {
      res = await this.makeHttpRestRequest('/apis');

      if (res.stausCode == 200) {
        res = res.body;
        this.discoveryCache.set(cacheKey, res);
      } else {
        res = res.body;
        this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
      }
    }

    return res;
  }

  async getAPIGroup(groupName) {
    const groups = await this.getAPIGroups();

    for (const group of groups.groups) {
      if (group.name == groupName) {
        return group;
      }
    }
  }

  async getAPIResourcesByGroup(groupName) {
    const group = await this.getAPIGroup(groupName);
    let res;

    const resources_obj = {};
    const resources_arr = [];

    for (const version of group.versions) {
      res = await this.makeHttpRestRequest(`/apis/${version.groupVersion}`);
      for (const resource of res.body.resources) {
        if (!(resource.name in resources_obj)) {
          resources_obj[resource.name] = resource;
          resources_obj[resource.name].groupVersion = res.body.groupVersion;
        }
      }
    }

    for (const resource in resources_obj) {
      resources_arr.push(resources_obj[resource]);
    }

    return resources_arr;
  }

  async getAPIResources(preferredVersions = false) {
    this.locks = this.locks || {};
    let cacheKey = '__APIResources';

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    let i = 0;
    while (this.locks[cacheKey]) {
      i++;
      await sleep(1000);

      if (i > 10) {
        break;
      }
    }

    // test cache lock and wait
    let resources = this.discoveryCache.get(cacheKey);

    if (resources === undefined) {
      // apply lock
      this.locks[cacheKey] = true;

      resources = [];

      try {
        let apiGroups = await this.getAPIGroups();
        let api = await this.makeHttpRestRequest('/api');

        if (api.statusCode == 200) {
          await Promise.all(
            api.body.versions.map(async version => {
              let res = await this.makeHttpRestRequest(`/api/${version}`);

              if (res.statusCode == 200) {
                resources.push(res.body);
              }
            })
          );
        }

        if (apiGroups.groups) {
          await Promise.all(
            apiGroups.groups.map(async group => {
              await Promise.all(
                group.versions.map(async version => {
                  let res = await this.makeHttpRestRequest(
                    `/apis/${version.groupVersion}`
                  );

                  if (res.statusCode == 200) {
                    resources.push(res.body);
                  }
                })
              );
            })
          );
        }
      } catch (err) {
        // noop
      }

      if (resources.length > 0) {
        this.discoveryCache.set(cacheKey, resources);
      }

      // remove lock
      this.locks[cacheKey] = false;
    }

    if (preferredVersions) {
      let apiGroups = await this.getAPIGroups();
      resources = resources.filter(resource => {
        // apiVersion is not present on core api resource list
        if (!resource.apiVersion) {
          return true;
        }
        return apiGroups.groups.some(group => {
          return group.preferredVersion.groupVersion == resource.groupVersion;
        });
      });
    }

    return resources;
  }

  /**
   *
   * @param {*} kind
   * @param {*} version
   */
  async getApiGroupVersion(kind, version) {
    const resources = await this.getAPIResources(true);
    let matches = resources.filter(resourceList => {
      let groupVersionVersion = resourceList.groupVersion.split('/').pop();
      if (version && !(groupVersionVersion == version)) {
        return false;
      }

      return resourceList.resources.some(resource => {
        return resource.kind.toLowerCase() == kind.toLowerCase();
      });
    });

    if (matches.length == 1) {
      return matches[0].groupVersion;
    }
  }

  async buildResourceSelfLink(kind, apiVersion, name, namespace) {
    let res;
    if (arguments.length == 1) {
      res = kind;

      if (res.metadata && res.metadata.selfLink) {
        return res.metadata.selfLink;
      }

      kind = res.kind;
      apiVersion = res.apiVersion;
      if (res.metadata) {
        name = res.metadata.name || res.name;
        namespace = res.metadata.namespace || res.namespace || null;
      } else {
        // this support the involvedObject syntax of Events
        name = res.name;
        namespace = res.namespace || null;
      }
    }

    // for testing
    //apiVersion = undefined;

    if (!apiVersion) {
      apiVersion = await this.getApiGroupVersion(kind);
    }

    if (apiVersion == undefined || apiVersion === null) {
      throw new Error('missing apiVersion');
    }

    let prefix = '/apis';
    if (apiVersion == 'v1') {
      prefix = '/api';
    }

    //console.log(kind, apiVersion, name, namespace);

    /**
     * cache each unique resource as a key
     * allows for JIT lookup and freshness on a per-resource basis
     */
    let cacheKey = `${prefix}/${apiVersion}`;
    res = this.discoveryCache.get(cacheKey);
    if (res === undefined) {
      res = await this.makeHttpRestRequest(`${prefix}/${apiVersion}`);

      if (res.statusCode == 200) {
        res = res.body;
        this.discoveryCache.set(cacheKey, res);
      } else if (res.statusCode == 404) {
        // assume in incomplete apiVersion (ie: only the version and not groupVersion)
        // attempt to find full groupVersion

        let newApiVersion = await this.getApiGroupVersion(kind, apiVersion);
        // try again
        if (newApiVersion && newApiVersion != apiVersion) {
          apiVersion = newApiVersion;
          res = await this.makeHttpRestRequest(`${prefix}/${apiVersion}`);

          if (res.statusCode == 200) {
            res = res.body;
            this.discoveryCache.set(cacheKey, res);
          } else {
            res = res.body;
            this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
          }
        } else {
          res = res.body;
          this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
        }
      } else {
        res = res.body;
        this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
      }
    }

    if (!res.resources) {
      return;
    }

    let resource = res.resources.find(resource => {
      return resource.kind == kind;
    });

    if (resource) {
      let endpoint = '';
      if (resource.namespaced) {
        endpoint = `${prefix}/${apiVersion}/namespaces/${namespace}/${resource.name}/${name}`;
      } else {
        endpoint = `${prefix}/${apiVersion}/${resource.name}/${name}`;
      }

      return endpoint;
    } else {
      throw new Error('failure to lookup resource selfLink');
    }
  }
}

module.exports.KubeConfig = KubeConfig;
