<script>
import { set, clone } from '@shell/utils/object';
import { clear } from '@shell/utils/array';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import NameNsDescription from '@shell/components/form/NameNsDescription.vue';
import FormValidation from '@shell/mixins/form-validation';
import CruResource from '@shell/components/CruResource.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import CreateEditView from '@shell/mixins/create-edit-view';
import Labels from '@shell/components/form/Labels.vue';
import { _EDIT } from '@shell/config/query-params';
import { MANAGEMENT } from '@shell/config/types';
import ClusterClassVariables from '../../components/CCVariables/index.vue';
import { versionValidator, hostValidator, portValidator, cidrValidator } from '../../util/validators';
import Checkbox from '@components/Form/Checkbox/Checkbox.vue';
import CardGrid from '../../components/CardGrid.vue';
import WorkerItem from './WorkerItem.vue';
import NetworkSection from './NetworkSection.vue';
import ControlPlaneEndpointSection from './ControlPlaneEndpointSection.vue';
import ControlPlaneSection from './ControlPlaneSection.vue';
import { mapGetters } from 'vuex';
import { LABELS, CAPI, MANAGED_CONTROL_PLANE_KINDS } from '../../types/capi';
import Loading from '@shell/components/Loading.vue';
import { NAMESPACE, FLEET } from '@shell/config/types';
import Accordion from '@components/Accordion/Accordion.vue';
import merge from 'lodash/merge';

const defaultTopologyConfig = {
  version: '',
  class:   '',
  workers: { machineDeployments: [], machinePools: [] }
};

export const FORM_SECTIONS = {
  GENERAL:       'general',
  CONFIGURATION: 'configuration',
  CONTROL_PLANE: 'controlplane',
  NETWORKING:    'networking',
  WORKERS:       'workers',
  LABELS:        'labels'
};

// Mapping of nodeType / machineType variable values to the canonical
// instance/machine type that the ClusterClass patches resolve to. The
// spot-placement-scores ConfigMap is keyed by these canonical names, so
// the UI panel needs the same mapping to look up scores. Keep in sync
// with the patch templates in cluster-templates-aws-eks.tf and
// cluster-templates-gcp.tf — when an enum entry changes there, the
// matching key here has to move too.
const NODE_TYPE_TO_INSTANCE = {
  // AWS EKS — nodeType variable
  'graviton2 (ARM64, $60/mo)':       'm6g.large',
  'graviton3 (ARM64, $60/mo)':       'm7g.large',
  'graviton4 (ARM64, $70/mo)':       'm8g.large',
  'icelake (AMD64, $70/mo)':         'm6i.large',
  'sapphire-rapids (AMD64, $80/mo)': 'm7i.large',
  'granite-rapids (AMD64, $80/mo)':  'm8i.large',
  'epyc (AMD64, $80/mo)':            'm7a.large',
  't4 (1× T4, $390/mo)':             'g4dn.xlarge',
  'v100 (1× V100, $2.3k/mo)':        'p3.2xlarge',
  'l4 (1× L4, $600/mo)':             'g6.xlarge',
  'l40s (1× L40S, $1.4k/mo)':        'g6e.xlarge',
  'a10g (1× A10G, $800/mo)':         'g5.xlarge',
  'a100 (8× A100 40GB, $24k/mo)':    'p4d.24xlarge',
  'a100-80 (8× A100 80GB, $30k/mo)': 'p4de.24xlarge',
  'h100 (8× H100, $72k/mo)':         'p5.48xlarge',
};

