import SteveModel from '@shell/plugins/steve/steve-class';

// Upstream capi-ui-extension hides the Edit action and forces every detail
// link to the raw YAML view. That made sense before the extension had a
// real form for cluster.x-k8s.io.cluster, but we maintain one
// (edit/cluster.x-k8s.io.cluster/index.vue) — so we let Rancher emit the
// normal goToEdit action and the normal detail link, which now both land on
// the form. Engineers can change TTL, owner, machine pool replicas, etc.
// without dropping into YAML.
export default class CapiCluster extends SteveModel {
  // Cluster.spec.topology.class only exists on v1beta1 wire format. The
  // v1beta2 schema replaces it with spec.topology.classRef.name. Our API
  // server serves v1beta2, so dot-path "spec.topology.class" in the
  // column config resolves to undefined — engineers see a blank column.
  // This getter normalizes both versions so the column shows the class
  // name regardless of which contract the API happens to return.
  get clusterClassName() {
    return this.spec?.topology?.classRef?.name || this.spec?.topology?.class || '';
  }

  // Pick the "Available" condition's status (True/False/Unknown) for the
  // list view. Rancher's SortableTable column `value` only supports simple
  // dot paths or model getter names, not JMESPath, so we expose the value
  // as a property here.
  get availableCondition() {
    const c = (this.status?.conditions || []).find((x) => x.type === 'Available');

    return c?.status || '';
  }
}
