// (2023-08-23)

var PoseAT = (function () {

  var module_common;
  var core;

  var _PoseAT = {
    type: 'PoseAT',
    init: async function init(_worker, param) {
module_common = await import('./mocap_lib_module.js?v=xra-7.82');
core = new module_common.Core(_PoseAT);
// core END

await core.init(_worker, param);
    },
  };

  return _PoseAT;
})();
