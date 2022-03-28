const _ = require('lodash');
const AsyncMutex = require('async-mutex');
const fs = require('fs');
const { IpAddress, IpRange } = require('cidr-calc');
const IpCommand = require('./lib/ip').IpCommand;
const k8s = require('@kubernetes/client-node');
const logger = require('./lib/logger').logger;
const yaml = require('js-yaml');

const ip = new IpCommand({ logger });
const mutex = new AsyncMutex.Mutex();

// interval time period
const MAX_RECONCILE_WAIT = process.env.MAX_RECONCILE_WAIT || 60 * 1000;

// route table
const TABLE_NAME = process.env.TABLE_NAME || 'metallb-nra';
const TABLE_WEIGHT = process.env.TABLE_WEIGHT || 20;
const TABLE_FILE = '/etc/iproute2/rt_tables';

// route settings
const PEER_WEIGHT = process.env.PEER_WEIGHT || 100;
const DESTINATION = 'default';

// metallb settings
const METALLB_NAMESPACE = process.env.METALLB_NAMESPACE;
const METALLB_CONFIGMAP_NAME = process.env.METALLB_CONFIGMAP_NAME || 'config';
const K8S_NAMESPACE_FILE =
  '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

const METALLB_STATIC_FILE = process.env.METALLB_STATIC_FILE;
const METALLB_STATIC_FILE_WAIT = process.env.METALLB_STATIC_FILE_WAIT || 5000;

// globals
let metallb_loaded = false;
let metallb_peers = [];
let metallb_addresses = [];

/**
 * pause program for given ms
 *
 * @param {*} ms
 * @returns
 */
function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Should return a list of peer ip addresses
 *
 * @returns array
 */
async function getPeers() {
  //return ["172.29.0.1", "172.29.0.2"];
  return metallb_peers;
}

/**
 * Should return a list of address/cidr entries OR
 * ranges in the form of <ip low>-<ip high>
 *
 * ranges are automatically translated to cidrs for the range for injection
 * into the kernel routing table
 *
 * @returns array
 */
async function getAddresses() {
  //return ["192.168.57.0/24", "172.28.42.32-172.28.42.63", "invalid/24", "foo-bar", "bar-baz-foo"];
  return metallb_addresses;
}

/**
 * run the reconciliation loop with mutex to prevent overlapping
 */
