# v0.4.3

Released 2023-07-21

- use `exec` instead of `spawn`

# v0.4.2

Released 2023-07-21

- bump chart details

# v0.4.1

Released 2023-07-21

- add additional packages to container image
- support executing arbitrary pre/post scripts during reconcile (should be
  idempotent)
- bump docker base image to `hydrogen-bookworm-slim`

# v0.4.0

Released 2023-07-20

- remove management of `TABLE_NAME` in `/etc/iproute2/rt_tables`
- better management of watches to unsubscribe when appropriate
- more robust reconcile logic to prevent race conditions
- support `RULE_FWMARK`

# v0.3.2

Released 2023-07-12

- proer support for `nodeSelectors` in the CRDs (ie: limit upstream routes to
  only those applicable to the given node)
- update chart to support new rbac neccessary for node logic

# v0.3.1

Released 2023-02-10

- support crds in the chart

# v0.3.0

Released 2023-01-31

- `METALLB_USE_CRDS` to enable usage of CRDs
- various minor improvements

# v0.2.0

Released 2022-03-30

- `RULE_PRIORITY` env var
- more robust logic for rule deletion

# v0.1.0

Released 2022-03-28

- initial release