export default {
  name:       'ClusterConfig',
  components: {
    CruResource,
    NameNsDescription,
    LabeledInput,
    WorkerItem,
    NetworkSection,
    ControlPlaneEndpointSection,
    ClusterClassVariables,
    CardGrid,
    Labels,
    ControlPlaneSection,
    Checkbox,
    Loading,
    LabeledSelect,
    Accordion
  },
  mixins: [CreateEditView, FormValidation],
  emits:  ['update:value'],
  props:  {
    mode: {
      type:     String,
      required: true,
    },
    value: {
      type:     Object,
      required: true,
    },
    preselectedClass: {
      type:     String,
      required: false,
      default:  ''
    },
    clusterClasses: {
      type:     Array,
      required: true
    }
  },

  beforeMount() {
    // Spot scores are independent of initSpecs — fire and forget; the panel
    // hides itself while spotScoreData is null and pops in once the cache
    // resolves. No need to delay the form on the ConfigMap fetch.
    this.loadSpotScores();

    // Look up the v3 User CR for the logged-in principal so we can store a
    // human-readable display name in the `owner` label rather than the raw
    // OAuth subject ID (e.g. "Radostin Stoyanov" instead of
    // "googleoauth_user-101475580257776198815"). Result is awaited before
    // initSpecs so the owner default falls through to the display name.
    this.loadCurrentUser().finally(() => {
      this.initSpecs().then(() => {
      }).catch((err) => {
        this.errors.push(err);
        this.loading = false;
      });
    });

    this.$store.dispatch('management/request', { url: '/v1-k3s-release/releases' }).then((res) => {
      this.k3sVersions = res;
    });

    this.$store.dispatch('management/request', { url: '/v1-rke2-release/releases' }).then((res) => {
      this.rke2Versions = res;
    });
    this.$nextTick(() => {
      this.loading = false;
    });
  },

  data() {
    const store = this.$store;
    const t = store.getters['i18n/t'];
    const stepClusterClass = {
      name:           'stepClusterClass',
      title:          t('capi.cluster.steps.clusterClass.title'),
      label:          t('capi.cluster.steps.clusterClass.label'),
      subtext:        '',
      descriptionKey: 'capi.cluster.steps.clusterClass.description',
      ready:          false,
      weight:         30
    };
    const stepConfiguration = {
      name:           'stepConfiguration',
      title:          t('capi.cluster.steps.configuration.title'),
      label:          t('capi.cluster.steps.configuration.label'),
      subtext:        '',
      descriptionKey: 'capi.cluster.steps.configuration.description',
      ready:          false,
      weight:         30
    };
    const addSteps = !!this.preselectedClass ? [stepConfiguration] : [stepClusterClass, stepConfiguration];

    return {
      addSteps,
      // Display name from the v3 User CR matching the logged-in principal.
      // Populated by loadCurrentUser before initSpecs runs so the owner
      // label gets a human name, not the raw OAuth subject id.
      currentUserDisplayName: null,
      // { region, updatedAt, scores: { "g4dn.xlarge": 1, "m7g.large": 3, ... } }
      // Populated by loadSpotScores from the capi-ttl-sweeper/spot-placement-scores
      // ConfigMap maintained by the spot-score-cache CronJob in the mgmt cluster.
      // null until the fetch resolves; UI treats null as "no data, hide panel".
      spotScoreData: null,
      fvFormRuleSets: [
        { path: 'metadata.name', rules: ['required'] },
        { path: 'spec.topology.version', rules: ['required', 'version'] },
        { path: 'spec.topology.controlPlane.replicas', rules: ['number'] },
        { path: 'spec.controlPlaneEndpoint.host', rules: ['host'] },
        { path: 'spec.controlPlaneEndpoint.port', rules: ['port'] },
        { path: 'spec.clusterNetwork.serviceDomain', rules: ['host'] },
        { path: 'spec.clusterNetwork.apiServerPort', rules: ['port'] },
        { path: 'spec.clusterNetwork.pods.cidrBlocks', rules: ['cidr'] },
        { path: 'spec.clusterNetwork.services.cidrBlocks', rules: ['cidr'] }
      ],
      credentialId:              '',
      credential:                null,
      versionInfo:               {},
      variableSectionReady: {
        general:       true,
        configuration: true,
        controlPlane:  true,
        networking:    true,
        misc:          true,
        workers:       true
      },
      clusterClassObj:           null,
      loading:                   true,
      k3sVersions:               [],
      rke2Versions:              [],
      autoImport:                !!this.value?.metadata?.labels && !!this.value?.metadata?.labels[LABELS.AUTO_IMPORT],
      classNamespaceSupported:   false,
      allNamespaces:             [],
      configHighlightOpen:       true,
      controlPlaneHighlightOpen:  true,
      networkingHighlightOpen:   true,
    };
  },

  watch: {
    clusterClassObj(neu) {
      const step = this.addSteps.find((s) => s.name === 'stepClusterClass');

      if (step) {
        step.ready = !!neu;
      }
    },

    stepConfigurationRequires: {
      // immediate so the initial true value in edit mode propagates to
      // step.ready without waiting for a change. Vue watchers don't fire on
      // initial render by default, so step.ready was stuck at its data()
      // default (false) and CruResource left the Save button disabled even
      // though stepConfigurationRequires returned true.
      immediate: true,
      handler(neu) {
        const step = this.addSteps.find((s) => s.name === 'stepConfiguration');

        if (step) {
          step.ready = !!neu;
        }
      }
    },
  },

  computed: {
    ...mapGetters({ t: 'i18n/t', schemaFor: 'management/schemaFor' }),
    fvExtraRules() {
      return {
        version:   versionValidator(this.t, this.clusterClassControlPlane),
        host:      hostValidator(this.t),
        port:      portValidator(this.t),
        cidr:      cidrValidator(this.t)
      };
    },

    formSections() {
      return FORM_SECTIONS;
    },

    machineDeploymentsValid() {
      if (this.value?.spec?.topology?.workers?.machineDeployments && this.value?.spec?.topology?.workers?.machineDeployments.length > 0) {
        for (const deployment of this.value?.spec?.topology?.workers?.machineDeployments) {
          if (!deployment.name || !deployment.class || Number.isNaN(deployment.replicas)) {
            return false;
          }
        }
      }

      return true;
    },

    machinePoolsValid() {
      if (this.value?.spec?.topology?.workers?.machinePools && this.value?.spec?.topology?.workers?.machinePools.length > 0) {
        for (const pool of this.value?.spec?.topology?.workers?.machinePools) {
          if (!pool.name || !pool.class || Number.isNaN(pool.replicas)) {
            return false;
          }
        }
      }

      return true;
    },

    variablesValid() {
      return !Object.values(this.variableSectionReady).includes(false);
    },

    stepConfigurationRequires() {
      // In edit mode the cluster already passed CAPI's admission webhook,
      // so re-running the client-side gate is mostly punishment — it trips
      // when an enum value got renamed in the ClusterClass after the
      // cluster was created, when a locked-in-view-mode field reports
      // validation-passed=false, or just when CCVariables hasn't finished
      // its first validation pass on mount. The save call itself still
      // goes through the webhook, and saveOverride now correctly re-enables
      // the button on error, so engineers retain a real failure path.
      if (this.clusterIsAlreadyCreated) {
        return true;
      }

      const workersValid = ((this.value?.spec?.topology?.workers?.machinePools && this.value?.spec?.topology?.workers?.machinePools.length > 0) ||
         (this.value?.spec?.topology?.workers?.machineDeployments && this.value?.spec?.topology?.workers?.machineDeployments.length > 0)) &&
         this.machineDeploymentsValid && this.machinePoolsValid;

      return this.fvFormIsValid && workersValid && this.variablesValid ;
    },
    clusterIsAlreadyCreated() {
      return this.mode === _EDIT;
    },

    // List of rows for the Spot Capacity panel — one row per worker pool /
    // deployment. Each row pairs the pool's effective nodeType pick with the
    // canonical instance type and the latest spot-placement score from the
    // ConfigMap. Returns [] when scores aren't loaded yet or aren't relevant
    // (e.g. all pools picked CPU types we don't have scores for); the
    // template gates the panel on length > 0.
    //
    // Score buckets follow AWS's documented Spot Placement Score
    // scale (1-10, higher is better):
    //   8-10 → green ("strong")
    //   4-7  → yellow ("moderate")
    //   1-3  → red ("tight, expect spot-pending delays")
    //   missing → grey, with the message "no data" (cron hasn't run yet or
    //             AWS returned no score, often the case for SKUs being
    //             phased out like p3.2xlarge / V100)
    spotCapacityRows() {
      const scores = this.spotScoreData?.scores;

      if (!scores) {
        return [];
      }
      const globalNodeType = (this.value?.spec?.topology?.variables || []).find((v) => v.name === 'nodeType' || v.name === 'machineType');
      const allPools = [
        ...(this.value?.spec?.topology?.workers?.machinePools || []),
        ...(this.value?.spec?.topology?.workers?.machineDeployments || []),
      ];

      return allPools.map((pool) => {
        const override = (pool.variables?.overrides || []).find((o) => o.name === 'nodeType' || o.name === 'machineType');
        const nodeType = override?.value || globalNodeType?.value || '';
        const instance = NODE_TYPE_TO_INSTANCE[nodeType] || (nodeType.split(' ')[0]);
        const score = scores[instance];
        let color = 'grey';
        let label = 'no data';

        if (typeof score === 'number') {
          if (score >= 8) {
            color = 'green';
            label = 'strong';
          } else if (score >= 4) {
            color = 'yellow';
            label = 'moderate';
          } else {
            color = 'red';
            label = 'tight';
          }
        }

        return {
          name:    pool.name || pool.class,
          nodeType,
          instance,
          score:   typeof score === 'number' ? score : null,
          color,
          label,
        };
      });
    },

    spotCapacityUpdatedAt() {
      return this.spotScoreData?.updatedAt;
    },

    // Mode shim for fields that are immutable after cluster creation per
    // CAPI semantics (or just don't make sense to change post-create):
    // clusterClass, name, namespace, region, k8s version. Forces `view`
    // mode in edit so the input renders disabled instead of pretending to
    // accept a value the API will reject. NameNsDescription handles name
    // and namespace internally — we use this for everything else.
    immutableFieldMode() {
      return this.clusterIsAlreadyCreated ? 'view' : this.mode;
    },

    controlPlane: {
      get() {
        return this.value?.spec?.topology?.controlPlane || {};
      },
      set(neu) {
        if (neu) {
          this.value.spec.topology.controlPlane = { replicas: parseInt(neu) };
        } else {
          delete this.value.spec.topology.controlPlane;
        }
      }
    },

    controlPlaneEndpoint: {
      get() {
        return this.value?.spec?.controlPlaneEndpoint || {};
      },
      set(neu) {
        if (!neu) {
          delete this.value.spec.controlPlaneEndpoint;
        } else {
          this.value.spec.controlPlaneEndpoint = neu;
        }
      }
    },

    network: {
      get() {
        return this.value?.spec?.clusterNetwork || {};
      },
      set(neu) {
        if (!neu) {
          delete this.value.spec.clusterNetwork;
        } else {
          this.value.spec.clusterNetwork = neu;
        }
      }
    },

    topology() {
      return this.value?.spec?.topology;
    },

    machineDeployments: {
      get() {
        return this.value?.spec?.topology?.workers?.machineDeployments || [];
      },
      set(neu) {
        if (!this.value?.spec?.topology?.workers?.machineDeployments) {
          this.value.spec.topology = merge(defaultTopologyConfig, this.value.spec.topology);
        }
        this.value.spec.topology.workers.machineDeployments = neu;
      }
    },

    machinePools: {
      get() {
        return this.value?.spec?.topology?.workers?.machinePools || [];
      },
      set(neu) {
        if (!this.value?.spec?.topology?.workers?.machinePools) {
          this.value.spec.topology = merge(defaultTopologyConfig, this.value.spec.topology );
        }
        this.value.spec.topology.workers.machinePools = neu;
      }
    },

    variables: {
      get() {
        return this?.value?.spec?.topology?.variables || [];
      },
      set(neu) {
        if (!this.value.spec.topology) {
          this.value.spec.topology = {};
        }
        this.value.spec.topology.variables = neu;
      }
    },

    machineDeploymentOptions() {
      return this.clusterClassObj?.spec?.workers?.machineDeployments?.map((w) => w.class);
    },

    machinePoolOptions() {
      return this.clusterClassObj?.spec?.workers?.machinePools?.map((w) => w.class);
    },
    clusterClassControlPlane() {
      // CAPI v1beta2 renamed `controlPlane.ref` to `controlPlane.templateRef`;
      // fall back to the new field so detection keeps working on CAPI v1beta2+
      // ClusterClasses (which is what current Rancher Turtles installs surface).
      return this.clusterClassObj?.spec?.controlPlane?.ref?.kind
        ?? this.clusterClassObj?.spec?.controlPlane?.templateRef?.kind;
    },

    clusterClassOptions() {
      const out = [];
      const currentObject = this.clusterClassObj;

      this.clusterClasses.forEach((obj) => {
        addType(obj);
      });

      return out;

      function addType(obj) {
        const id = obj?.id;
        const subtype = {
          id,
          obj,
          selected: currentObject === obj
        };

        out.push(subtype);
      }
    },

    canCreateGitRepos() {
      const gitRepoSchema = this.$store.getters[`management/schemaFor`](FLEET.GIT_REPO);

      return gitRepoSchema && gitRepoSchema?.collectionMethods.find((x) => x.toLowerCase() === 'post') ;
    },

    isk3s() {
      return this.clusterClassControlPlane === CAPI.K3S_CP;
    },

    isRke2() {
      return this.clusterClassControlPlane === CAPI.RKE2_CP;
    },

    // For managed-control-plane infra (EKS / AKS / GKE / OKE) the cloud
    // provider sets controlPlaneEndpoint, replicas, and the cluster
    // network — exposing those form fields just confuses engineers.
    isManagedControlPlane() {
      return MANAGED_CONTROL_PLANE_KINDS.includes(this.clusterClassControlPlane);
    },

    // TTL drives the capi-ttl-sweeper CronJob. Stored as the `ttl` cluster
    // label. Accepts either a number of days (stored as "<n>d") or the
    // special sentinel "do-not-delete" to exempt the cluster from sweeping.
    // Returns the display value: a plain number for "<n>d" labels, or the
    // raw string for "do-not-delete".
    ttlDays() {
      const raw = this.value?.metadata?.labels?.ttl;

      if (raw === 'do-not-delete') {
        return 'do-not-delete';
      }
      // Accept any well-formed Go-style duration ("7d", "8h", "1h30m",
      // "2d4h", "90s"). The sweeper sums all <number><unit> segments,
      // so we just pass the raw label through to the input as-is.
      if (typeof raw === 'string' && /^(\d+[dhms])+$/.test(raw)) {
        return raw;
      }

      return '7d';
    },

    // Default owner label value, sourced from the logged-in user. Cluster
    // labels accept [a-z0-9_.-], so emails / display names work after we
    // sanitize anything weirder (e.g. github_user://12345 -> github_user_12345).
    //
    // For Google OAuth users the principal object only carries the raw
    // subject ID — Rancher's User CR is the only place the human display
    // name lives. loadCurrentUser populates currentUserDisplayName before
    // initSpecs runs so this falls through to it.
    ownerLabelDefault() {
      const principal = this.$store.getters['auth/principal'];
      const candidate =
        principal?.loginName ||
        this.currentUserDisplayName ||
        principal?.name ||
        principal?.id ||
        this.$store.getters['auth/principalId'] ||
        'unknown';

      return String(candidate).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    },

    // if k3s or rke2 use release channel endpoint to get a list of version choices
    // if this property is [] show a plain text input for cp version
    versionOptions() {
      if (this.isk3s) {
        return (this.k3sVersions?.data || []).map((d) => d.version).reverse();
      }

      if (this.isRke2) {
        return (this.rke2Versions?.data || []).map((d) => d.version).reverse();
      }

      // For everything else (managed CP / kubeadm / etc.) admins opt into a
      // dropdown by adding turtles-capi.cattle.io/version-options to the
      // ClusterClass with a comma-separated list of allowed versions.
      const annotated = this.clusterClassObj?.metadata?.annotations?.['turtles-capi.cattle.io/version-options'];

      if (annotated) {
        return annotated.split(',').map((s) => s.trim()).filter(Boolean);
      }

      return [];
    },

    defaultDeploymentAddValue() {
      let cclass = '';

      if (this.machineDeploymentOptions && this.machineDeploymentOptions.length === 1 ) {
        cclass = this.machineDeploymentOptions[0];
      }

      return {
        name:      '',
        class:     cclass,
        variables: { overrides: [] }
      };
    },

    defaultPoolAddValue() {
      let cclass = '';

      if (this.machinePoolOptions && this.machinePoolOptions.length === 1 ) {
        cclass = this.machinePoolOptions[0];
      }

      return {
        name:      '',
        class:     cclass,
        variables: { overrides: [] }
      };
    },
  },

  methods: {
    set,

    // Fetch the spot-placement-scores ConfigMap and parse its scores.json
    // payload. The CronJob in capi-ttl-sweeper writes one entry per
    // instance type. Missing keys mean no spot capacity data is available
    // for that type (e.g. p3.2xlarge / V100 has been returning empty in
    // us-west-2 — AWS effectively has no spot to offer there).
    //
    // Permission-denied (e.g. a downstream cluster's Rancher proxy stripping
    // mgmt-cluster access) is fine: leave spotScoreData null and the panel
    // simply doesn't render.
    async loadSpotScores() {
      try {
        const cm = await this.$store.dispatch('management/find', {
          type: 'configmap',
          id:   'capi-ttl-sweeper/spot-placement-scores',
        });
        const raw = cm?.data?.['scores.json'];

        if (!raw) {
          return;
        }
        this.spotScoreData = JSON.parse(raw);
      } catch (e) {
        // No access, no ConfigMap, malformed JSON — quietly skip the panel.
      }
    },

    // Resolve the v3 User CR matching the logged-in principal so we can
    // surface displayName as the default owner label. Rancher's auth
    // principal carries only the OAuth subject id for some providers
    // (Google), so without this lookup the owner label ends up looking
    // like "googleoauth_user-101475...". User principalIds use "://" as
    // the type/subject separator while auth/principalId uses "-" — try
    // both shapes when matching. Permission-denied (non-admin viewers)
    // is fine; we just leave currentUserDisplayName null and fall
    // through to the principal id.
    async loadCurrentUser() {
      const principalId = this.$store.getters['auth/principalId'];

      if (!principalId) {
        return;
      }
      // "googleoauth_user-101..." → "googleoauth_user://101..."
      const colonForm = principalId.replace(/_(user|group)-/, '_$1://');

      try {
        const users = await this.$store.dispatch('management/findAll', { type: MANAGEMENT.USER });
        const me = users.find((u) => {
          const ids = u.principalIds || [];

          return ids.includes(principalId) || ids.includes(colonForm);
        });

        if (me?.displayName) {
          this.currentUserDisplayName = me.displayName;
        }
      } catch (e) {
        // Non-admin users can't list management.cattle.io.user; that's fine.
      }
    },

    setClassInfo(name) {
      this.clusterClassObj = this.clusterClasses.find((x) => {
        const split = unescape(name).split('/');

        return x.metadata.namespace === split[0] && x.metadata.name === split[1];
      }) || null;
      if (!!this.clusterClassObj) {
        this.setClass();
        this.setClassNamespace();
      } else {
        this.errors.push(this.t('error.clusterClassNotFound'));
      }
    },

    async setClass({ resetTopology = false } = {}) {
      const clusterClassName = this.clusterClassObj?.metadata?.name;

      // Only blow away the existing topology when the user explicitly picks a
      // different class in the create-mode picker. Calling initSpecs(true)
      // unconditionally — as the previous code did when topology.class was
      // truthy — wiped variables, version, workers and labels on every edit
      // mount, because edit-mode clusters always already have a class set.
      const currentClass = this.topology.classRef?.name || this.topology.class;
      const switchingClass = currentClass && currentClass !== clusterClassName;

      if (resetTopology || switchingClass) {
        await this.initSpecs(true);
      }

      // CAPI v1beta2 replaced spec.topology.class (string) with
      // spec.topology.classRef.name. Set both: the new field is what the
      // admission webhook validates; the legacy field is harmless and keeps
      // any v1beta1-only consumer working.
      this.$emit('update:value', { k: 'spec.topology.class', val: clusterClassName });
      this.$emit('update:value', { k: 'spec.topology.classRef', val: { name: clusterClassName } });
    },

    setClassNamespace() {
      const clusterClassNs = this.clusterClassObj?.metadata?.namespace;

      this.$emit('update:value', { k: 'metadata.namespace', val: clusterClassNs });
      if (this.classNamespaceSupported) {
        this.value.spec.topology.classNamespace = clusterClassNs;
        // v1beta2 nests namespace inside classRef as well.
        if (this.value.spec.topology.classRef) {
          this.value.spec.topology.classRef.namespace = clusterClassNs;
        }
      }
    },

    setVariables(vars, names) {
      const removed = (this.value?.spec?.topology?.variables || []).filter((v) => !names.includes(v.name));

      this.value.spec.topology.variables = removed;

      this.value.spec.topology.variables.push(...vars);
    },

    async saveOverride(buttonDone) {
      if (this.errors) {
        clear(this.errors);
      }

      // CAPI v1beta2 enforces minItems=1 on machineDeployments and
      // machinePools when present, so empty default arrays we initialize
      // the topology with would fail admission. Strip them before save.
      const workers = this.value?.spec?.topology?.workers;

      if (workers) {
        if (Array.isArray(workers.machineDeployments) && workers.machineDeployments.length === 0) {
          delete workers.machineDeployments;
        }
        if (Array.isArray(workers.machinePools) && workers.machinePools.length === 0) {
          delete workers.machinePools;
        }
        if (Object.keys(workers).length === 0) {
          delete this.value.spec.topology.workers;
        }
      }

      // CruResource hands us a callback so the Save button can re-enable
      // itself. We must call it on both branches — without buttonDone(false)
      // on the error path the button stays disabled + spinning forever and
      // the user has to leave the form to retry. The optional chain keeps
      // the handler defensive in case the prop is ever wired differently.
      try {
        await this.value.save();
        buttonDone?.(true);

        return this.done();
      } catch (err) {
        this.errors.push(err);
        buttonDone?.(false);
      }
    },

    async initSpecs(reset = false) {
      const inStore = this.$store.getters['currentStore'](NAMESPACE);
      const val = this.value;
      let namespaces = [];

      if ( !val || reset ) {
        set(val, 'spec', { });
        set(val, 'metadata', { labels: {}, annotations: {} });
      }
      if (!val.spec.topology || reset) {
        set(val.spec, 'topology', clone(defaultTopologyConfig));
      }
      // Always Rancher-auto-import CAPI clusters created from the form so
      // engineers don't have to think about a checkbox or remember the label.
      // Default TTL to 7 days; engineers can override in the General form
      // input. Owner is required by the cluster-owner-ttl Kyverno policy
      // and gets auto-filled from the logged-in user's email/principal id
      // so engineers don't have to type their own email every time.
      if (!val.metadata.labels) {
        val.metadata.labels = {};
      }
      val.metadata.labels[LABELS.AUTO_IMPORT] = 'true';
      if (!val.metadata.labels.ttl) {
        val.metadata.labels.ttl = '7d';
      }
      if (!val.metadata.labels.owner) {
        val.metadata.labels.owner = this.ownerLabelDefault;
      }
      this.$emit('update:value', { k: 'spec', val: val.spec });

      if (!reset) {
        if (this.preselectedClass) {
          this.setClassInfo(this.preselectedClass);
        }

        const schema = this.$store.getters[`management/schemaFor`](
          CAPI.CLUSTER
        );

        await schema.fetchResourceFields();
        if ( schema.schemaDefinitions?.[`${ schema.schemaDefinition.type }.spec.topology`]?.resourceFields?.classNamespace ) {
          this.classNamespaceSupported = true;
          namespaces = await this.$store.dispatch(`${ inStore }/findAll`, { type: NAMESPACE });
        }

        this.allNamespaces = namespaces || [];
      }
    },

    cancelCredential() {
      if (this.$refs.cruresource) {
        this.$refs.cruresource.emitOrRoute();
      }
    },

    cancel() {
      this.$router.push({
        name:   'c-cluster-manager-capi',
        params: {},
      });
    },

    done() {
      this.$router.push({
        name:   'c-cluster-manager-capi',
        params: {},
      });
    },

    clickedType(obj) {
      this.clusterClassObj = this.clusterClasses.find((x) => x.id === obj.id) || null;
      // User actively clicked a class in the create-mode picker — reset any
      // half-filled topology state. setClassInfo callers from initSpecs
      // don't pass resetTopology, so edit-mode mount preserves existing
      // variables / workers / version.
      this.setClass({ resetTopology: true });
      this.setClassNamespace();
    },
    enableAutoImport(val) {
      if (val) {
        this.value.metadata.labels['cluster-api.cattle.io/rancher-auto-import'] = 'true';
      } else {
        delete this.value.metadata.labels['cluster-api.cattle.io/rancher-auto-import'];
      }
    },

    setTtlDays(val) {
      if (!this.value.metadata.labels) {
        this.value.metadata.labels = {};
      }
      const trimmed = String(val).trim().toLowerCase();

      if (trimmed === 'do-not-delete') {
        this.value.metadata.labels.ttl = 'do-not-delete';

        return;
      }
      // Accept Go-style compound durations: "7d", "8h", "1h30m", "2d4h30m",
      // "90s". One or more <number><unit> segments where unit is d/h/m/s.
      // Sweeper sums them. Bare numbers like "7" are interpreted as days
      // for backward compatibility with the old days-only input.
      if (/^(\d+[dhms])+$/.test(trimmed)) {
        this.value.metadata.labels.ttl = trimmed;

        return;
      }
      const n = parseInt(trimmed, 10);

      if (Number.isFinite(n) && n > 0 && String(n) === trimmed) {
        this.value.metadata.labels.ttl = `${ n }d`;

        return;
      }
      // Invalid input — leave the label alone rather than wiping it. The
      // input retains the user's text so they can fix it. Sweeper's default
      // (7d) applies if the label ends up unset on save.
    },

    openRepoModal() {
      this.$store.dispatch('management/promptModal', { component: 'AddExampleRepoDialog', modalWidth: '800px' });
    }
  }
};
</script>
<template>
  <Loading v-if="loading" />

  <CruResource
    v-else
    :mode="mode"
    :show-as-form="true"
    :resource="value"
    :errors="errors"
    :validation-passed="true"
    :cancel-event="true"
    :done-route="doneRoute"
    :apply-hooks="applyHooks"
    :steps="addSteps"
    component-testid="capi-cluster-create"
    @done="done"
    @error="e => errors = e"
    @finish="saveOverride"
    @cancel="cancel"
  >
    <template #stepClusterClass>
      <CardGrid
        :rows="clusterClassOptions"
        key-field="id"
        name-field="label"
        side-label-field="tag"
        @clicked="clickedType"
      >
        <template #no-rows>
          <div v-if="canCreateGitRepos">
            <t
              raw
              k="capi.exampleClasses.noClass"
            />
            <div class="mt-20">
              <button
                type="button"
                class="btn role-secondary"
                @click="openRepoModal"
              >
                <t
                  k="capi.exampleClasses.addExamples"
                />
              </button>
            </div>
          </div>
        </template>
      </CardGrid>
    </template>
    <template #stepConfiguration>
      <!-- Keying the wrapper on the class name forces a teardown when the
           user picks a different class in the create-mode picker. For
           v1beta2 clusters topology.class is undefined (the class lives at
           classRef.name) so without a fallback the key flips from undefined
           → string mid-mount when setClass emits its initial update, which
           tears down NameNsDescription / the version field / TTL on every
           edit-mode mount. Fall back to classRef.name so the key is stable
           from first render. -->
      <div :key="topology.classRef?.name || topology.class || 'no-class'">
        <Accordion
          class="mt-20 section-accordion"
          open-initially
          :title="t(`capi.cluster.section.${formSections.GENERAL}`)"
        >
          <!-- GENERAL CONFIGURATION -->
          <NameNsDescription
            v-if="!isView"
            :value="value"
            :mode="mode"
            :namespaced="classNamespaceSupported"
            :namespace-options="allNamespaces"
            name-label="cluster.name.label"
            name-placeholder="cluster.name.placeholder"
            description-label="cluster.description.label"
            description-placeholder="cluster.description.placeholder"
            :rules="{ name: fvGetAndReportPathRules('metadata.name') }"
            @update:value="$emit('update:value', { k: 'metadata', val: $event.metadata })"
          />
          <div class="row mb-20">
            <div class="col col-half mt-20">
              <LabeledSelect
                v-if="versionOptions.length"
                :mode="immutableFieldMode"
                :value="value.spec.topology.version"
                label-key="cluster.kubernetesVersion.label"
                required
                searchable
                taggable
                :rules="fvGetAndReportPathRules('spec.topology.version')"
                :options="versionOptions"
                @selecting="$emit('update:value', {k: 'spec.topology.version', val: $event})"
              />
              <LabeledInput
                v-else
                v-model:value="value.spec.topology.version"
                :mode="immutableFieldMode"
                label-key="cluster.kubernetesVersion.label"
                required
                :rules="fvGetAndReportPathRules('spec.topology.version')"
                @update:value="$emit('update:value', { k: 'spec.topology.version', val: $event })"
              />
            </div>
          </div>
          <div class="row mb-20">
            <div class="col col-half mt-20">
              <LabeledInput
                :value="ttlDays"
                :mode="mode"
                label="TTL"
                placeholder="e.g. 7d, 8h, 1h30m, or do-not-delete"
                tooltip="Time until auto-deletion, Go-style duration: 7d, 8h, 30m, 90s, or compound like 1h30m / 2d4h. Use 'do-not-delete' to exempt this cluster from the TTL sweeper. Stored as the 'ttl' label; you can edit it later from this same form to extend."
                @update:value="setTtlDays"
              />
            </div>
          </div>
          <ClusterClassVariables
            :will-open="configHighlightOpen"
            :value="variables"
            :section="formSections.GENERAL"
            :cluster-class="clusterClassObj"
            :cluster-namespace="value.metadata?.namespace"

            @update-variables="setVariables"
            @validation-passed="e => variableSectionReady.general = e"
          />
        </Accordion>

        <Accordion
          class="mt-20 section-accordion"
          open-initially
          :title="t(`capi.cluster.section.${formSections.CONFIGURATION}`)"
        >
          <ClusterClassVariables
            :value="variables"
            :mode="immutableFieldMode"
            :section="formSections.CONFIGURATION"
            :cluster-class="clusterClassObj"
            :cluster-namespace="value.metadata?.namespace"

            @update-variables="setVariables"
            @validation-passed="e => variableSectionReady.configuration = e"
          />
        </Accordion>

        <Accordion
          v-if="!isManagedControlPlane"
          class="mt-20 section-accordion"
          open-initially
          :title="t(`capi.cluster.section.${formSections.CONTROL_PLANE}`)"
        >
          <!-- CONTROL PLANE CONFIGURATION -->
          <div class="row row-config">
            <div class="col col-half">
              <ControlPlaneEndpointSection
                v-model:value="controlPlaneEndpoint"
                :mode="mode"
                :rules="{ host: fvGetAndReportPathRules('spec.controlPlaneEndpoint.host'), port: fvGetAndReportPathRules('spec.controlPlaneEndpoint.port') }"
              />
            </div>
          </div>
          <div class="row  row-config">
            <div class="col col-half">
              <ControlPlaneSection
                v-model:value="controlPlane"
                :mode="mode"
                :rules="{ replicas: fvGetAndReportPathRules('spec.topology.controlPlane.replicas') }"
              />
            </div>
          </div>
          <ClusterClassVariables
            :will-open="controlPlaneHighlightOpen"
            :value="variables"
            :section="formSections.CONTROL_PLANE"
            :cluster-class="clusterClassObj"
            :cluster-namespace="value.metadata?.namespace"

            @update-variables="setVariables"
            @validation-passed="e => variableSectionReady.controlPlane = e"
          />
        </Accordion>

        <Accordion
          v-if="!isManagedControlPlane"
          class="mt-20"
          open-initially
          :title="t(`capi.cluster.section.${formSections.NETWORKING}`)"
        >
          <!-- NETWORKING CONFIGURATION -->
          <div class="col col-half mt-20">
            <NetworkSection
              v-model:value="network"
              :mode="mode"
              :rules="{
                serviceDomain: fvGetAndReportPathRules('spec.clusterNetwork.serviceDomain'),
                apiServerPort: fvGetAndReportPathRules('spec.clusterNetwork.apiServerPort'),
                pods: fvGetAndReportPathRules('spec.clusterNetwork.pods.cidrBlocks'),
                services: fvGetAndReportPathRules('spec.clusterNetwork.services.cidrBlocks')
              }"
            />
          </div>
          <ClusterClassVariables
            :will-open="networkingHighlightOpen"
            :value="variables"
            :cluster-class="clusterClassObj"
            :section="formSections.NETWORKING"
            :cluster-namespace="value.metadata?.namespace"
            @validation-passed="e => variableSectionReady.networking = e"

            @update-variables="setVariables"
          />
        </Accordion>

        <!-- WORKERS -->
        <Accordion
          class="mt-20 section-accordion"
          open-initially
          :title="t(`capi.cluster.section.${formSections.WORKERS}`)"
        >
          <div class="col span-12 mb-20">
            <div class="span-12">
              <div
                v-if="!!machineDeploymentOptions"
                class="row"
              >
                <WorkerItem
                  v-model:value="machineDeployments"
                  :global-variables="variables"
                  :mode="mode"
                  :title="t('capi.cluster.workers.machineDeployments.title')"
                  :default-add-value="defaultDeploymentAddValue"
                  :class-options="machineDeploymentOptions"
                  :initial-empty-row="true"
                  :cluster-class="clusterClassObj"
                  @update:value="$emit('update:value', { k: 'spec.topology.workers.machineDeployments', val: $event })"
                />
              </div>
              <div
                v-if="!!machinePoolOptions"
                class="row"
              >
                <WorkerItem
                  v-model:value="machinePools"
                  :global-variables="variables"
                  :is-deployments="false"
                  :mode="mode"
                  :title="t('capi.cluster.workers.machinePools.title')"
                  :default-add-value="defaultPoolAddValue"
                  :class-options="machinePoolOptions"
                  :initial-empty-row="true"
                  :cluster-class="clusterClassObj"
                  @update:value="$emit('update:value', { k: 'spec.topology.workers.machinePools', val: $event })"
                />
              </div>
            </div>
          </div>

          <!-- Spot capacity indicator. Hidden when no scores or no pools.
               One row per pool, with a colored dot summarising the
               AWS Spot Placement Score for that pool's instance type. -->
          <div
            v-if="spotCapacityRows.length"
            class="spot-capacity-panel mt-20"
          >
            <div class="spot-capacity-header">
              <strong>Spot capacity</strong>
              <span
                v-if="spotCapacityUpdatedAt"
                class="spot-capacity-updated"
              >
                updated {{ spotCapacityUpdatedAt }}
              </span>
            </div>
            <table class="spot-capacity-table">
              <tr
                v-for="row in spotCapacityRows"
                :key="row.name + row.instance"
              >
                <td class="spot-capacity-pool">
                  {{ row.name }}
                </td>
                <td class="spot-capacity-instance">
                  {{ row.instance }}
                </td>
                <td class="spot-capacity-score">
                  <span :class="['spot-dot', `spot-dot-${row.color}`]" />
                  {{ row.score === null ? '—' : `${ row.score }/10` }}
                  <span class="spot-capacity-label">{{ row.label }}</span>
                </td>
              </tr>
            </table>
          </div>
        </Accordion>



        <Accordion
          class="mt-20 section-accordion"
          :title="t(`capi.cluster.section.${formSections.LABELS}`)"
        >
          <Labels
            :value="value"
            :mode="mode"
          />
        </Accordion>
      </div>
    </template>
  </CruResource>
