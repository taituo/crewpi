# platform-config

Desired state for the `demo-apps` namespace. Agents change it on `agent/*` branches;
a human approves before anything reaches the cluster.

- `demo-apps/checkout-config.json` — ConfigMap read by the checkout-api deployment
