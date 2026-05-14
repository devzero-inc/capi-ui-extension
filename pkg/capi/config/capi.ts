import { CAPI as RANCHER_CAPI } from '@shell/config/types';
import { CAPI as TURTLES_CAPI } from '../types/capi';
const CLUSTER_MGMT_PRODUCT = 'manager';

// Custom column set for the CAPI Cluster list. Rancher's default set leaks
// the full CAPI status (CP Desired/Current/Ready/Available/Up-to-date, then
// the same five fields for workers, plus Paused) which is mostly blank
// noise for managed-control-plane providers (EKS, GKE) where the entire
// control plane is one external thing — the columns just don't apply.
//
// We replace them with two things engineers actually need at a glance:
// TTL (when will this disappear?) and Owner (who do I bother about it?).
// Both come straight out of metadata.labels stamped by the create form.
const CAPI_CLUSTER_HEADERS = [
  {
    name:      'state',
    labelKey:  'tableHeaders.state',
    sort:      ['stateSort', 'nameSort'],
    value:     'stateDisplay',
    width:     100,
    default:   'unknown',
    formatter: 'BadgeStateFormatter'
  },
  {
    name:          'name',
    labelKey:      'tableHeaders.name',
    value:         'nameDisplay',
    sort:          ['nameSort'],
    formatter:     'LinkDetail',
    canBeVariable: true,
  },
  {
    name:     'clusterClass',
    label:    'ClusterClass',
    // Resolved via model getter so we cover both v1beta1
    // (spec.topology.class) and v1beta2 (spec.topology.classRef.name).
    value:    'clusterClassName',
    sort:     ['clusterClassName'],
  },
  {
    name:     'available',
    label:    'Available',
    // Resolved via model getter — Rancher's SortableTable doesn't support
    // JMESPath in `value`, only dot paths or model getter names.
    value:    'availableCondition',
    sort:     ['availableCondition'],
    width:    100,
  },
  {
    name:     'ttl',
    label:    'TTL',
    value:    'metadata.labels.ttl',
    sort:     ['metadata.labels.ttl'],
    width:    120,
  },
  {
    name:     'owner',
    label:    'Owner',
    value:    'metadata.labels.owner',
    sort:     ['metadata.labels.owner'],
  },
  {
    name:     'phase',
    label:    'Phase',
    value:    'status.phase',
    sort:     ['status.phase'],
    width:    130,
  },
  {
    name:     'version',
    label:    'Version',
    value:    'spec.topology.version',
    sort:     ['spec.topology.version'],
  },
  {
    name:      'age',
    labelKey:  'tableHeaders.age',
    value:     'metadata.creationTimestamp',
    sort:      'metadata.creationTimestamp:desc',
    search:    false,
    formatter: 'LiveDate',
    width:     75,
    align:     'right',
  },
];

export function init($plugin: any, store: any) {
  const {
    basicType,
    weightType,
    weightGroup,
    virtualType,
    configureType,
    headers,
  } = $plugin.DSL(store, CLUSTER_MGMT_PRODUCT);


  virtualType({
    label:       'CAPI Turtles',
    icon:        'gear',
    name:        'capi-dashboard',
    namespaced:  false,
    weight:      99,
    route:                  {
      name:   `c-cluster-${ CLUSTER_MGMT_PRODUCT }-capi`,
      params: { cluster: '_' }
    },
    overview: true,
    exact:    true,
  });

  configureType(RANCHER_CAPI.CAPI_CLUSTER, {showConfigView: false})
  headers(RANCHER_CAPI.CAPI_CLUSTER, CAPI_CLUSTER_HEADERS)

  // Interestingly, types can only appear in one place, so by adding machine deployment
  // and others here, they will no longer show up in the Advanced section, which is
  // quite nice for this use case
  basicType([
    'capi-dashboard',
    RANCHER_CAPI.CAPI_CLUSTER,
    TURTLES_CAPI.CLUSTER_CLASS,
    TURTLES_CAPI.PROVIDER,
    // keep this page hidden under 'advanced' still as it may fail to load in Rancher <=2.8.0, see https://github.com/rancher/dashboard/issues/9973
    // RANCHER_CAPI.MACHINE,
    RANCHER_CAPI.MACHINE_SET,
    RANCHER_CAPI.MACHINE_DEPLOYMENT,
  ], 'CAPITurtles');

  weightType(RANCHER_CAPI.CAPI_CLUSTER, 10, true);

  weightGroup('CAPITurtles', 10, true);
}
