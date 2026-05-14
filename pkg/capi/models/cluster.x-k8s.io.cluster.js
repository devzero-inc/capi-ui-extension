import SteveModel from '@shell/plugins/steve/steve-class';

// Upstream capi-ui-extension hides the Edit action and forces every detail
// link to the raw YAML view. That made sense before the extension had a
// real form for cluster.x-k8s.io.cluster, but we maintain one
// (edit/cluster.x-k8s.io.cluster/index.vue) — so we let Rancher emit the
// normal goToEdit action and the normal detail link, which now both land on
// the form. Engineers can change TTL, owner, machine pool replicas, etc.
// without dropping into YAML.
export default class CapiCluster extends SteveModel {}
