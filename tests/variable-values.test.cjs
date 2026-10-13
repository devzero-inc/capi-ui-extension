const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the SFC methods without needing the Rancher runtime. UI imports
// are stubbed; the value conversion and parent update methods run unchanged.
function loadComponent(relativePath, stubs) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default', 'module.exports =');
  const context = { module: { exports: {} }, mapGetters: () => ({}), _CREATE: 'create', ...stubs };

  vm.runInNewContext(script, context);

  return context.module.exports;
}

const variable = loadComponent('pkg/capi/components/CCVariables/Variable.vue', {
  YamlEditor: {}, VariableHighlight: {}
});
const parent = loadComponent('pkg/capi/components/CCVariables/index.vue', {
  Variable: {}, GroupPanel: {}, Accordion: {}
});

function update(type, input, isMachineScoped = false, existing = false) {
  let emitted;
  const values = existing ? [{ name: 'rootVolumeSize', value: 50 }] : [];
  const parentContext = {
    ownedVariables: values,
    ownedVariableNames: ['rootVolumeSize'],
    $emit(event, value) {
      if (event === 'update:value') {
        emitted = value;
      }
    }
  };
  const definition = { name: 'rootVolumeSize' };

  variable.methods.setValue.call({
    schema: { type }, isMachineScoped, isYamlComponent: false, isToggle: false,
    $emit(event, value) {
      assert.equal(event, 'update:value');
      parent.methods.updateVariables.call(parentContext, value, definition);
    }
  }, input);

  return JSON.parse(JSON.stringify(emitted));
}

for (const scope of [false, true]) {
  for (const existing of [false, true]) {
    test(`integer payload: machineScoped=${scope}, existing=${existing}`, () => {
      assert.deepEqual(update('integer', '100', scope, existing), [{ name: 'rootVolumeSize', value: 100 }]);
    });
  }
}

test('numeric input preserves zero and decimal precision', () => {
  assert.equal(update('integer', '0')[0].value, 0);
  assert.equal(update('number', '1.25')[0].value, 1.25);
  assert.equal(update('integer', '1.25')[0].value, 1.25);
});

test('empty and invalid numeric input is not silently changed to zero', () => {
  for (const value of ['', ' ', 'invalid', 'Infinity']) {
    assert.equal(update('integer', value)[0].value, value);
  }
});

test('string and boolean schemas keep their original types', () => {
  assert.equal(update('string', '100')[0].value, '100');
  assert.equal(update('boolean', false)[0].value, false);
  assert.equal(update('integer', 100)[0].value, 100);
});