async function reconcile() {
  logger.verbose('reconcile invoked');
  // cancel any pending
  mutex.cancel();

  // run exclusive
  try {
    await mutex.runExclusive(async () => {
      logger.info('starting reconcile process');
      // prevent disastrous operations before data has actually been loaded up
      if (!metallb_loaded) {
        logger.info('skipping reconcile, metallb data not yet loaded');
        return;
      }

      let args = [];

      //////// step 1, create the routing table as appropriate /////////

      let tableExists = await ip.tableExists(TABLE_NAME);
      if (!tableExists) {
        logger.info(
          `adding route table ${TABLE_NAME} (${TABLE_WEIGHT}) to ${TABLE_FILE}`
        );
        // TODO: create table
        fs.writeFileSync(TABLE_FILE, `\n${TABLE_WEIGHT}\t${TABLE_NAME}\n\n`, {
          flag: 'a'
        });
      }

      //////// step 2, populate the routing table as appropriate /////////

      let peers = await getPeers();
      peers = [...new Set(peers)];

      // if peers is empty, both the table and the rules entries should be wiped out
      if (peers.length > 0) {
        args = ['route', 'show', 'table', TABLE_NAME];
        let routes = await ip.exec(args);
        routes = routes.parsed;

        let current_gateways = [];
        for (let route of routes) {
          if (route.dst != DESTINATION) {
            logger.warn(
              'removing imposeter route: %s from table %s',
              route.dst,
              TABLE_NAME
            );
            args = ['route', 'del', route.dst, 'table', TABLE_NAME];
            await ip.exec(args);
            continue;
          } else {
            if (route.gateway) {
              current_gateways.push(route.gateway);
            }
            if (route.nexthops) {
              for (let hop of route.nexthops) {
                if (hop.gateway) {
                  current_gateways.push(hop.gateway);
                }
              }
            }
          }
        }

        current_gateways = [...new Set(current_gateways)];
        let intersection = peers.filter(x => current_gateways.includes(x));

        if (
          intersection.length != peers.length ||
          current_gateways.length != peers.length
        ) {
          logger.info(
            'setting routing rule %s for table %s (%d) with peers %s',
            DESTINATION,
            TABLE_NAME,
            TABLE_WEIGHT,
            peers.join(', ')
          );
          args = ['route', 'replace', DESTINATION, 'table', TABLE_NAME];
          for (const peer of peers) {
            args.push('nexthop', 'via', peer, 'weight', PEER_WEIGHT);
          }
          await ip.exec(args);
        } else {
          // everything seems to be in order
        }
      } else {
        // remove the rule(s)
        logger.warn(
          'empty peers, removing all rules referencing routing table'
        );
        await ip.clearRulesByTable(TABLE_NAME);

        // delete rule from table
        logger.warn('empty peers, removing all entries from routing table');
        args = ['route', 'del', DESTINATION, 'table', TABLE_NAME];
        try {
          await ip.exec(args);
        } catch (e) {
          // 2 = rule already deleted from table
          if (e.code != 2) {
            throw e;
          }
        }
      }

      //////// step 3, manage routing rules instructing usage of the routing table as appropriate /////////

      let addresses = await getAddresses();
      let subnets = [];
      for (const address of addresses) {
        // sanity check cidr entries
        if (address.includes('/')) {
          try {
            let re = new RegExp(
              '^([0-9]{1,3}.){3}[0-9]{1,3}(/([0-9]|[1-2][0-9]|3[0-2]))?$'
            );
            if (!re.test(address)) {
              throw new Error(`invalid ip/cidr: %s`);
            }
            subnets.push(address);
          } catch (e) {
            logger.error('failed to parse address: %s', address);
          }
        }

        // convert ranges to applicable cidrs
        if (address.includes('-')) {
          let parts = address.split('-');
          try {
            let ipRange = new IpRange(
              IpAddress.of(parts[0]),
              IpAddress.of(parts[1])
            );
            let cidrs = ipRange.toCidrs();
            for (let cidr of cidrs) {
              subnets.push(`${cidr.prefix}/${cidr.prefixLen}`);
            }
          } catch (e) {
            logger.error('failed to parse address: %s', address);
          }
        }
      }

      // ensure unique values
      subnets = [...new Set(subnets)];

      let rules = await ip.exec(['rule', 'show', 'table', TABLE_NAME]);
      rules = rules.parsed;
      if (subnets.length > 0 && peers.length > 0) {
        // create a new routing rule for each relevant subnet
        for (const subnet of subnets) {
          const lookup = {};
          lookup.src = subnet.split('/')[0];
          lookup.srclen = subnet.split('/')[1];
          lookup.table = TABLE_NAME;

          let matches = await ip.getRulesByProperties(lookup, TABLE_NAME);

          if (matches.length == 0) {
            logger.info('creating routing rule for subnet: %s', subnet);
            args = ['rule', 'add', 'from', subnet, 'lookup', TABLE_NAME];
            await ip.exec(args);
          }

          if (matches.length == 1) {
            logger.verbose(
              'routing rule already exists for subnet: %s',
              subnet
            );
          }

          if (matches.length > 1) {
            // leave the lowest numbered match intact
            for (let i = matches.length - 1; i > 0; i--) {
              let rule = matches[i];
              if (rule.priority) {
                logger.warn('removing duplicate rule:', rule);
                await ip.deleteRuleByPriority(rule.priority);
              }
            }
          }
        }

        // remove any rules which do NOT match
        for (const rule of rules) {
          if (!rule.priority) {
            continue;
          }

          let match = false;
          for (const subnet of subnets) {
            const lookup = {};
            lookup.src = subnet.split('/')[0];
            lookup.srclen = subnet.split('/')[1];
            lookup.table = TABLE_NAME;

            // TODO: make this work with ipv6
            // fill in the missing srclen when it is /32
            let r_srclen = rule.srclen || 32;

            if (
              rule.src == lookup.src &&
              r_srclen == lookup.srclen &&
              rule.table == lookup.table
            ) {
              match = true;
              break;
            }
          }

          if (!match) {
            logger.warn(
              'removing imposter rule: %s (%s)',
              `${rule.src}/${rule.srclen || 32}`,
              rule.priority
            );
            await ip.deleteRuleByPriority(rule.priority);
          }
        }
      } else {
        // only clean if peers is > 0 because if 0 rules are already wiped with
        // earlier logic
        if (peers.length > 0) {
          // cleanup
          logger.warn(
            'empty subnets, removing all rules referencing routing table %s (%d)',
            TABLE_NAME,
            TABLE_WEIGHT
          );
          await ip.clearRulesByTable(TABLE_NAME);
        }
      }

      logger.verbose('reconcile finished');
    });
  } catch (e) {
    if (e === AsyncMutex.E_CANCELED) {
      logger.verbose('reconcile canceled');
    } else {
      logger.error('unexpected error', e);
    }
  }
}

