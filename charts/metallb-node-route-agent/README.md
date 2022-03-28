# development

```
helm template --namespace metallb-system metallb-node-route-agent .
helm template --namespace metallb-system metallb-node-route-agent . | kubectl -n metallb-system apply  -f -
helm template --namespace metallb-system metallb-node-route-agent . | kubectl -n metallb-system delete -f -
```