</template>
<style lang="scss" scoped>
.required {
  color: var(--error);
}
.version {
    width: 65%
}

.spot-capacity-panel {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px 16px;
  background: var(--body-bg);
}

.spot-capacity-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}

.spot-capacity-updated {
  color: var(--muted);
  font-size: 0.85em;
}

.spot-capacity-table {
  width: 100%;
  border-collapse: collapse;

  td {
    padding: 4px 12px 4px 0;
    vertical-align: middle;
  }
}

.spot-capacity-pool {
  font-weight: 500;
}

.spot-capacity-instance {
  color: var(--muted);
  font-family: monospace;
}

.spot-capacity-label {
  color: var(--muted);
  margin-left: 6px;
  font-size: 0.9em;
}

.spot-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}

.spot-dot-green  { background-color: #4caf50; }
.spot-dot-yellow { background-color: #f0c419; }
.spot-dot-red    { background-color: #e53935; }
.spot-dot-grey   { background-color: #9e9e9e; }

//custom width for input columns instead of the usual classes (span-*) to simplify variable sizing
:deep(.col-half)  {
  margin-right: 0px;
  width: 50%;
}

:deep(.accordion-container){
  border-radius: 5px;
}

@media screen and (max-width: 1000px) {
  .row-config {
    flex-direction: column;
    width: 100%
  }

  .col-config {
    width: 100%
  }
}
</style>
