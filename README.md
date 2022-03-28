# metallb-node-route-agent

The purpose of this project is to create routes on the nodes to ensure outbound
`LoadBalancer` traffic uses the `metallb` bgp peers on the return path (ie:
avoid possible asymmetric routing scenarios).

To achieve this goal the agent creates/manages a specific routing tables and
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

## env vars

- `MAX_RECONCILE_WAIT` - a timer is setup on this interval (ms) to reconcile
  - default: 60s
  - minimum value is 1s
  - `0` disables the feature
- `TABLE_NAME` - name of the routing table to manage
  - default: `metallb-nra`
- `TABLE_WEIGHT` - weight of the routing table to manage
  - default: `20`
- `PEER_WEIGHT` - weight of reach peer add the to routing table
  - default: 100
  - all peers have the same weight currently so not super helpful to modify
- `DESTINATION` - the `dst` network of the rule
  - default: `default`
- `METALLB_NAMESPACE` - namespace where `metallb` is running
  - default: `""`
  - will fallback to the value in
    `/var/run/secrets/kubernetes.io/serviceaccount/namespace` if possible
  - will use `metallb-system` as a last resort
- `METALLB_CONFIGMAP_NAME` - name of the `metallb` `configmap`
  - default: `config`
- `METALLB_STATIC_FILE` - a static file on the filesystem to monitor (mostly
  for development purposes). If set the k8s watch is disabled entirely.

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