function processMetalLBData(data) {
  let peers = [];
  let peer_data = _.get(data, 'peers', []);
  for (let peer of peer_data) {
    if (peer['peer-address']) {
      peers.push(peer['peer-address']);
    }
  }

  let addresses = [];
  let address_data = _.get(data, 'address-pools', []);
  for (let pool of address_data) {
    if (_.get(pool, 'protocol', '').toLowerCase() != 'bgp') {
      logger.verbose(
        'skipping pool %s due to non-bgp protocol %s',
        pool.name,
        pool.protocol
      );
      continue;
    }

    if (pool.addresses && pool.addresses.length > 0) {
      addresses.push(...pool.addresses);
    }
  }

  metallb_peers = peers;
  metallb_addresses = addresses;
  metallb_loaded = true;
}

async function setupMetalLBWatch() {
  if (METALLB_STATIC_FILE) {
    logger.info(`starting watch static file ${METALLB_STATIC_FILE}`);
    const staticFilePath = METALLB_STATIC_FILE;
    setInterval(function () {
      logger.verbose('refresh metallb addresses');
      let data = fs.readFileSync(staticFilePath, {
        encoding: 'utf8',
        flag: 'r'
      });
      data = yaml.load(data);
      processMetalLBData(data);
    }, METALLB_STATIC_FILE_WAIT);
  }

  if (!METALLB_STATIC_FILE) {
    // use env var if set
    let ns = METALLB_NAMESPACE;

    // if running in k8s determine using file
    if (!ns) {
      if (fs.existsSync(K8S_NAMESPACE_FILE)) {
        ns = fs.readFileSync(K8S_NAMESPACE_FILE, {
          encoding: 'utf8',
          flag: 'r'
        });
      }
    }

    // fallback to default ns
    if (!ns) {
      ns = 'metallb-system';
    }

    let cf = METALLB_CONFIGMAP_NAME;

    logger.info(`starting watch on k8s configmap ${ns}/${cf}`);

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const watch = new k8s.Watch(kc);
    watch.watch(
      `/api/v1/watch/namespaces/${ns}/configmaps/${cf}`,
      {},
      (type, apiObj, watchObj) => {
        switch (type) {
          case 'ADDED':
          case 'MODIFIED':
            logger.info('metallb configmap added/modified');
            let data = _.get(apiObj, 'data.config', '{}');
            data = yaml.load(data);
            processMetalLBData(data);
            reconcile();
            break;
          case 'DELETED':
            logger.warn('metallb configmap deleted from watch');
            processMetalLBData({});
            reconcile();
            break;
          case 'BOOKMARK':
            logger.verbose(
              `metallb confimap bookmarked: ${watchObj.metadata.resourceVersion}`
            );
            break;
          default:
            logger.error(
              'unknown operation on metallb configmap watch: %s',
              type
            );
            break;
        }
      },
      async e => {
        metallb_loaded = false;
        if (e) {
          logger.error('watch failure: %s', e);
          switch (e.code) {
            case 'ECONNREFUSED':
              process.exit(1);
          }
        } else {
          logger.info('watch timeout');
        }

        await sleep(5000);
        setupMetalLBWatch();
      }
    );
  }
}

// start the run loop
(async () => {
  // development
  await setupMetalLBWatch();

  if (MAX_RECONCILE_WAIT > 0) {
    let wait = MAX_RECONCILE_WAIT;
    if (wait < 1000) {
      wait = 1000;
    }

    setInterval(function () {
      logger.info('reconciling due to max wait');
      reconcile();
    }, wait);
  }

  // manually trigger the fist reconcile
  reconcile();
})().catch(e => {
  logger.error('uncaught error', e);
  process.exit(1);
});
