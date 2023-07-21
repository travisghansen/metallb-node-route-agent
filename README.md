![Image](https://img.shields.io/docker/pulls/travisghansen/metallb-node-route-agent.svg)
![Image](https://img.shields.io/github/actions/workflow/status/travisghansen/metallb-node-route-agent/main.yml?branch=master&style=flat-square)

# metallb-node-route-agent

The purpose of this project is to create routes on the nodes to ensure outbound
`LoadBalancer` traffic uses the `metallb` bgp peers on the return path (ie:
avoid possible asymmetric routing scenarios).

To achieve this goal the agent creates/manages a specific routing table and
directs all traffic from relevant `LoadBalancer` IPs to route through the
configured `metallb` `peers`.

It is assumed this application will entirely manage the `TABLE_NAME` routing
table along with all rules referencing the table. In other words, any manually
created `rules` or `routes` in the table will be considered 'imposters' and
removed.

# configuration

The container should run in the `host` networking namespace. Additionally you
must mount `/etc/iproute2` from the host into the same location in the
container.

Additionally if you have multiple paths (bgp peers) you likely want to ensure
your nodes have the sysctl `net.ipv4.fib_multipath_use_neigh` set to `1`.

## env vars

- `MAX_RECONCILE_WAIT` - a timer is setup on this interval (ms) to reconcile
  - default: 60s
  - minimum value is 1s
  - `0` disables the feature
- `TABLE_WEIGHT` - weight of the routing table to manage
  - default: `20`
- `PEER_WEIGHT` - weight of each peer added to the routing table
  - default: 100
  - all peers have the same weight currently so not super helpful to modify
- `RULE_PRIORITY` - the priority to give to the managed rules
  - default: 20
- `RULE_FWMARK` - the fwmark to give to the managed rules (show be provided in
  hex format exactly as the `ip` output shows)
  - default: unset
- `DESTINATION` - the `dst` network of the route
  - default: `default`
- `PRE_RECONCILE_SCRIPT_PATH` - path to script (must be marked executable) to
  run _before_ the reonciliation happens
- `POST_RECONCILE_SCRIPT_PATH` - path to script (must be marked executable) to
  run _after_ the reonciliation happens
- `METALLB_NAMESPACE` - namespace where `metallb` is running
  - default: `""`
  - will fallback to the value in
    `/var/run/secrets/kubernetes.io/serviceaccount/namespace` if possible
  - will use `metallb-system` as a last resort
- `METALLB_CONFIGMAP_NAME` - name of the `metallb` `configmap`
  - default: `config`
- `METALLB_STATIC_FILE` - a static file on the filesystem to monitor (mostly
  for development purposes). If set the k8s watch is disabled entirely.
- `METALLB_USE_CRDS` - prefer `CRDs` over configmap
- `LOG_LEVEL` - `error|warn|info|verbose|debug|silly`
  - default: `info`
- `CLEANANDEXIT` - if equals `1` then all rules/tables will be deleted and the
  process will exit
- `ONESHOT` - if equals `1` then then reconciliation will complete once and the
  process will exit (useful as a cronjob for example)

# CNI

## cilium

This project 'just works' with cilium if using hte kube-proxy replacement feature.

## calico

If using with calico you must run `kube-proxy` in `ipvs` mode. In addition it
will likely require very special firewall rules to ensure proper traffic flows.

Without the rules etc below undesirable traffic flows will occur and
functionality will likely break. Namely Pod (both CNI and HostNetwork) traffic
may end up routing to BGP Peers instead of staying local to the cluster.

```
# 0x14 = 20 in decimal, you may use whatever value you wish however

# mark *connections* coming from the 'outside' world
iptables -t nat -I PREROUTING \
  -m set   --match-set KUBE-LOAD-BALANCER dst,dst \
  -m set ! --match-set cali40masq-ipam-pools src \
  -j CONNMARK --set-mark 0x14

# copy *connection* mark to *packet* mark *before* POSTROUTING/SNAT takes place
iptables -t mangle -I FORWARD -m connmark --mark 0x14 -j CONNMARK --restore-mark

# ensure proper env vars for metallb-nra
RULE_FWMARK=0x14
```

# development

```
sudo -E METALLB_STATIC_FILE=./examples/metallb-config.yaml MAX_RECONCILE_WAIT=5000 node agent.js

docker build --pull -t foobar .
docker run --rm -ti --net=host -v /etc/iproute2:/etc/iproute2 foobar bash

# create table
# test table exists
# exit 0   = exists
# exit 2   = exists, no entries
# exit 255 = not exists
ip route show table metallb-nra
echo 20 metallb-nra >> /etc/iproute2/rt_tables


# upsert routes to the table
# network parsing/calculation needed in this step
ip route replace default via 172.28.4.130 table metallb-nra

# note that linux does a hash-based/tuple algorithm
# https://serverfault.com/questions/696675/multipath-routing-in-post-3-6-kernels
# https://docs.kernel.org/networking/nexthop-group-resilient.html
ip route replace default table metallb-nra \
    nexthop via 172.28.4.130 weight 1 \
    nexthop via 172.28.4.131 weight 1

# add rule(s)
# test if the rule is already present? do not create duplicates
# ip rule show
ip rule add from 172.28.42.0/24 lookup metallb-nra
...

ip rule add from <service network> lookup metallb-nra
ip route add default via <frr ip> table metallb-nra


# review entries
ip -d rule show table metallb-nra
ip -d route show table metallb-nra

# remove rules
while ip rule delete from 0/0 to 0/0 table metallb-nra 2>/dev/null; do true; done


ip route flush cache
```

# TODO

- introduce a one-shot execution style to set/wipe state
- use `ip -batch` for operations?
- use `nexthop groups`?
- use a proper `netlink` library to manage the rules
  - https://github.com/vishvananda/netlink
  - https://github.com/hariguchi/iproute
  - https://www.npmjs.com/package/netlink
  - https://www.npmjs.com/package/node-netlink
  - https://github.com/k13-engineering/node-rtnetlink

# links

- https://serverfault.com/questions/696675/multipath-routing-in-post-3-6-kernels
- https://docs.kernel.org/networking/nexthop-group-resilient.html
- http://manpages.ubuntu.com/manpages/trusty/man8/ip-route.8.html
- https://manpages.ubuntu.com/manpages/trusty/man8/ip-rule.8.html
