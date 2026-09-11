// XRA_UNIVERSAL_RUNTIME_V9
// XRA_FRONTEND_STABILITY_V6
// XRA_CAMERA_OWNERSHIP_V4
// XRA_BACKEND_CAMERA_V3
// 2025-05-24

const is_worker = (typeof window !== "object");

// Runtime controls shared with the custom XR Animator UI.

let XRA_hands_enabled = true;
let XRA_pose_target_fps = 30;
let XRA_hand_target_fps = 20;
let XRA_telemetry_enabled = false;
let XRA_hand_recovery_mode = 'normal';
let XRA_hand_detection_sensitivity = 'high';
// Invalid landmark packets are never useful to the rig. Keep the loss gate
// fail-safe even before/without the UI BroadcastChannel handshake; the control
// message can still explicitly disable it for legacy behavior.
let XRA_body_stabilization_enabled = true;
let XRA_motion_hysteresis_enabled = false;
let XRA_debug_trace_enabled = false;
let XRA_pose_recovery_ms = 350;
let XRA_last_hands_seen_ms = 0;
let XRA_last_hand_recovery_scan_ms = 0;
let XRA_control_channel = null;

function XRA_debug_event(name, data) {
  if (!XRA_debug_trace_enabled || !XRA_control_channel) return;
  try {
    XRA_control_channel.postMessage({
      type:"xra_debug_event", source:"mocap-worker", name,
      at_ms:performance.now(), data:data || {}
    });
  } catch (e) {}
}

function XRA_hand_recovery_interval() {
  if (XRA_hand_recovery_mode === 'aggressive') return 80;
  if (XRA_hand_recovery_mode === 'normal') return 180;
  return Infinity;
}

function XRA_should_hand_recover(now = performance.now()) {
  if (!XRA_hands_enabled || XRA_hand_recovery_mode === 'off') return false;
  if (XRA_last_hands_seen_ms && now - XRA_last_hands_seen_ms < 420) return false;
  const interval = XRA_hand_recovery_interval();
  if (now - XRA_last_hand_recovery_scan_ms < interval) return false;
  XRA_last_hand_recovery_scan_ms = now;
  return true;
}

try {
  if (typeof BroadcastChannel !== "undefined") {
    XRA_control_channel = new BroadcastChannel("XRA_CONTROL");
    XRA_control_channel.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "hands_enabled") {
        XRA_hands_enabled = !!d.value;
      }
      else if (d.type === "mocap_rates") {
        if (Number.isFinite(Number(d.pose_fps))) XRA_pose_target_fps = Math.max(5, Math.min(60, Number(d.pose_fps)));
        if (Number.isFinite(Number(d.hand_fps))) XRA_hand_target_fps = Math.max(1, Math.min(60, Number(d.hand_fps)));
      }
      else if (d.type === "hands_config") {
        const recovery = String(d.recovery || 'normal').toLowerCase();
        XRA_hand_recovery_mode = ['off','normal','aggressive'].includes(recovery) ? recovery : 'normal';
        const sensitivity = String(d.sensitivity || 'high').toLowerCase();
        XRA_hand_detection_sensitivity = ['normal','high'].includes(sensitivity) ? sensitivity : 'high';
      }
      else if (d.type === "benchmark_telemetry") {
        XRA_telemetry_enabled = !!d.value;
      }
      else if (d.type === "body_stabilization") {
        XRA_body_stabilization_enabled = !!d.value;
        if (Number.isFinite(Number(d.recovery_ms))) XRA_pose_recovery_ms = Math.max(0, Math.min(2000, Number(d.recovery_ms)));
      }
      else if (d.type === "motion_hysteresis") {
        XRA_motion_hysteresis_enabled = !!d.value;
      }
      else if (d.type === "debug_trace") {
        XRA_debug_trace_enabled = !!d.value;
      }
    };
    XRA_control_channel.postMessage({ type:"hands_state_request" });
    XRA_control_channel.postMessage({ type:"mocap_rates_request" });
    XRA_control_channel.postMessage({ type:"tracking_state_request" });
    XRA_control_channel.postMessage({ type:"debug_state_request" });
  }
}
catch (e) {
  console.warn("[XRA MOCAP] Control channel unavailable", e);
}
function path_adjusted(url) {
  if (!is_worker && !/^\w+\:/i.test(url)) {
    url = url.replace(/^(\.?\/?)([\w\@])/, "$1js/$2")
  }
  return url
}

// Companion to XRA_ONNX_pose: the backend pose bypasses pose_adjust(), which is
// the ONLY place shoulder_width is normally computed. hands_adjust() derives its
// palm-distance acceptance radius from shoulder_width, so without an explicit
// value here that radius becomes NaN (first frame) or a stale MediaPipe number
// (later frames) and EVERY detected hand is silently filtered out before the
// pose is posted to the renderer -> no hand wireframe anywhere downstream.
// Measure it from the BlazePose-33 shoulder keypoints (indices 11/12) exactly
// like pose_adjust() does, keeping the rig/hand scale self-consistent.
function XRA_pose_shoulder_width(pose) {
  const pointAt = (i) => {
    const kp = pose?.keypoints?.[i];
    if (!kp) return null;
    const p = kp.position || kp;
    const x = Number(p.x), y = Number(p.y), z = Number(p.z) || 0;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, z } : null;
  };
  const l = pointAt(11), r = pointAt(12);
  if (!l || !r) return 0;
  const dx = l.x - r.x, dy = l.y - r.y, dz = (l.z - r.z) / 3;
  const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function XRA_pose_model_asset_path(quality) {
  const tier = quality === 'Best' ? 'heavy' : quality === 'Lite' ? 'lite' : 'full';
  return path_adjusted(`@mediapipe/tasks/pose_landmarker_${tier}.task`);
}

async function load_scripts(url) {
  if (is_worker) {
    importScripts(url)
  }
  else {
    return new Promise((resolve, reject) => {
      let script = document.createElement('script');
      script.onload = () => { resolve() };
      script.src = path_adjusted(url);
      document.head.appendChild(script);
    });
  }
}

function Core(AT) {

  var postMessageAT;

function init_common(_worker, param, _onmessage) {
  this.AT._worker = _worker;

  if (is_worker) {
    onmessage = (e)=>{ _onmessage.call(this, e); }
  }
  else {
    this.AT.onmessage = (e)=>{ _onmessage.call(this, e); }
  }

  if (param) {
    param = (function () {
      var _param = {};
      param.forEach((p)=>{
        if (/(\w+)\=(\w+)/.test(p))
          _param[RegExp.$1] = RegExp.$2
      });
      return {
        get: function (id) {
          return _param[id]
        }
      };
    })();
  }
  else {
    param = new URLSearchParams(self.location.search.substring(1));
  }

  return param;
}

async function PoseAT_init(_worker, param) {

function _onmessage(e) {
  let t = performance.now()
  let data = (typeof e.data === "string") ? JSON.parse(e.data) : e.data;
  if (data?.options) {
    XRA_backend_last_options = data.options;
    if (Number.isFinite(Number(data.w))) XRA_backend_last_w = Number(data.w);
    if (Number.isFinite(Number(data.h))) XRA_backend_last_h = Number(data.h);
    XRA_ONNX?.frontendReady?.(XRA_backend_last_w, XRA_backend_last_h);
  }

  if (data.canvas) {
    canvas = data.canvas
    context = canvas.getContext("2d")
  }
  if (data.canvas_hands)
    _canvas_hands = data.canvas_hands;
  canvas_hands = (data.options.use_canvas_hands && !data.options.use_holistic) ? _canvas_hands : null;
  if (data.canvas_hands) console.log('(Transferred - canvas_hands)');

  if (data.canvas_hands_worker)
    _canvas_hands_worker = data.canvas_hands_worker;

  if (data.rgba && XRA_ONNX_active()) {
    // The synthetic browser frame is only XR Animator's scheduler tick. Python owns
    // the physical camera, therefore this ImageBitmap must never be inferred here;
    // it must still be closed explicitly or Chromium retains its backing texture.
    const XRA_tick_frame = data.rgba;
    data.rgba = undefined;
    XRA_backend_close_tick_frame(XRA_tick_frame);
    XRA_backend_diag.ticks++;

    // Preserve the original one-request/one-reply worker contract. A WebSocket
    // callback only updates XRA_ONNX.latest; this tick consumes it. Never run a
    // second push-driven process_video_buffer() in parallel.
    if (XRA_backend_tick_busy) {
      XRA_backend_diag.busyReplays++;
      XRA_backend_replay_last_output("tick_busy");
    }
    else if (!XRA_backend_has_fresh_pose() && XRA_backend_last_output_json) {
      XRA_backend_diag.cleanReplays++;
      XRA_backend_replay_last_output("no_new_pose");
    }
    else {
      XRA_backend_tick_busy = true;
      const XRA_tick_promise = process_video_buffer.call(
        this, null, data.w, data.h, data.options
      );
      Promise.resolve(XRA_tick_promise).catch((err) => {
        XRA_backend_diag.processErrors++;
        XRA_backend_diag.lastError = String(err?.stack || err?.message || err);
        try { console.error('[XRA MOCAP] backend tick failed:', err); } catch (e) {}
        XRA_backend_replay_last_output("process_error");
      }).finally(() => {
        XRA_backend_tick_busy = false;
      });
    }
    data = undefined;
    return;
  }
    try {
      const _pv = process_video_buffer.call(this, data.rgba, data.w,data.h, data.options);
      // The worker message handler is fire-and-forget: if the async pipeline
      // rejects after its first await, the promise is orphaned and NOTHING
      // downstream (including postMessageAT) ever runs -- which looks exactly
      // like "the pipeline silently stops after N frames". Surface it.
      if (_pv && typeof _pv.catch === 'function') {
        _pv.catch((err)=>{
          try { console.error('[XRA MOCAP] process_video_buffer rejected:', err && (err.stack || err.message || err)); } catch (e) {}
        });
      }
    }
    catch (err) {
      try { console.error('[XRA MOCAP] process_video_buffer threw sync:', err && (err.stack || err.message || err)); } catch (e) {}
    }

    data.rgba = undefined
    data = undefined
  }

// common
param = init_common.call(this, _worker, param, _onmessage);

//if (is_worker) this.AT._canvas_for_imagedata = new OffscreenCanvas(1,1);

if (use_human || param.get('use_human')) {
  use_human_only = true

  use_human = true
  use_tfjs = false
  use_tfjs_posenet = false

  use_human_pose = true
  use_human_hands = true
}
else if (use_mixed_human || param.get('use_mixed_human')) {
  use_mixed_human = true

  use_human = true
  use_tfjs = true
  use_tfjs_posenet = true

  use_human_hands = true
}
else {
  use_human = false
  use_tfjs = true
  use_tfjs_posenet = true
}

if (use_blazepose || param.get('use_blazepose')) {
  use_blazepose = true
//use_mediapipe=true
//use_holistic=true
}

if (use_tfjs && (use_mediapipe || param.get('use_mediapipe'))) {
  use_mediapipe = true
  if (use_human) {
// use human for pose, mediapipe for hands
    use_tfjs = false
    use_tfjs_posenet = false

    use_human_pose = true
    use_human_hands = false
  }
  else if (use_holistic || param.get('use_holistic')) {
    use_holistic = true
  }
}

// new hand-pose-detection
// assumed mediapipe version for now
if (!use_human || !use_human_hands) use_mediapipe_hands = true;

//if (use_mediapipe || use_mediapipe_hands) process=undefined;

if (use_movenet || param.get('use_movenet')) {
  use_movenet = true
}

use_mediapipe_hand_landmarker = use_mediapipe_pose_landmarker = use_mediapipe;

use_mobilenet = param.get('use_mobilenet');

if (is_worker) {
  importScripts('./one_euro_filter.js');
  // Optional ONNX backend bridge. Loaded defensively: if the file is missing
  // the worker still runs MediaPipe exactly as before.
  try { importScripts('./xra_onnx_bridge.js'); }
  catch (e) { console.warn('[XRA MOCAP] ONNX bridge unavailable', e); }
  // Do not install a push processor here. xra_onnx_bridge.js already caches
  // the newest WebSocket pose; the normal pose-worker tick consumes that cache.
  // This keeps XR Animator's legacy worker scheduler back-pressured and bounded.
}

postMessageAT('(Pose worker initialized)')
postMessageAT('OK')
}

async function HandsAT_init(_worker, param) {

function _onmessage(e) {
  let t = performance.now()
  let data = (typeof e.data === "string") ? JSON.parse(e.data) : e.data;

  if (data.canvas) {
    canvas = data.canvas
    context = canvas.getContext("2d")
  }
  if (data.canvas_hands)
    _canvas_hands = data.canvas_hands;
  canvas_hands = (data.options.use_canvas_hands && !data.options.use_holistic) ? _canvas_hands : null;
  if (data.canvas_hands) console.log('(Transferred - canvas_hands_workers)');

  if (data.rgba) {
    process_video_buffer.call(this, data.rgba, data.w,data.h, data.options);

    data.rgba = undefined
    data = undefined
  }
}

// common
  param = init_common.call(this, _worker, param, _onmessage);

  if (is_worker) importScripts('./one_euro_filter.js');

  postMessageAT('(Hands worker initialized)');
  postMessageAT('OK');
}

  var posenet_initialized, handpose_initialized, holistic_initialized, human_initialized;
  async function PoseAT_load_lib(options) {
  // XRA_CAMERA_OWNERSHIP_V4: wait for the main-window backend choice.
  // Without this, PoseAT can start MediaPipe WASM before BroadcastChannel replies.
  if (is_worker && typeof XRA_ONNX !== 'undefined' && XRA_ONNX?.waitUntilConfigured) {
    await XRA_ONNX.waitUntilConfigured(1500);
  }
    // Calibration / startup decoupling: when an ONNX or native-MediaPipe
    // backend is active, do NOT instantiate the WASM MediaPipe runtime at all
    // (it was the WebKitGTK calibration stall). The body/face/hand landmarks
    // come straight from the backend's WebSocket stream instead, so the
    // calibration routine below consumes those frames directly.
    if (XRA_ONNX_active()) {
      posenet_initialized = holistic_initialized = true;
      postMessageAT('(ONNX/native backend active: WASM MediaPipe skipped)');
      return;
    }
if (options.use_holistic_legacy && !holistic_initialized) {
  await load_scripts('@mediapipe/holistic/holistic.js');

  await (async ()=>{
    var holistic = new Holistic({locateFile: (file) => {
return this.AT.path_adjusted('@mediapipe/holistic/' + file);
//return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}`;
    }});

    pose_model_quality = options.model_quality || '';
    holistic.setOptions({
modelComplexity: (pose_model_quality == 'Best') ? 2 : 1,
smoothLandmarks: true,
minDetectionConfidence: 0.5,
minTrackingConfidence: 0.5,
refineFaceLandmarks: true,
    });

    var holistic_results;
    holistic.onResults((results)=>{
holistic_results = results;
    });

    await holistic.initialize();

    holistic_model = {
predict: async function (img, config, timestamp) {
  await holistic.send({image:img}, timestamp);
  return holistic_results;
}
    };

    holistic_initialized = true
  })();

  console.log('(Mediapipe Holistic initialized)')
  postMessageAT('(Mediapipe Holistic initialized)')
}

if (!use_mediapipe_pose_landmarker && !options.use_holistic && use_tfjs && !posenet_initialized) {
  if (use_mediapipe && use_blazepose) {
    await load_scripts('@mediapipe/pose/pose.js');//'https://cdn.jsdelivr.net/npm/@mediapipe/pose');
  }

  if (!(((use_mediapipe && use_blazepose) || use_human_pose) && use_mediapipe_hands)) {
// https://blog.tensorflow.org/2020/03/face-and-hand-tracking-in-browser-with-mediapipe-and-tensorflowjs.html
    let tfjs_version = '';//'@3.9.0';//'@3.5.0';//'@3.3.0';//@2.8.5';
    await load_scripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs' + tfjs_version);
    console.log('Use TFJS (pose/hands)')
  }
}

if (use_human && !human_initialized) {
  await load_scripts('./human/dist/human.js');

  human = new Human.default();//(is_worker) ? new Human.default() : new Human();
//import Human from './human/dist/human.esm.js';
//human = new Human();

  human.load({
    backend: 'webgl',
//warmup: 'full',

    filter: {
      enabled: false
    },

    gesture: {
      enabled: false
    },

    face: {
      enabled: false
    },

    body: {
      enabled: use_human_pose,
//      maxDetections: 1,
      maxDetected: 1,
      modelPath: path_adjusted('./human/models/' + ((use_blazepose) ? 'blazepose' : ((use_movenet) ? 'movenet-thunder' : 'posenet')) + '.json'),
//modelType: 'posenet-resnet', modelPath: 'https://storage.googleapis.com/tfjs-models/savedmodel/posenet/resnet50/quant2/model-stride16.json', outputStride: 16,
//      modelType: 'ResNet', modelPath: 'https://storage.googleapis.com/tfjs-models/savedmodel/posenet/resnet50/quant2/model-stride16.json', outputStride: 16,
//scoreThreshold: 0.1,
    },

    hand: {
      enabled: use_human_hands,
//      maxHands: 2,
      maxDetected: 2,
      rotation: true,
      detector: {
        modelPath: path_adjusted('./human/models/handtrack.json')//handdetect.json')//
      },
      skeleton: {
        modelPath: path_adjusted('./human/models/handskeleton.json')
      },
//iouThreshold:0.3, scoreThreshold:0.75, skipFrames:2
/*
iouThreshold: 0.3,
scoreThreshold:0.5,
*/
skipFrames:5,
minConfidence: 0.2
    }
  });
//human.warmup().then(()=>{console.log('OK')});

  console.log('(Human - body:' + !!use_human_pose + '/hand:' + !!use_human_hands + ')')

  human_initialized = true
}

if (!options.use_holistic_legacy && !use_human_pose) {

if ((options.use_holistic_landmarker) ? !holistic_initialized : !posenet_initialized) {
/*
  await load_scripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/dist/tf-backend-wasm.js');
  tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/dist/');
  await tf.setBackend("wasm")
*/
  if (use_mediapipe_pose_landmarker) {
    const vision = await load_vision_common();

    if (options.use_holistic_landmarker) {
      holistic_landmarker = await HolisticLandmarker.createFromOptions(
vision,
{
  baseOptions: {
    modelAssetPath: path_adjusted('@mediapipe/tasks/' + 'holistic_landmarker' + '.task'),
    delegate: "GPU"
  },
  runningMode: 'VIDEO',

  outputFaceBlendshapes: true
}
      );

      mediapipe_hand_landmarker.setup();
    }
    else {
      pose_model_quality = options.model_quality || '';
      pose_landmarker = await PoseLandmarker.createFromOptions(
vision,
{
  baseOptions: {
    modelAssetPath: XRA_pose_model_asset_path(pose_model_quality),
    delegate: "GPU"
  },
  runningMode: 'VIDEO',
//minPoseDetectionConfidence:0.8, minPosePresenceConfidence:0.8, minTrackingConfidence:0.8,
  numPoses: 1
}
      );
      console.log('Pose model quality:' + (pose_model_quality||'Normal'));
    }

    data_filter[0] = {
      landmarks: [],
      worldLandmarks: [],
    };
    for (let i = 0; i < 33; i++) {
      data_filter[0].landmarks[i] = new OneEuroFilter(30, 1,1,2, 3);
      data_filter[0].worldLandmarks[i] = new OneEuroFilter(30, 1,1,2, 3);
    }
    data_filter[0].poseLandmarks = data_filter[0].landmarks;
    data_filter[0].poseWorldLandmarks = data_filter[0].worldLandmarks;

    posenet = {
estimatePoses: function (video, dummy, nowInMs) {
  const landmarker = (options.use_holistic_landmarker) ? holistic_landmarker : pose_landmarker;
  let result = landmarker.detectForVideo(video, nowInMs);
//console.log(result)

  let pose_names;
  let result_hands, result_face;
  if (options.use_holistic_landmarker) {
// https://github.com/google/mediapipe/blob/master/mediapipe/tasks/web/vision/holistic_landmarker/holistic_landmarker_result.ts
    pose_names = ['poseLandmarks', 'poseWorldLandmarks'];
    result_face = { multiFaceLandmarks:result.faceLandmarks };

    const multiHandLandmarks = [];
    const multiHandedness = [];
    [result.leftHandLandmarks, result.rightHandLandmarks].forEach((hand,i)=>{
      if (hand.length) {
        multiHandLandmarks.push(hand[0]);
// swapped label since v0.10.5
        const label = (i==1)?'Left':'Right';
        multiHandedness.push({ index:i, score:1, categoryName:label, displayName:label });
      }
    });
    result_hands = { multiHandLandmarks:multiHandLandmarks, multiHandedness:multiHandedness };
  }
  else {
    pose_names = ['landmarks', 'worldLandmarks'];
  }

  for (const p of pose_names) {
    const c = result[p]?.[0];
    if (!c) continue;

    for (let i = 0; i < 33; i++) {
      const v = c[i];

//      const v3 = data_filter[0][p][i].filter([v.x, v.y, v.z], nowInMs);
//      v.x = v3[0];
//      v.y = v3[1];

      const v3 = data_filter[0][p][i].filter([0, 0, v.z], nowInMs);
      v.z = v3[2];
   }
  }

//console.log(Object.assign(result, { poseLandmarks:result[pose_names[0]][0], za:result[pose_names[1]][0] }, result_face, result_hands))
  return Promise.resolve(Object.assign(result, { poseLandmarks:result[pose_names[0]][0], za:result[pose_names[1]][0] }, result_face, result_hands));
}
    };

    if (options.use_holistic_landmarker) {
      console.log('(Mediapipe Holistic Landmarker initialized)');
    }
    else {
      console.log('(Mediapipe Pose Landmarker initialized)');
      postMessageAT('(Mediapipe Pose Landmarker initialized)');
    }
  }
  else if (use_movenet) {
    await load_scripts((use_mediapipe && use_blazepose)?'@mediapipe/pose-detection.js':'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection');

    if (use_blazepose) {
      const detectorConfig = (use_mediapipe) ?
{
  runtime: 'mediapipe',
//  modelType: 'heavy'
//  solutionPath: 'base/node_modules/@mediapipe/pose'
}
:
{
  runtime: 'tfjs',
  enableSmoothing: true,
  modelType: 'full'
};
      posenet = await poseDetection.createDetector(poseDetection.SupportedModels.BlazePose, detectorConfig);

      let msg = '(' + ((use_mediapipe) ? 'Mediapipe' : 'TFJS') + ' BlazePose initialized)';
      console.log(msg)
      postMessageAT(msg)
    }
    else {
      const detectorConfig = {modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER};//{modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING};//
      posenet = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);

      console.log('(MoveNet initialized)')
      postMessageAT('(MoveNet initialized)')
    }
  }
  else {
    await load_scripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/posenet');

    posenet_model = await posenet.load((use_mobilenet) ?
{
  architecture: 'MobileNetV1',
  outputStride: 16,
//  inputResolution: { width: 640, height: 480 },
  multiplier: 0.75
}
:
{
  architecture: 'ResNet50',
  outputStride: 32,
//  inputResolution: { width: 257, height: 200 },
  quantBytes: 2/2
}
    );

    console.log('(PoseNet initialized)')
    postMessageAT('(PoseNet initialized)')
  }

  if (options.use_holistic_landmarker) {
    holistic_initialized = true;
  }
  else {
    posenet_initialized = true;
  }
}
else {
  if (!options.use_holistic_landmarker && use_mediapipe_pose_landmarker && (options.model_quality != null) && (pose_model_quality != options.model_quality)) {
    pose_model_quality = options.model_quality;
    pose_landmarker.setOptions({
      baseOptions: {
        modelAssetPath: XRA_pose_model_asset_path(pose_model_quality),
        delegate: "GPU"
      },
    });
    console.log('Pose model quality:' + (pose_model_quality||'Normal'));
  }
}

}

use_hands_worker = options.pose_enabled && options.use_hands_worker;// = true;
if (XRA_ONNX_active()) use_hands_worker = false;
use_hands_worker_parallel = (use_hands_worker == 2);

if (use_hands_worker) {
  if (!hands_worker)
    handpose_initialized = false;
}
else {
  hands_worker_data = null;
  if (!handpose_model)
    handpose_initialized = false;
}

if (!options.use_holistic && !use_human_hands && options.use_handpose && !handpose_initialized) {
  if (use_hands_worker) {
    await new Promise((resolve)=>{
      hands_worker = new Worker('hands_worker.js');
      hands_worker.onmessage = function (e) {
var data = ((typeof e.data == "string") && (e.data.charAt(0) === "{")) ? JSON.parse(e.data) : e.data;

if (typeof data === "string") {
  if (data == 'OK') {
    hands_worker_ready = true;
    resolve();
  }
  else {
    postMessageAT(data);
  }
}
else {
  hands_worker_ready = true;
  hands_worker_data = data;
  if (resolve_hands_worker_parallel) resolve_hands_worker_parallel();
}
      };
    });
  }
  else if (use_mediapipe_hand_landmarker) {
    handpose_model = await mediapipe_hand_landmarker.load();
  }
  else {
    await load_scripts('@mediapipe/hands/hands.js');//'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');//

    await (async ()=>{
      var hands = new Hands({locateFile: (file) => {
return this.AT.path_adjusted('@mediapipe/hands/' + file);
//return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
      }});

      hands.setOptions({
maxNumHands: 2,
minDetectionConfidence: 0.5,
minTrackingConfidence: 0.5,
modelComplexity: 1,
      });

      var hands_results;
      hands.onResults((results)=>{
hands_results = results;
      });

      await hands.initialize();

      handpose_model = {
estimateHands: async function (img, config) {
  await hands.send({image:img});
  return hands_results;
}
      };
    })();

    console.log('(Mediapipe hands initialized)')
    postMessageAT('(Mediapipe hands initialized)')
  }

  handpose_initialized = true
}
  }

  async function HandsAT_load_lib(options) {
if (!handpose_initialized) {
  handpose_model = await mediapipe_hand_landmarker.load();

  console.log('(Mediapipe hands initialized)')
  postMessageAT('(Mediapipe hands initialized)')
}

handpose_initialized = true
  }

async function load_vision_common() {
  await load_scripts('@mediapipe/tasks/tasks-vision/XRA_module_loader.js');

  await new Promise((resolve)=>{
const timerID = setInterval(()=>{
  if ('FilesetResolver' in self) {
    clearInterval(timerID);
    resolve();
  }
}, 100);
  });

  const vision = await FilesetResolver.forVisionTasks(
// path/to/wasm/root
//"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
path_adjusted('@mediapipe/tasks/tasks-vision/wasm')
  );

  return vision;
}

const mediapipe_hand_landmarker = (()=>{
  return {

    load: async function () {
  const vision = await load_vision_common();

  const f = [];
  const score_list = [0.5, 0.1];//0.3, 0.1];
  for (let i = 0; i < score_list.length; i++) {
    const score = score_list[i];
    f[i] = await HandLandmarker.createFromOptions(
vision,
{
  baseOptions: {
    modelAssetPath: path_adjusted('@mediapipe/tasks/hand_landmarker.task'),
    delegate: "GPU"
  },
  runningMode: 'VIDEO',

  numHands: 2,
  minHandDetectionConfidence: score,
  minHandPresenceConfidence: 0.5,//score,
  minTrackingConfidence: score,
}
    );
  }

  let f_index = 0;

  this.setup();

  console.log('(Mediapipe Hand Landmarker initialized)');
  postMessageAT('(Mediapipe Hand Landmarker initialized)');

  return {
set_score: (()=>{
  let timestamp = 0;
  return function (w,h, options) {
    if (!options.pose_enabled || XRA_hand_detection_sensitivity === 'high' || options.XRA_full_hand_recovery) {
      f_index = 1;
      return;
    }
//f_index=1;return;
//    let s = Math.min(Math.max(Math.max(w,h)/shoulder_width-5, 0)/5, 2);
    let s = Math.min(Math.max(Math.max(w,h)/shoulder_width-7.5, 0), 1);
    let index = (options.minHandDetectionConfidence != null) ? ((options.minHandDetectionConfidence < 0.5) ? 1 : 0) : Math.ceil(s);
//console.log(s, index);
    if (index != f_index) {
      const t = Date.now();
      if (t > timestamp + 1000) {
        f_index = index;
        timestamp = t;
//console.log(f_index, timestamp);
      }
    }
  };
})(),

estimateHands: (()=>{
  let initialized;
  return function (video, nowInMs) {
    let result;
    if (!initialized) {
      initialized = true;
      f.forEach(d=>{
        result = d.detectForVideo(video, nowInMs);
      });
    }
    else {
      result = f[f_index].detectForVideo(video, nowInMs);
    }
//console.log(result)

// left and right hand labels swapped/handednesses=>handedness in v0.10.5
    result.handedness?.forEach(hand=>{hand.forEach(h=>{
const label = (h.categoryName == 'Left') ? 'Right' : 'Left';
h.categoryName = h.displayName = label;
    })});

//    result.worldLandmarks?.forEach((hand,i)=>{ result.worldLandmarks[i] = hand.map(f=>[f.x,f.y,f.z]); });

    return Promise.resolve(Object.assign({ multiHandLandmarks:result.landmarks, multiHandedness:result.handedness?.map(h=>h[0]) }, result));

//    return Promise.resolve(Object.assign({ multiHandLandmarks:result.landmarks, multiHandedness:result.handednesses?.map(h=>h[0]) }, result));
  };
})(),
  };
    },

    setup: function () {
data_filter[1] = {
  Left: {
    landmarks: [],
  },
  Right: {
    landmarks: [],
  },
};
for (const d of ['Left', 'Right']) {
  for (let i = 0; i < 21; i++) {
    data_filter[1][d].landmarks[i] = new OneEuroFilter(30, 1,1/1000,1, 3);
  }
}
    },

  };
})();

var use_human;
var use_mixed_human;
var use_tfjs, use_tfjs_posenet, use_mediapipe, use_blazepose, use_movenet, use_holistic, use_mediapipe_hands;

var use_mediapipe_hand_landmarker, use_mediapipe_pose_landmarker;
var pose_landmarker;
var pose_model_quality, pose_model_z_depth_scale;

var holistic_landmarker;

var hands_worker, hands_worker_data, hands_worker_pose;
var hands_worker_ready;
var use_hands_worker// = true;
var use_hands_worker_parallel;
var resolve_hands_worker_parallel;

var pose_last;

var object_detection_worker, object_detection_worker_ready;
var object_detection_data;

var use_human_only, use_human_pose, use_human_hands;

var human;

var posenet;
var posenet_model, handpose_model;
var holistic_model;

var use_mobilenet;

var no_hand_countdown = 0, no_hand_countdown_max = 3;

var fps = 0, fps_count = 0, fps_ms = 0;


var skip_hand_countdown = 0

// Standalone inference-rate control. The pose worker still replies on every
// camera frame, but may reuse the last result instead of running MediaPipe.
var XRA_last_pose_run_ms = 0;
var XRA_last_pose_payload = null;
var XRA_last_hand_run_ms = 0;
var XRA_last_hands_result = null;
// Set true on the frame the ONNX/native-MediaPipe wholebody stream supplied
// hands/face, so the native hand-pose blocks below don't clobber them.
var XRA_ONNX_wholebody = false;
var XRA_backend_last_options = null;
var XRA_backend_last_w = 384;
var XRA_backend_last_h = 216;
var XRA_backend_tick_busy = false;
var XRA_backend_last_output = null;
var XRA_backend_last_output_json = null;

var XRA_backend_diag = {
  ticks: 0,
  posted: 0,
  replayed: 0,
  busyReplays: 0,
  cleanReplays: 0,
  processErrors: 0,
  closedImageBitmaps: 0,
  lastFrameId: null,
  lastPostedFrameId: null,
  lastReplayReason: null,
  lastError: ""
};

function XRA_backend_close_tick_frame(frame) {
  try {
    if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
      frame.close();
      XRA_backend_diag.closedImageBitmaps++;
    }
  }
  catch (error) {
    XRA_backend_diag.lastError = String(error?.message || error);
  }
}

function XRA_backend_has_fresh_pose() {
  const status = (typeof XRA_ONNX !== 'undefined') ? XRA_ONNX.status : null;
  return !!status && Number(status.sequence) !== Number(status.consumed);
}

self.XRA_BACKEND_PIPELINE_STATUS = function () {
  const bridge = (typeof XRA_ONNX !== "undefined") ? XRA_ONNX.status : null;
  return {
    ...XRA_backend_diag,
    hasOptions: !!XRA_backend_last_options,
    busy: XRA_backend_tick_busy,
    hasCachedOutput: !!XRA_backend_last_output_json,
    freshPose: XRA_backend_has_fresh_pose(),
    bridge
  };
};

function XRA_backend_empty_output(reason) {
  return {
    posenet: {
      score: 0,
      keypoints: [],
      keypoints3D: [],
      keypoints3D_raw: [],
      ea: [],
      has_pose: false,
      data_detected: 0,
      _xra_empty: true,
      _xra: { source: "backend_camera", reason }
    },
    handpose: [],
    facemesh: null,
    object_detection: null,
    _t: 0,
    fps: 0
  };
}

function XRA_backend_post_output(payload) {
  XRA_backend_last_output = payload;
  XRA_backend_last_output_json = JSON.stringify(payload);
  XRA_backend_diag.posted++;
  XRA_backend_diag.lastPostedFrameId = payload?.posenet?._xra?.frame_id ?? null;
  postMessageAT(XRA_backend_last_output_json);
}

function XRA_backend_replay_last_output(reason) {
  XRA_backend_diag.replayed++;
  XRA_backend_diag.lastReplayReason = reason || null;
  if (!XRA_backend_last_output_json) {
    XRA_backend_post_output(XRA_backend_empty_output(reason || "waiting_backend_pose"));
    return;
  }
  postMessageAT(XRA_backend_last_output_json);
}

var XRA_last_stable_pose = null;
var XRA_last_stable_hands = null;
var XRA_pose_loss_active = false;
var XRA_pose_reacquire_count = 0;
var XRA_pose_reacquire_state = null;
var XRA_pose_recovery = null;
var XRA_pose_filter_state = 'live';
const XRA_STABLE_HISTORY_SIZE = 10;
const XRA_STABLE_LOOKBACK_MS = 120;
const XRA_MOTION_WINDOW_MS = 240;
const XRA_MOTION_MIN_SAMPLES = 3;
var XRA_stable_tracking_history = new Array(XRA_STABLE_HISTORY_SIZE);
var XRA_stable_tracking_write = 0;
var XRA_stable_tracking_count = 0;
var XRA_motion_tracking_window = [];

function XRA_hand_due(now) {
  if (!XRA_hands_enabled) return false;
  const interval = 1000 / Math.max(1, XRA_hand_target_fps || 20);
  if (!XRA_last_hands_result || (now - XRA_last_hand_run_ms) >= interval) {
    XRA_last_hand_run_ms = now;
    return true;
  }
  return false;
}

function XRA_send_telemetry(payload) {
  if (!XRA_telemetry_enabled || !XRA_control_channel) return;
  try {
    XRA_control_channel.postMessage(Object.assign({ type:"mocap_telemetry" }, payload));
  } catch (e) {}
}

// -- ONNX backend bridge accessors ------------------------------------------
// The bridge (js/xra_onnx_bridge.js) installs self.XRA_ONNX. These thin
// wrappers keep the call sites safe when the bridge is absent (e.g. the file
// was not shipped, or importScripts failed) so MediaPipe keeps working.
function XRA_ONNX_active() {
  return is_worker && typeof XRA_ONNX !== 'undefined' && XRA_ONNX && XRA_ONNX.active;
}

function XRA_ONNX_pose(rgba, w, h) {
  if (!XRA_ONNX_active()) return null;
  try {
    return (XRA_ONNX.consumeLatestPose ? XRA_ONNX.consumeLatestPose(w, h) : XRA_ONNX.maybeReplaceFrame(null, w, h)) || null;
  }
  catch (e) {
    XRA_debug_event('onnx-bridge-error', { error:String(e) });
    return null;
  }
}

// Build the worker's `hands` array from normalized COCO-hand landmarks.
// hands_adjust(..., from_onnx=true) performs the single normalized->pixel scale.
function XRA_ONNX_hands(w, h) {
  if (!XRA_ONNX_active() || typeof XRA_ONNX.leftHand === 'undefined') return null;
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const to_normalized = (arr) => (arr || []).slice(0, 21).map(p => ({
    x: finite(p.x), y: finite(p.y), z: finite(p.z),
    visibility: Math.max(0, Math.min(1, finite(p.score ?? p.visibility, 1))),
  }));
  const left = to_normalized(XRA_ONNX.leftHand);
  const right = to_normalized(XRA_ONNX.rightHand);
  if (!left.length && !right.length) return null;

  const hands = { multiHandedness: [], multiHandLandmarks: [] };
  // Mirrored convention: the camera-left hand is the subject's Right (matches
  // MediaPipe holistic legacy, which the rest of the pipeline expects).
  if (left.length >= 21) {
    hands.multiHandLandmarks.push(left);
    hands.multiHandedness.push({ score: 1, categoryName: 'Right', label: 'Right' });
  }
  if (right.length >= 21) {
    hands.multiHandLandmarks.push(right);
    hands.multiHandedness.push({ score: 1, categoryName: 'Left', label: 'Left' });
  }
  return hands.multiHandLandmarks.length ? hands : null;
}

// Build the worker's `facemesh` object from the ONNX wholebody face payload.
// The server sends face landmarks (px) + a small blendshape dict; we forward
// the blendshapes verbatim so the VRM morph solver (which reads
// faceBlendshapes) animates blinks/jaw regardless of which backend produced them.
function XRA_ONNX_facemesh(w, h) {
  if (!XRA_ONNX_active() || typeof XRA_ONNX.face === 'undefined') return null;
  const face = XRA_ONNX.face;
  const landmarks = face?.landmarks;
  if (!Array.isArray(landmarks) || landmarks.length < 468) return null;

  // Existing XR Animator facemesh consumers index MediaPipe's 468/478 topology
  // (e.g. 234, 454, 468, 473) and expect [x,y,z] arrays, not {x,y,z} objects.
  const scaledMesh = landmarks.map(p => [
    (Number(p.x) || 0) * w,
    (Number(p.y) || 0) * h,
    (Number(p.z) || 0) * w,
  ]);
  const mesh = landmarks.map(p => [
    Number(p.x) || 0,
    Number(p.y) || 0,
    Number(p.z) || 0,
  ]);

  let blendshapes = null;
  const bs = face.blendshapes || {};
  const entries = bs.native || bs;
  if (entries && typeof entries === 'object') {
    blendshapes = Object.keys(entries).map(name => ({
      categoryName: name,
      score: Number(entries[name]) || 0,
    }));
  }
  return {
    faces: [{
      faceInViewConfidence: 0.9,
      scaledMesh,
      mesh,
      faceBlendshapes: blendshapes,
    }],
  };
}

// Report detector validity from the worker that owns the fresh inference result.
// Reading pose data back from the renderer is unreliable because several XR
// Animator pipelines retain their last result after the person has disappeared.
function XRA_pose_tracking_state(pose, width, height, enabled) {
  if (!enabled) {
    return { type:'pose_tracking_state', available:false, present:false, confidence:null, signature:'', source:'mocap-worker' };
  }
  const points = Array.isArray(pose?.keypoints) ? pose.keypoints : [];
  let core = points.filter(point => /shoulder|hip/i.test(String(point?.part || point?.name || '')));
  if (!core.length) {
    const indices = points.length >= 30 ? [11, 12, 23, 24] : [5, 6, 11, 12];
    core = indices.map(index => points[index]).filter(Boolean);
  }

  let confidenceTotal = 0;
  let confidenceCount = 0;
  let visibleCore = 0;
  let insideCore = 0;
  let visibleShoulders = 0;
  let visibleHips = 0;
  let insideShoulders = 0;
  let insideHips = 0;
  const signature = [];
  const shoulderPoints = [];
  const hipPoints = [];
  for (let index = 0; index < core.length; index++) {
    const point = core[index];
    const position = point?.position || point;
    const x = Number(position?.x);
    const y = Number(position?.y);
    const label = String(point?.part || point?.name || '');
    const shoulder = /shoulder/i.test(label) || (!label && index < 2);
    const hip = /hip/i.test(label) || (!label && index >= 2);
    const confidence = Number(point?.score ?? point?.visibility ?? point?.presence);
    const usableConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 1;
    if (Number.isFinite(confidence)) {
      confidenceTotal += usableConfidence;
      confidenceCount++;
    }
    if (usableConfidence >= 0.25) {
      visibleCore++;
      if (shoulder) visibleShoulders++;
      if (hip) visibleHips++;
    }
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const hasNorm = Number.isFinite(point?.normX);
      const nx = hasNorm ? point.normX : (Math.abs(x) <= 2.5 ? x : x / Math.max(1, Number(width) || 640));
      const ny = hasNorm ? point.normY : (Math.abs(y) <= 2.5 ? y : y / Math.max(1, Number(height) || 480));
      const margin = 0.10;
      if (nx >= -margin && nx <= 1 + margin && ny >= -margin && ny <= 1 + margin) {
        insideCore++;
        if (shoulder) insideShoulders++;
        if (hip) insideHips++;
      }
      if (shoulder) shoulderPoints.push([nx, ny]);
      if (hip) hipPoints.push([nx, ny]);
      signature.push(`${Math.round(nx / 0.02)},${Math.round(ny / 0.02)}`);
    }
  }

  const confidence = confidenceCount ? confidenceTotal / confidenceCount : (points.length ? 1 : 0);
  const midpoint = pair => pair.length >= 2
    ? [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2]
    : null;
  const distance = (a, b) => a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  const shouldersMid = midpoint(shoulderPoints);
  const hipsMid = midpoint(hipPoints);
  const shoulderSpan = shoulderPoints.length >= 2 ? distance(shoulderPoints[0], shoulderPoints[1]) : 0;
  const hipSpan = hipPoints.length >= 2 ? distance(hipPoints[0], hipPoints[1]) : 0;
  const torsoSpan = shouldersMid && hipsMid ? distance(shouldersMid, hipsMid) : 0;

  const hasHips = hipPoints.length >= 2 && visibleHips >= 2 && insideHips >= 2;
  const shoulderValid = shoulderSpan >= .035 && shoulderSpan <= .85 && visibleShoulders >= 2 && insideShoulders >= 2;
  const hipTorsoValid = !hasHips || (hipSpan >= .025 && hipSpan <= .75 && torsoSpan >= .035 && torsoSpan <= .90);
  const geometryValid = shoulderValid && hipTorsoValid;

  const requiredCore = hasHips ? 4 : 2;
  const present = points.length > 0 && core.length > 0 &&
    visibleCore >= requiredCore && insideCore >= requiredCore &&
    visibleShoulders >= 2 && insideShoulders >= 2 &&
    confidence >= 0.25 && geometryValid;

  const centerX = shouldersMid && hipsMid ? (shouldersMid[0] + hipsMid[0]) / 2 : (shouldersMid ? shouldersMid[0] : null);
  const centerY = shouldersMid && hipsMid ? (shouldersMid[1] + hipsMid[1]) / 2 : (shouldersMid ? shouldersMid[1] : null);

  return {
    type:'pose_tracking_state', available:true, present, confidence,
    core_points:core.length, visible_core:visibleCore, inside_core:insideCore,
    visible_shoulders:visibleShoulders, visible_hips:visibleHips,
    center_x:centerX,
    center_y:centerY,
    shoulder_span:shoulderSpan, hip_span:hipSpan, torso_span:torsoSpan,
    geometry_valid:geometryValid,
    signature:signature.join('|'), source:'mocap-worker'
  };
}

function XRA_send_pose_tracking_state(state) {
  if (!XRA_control_channel || !state) return;
  try { XRA_control_channel.postMessage(state); }
  catch (e) {}
}

function XRA_remember_stable_tracking(pose, hands, state) {
  const slot = XRA_stable_tracking_history[XRA_stable_tracking_write] || {};
  slot.at = performance.now();
  slot.pose = pose;
  slot.hands = hands;
  slot.state = state;
  XRA_stable_tracking_history[XRA_stable_tracking_write] = slot;
  XRA_stable_tracking_write = (XRA_stable_tracking_write + 1) % XRA_STABLE_HISTORY_SIZE;
  XRA_stable_tracking_count = Math.min(XRA_stable_tracking_count + 1, XRA_STABLE_HISTORY_SIZE);
  XRA_last_stable_pose = pose;
  if (Array.isArray(hands) && hands.length) XRA_last_stable_hands = hands;
}

function XRA_trusted_tracking() {
  if (!XRA_stable_tracking_count) return { pose:XRA_last_stable_pose, hands:XRA_last_stable_hands };
  const target = performance.now() - XRA_STABLE_LOOKBACK_MS;
  let fallback = null;
  for (let offset = 1; offset <= XRA_stable_tracking_count; offset++) {
    const index = (XRA_stable_tracking_write - offset + XRA_STABLE_HISTORY_SIZE) % XRA_STABLE_HISTORY_SIZE;
    const sample = XRA_stable_tracking_history[index];
    if (!sample) continue;
    fallback ||= sample;
    if (sample.at <= target) return { pose:sample.pose, hands:sample.hands };
  }
  return { pose:fallback?.pose || XRA_last_stable_pose, hands:fallback?.hands || XRA_last_stable_hands };
}

function XRA_tracking_debug_summary(state) {
  return {
    present:!!state?.present,
    confidence:state?.confidence != null ? Number(state.confidence.toFixed(3)) : null,
    reason:state?.reason || (state?.present ? 'present' : 'missing'),
    visible_core:state?.visible_core,
    geometry_valid:state?.geometry_valid,
    shoulder_span:state?.shoulder_span != null ? Number(state.shoulder_span.toFixed(3)) : null,
    hip_span:state?.hip_span != null ? Number(state.hip_span.toFixed(3)) : null,
    torso_span:state?.torso_span != null ? Number(state.torso_span.toFixed(3)) : null
  };
}

function XRA_set_pose_filter_state(next, data) {
  if (XRA_pose_filter_state === next) return;
  const previous = XRA_pose_filter_state;
  XRA_pose_filter_state = next;
  XRA_debug_event('pose-filter-state', Object.assign({ previous, next }, data || {}));
}

function XRA_clone_pose_point(point) {
  if (!point || typeof point !== 'object') return point;
  const clone = Object.assign({}, point);
  if (point.position && typeof point.position === 'object') clone.position = Object.assign({}, point.position);
  return clone;
}

function XRA_clone_pose(pose) {
  if (!pose || typeof pose !== 'object') return pose;
  const clone = Object.assign({}, pose);
  for (const key of ['keypoints', 'keypoints3D', 'keypoints3D_raw']) {
    if (Array.isArray(pose[key])) clone[key] = pose[key].map(XRA_clone_pose_point);
  }
  return clone;
}

function XRA_lerp_number(from, to, mix) {
  from = Number(from); to = Number(to);
  return Number.isFinite(from) && Number.isFinite(to) ? from + (to - from) * mix : to;
}

function XRA_blend_pose_point(from, to, mix) {
  if (!to || typeof to !== 'object') return to;
  if (!from || typeof from !== 'object') return XRA_clone_pose_point(to);
  const out = Object.assign({}, to);
  for (const axis of ['x', 'y', 'z']) {
    if (axis in to) out[axis] = XRA_lerp_number(from[axis], to[axis], mix);
  }
  if (to.position && typeof to.position === 'object') {
    out.position = Object.assign({}, to.position);
    for (const axis of ['x', 'y', 'z']) {
      if (axis in to.position) out.position[axis] = XRA_lerp_number(from.position?.[axis], to.position[axis], mix);
    }
  }
  return out;
}

function XRA_blend_pose(from, to, mix) {
  if (!from || !to || typeof to !== 'object') return to;
  const out = Object.assign({}, to);
  for (const key of ['keypoints', 'keypoints3D', 'keypoints3D_raw']) {
    const targetPoints = to[key];
    const sourcePoints = from[key];
    if (!Array.isArray(targetPoints)) continue;
    out[key] = targetPoints.map((point, index) => XRA_blend_pose_point(sourcePoints?.[index], point, mix));
  }
  return out;
}

function XRA_recovery_mix(elapsed, duration) {
  if (!(duration > 0)) return 1;
  const t = Math.max(0, Math.min(1, elapsed / duration));
  return t * t * (3 - 2 * t);
}

function XRA_reset_pose_recovery() {
  XRA_pose_recovery = null;
}

function XRA_tracking_states_discontinuous(state, previous, centerLimit = .24) {
  if (!previous?.present) return false;
  const currentCenterX = Number(state.center_x);
  const previousCenterX = Number(previous.center_x);
  const currentCenterY = Number(state.center_y);
  const previousCenterY = Number(previous.center_y);
  if (!Number.isFinite(currentCenterX) || !Number.isFinite(previousCenterX) ||
      !Number.isFinite(currentCenterY) || !Number.isFinite(previousCenterY)) return false;
  const centerJump = Math.hypot(
    currentCenterX - previousCenterX,
    currentCenterY - previousCenterY
  );
  const ratioOutside = (current, old, low, high) => {
    current = Number(current); old = Number(old);
    if (!(current > 0) || !(old > 0)) return false;
    const ratio = current / old;
    return ratio < low || ratio > high;
  };
  return centerJump > centerLimit ||
    ratioOutside(state.shoulder_span, previous.shoulder_span, .48, 2.1) ||
    ratioOutside(state.hip_span, previous.hip_span, .42, 2.3) ||
    ratioOutside(state.torso_span, previous.torso_span, .42, 2.3);
}

function XRA_motion_state_sample(state, at) {
  return {
    at,
    center_x:Number(state.center_x), center_y:Number(state.center_y),
    shoulder_span:Number(state.shoulder_span), hip_span:Number(state.hip_span),
    torso_span:Number(state.torso_span)
  };
}

function XRA_motion_transition(a, b) {
  const dt = Math.max(1, b.at - a.at) / 1000;
  const dx = b.center_x - a.center_x;
  const dy = b.center_y - a.center_y;
  const centerDistance = Number.isFinite(dx) && Number.isFinite(dy) ? Math.hypot(dx, dy) : 0;
  let scaleLogDistance = 0;
  for (const key of ['shoulder_span','hip_span','torso_span']) {
    if (!(a[key] > 0) || !(b[key] > 0)) continue;
    scaleLogDistance = Math.max(scaleLogDistance, Math.abs(Math.log(b[key] / a[key])));
  }
  return {
    centerDistance,
    scaleLogDistance,
    fast: centerDistance / dt > .90 || scaleLogDistance / dt > 2.4
  };
}

// Detect a burst, not an isolated packet. The window catches rapid motion made
// of several individually plausible steps (the old last-frame comparison did
// not) and requires at least two fast transitions before rejecting anything.
function XRA_pose_rapid_motion(state, now = performance.now()) {
  if (!state?.present) {
    XRA_motion_tracking_window.length = 0;
    return false;
  }

  XRA_motion_tracking_window.push(XRA_motion_state_sample(state, now));
  while (XRA_motion_tracking_window.length && now - XRA_motion_tracking_window[0].at > XRA_MOTION_WINDOW_MS) {
    XRA_motion_tracking_window.shift();
  }
  if (XRA_motion_tracking_window.length < XRA_MOTION_MIN_SAMPLES) return false;

  let centerPath = 0;
  let scalePath = 0;
  let fastTransitions = 0;
  for (let i = 1; i < XRA_motion_tracking_window.length; i++) {
    const delta = XRA_motion_transition(XRA_motion_tracking_window[i - 1], XRA_motion_tracking_window[i]);
    centerPath += delta.centerDistance;
    scalePath += delta.scaleLogDistance;
    if (delta.fast) fastTransitions++;
  }
  const elapsed = Math.max(1, now - XRA_motion_tracking_window[0].at) / 1000;
  const rapidCenter = centerPath >= .14 && centerPath / elapsed > .85;
  const rapidScale = scalePath >= .30 && scalePath / elapsed > 1.8;
  return fastTransitions >= 2 && (rapidCenter || rapidScale);
}

// Stop invalid landmarks before they reach IK/bone solving. Keeping this in the
// worker also protects native code that runs before XRA's final render hooks.
function XRA_hold_invalid_tracking(pose, hands, state) {
  if (!state?.available) {
    XRA_pose_loss_active = false;
    XRA_pose_reacquire_count = 0;
    XRA_pose_reacquire_state = null;
    XRA_reset_pose_recovery();
    XRA_motion_tracking_window.length = 0;
    XRA_set_pose_filter_state('live', { reason:'tracking-unavailable' });
    return { pose, hands };
  }

  if (!XRA_body_stabilization_enabled && !XRA_motion_hysteresis_enabled) {
    XRA_pose_loss_active = false;
    XRA_pose_reacquire_count = 0;
    XRA_pose_reacquire_state = null;
    XRA_reset_pose_recovery();
    XRA_motion_tracking_window.length = 0;
    XRA_set_pose_filter_state('live', { reason:'filter-disabled' });
    if (state.present && pose?.keypoints?.length) XRA_remember_stable_tracking(pose, hands, state);
    return { pose, hands };
  }

  const rapidMotion = state.present && XRA_motion_hysteresis_enabled
    ? XRA_pose_rapid_motion(state)
    : false;
  const discontinuous = !XRA_pose_loss_active && rapidMotion;
  if (discontinuous) {
    state.present = false;
    state.reason = 'rapid-pose-sequence';
  }

  if (!state.present) {
    // Hysteresis is not another tracking-loss toggle. With body stabilization
    // off, ordinary missing detections pass through; only a discontinuity that
    // this filter itself rejected starts/continues a short last-good hold.
    if (!XRA_body_stabilization_enabled && !discontinuous && !XRA_pose_loss_active) {
      XRA_pose_reacquire_count = 0;
      XRA_pose_reacquire_state = null;
      XRA_reset_pose_recovery();
      XRA_motion_tracking_window.length = 0;
      XRA_set_pose_filter_state('live', { reason:'missing-passthrough' });
      return { pose, hands };
    }
    XRA_pose_loss_active = true;
    XRA_pose_reacquire_count = 0;
    XRA_pose_reacquire_state = null;
    XRA_reset_pose_recovery();
    XRA_set_pose_filter_state('holding', XRA_tracking_debug_summary(state));
    const trusted = XRA_trusted_tracking();
    const returnHands = (XRA_body_stabilization_enabled && !XRA_motion_hysteresis_enabled && hands && hands.length)
      ? (trusted.hands || XRA_last_stable_hands || hands)
      : hands;
    return { pose: trusted.pose || pose, hands: returnHands };
  }

  // A single plausible frame is not enough after an occlusion. Four consecutive
  // detections prevent flicker between a hand/poster and the returning user.
  if (XRA_pose_loss_active) {
    if (XRA_pose_reacquire_state && XRA_tracking_states_discontinuous(state, XRA_pose_reacquire_state, .10)) {
      XRA_pose_reacquire_count = 1;
      XRA_reset_pose_recovery();
      XRA_set_pose_filter_state('validating', Object.assign({ reset:true, count:1 }, XRA_tracking_debug_summary(state)));
    }
    else {
      XRA_pose_reacquire_count += 1;
    }
    XRA_pose_reacquire_state = state;
    if (XRA_pose_reacquire_count < 4) {
      XRA_set_pose_filter_state('validating', Object.assign({ count:XRA_pose_reacquire_count }, XRA_tracking_debug_summary(state)));
      const trusted = XRA_trusted_tracking();
      const returnHands = (XRA_body_stabilization_enabled && !XRA_motion_hysteresis_enabled && hands && hands.length)
        ? (trusted.hands || XRA_last_stable_hands || hands)
        : hands;
      return { pose: trusted.pose || pose, hands: returnHands };
    }

    const now = performance.now();
    if (!XRA_pose_recovery) {
      const trusted = XRA_trusted_tracking();
      XRA_pose_recovery = {
        started_at:now,
        from_pose:XRA_clone_pose(trusted.pose || pose)
      };
      XRA_set_pose_filter_state('recovering', Object.assign({
        count:XRA_pose_reacquire_count,
        duration_ms:XRA_pose_recovery_ms
      }, XRA_tracking_debug_summary(state)));
    }

    const elapsed = now - XRA_pose_recovery.started_at;
    if (XRA_pose_recovery_ms > 0 && elapsed < XRA_pose_recovery_ms) {
      const mix = XRA_recovery_mix(elapsed, XRA_pose_recovery_ms);
      return { pose:XRA_blend_pose(XRA_pose_recovery.from_pose, pose, mix), hands };
    }
  }

  XRA_pose_loss_active = false;
  XRA_pose_reacquire_count = 0;
  XRA_pose_reacquire_state = null;
  XRA_reset_pose_recovery();
  XRA_motion_tracking_window.length = 0;
  XRA_set_pose_filter_state('live', { reason:'recovery-complete' });
  if (pose?.keypoints?.length) XRA_remember_stable_tracking(pose, hands, state);
  return { pose, hands };
}

var eyes;
var eyes_xy_last = [[0,0],[0,0]];

var vt, vt_offset=0, vt_last=-1;

let _canvas_hands, _canvas_hands_worker;
let canvas_hands;// = new OffscreenCanvas(1,1);

let shoulder_width;

let data_filter = [];

const hand_clip = [];

async function process_video_buffer(rgba, w,h, options) {
  function pose_adjust(pose) {
    shoulder_width = Math.max(w,h)/7;

    if (!pose || !use_movenet) return pose

// latest human
    if (use_human_pose) {
      pose.keypoints.forEach((kp) => {
        if (kp.position.length)
          kp.position = {x:kp.position[0], y:kp.position[1]}
      });
      return pose;
    }

    let _keypoints3D;
    let assign_keypoints3D;
    if (options.use_holistic || use_mediapipe_pose_landmarker) {
      const _result = pose
//console.log(_result)
      _keypoints3D = _result.ea || _result.za;
      if (_keypoints3D?.length && _result.poseLandmarks?.length) {
// https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/blazepose_mediapipe/detector.ts

        const iw = _result.image?.width  || w;
        const ih = _result.image?.height || h

        pose  = [{
  score: 1,
  keypoints: _result.poseLandmarks.map((landmark, i) => ({
x: landmark.x * iw,
y: landmark.y * ih,
z: landmark.z * iw,
name: BLAZEPOSE_KEYPOINTS[i]
  })),
        }];
      }
      else {
        pose = []
      }
    }

    if (!pose.length)
      return {score:0,keypoints:[]}

    const armL_pos = pose[0].keypoints[get_pose_index(5)];
    const armR_pos = pose[0].keypoints[get_pose_index(6)];
    const arm_diff = [armL_pos.x-armR_pos.x, armL_pos.y-armR_pos.y, (armL_pos.z-armR_pos.z)/3];
    shoulder_width = Math.sqrt(arm_diff[0]*arm_diff[0] + arm_diff[1]*arm_diff[1] + arm_diff[2]*arm_diff[2]);

    if (data_filter[0]) {
      let filter_factor = Math.max(w,h)/shoulder_width;
      filter_factor = (filter_factor < 5) ? 1 : Math.min(filter_factor/5, 3);
//console.log(filter_factor)
      for (const p of ['landmarks', 'worldLandmarks']) {
        for (let i = 0; i < 33; i++) {
          const f = data_filter[0][p][i];
//          f.minCutOff = 1 * (1 + (filter_factor-1)/2);
//          f.minCutOff = filter_factor;
          f.beta = filter_factor;
          f.dCutOff = 2 * filter_factor;
        }
      }
    }

    if (pose[0].keypoints[0].score == null) {
      const score = pose[0].keypoints.map(landmark=>{
if (landmark.visibility != null) return landmark.visibility;

let score = 1;
for (const d of ['x','y']) {
  const dim = (d == 'x') ? w : h;
  const v = landmark[d]/dim;
  const limit = (shoulder_width/1)/dim;
  if (v < 0) {
    score *= Math.max(1 + v/limit, 0);
  }
  else if (v > 1) {
    score *= Math.max(1 - (v-1)/limit, 0);
  }
}

return score;
      });

      pose[0].keypoints.forEach((p,i)=>{p.score=score[i]});

      if (_keypoints3D) {
        if (pose_model_quality == 'Best') {
const z_scale = 1 / pose_model_z_depth_scale;

const hipL = pose[0].keypoints[23];
const hipR = pose[0].keypoints[24];
const hip = {
  x:(hipL.x+hipR.x)/2,
  y:(hipL.y+hipR.y)/2,
  z:(hipL.z+hipR.z)/2
};
const hip_dis = {
  x:(hipL.x-hipR.x),
  y:(hipL.y-hipR.y),
  z:(hipL.z-hipR.z)*z_scale
};
const hip3D_dis = {
  x:(_keypoints3D[23].x-_keypoints3D[24].x),
  y:(_keypoints3D[23].y-_keypoints3D[24].y),
  z:(_keypoints3D[23].z-_keypoints3D[24].z)
};
const scale = Math.sqrt(Math.sqrt(hip3D_dis.x*hip3D_dis.x + hip3D_dis.y*hip3D_dis.y + hip3D_dis.z*hip3D_dis.z)) / Math.sqrt(hip_dis.x*hip_dis.x + hip_dis.y*hip_dis.y + hip_dis.z*hip_dis.z);

pose[0].keypoints3D = pose[0].keypoints.map((landmark, i)=>({
  x: (landmark.x - hip.x) * scale,
  y: (landmark.y - hip.y) * scale,
  z: (landmark.z - hip.z) * scale * z_scale,
  name: BLAZEPOSE_KEYPOINTS[i]
}));

//console.log((pose[0].keypoints3D[23].z-pose[0].keypoints3D[24].z)/(_keypoints3D[23].z-_keypoints3D[24].z), hipL.name,hipR.name);

pose[0].keypoints3D_raw = _keypoints3D.map((landmark, i) => ({
  x: landmark.x,
  y: landmark.y,
  z: landmark.z,
  name: BLAZEPOSE_KEYPOINTS[i]
}));
        }
        else {
          pose[0].keypoints3D = _keypoints3D.map((landmark, i) => ({
x: landmark.x,
y: landmark.y,
z: landmark.z,
name: BLAZEPOSE_KEYPOINTS[i]
          }));
        }
      }

      pose[0].keypoints3D?.forEach((p,i)=>{p.score=score[i]});
    }

    let keypoints_movenet = []
    pose[0].keypoints.forEach((kp) => {
      keypoints_movenet.push({
  position: {x:kp.x, y:kp.y, z:kp.z},
  score: kp.score,
  part: kp.name.replace(/\_(\w)/, (match, p1)=>p1.toUpperCase()),
      });
    });

    if (use_blazepose && use_mediapipe && pose[0].keypoints && pose[0].keypoints.length) {
// temp fix for undefined .score
      pose[0].score = 1
    }

    let result = { score:pose[0].score, keypoints:keypoints_movenet };
    if (pose[0].keypoints3D)
      result.keypoints3D = pose[0].keypoints3D
    if (pose[0].keypoints3D_raw)
      result.keypoints3D_raw = pose[0].keypoints3D_raw

//console.log(result)
    return result;
  }

  function hands_adjust(hands, nowInMs, pose, from_onnx) {
    function landmark_adjust(h, clip) {
const scale = clip[8];
const cw = canvas_hands.width;

return [
  (h.x*cw - clip[4])/scale + clip[0],
  (h.y*cw - clip[5])/scale + clip[1],
  h.z*cw/scale,
];
    }

    function process_handedness(i) {
if (discard_wrong_handedness) {
  hands.multiHandedness = hands.multiHandedness.filter((h,idx)=>idx != i);
  hands.multiHandLandmarks = hands.multiHandLandmarks.filter((h,idx)=>idx != i);
}
else {
  const h = hands.multiHandLandmarks[i];
  const label = hands.multiHandedness[i].categoryName;

  hands.multiHandedness[i].categoryName = hands.multiHandedness[i].label = (label == 'Left') ? 'Right' : 'Left';

  hands.multiHandLandmarks[i] = [
    h[0],
    h[17],h[18],h[19],h[20],
    h[13],h[14],h[15],h[16],
    h[9], h[10],h[11],h[12],
    h[5], h[6], h[7], h[8],
    h[1], h[2], h[3], h[4],
  ];

}
    }

    function palm_distance_squared(side) {
function get_wrist(i) {
  if (side && wrist) return true;

  let _side = hands.multiHandedness[i].categoryName;
  if (canvas_hands && !from_onnx) {
    let clip_index = hand_clip.findIndex(c=>(_side=='Left') ? c[9]==1 : c[9]==-1);
    if (clip_index == -1) return false;

    clip = hand_clip[clip_index];
    wrist = [clip[10], clip[11]];
    return true;
  }
  else {
// assumed mirrored
    const kp = pose.keypoints[get_pose_index((_side=='Left')?10:9)];
    if (kp.score < score_threshold) return false;

    wrist = [kp.position.x, kp.position.y];
    return true;
  }
}

let clip, wrist;
let dis;
dis = hands.multiHandLandmarks.map((hand,i)=>{
  if (!get_wrist(i)) return 9999*9999;

  const palm = (canvas_hands && !from_onnx) ? landmark_adjust(hand[0], clip) : [hand[0].x*w, hand[0].y*h];
  const x = wrist[0] - palm[0];
  const y = wrist[1] - palm[1];
//console.log(i, wrist.slice(), palm.slice())
  return x*x + y*y;
});

return dis;
    }

    function index_to_flip_by_distance(flip_side) {
let side = hands.multiHandedness[0].categoryName;
if (flip_side)
  side = (side == 'Left') ? 'Right' : 'Left';

const dis = palm_distance_squared(side);
//console.log((((dis[0] > dis[1]) ? hands.multiHandedness[0].score > hands.multiHandedness[1].score : hands.multiHandedness[0].score < hands.multiHandedness[1].score)?'higher':'lower')+' score discarded');

return (dis[0] > dis[1]) ? 0 : 1;
    }

    function clipped(i, flip_side) {
const h = hands.multiHandLandmarks[i];
const label = hands.multiHandedness[i].categoryName;

const side = (flip_side) ? 'Right' : 'Left';
let clip_index = hand_clip.findIndex(c=>(label==side) ? c[9]==1 : c[9]==-1);
if (clip_index == -1) return false;

let clip = hand_clip[clip_index];
const h_list = [landmark_adjust(h[0], clip), landmark_adjust(h[9], clip)];

return h_list.some(_h=>(_h[0] >= clip[0]) && (_h[1] >= clip[1]) && (_h[0] <= clip[0]+clip[2]) && (_h[1] <= clip[1]+clip[3]));
    }

    if (!hands || use_human_hands) return hands

    if (options.use_holistic_legacy) {
      const _result = hands
      hands = { image:_result.image, multiHandedness:[], multiHandLandmarks:[] }
      if (_result.leftHandLandmarks && _result.leftHandLandmarks.length) {
        hands.multiHandLandmarks.push(_result.leftHandLandmarks)
// LR flipped
        hands.multiHandedness.push({score:1, categoryName:'Right'})
      }
      if (_result.rightHandLandmarks && _result.rightHandLandmarks.length) {
        hands.multiHandLandmarks.push(_result.rightHandLandmarks)
        hands.multiHandedness.push({score:1, categoryName:'Left'})
      }
    }

    if (!hands.multiHandedness || !hands.multiHandedness.length)
      return [];

// legacy version of mediapipe hands may return more than 2 detections
//if (hands.multiHandedness.length > 2) console.log(hands.multiHandedness.length);
    hands.multiHandedness = hands.multiHandedness.slice(0,2);
    hands.multiHandLandmarks = hands.multiHandLandmarks.slice(0,2);
    

    var _hands = [];
    var iw = hands.image?.width  || w;
    var ih = hands.image?.height || h;

    const adjust_handedness = [];
    let discard_wrong_handedness = true;

    if (!pose || options.use_holistic) {}
    else if (canvas_hands && !from_onnx) {
      if (hands.multiHandedness.length == 1) {
        if (!clipped(0)) {
          if (discard_wrong_handedness || clipped(0,true)) {
            adjust_handedness[0] = true;
//console.log('One side');
          }
        }
      }
      else {
        const idx_list = [0,1];
        if (hands.multiHandedness[0].categoryName != hands.multiHandedness[1].categoryName) {
          if (idx_list.every(i=>!clipped(i))) {
            if (discard_wrong_handedness || idx_list.some(i=>clipped(i,true))) {
              adjust_handedness[0] = adjust_handedness[1] = true;
//console.log('Both sides');
            }
          }
        }
        else {
          if (idx_list.every(i=>clipped(i))) {
            adjust_handedness[index_to_flip_by_distance()] = true;
//console.log('By dstance');
          }
          else if (idx_list.every(i=>clipped(i,true))) {
            if (discard_wrong_handedness) {
              adjust_handedness[0] = adjust_handedness[1] = true;
//console.log('Discarded');
            }
            else {
              adjust_handedness[index_to_flip_by_distance(true)] = true;
            }
//console.log('By dstance, flipped');
          }
          else {
            const idx_correct = idx_list.findIndex(i=>clipped(i));
            if (idx_correct != -1) {
              adjust_handedness[(idx_correct==0)?1:0] = true;
//console.log('Flip the wrong side');
            }
            else if (discard_wrong_handedness) {
              adjust_handedness[0] = adjust_handedness[1] = true;
//console.log('Discarded');
            }
          }
        }
      }
    }
    else {
      if ((hands.multiHandedness.length > 1) && (hands.multiHandedness[0].categoryName == hands.multiHandedness[1].categoryName)) {
        adjust_handedness[index_to_flip_by_distance()] = true;
//console.log('By dstance');
      }
    }

    for (let i = 0; i < 2; i++) {
      if (adjust_handedness[i]) {
        process_handedness(i);
      }
    }

    if (pose) {
      const _multiHandedness = [];
      const _multiHandLandmarks = [];
      // Fail-safe: a non-finite shoulder_width (any pose source that skipped
      // pose_adjust) must not yield a NaN acceptance radius, which makes
      // `dis < dis_to_palm` false for every hand and discards all of them.
      let dis_to_palm = shoulder_width*shoulder_width*0.25 * Math.pow(1 + Math.max(options.stabilize_hand_percent/100-0.2, 0), 4);
      if (!Number.isFinite(dis_to_palm)) dis_to_palm = Infinity;
      palm_distance_squared().forEach((dis,i)=>{
        if (dis < dis_to_palm) {
          _multiHandedness.push(hands.multiHandedness[i]);
          _multiHandLandmarks.push(hands.multiHandLandmarks[i]);
        }
      });
      hands.multiHandedness = _multiHandedness;
      hands.multiHandLandmarks = _multiHandLandmarks;
    }

    for (let i = 0; i < hands.multiHandedness.length; i++) {
      const label = hands.multiHandedness[i].label || hands.multiHandedness[i].categoryName;
//options.video_flipped
      let clip;
      if (!options.use_holistic && canvas_hands && !from_onnx) {
        clip = hand_clip.find(c=>(label=='Left') ? c[9]==1 : c[9]==-1);
        if (!clip) continue;
      }

      const h = hands.multiHandLandmarks[i].map(_h=>{
if (options.use_holistic || !canvas_hands || from_onnx) {
  return [
_h.x*iw,
_h.y*ih,
_h.z*iw,
  ];
}
else {
  return landmark_adjust(_h, clip);
}
      });

      const worldCandidate = Array.isArray(hands.worldLandmarks?.[i])
        ? hands.worldLandmarks[i]
        : null;
      const worldLandmarks = worldCandidate?.length >= 21 ? worldCandidate : null;

      // Build the hand object WITHOUT a `worldLandmarks` key when there is no
      // world-landmark data (the ONNX/native backend path never sends any).
      // Writing `worldLandmarks: undefined` leaves the key present-but-undefined,
      // and the renderer's rig indexes hand.worldLandmarks[0] -> TypeError
      // "Cannot read properties of undefined (reading '0')" -> the rig aborts
      // every frame and NO hand wireframe is ever drawn. Omitting the key keeps
      // the object shaped exactly like a MediaPipe hand that has no world set.
      const hand_entry = {
score: hands.multiHandedness[i].score,
label: hands.multiHandedness[i].label || hands.multiHandedness[i].categoryName,
keypoints: h,
      };
      if (worldLandmarks) {
hand_entry.worldLandmarks = {
  keypoints: worldLandmarks,
  annotations: {
    "palm":   [worldLandmarks[0]],
    "thumb":  [worldLandmarks[1], worldLandmarks[2], worldLandmarks[3], worldLandmarks[4]],
    "index":  [worldLandmarks[5], worldLandmarks[6], worldLandmarks[7], worldLandmarks[8]],
    "middle": [worldLandmarks[9], worldLandmarks[10],worldLandmarks[11],worldLandmarks[12]],
    "ring":   [worldLandmarks[13],worldLandmarks[14],worldLandmarks[15],worldLandmarks[16]],
    "pinky":  [worldLandmarks[17],worldLandmarks[18],worldLandmarks[19],worldLandmarks[20]]
  }
};
      }

      _hands.push(hand_entry);
    }
//console.log(_hands)


    _hands.forEach(hand=>{
const h = hand.keypoints;

//[0,1,5,9,13,17]
let palm_width, palm_height;
palm_width  = [h[1][0]-h[17][0], h[1][1]-h[17][1], h[1][2]-h[17][2]];
palm_height = [h[0][0]-h[9][0],  h[0][1]-h[9][1],  h[0][2]-h[9][2]];

const w_palm = Math.sqrt(palm_width[0]*palm_width[0] + palm_width[1]*palm_width[1] + palm_width[2]*palm_width[2]);
const h_palm = Math.sqrt(palm_height[0]*palm_height[0] + palm_height[1]*palm_height[1] + palm_height[2]*palm_height[2]);

let _adjust_ratio = h_palm / w_palm;

_adjust_ratio = (_adjust_ratio < 1.25) ? 1.25 : ((_adjust_ratio > 1.75) ? 1.75 : 1);
if (_adjust_ratio != 1) {
  const adjust_max = Math.max(Math.abs(palm_height[2]/h_palm), Math.abs(palm_width[2]/w_palm));

  const s = _adjust_ratio * _adjust_ratio;
  palm_width  = [h[1][0]-h[17][0], h[1][1]-h[17][1], h[1][2]-h[17][2]];
  palm_height = [h[0][0]-h[9][0],  h[0][1]-h[9][1],  h[0][2]-h[9][2]];
/*
1.5 * (x1*x1 + y1*y1 + (z1*s)*(z1*s)) = x2*x2 + y2*y2 + (z2*s)*(z2*s)
(z1*s)*(z1*s) - (z2*s)*(z2*s)/1.5 = (x2*x2 + y2*y2)/1.5 - (x1*x1 + y1*y1)
s*s = ((x2*x2 + y2*y2)/1.5 - (x1*x1 + y1*y1))/(z1*z1 - z2*z2/1.5)
*/
  _adjust_ratio = Math.min(Math.sqrt(Math.abs(((palm_height[0]*palm_height[0] + palm_height[1]*palm_height[1])/s - (palm_width[0]*palm_width[0] + palm_width[1]*palm_width[1])) / (palm_width[2]*palm_width[2] - palm_height[2]*palm_height[2]/s))), 1.5 + 1.5*adjust_max);
//console.log(_adjust_ratio)
  h.forEach(j=>{j[2] *= _adjust_ratio});
}
//hand.z_adjust_ratio = _adjust_ratio;


const palm0 = h[0];
for (let f_idx = 0; f_idx < 5; f_idx++) {
  const finger = [];
  for (let idx = 0; idx < 4; idx++)
    finger[idx] = h[f_idx*4+1+idx];

  let dx = finger[0][0] - palm0[0];
  let dy = finger[0][1] - palm0[1];
  let dz = finger[0][1] - palm0[1];
  const ref_length = Math.sqrt(dx*dx + dy*dy + dz*dz) * ((f_idx == 0) ? 2 : 0.75) * 0.5;

  for (let i = 0; i < 3; i++) {
    const f1 = [];
    for (let idx = 0; idx < 3; idx++)
      f1[idx] = finger[i+1][idx] - finger[i][idx];
    const min_length = ref_length * ((i < 2) ? 0.4 : 0.2);// * ((f_idx == 4) ? 0.75 : 1);
    if (f1[0]*f1[0] + f1[1]*f1[1] + f1[2]*f1[2] < min_length*min_length) {
      const z_mod = Math.sign(f1[2]) * Math.sqrt(min_length*min_length - (f1[0]*f1[0] + f1[1]*f1[1]));
//console.log(hand.label+f_idx+':'+z_mod);
      for (let j = i+1; j < 4; j++)
        finger[j][2] += z_mod;
    }
  }
}


if (data_filter[1]) {
  const d = hand.label;
  const palm0 = h[0].slice();
  h.forEach((j,idx)=>{
    j.forEach((v,i)=>{j[i] -= palm0[i]});
    const j_new = data_filter[1][d].landmarks[idx].filter(j, nowInMs);
    j.forEach((v,i)=>{j[i] = j_new[i] + palm0[i]});
  });
}

// ["thumb", "index", "middle", "ring", "pinky"]
hand.annotations = {
  "palm":   [h[0]],
  "thumb":  [h[1], h[2], h[3], h[4]],
  "index":  [h[5], h[6], h[7], h[8]],
  "middle": [h[9], h[10],h[11],h[12]],
  "ring":   [h[13],h[14],h[15],h[16]],
  "pinky":  [h[17],h[18],h[19],h[20]]
};
    });

    return _hands;
  }

  function is_hand_visible(pose, limit_ratio=1) {
    if (!pose || (pose.score < 0.1)) return false;

    const limit = shoulder_width/Math.max(w,h) * 0.5 * limit_ratio;

    const hand_visible = ['left','right'].filter((side)=>{
      const id = (side == 'left') ? 9 : 10;
      const kp = pose.keypoints[id+6];//get_pose_index(id)];
      return (kp.score > score_threshold) && (kp.position.x > -w*limit) && (kp.position.x < w*(1+limit)) && (kp.position.y > -h*limit) && (kp.position.y < h*(1+limit));
    });

    return (hand_visible.length) ? hand_visible : false;
  }

  hand_clip.length = 0;
  function get_hand_canvas(pose) {
    // When wrists are unreliable, periodically search the complete frame.
    if (options?.XRA_full_hand_recovery) return rgba;
//return rgba;
    if (!canvas_hands) return rgba;

const ctx = canvas_hands.getContext('2d');
ctx.save();

//ctx.beginPath();

hand_clip.length = 0;
let clip = [];
const radius = shoulder_width * (1 + Math.max(shoulder_width/Math.max(w,h)*5-0.5, 0.1)) /2 * ((use_hands_worker_parallel) ? 1.2 : 1);
for (const id of [9,10]) {
  const kp = pose.keypoints[get_pose_index(id)];
  if (kp.score < score_threshold) continue;

  let cw = radius * 2;
  let ch = radius * 2;
  let x = kp.position.x - radius;
  if (x < 0) {
    cw += x;
    x = 0;
  }
  let y = kp.position.y - radius;
  if (y < 0) {
    ch += y;
    y = 0;
  }
  if (x + cw > w)
    cw -= (x + cw) - w;
  if (y + ch > h)
    ch -= (y + ch) - h;

  if ((cw <= 0) || (ch <= 0)) continue;

//console.log(id+':',x,y, cw,ch)
// assumed mirrored
  clip.push([x,y, cw,ch, (id==9)?-1:1, kp.position.x,kp.position.y]);
}

if (clip.length) {
  ctx.fillStyle = 'black';
  ctx.fillRect(0,0, canvas_hands.width,canvas_hands.height);

  let x = Math.min(...clip.map(v=>v[0]));
  let y = Math.min(...clip.map(v=>v[1]));
  let cw = Math.max(...clip.map(v=>v[0]+v[2])) - x;
  let ch = Math.max(...clip.map(v=>v[1]+v[3])) - y;

  const c_radius = canvas_hands.width/2;
  let scale;
  if ((cw < radius*4) && (ch < radius*4)) {
    scale = canvas_hands.width / Math.max(cw,ch);
    let x_offset, y_offset;
    if (cw > ch) {
      x_offset = 0;
      y_offset = (canvas_hands.width-ch*scale)/2;
    }
    else {
      x_offset = (canvas_hands.width-cw*scale)/2;
      y_offset = 0;
    }
    clip.forEach(c=>{
      const x2 = x_offset + (c[0]-x)*scale;
      const y2 = y_offset + (c[1]-y)*scale;
      hand_clip.push([c[0],c[1],c[2],c[3], x2,y2,cw*scale,ch*scale, scale, c[4], c[5],c[6]]);
    });
    ctx.drawImage(rgba, x,y,cw,ch, x_offset,y_offset,cw*scale,ch*scale);
  }
  else {
    scale = c_radius / (radius*2);
    clip.forEach((c,i)=>{
      const y2 = Math.max(Math.min( (((c[1] - y + c[3]/2) / ch) - 0.5) * 4, 1), -1) * c_radius/4 + c_radius/2;
//((options.video_flipped)?1:-1)
      const x2 = (c[4] == 1) ? 0 : c_radius;
      hand_clip[i] = [c[0],c[1],c[2],c[3], x2,y2,c[2]/(radius*2)*c_radius,c[3]/(radius*2)*c_radius];
      ctx.drawImage(rgba, ...hand_clip[i]);
      hand_clip[i].push(scale, c[4], c[5],c[6]);
    });
  }
}

ctx.restore();

return (clip.length) ? canvas_hands : rgba;
  }


let use_mediapipe_facemesh = true;
let use_faceLandmarksDetection = true;

function process_facemesh(faces, w,h, bb) {
  let sx = bb.x
  let sy = bb.y
  let cw = bb.w
  let ch = bb.h

  eyes = []

  let face;
  if (use_mediapipe_facemesh) {
    face = {}
    face.faceInViewConfidence = 1
    let min_x=9999, min_y=9999, max_x=-9999, max_y=-9999;
    let mesh=[], scaledMesh=[];
    faces.multiFaceLandmarks[0].forEach((f)=>{
      var x = f.x * cw
      var y = f.y * ch
      var z = f.z * cw

      min_x = Math.min(min_x, x)
      min_y = Math.min(min_y, y)
      max_x = Math.max(max_x, x)
      max_y = Math.max(max_y, y)

      mesh.push([f.x, f.y, f.z])
      scaledMesh.push([x, y, z])
    });
    face.boundingBox = { topLeft:[min_x,min_y], bottomRight:[max_x,max_y] }
    face.scaledMesh = scaledMesh
    face.mesh = mesh
    const size = Math.max(max_x-min_x, max_y-min_y);
    face.mesh.forEach(coords=>{
      coords[0] *= 256 * cw / size;
      coords[1] *= 256 * ch / size;
      coords[2] *= 256 * cw / size;
    });
    faces = [face]
//console.log(face)
  }
  else {
    face = faces[0]
    if (use_human_facemesh) {
      face.faceInViewConfidence = face.confidence
      face.scaledMesh = face.mesh
      face.mesh = face.meshRaw
      face.boundingBox = face.boxRaw
// human v1.1.9+
      face.boundingBox = { topLeft:[face.boxRaw[0]*cw,face.boxRaw[1]*ch], bottomRight:[(face.boxRaw[0]+face.boxRaw[2])*cw,(face.boxRaw[1]+face.boxRaw[3])*ch] }
      const size = Math.max(face.boxRaw[2]*cw, face.boxRaw[3]*ch) / 1.5;
      face.mesh.forEach(coords=>{
        coords[0] *= 256 * cw / size;
        coords[1] *= 256 * ch / size;
        coords[2] *= 256;
      });
    }
    else if (facemesh_version == '@0.0.3') {
      face.boundingBox = { topLeft:face.boundingBox.topLeft[0], bottomRight:face.boundingBox.bottomRight[0]}
    }
  }

//  let bb = face.boundingBox;
//  let face_radius = Math.min(bb.bottomRight[0][0]-bb.topLeft[0][0], bb.bottomRight[0][1]-bb.topLeft[0][1])/2;

  let sm = face.scaledMesh;

  let eye_bb, eye_center, eye_w, eye_h, eye_radius;

// face LR:234,454
// right eye
// LR: 33,133
// TB: 159,145
// left eye
// LR: 362,263
// TB: 386,374

//  let z_diff = face.mesh[454][2] - face.mesh[234][2]
//  let eye_LR = (z_diff > 0) ? ["L","R"] : ["R","L"]
  let eye_LR = ["L","R"] 

  let m454 = face.mesh[454]
  let m234 = face.mesh[234]
  let dx = m454[0] - m234[0]
  let dy = m454[1] - m234[1]
  let dz = m454[2] - m234[2]
  let dis = Math.sqrt(dx*dx + dy*dy + dz*dz)
  let z_rot = Math.asin(dy / dis)

  for (var i = 0; i < 2; i++) {
    let LR = eye_LR[i]
    if (LR == "L") {
      eye_bb = [[Math.min(sm[33][0],sm[133][0],sm[159][0],sm[145][0]), Math.min(sm[33][1],sm[133][1],sm[159][1],sm[145][1])], [Math.max(sm[33][0],sm[133][0],sm[159][0],sm[145][0]), Math.max(sm[33][1],sm[133][1],sm[159][1],sm[145][1])]];
    }
    else {
      eye_bb = [[Math.min(sm[362][0],sm[263][0],sm[386][0],sm[374][0]), Math.min(sm[362][1],sm[263][1],sm[386][1],sm[374][1])], [Math.max(sm[362][0],sm[263][0],sm[386][0],sm[374][0]), Math.max(sm[362][1],sm[263][1],sm[386][1],sm[374][1])]];
    }

    eye_center = [(eye_bb[0][0] + eye_bb[1][0])/2, (eye_bb[0][1] + eye_bb[1][1])/2]
    eye_w = eye_bb[1][0]-eye_bb[0][0]
    eye_h = eye_bb[1][1]-eye_bb[0][1]
    eye_radius = Math.max(eye_w, eye_h)/2

    let yx;
if (use_faceLandmarksDetection) {
// https://github.com/tensorflow/tfjs-models/blob/master/face-landmarks-detection/src/mediapipe-facemesh/keypoints.ts
// NOTE: video source is assumed to be mirrored (eg. video L == landmarks R)
    yx = (sm[473]) ? ((LR == ((use_mediapipe_facemesh)?"R":"L")) ? [sm[473][1], sm[473][0]] : [sm[468][1], sm[468][0]]) : [];
}
else {
  if ((gray_w != cw) || (gray_h != ch)) {
    gray_w = cw
    gray_h = ch
    gray = new Uint8Array(cw*ch);
  }

  const image = {
    "pixels": gray,
    "nrows": ch,
    "ncols": cw,
    "ldim": cw
  };

  let r,c,s;
  r = eye_center[1];
  c = eye_center[0];
  s = eye_radius*2;
  rgba_to_grayscale(rgba, eye_center, eye_radius)
  yx = do_puploc(r, c, s, 63, image);
}

    if ((yx[0] >=0) && (yx[1] >= 0)) {
      let confidence = (0.25 + Math.min(Math.max(eye_radius-5,0)/30, 1) * 0.5)
      dx = (eye_center[0] - yx[1]) / eye_radius
      dy = (eye_center[1] - yx[0]) / eye_radius
      dis = Math.sqrt(dx*dx + dy*dy)
      let eye_z_rot = Math.atan2(dy, dx) - z_rot
      let eye_x = eyes_xy_last[i][0] = Math.max(Math.min(Math.cos(eye_z_rot)*dis, 1), -1) * confidence + eyes_xy_last[i][0] * (1-confidence)
      let eye_y = eyes_xy_last[i][1] = Math.max(Math.min(Math.sin(eye_z_rot)*dis*Math.max(1.5-Math.abs(z_rot)/(Math.PI/4)*0.5,1), 1), -1) * confidence + eyes_xy_last[i][1] * (1-confidence)

      eyes[i] = [yx[1]+sx,yx[0]+sy, eye_x,eye_y, [LR]]
    }
  }

if (!use_faceLandmarksDetection) {
// practically only the first eye data is used
  if (eyes.length) {
    if (!eyes[0])
      eyes = [eyes[1]]
//    let score = eyes[0][5] - ((eyes[1] && eyes[1][5])||99999)
//    if (score > 0) eyes = [eyes[1],eyes[0]]

let eye_x = null
let eye_y = null
//_eyes = (eyes.length==1) ? [eyes[0],eyes[0]] : eyes
//eye_x = (Math.sign(_eyes[0][2]) + Math.sign(_eyes[1][2]) == 0) ? null : ((Math.abs(_eyes[0][2]) > Math.abs(_eyes[1][2])) ? Math.abs(_eyes[0][2]) : Math.abs(_eyes[1][2]));
//eye_y = (Math.sign(_eyes[0][3]) + Math.sign(_eyes[1][3]) == 0) ? null : ((Math.abs(_eyes[0][3]) > Math.abs(_eyes[1][3])) ? Math.abs(_eyes[0][3]) : Math.abs(_eyes[1][3]));
if (eye_x == null) {
  eyes.forEach((e)=>{eye_x+=e[2]})
  eye_x /= eyes.length
}
if (eye_y == null) {
  eyes.forEach((e)=>{eye_y+=e[3]})
  eye_y /= eyes.length
}
eyes.forEach((e)=>{e[2]=eye_x;e[3]=eye_y;})
    eyes[0][4].push(_t_list[1])
  }
}

  if (sx || sy) {
    sm.forEach(xyz => {xyz[0]+=sx; xyz[1]+=sy;});
  }

  faces[0].bb = bb
  faces[0].bb_center = [(face.boundingBox.topLeft[0]+(face.boundingBox.bottomRight[0]-face.boundingBox.topLeft[0])/2+sx)/w, (face.boundingBox.topLeft[1]+(face.boundingBox.bottomRight[1]-face.boundingBox.topLeft[1])/2+sy)/h]

  return faces
}


let score_threshold;

try {
  await this.load_lib(options);
}
catch (err) {
  console.error(err);
  postMessageAT('Facemesh/PoseNet/Handpose ERROR:' + err);
  return;
}

async function PoseAT_process_video_buffer() {
  const XRA_pose_gate_now = performance.now();
  const XRA_pose_interval = 1000 / Math.max(5, XRA_pose_target_fps || 30);
  // NOTE: on the ONNX/native backend path this worker-side replay gate MUST be
  // bypassed. The gate caches XRA_last_pose_payload and re-emits it verbatim on
  // every frame that arrives faster than the target interval. The bridge already
  // paces uploads to the server (targetFps), so the gate is redundant here -- and
  // harmful: if the cached payload was captured on a cold frame whose hands were
  // still empty but whose face was already present, the pipeline replays that
  // frozen packet forever, which is exactly "face animates, hands never move"
  // (and, if the cold frame had neither, "nothing works / calibration stuck").
  // The bridge owns pacing on this path, so run the full pipeline every frame.
  if (!XRA_ONNX_active() && XRA_last_pose_payload && (XRA_pose_gate_now - XRA_last_pose_run_ms) < XRA_pose_interval) {
    // Reply with the last complete mocap packet so the parent worker/main thread
    // remains ready for the next frame. This limits actual inference, not render.
    const reused = Object.assign({}, XRA_last_pose_payload, { xra_reused:true, _t:0 });
    postMessageAT(JSON.stringify(reused));
    return;
  }
  XRA_last_pose_run_ms = XRA_pose_gate_now;

  async function process_hands_worker(_pose=pose) {
    if (!hands_worker_ready) await new Promise((resolve)=>{ setTimeout(resolve, 0); });

    if (hands_worker_ready) {
hands_worker_pose = _pose;

options.pose = _pose;
options.shoulder_width = shoulder_width;

let _rgba = rgba;
if (use_hands_worker_parallel) {
  _rgba = await createImageBitmap(_rgba);
}
else if (!(_rgba instanceof ImageBitmap)) {
  rgba = undefined;
  _rgba = _rgba.data.buffer;
}

let data_to_transfer = [_rgba];
let data = { w:w, h:h, options:options, rgba:_rgba };
if (_canvas_hands_worker) {
  data.canvas_hands = _canvas_hands_worker;
  data_to_transfer.push(_canvas_hands_worker);
}

hands_worker.postMessage(data, data_to_transfer);

_canvas_hands_worker = null;

data_to_transfer.length = 0;
data_to_transfer = undefined;
data.rgba = _rgba = undefined;

hands_worker_ready = false;
    }
  }

  let _t = performance.now();

  // Reset the per-frame ONNX wholebody marker; it is re-set below if this
  // frame's pose came from the backend and carried hands/face.
  XRA_ONNX_wholebody = false;

  if (options.timestamp != null) {
    vt = options.timestamp + vt_offset;
    if (vt <= vt_last + 1) {
      vt_offset = (vt_last - options.timestamp) + 16.6667;
      vt = options.timestamp + vt_offset;;
    }
    vt_last = vt;
  }
  else {
    vt = _t;
  }
//console.log(vt)

  if (rgba instanceof ArrayBuffer)
    rgba = new ImageData(new Uint8ClampedArray(rgba), w,h)
//rgba = tf.browser.fromPixels(rgba)

  let pose, hands, facemesh;
  score_threshold = (use_movenet) ? 0.3 : 0.5;

//  use_mediapipe_facemesh = true
//  use_faceLandmarksDetection = true

  pose_model_z_depth_scale = options.z_depth_scale || 3;

  if (!XRA_ONNX_active() && options.use_holistic_legacy) {
    const result = await holistic_model.predict(rgba, {}, vt);
//console.log(result)

    pose = pose_adjust(result);
    hands = XRA_hands_enabled ? hands_adjust(result, vt, pose) : undefined;

    if (result.faceLandmarks && result.faceLandmarks.length) {
      let faces = process_facemesh({multiFaceLandmarks:[result.faceLandmarks]}, w,h, {x:0, y:0, w:w, h:h, ratio:0, scale:1});

      let face = faces[0]
      let sm = face.scaledMesh;
// NOTE: pass the full scaledMesh as it is needed to be passed and drawn on the facemesh worker
      facemesh = { faces:[{ faceInViewConfidence:face.faceScore||face.faceInViewConfidence||0, scaledMesh:sm, mesh:face.mesh, eyes:eyes, bb_center:face.bb_center, emotion:face.emotion, rotation:face.rotation }] };
//console.log(facemesh)
    }
  }
  else if (!XRA_ONNX_active() && use_human_only) {
    const result = await human.detect(rgba, {
      hand: { enabled: options.use_handpose && XRA_hands_enabled }
    });

    pose = result.body[0]
    hands = result.hand

// human v2.0+
    if (pose.keypoints && pose.keypoints.length && Array.isArray(pose.keypoints[0].position)) {
      pose.keypoints.forEach((kp)=>{
        kp.position = {x:kp.position[0], y:kp.position[1]}
      });
    }
  }
  else {//if (no_hand_countdown <= 0) {
    let _use_hands_worker_parallel;
    const XRA_hand_now = performance.now();
    const XRA_parallel_hand_visible = pose_last && is_hand_visible(pose_last);
    const XRA_parallel_recovery = !!(pose_last && !XRA_parallel_hand_visible && XRA_should_hand_recover(XRA_hand_now));
    if (
      !XRA_ONNX_active() &&
      XRA_hands_enabled &&
      use_hands_worker_parallel &&
      pose_last &&
      (XRA_parallel_hand_visible || XRA_parallel_recovery) &&
      XRA_hand_due(XRA_hand_now)
    ) {
      _use_hands_worker_parallel = true;
      hands_worker_data = null;
      options.XRA_full_hand_recovery = XRA_parallel_recovery;
      await process_hands_worker(pose_last);
      options.XRA_full_hand_recovery = false;
    }

    // ONNX/native backend bridge: when a server-side model is selected we do
    // NOT run the WASM MediaPipe estimator (PoseAT_load_lib skipped it, so
    // posenet_model/holistic would be undefined anyway). Source the rig pose
    // straight from the Python WS backend instead. The bridge returns the same
    // {score, keypoints:[{position,score,part}], keypoints3D, keypoints3D_raw}
    // shape pose_adjust emits, so stabilization / IK / bones are unchanged.
    let XRA_onnx_handled = false;
    if (XRA_ONNX_active()) {
      const onnxPose = XRA_ONNX_pose(rgba, w, h);
      if (onnxPose?._xra_empty) {
        pose = onnxPose;
        hands = [];
        facemesh = null;
        XRA_onnx_handled = true;
        XRA_last_pose_payload = null;
      }
      else if (onnxPose && onnxPose.keypoints && onnxPose.keypoints.length >= 17) {
        pose = onnxPose;
        pose.score = 1.0;
        if (!pose.landmarks) pose.landmarks = pose.keypoints;
        if (!pose.keypoints3D_raw) pose.keypoints3D_raw = pose.keypoints3D;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < pose.keypoints.length; i++) {
          const kp = pose.keypoints[i];
          const pos = kp.position || kp;
          if (pos.x < minX) minX = pos.x;
          if (pos.x > maxX) maxX = pos.x;
          if (pos.y < minY) minY = pos.y;
          if (pos.y > maxY) maxY = pos.y;
        }
        pose.box = { xMin: minX, yMin: minY, width: maxX - minX, height: maxY - minY };
        const onnx_shoulder_width = XRA_pose_shoulder_width(pose);
        shoulder_width = onnx_shoulder_width > 0 ? onnx_shoulder_width : (Math.max(w, h) / 7);
        XRA_onnx_handled = true;
        const onnxHands = XRA_ONNX_hands(w, h);
        if (onnxHands) hands = hands_adjust(onnxHands, vt, pose, true);
        const onnxFace = XRA_ONNX_facemesh(w, h);
        if (onnxFace) facemesh = onnxFace;
        XRA_ONNX_wholebody = !!onnxHands;
      } else {
        // The backend is the selected engine but the socket is still warming up
        // (handshake + first model frame can take a few ms). Return the last
        // cached payload unchanged so calibration / IK / rig does not see an
        // empty pose that resets the hold counter or triggers a false "no body"
        // state. We skip writing XRA_last_pose_payload for this frame too
        // (it is written after this block only when XRA_onnx_handled is true
        // or the MediaPipe branch ran).
        if (XRA_last_pose_payload) {
          // Reuse last good packet: keeps the rig frozen in place instead of
          // snapping to the T-pose during the model warm-up window.
          XRA_backend_replay_last_output("backend_pose_not_fresh");
          return;
        }
        // Very first frame ever, no cached payload: emit a silent empty one
        // (the rig is in T-pose anyway at startup).
        pose = { score:0, keypoints:[], keypoints3D:[], keypoints3D_raw:[] };
        hands = [];
      }
    }

    let result;
    if (options.pose_enabled && !XRA_onnx_handled && !XRA_ONNX_active()) {
      result = await ((use_human_pose) ? human.detect(rgba) : ((use_movenet) ? posenet.estimatePoses(rgba, {}, vt) : posenet_model.estimateSinglePose(rgba, {})));
      pose = pose_adjust((use_human_pose) ? result.body[0] : result);
    }

    if (use_hands_worker_parallel) pose_last = pose;

    if (!XRA_ONNX_active() && options.object_detection?.enabled) {
      if (!object_detection_worker) {
        await new Promise((resolve)=>{
          object_detection_worker = new Worker('object_detection_worker.js');
          object_detection_worker.onmessage = function (e) {
let data = ((typeof e.data == "string") && (e.data.charAt(0) === "{")) ? JSON.parse(e.data) : e.data;

if (typeof data === "string") {
  if (data == 'OK') {
    console.log('(Object Detection worker loaded)');
    resolve();
  }
  object_detection_worker_ready = true;
}
else {
  object_detection_data = data;
//  console.log(Date.now(), object_detection_data);
}
          };
        });
      }
      else if (object_detection_worker_ready) {
const hand_visible = is_hand_visible(pose, 0.2);
if (hand_visible) {
  object_detection_worker_ready = false;

  options.pose = pose;
  options.hand_visible = hand_visible;
  options.vt = vt;

  let _rgba = await createImageBitmap(rgba);

  let data_to_transfer = [_rgba];
  let data = { w:w, h:h, options:options, rgba:_rgba };
  object_detection_worker.postMessage(data, data_to_transfer);

  _rgba = undefined;
}
else {
  object_detection_data = null;
}
      }
    }
    else {
      object_detection_data = null;
    }

    if (options.use_holistic_landmarker && !XRA_ONNX_wholebody && !XRA_ONNX_active()) {
      hands = XRA_hands_enabled ? hands_adjust(result, vt, pose) : undefined;

      if (result.faceLandmarks && result.faceLandmarks.length) {
        let faces = process_facemesh({multiFaceLandmarks:result.faceLandmarks}, w,h, {x:0, y:0, w:w, h:h, ratio:0, scale:1});

        let face = faces[0]
        let sm = face.scaledMesh;
// NOTE: pass the full scaledMesh as it is needed to be passed and drawn on the facemesh worker
        facemesh = { faces:[{ faceInViewConfidence:face.faceScore||face.faceInViewConfidence||0, scaledMesh:sm, mesh:face.mesh, eyes:eyes, bb_center:face.bb_center, emotion:face.emotion, rotation:face.rotation, faceBlendshapes:result.faceBlendshapes?.[0] }] };
//console.log(facemesh)
      }
    }
    else if (
      !XRA_ONNX_wholebody &&
      !XRA_ONNX_active() &&
      XRA_hands_enabled &&
      options.use_handpose &&
      (
        use_hands_worker ||
        ((handpose_model || use_human_hands) && skip_hand_countdown-- <= 0)
      ) &&
      XRA_hand_due(performance.now())
    ) {
      skip_hand_countdown = options.skip_hand_countdown_max||0;
      const XRA_visible_hands = !options.pose_enabled ? true : is_hand_visible(pose);
      const XRA_recovery_due = !XRA_visible_hands && XRA_should_hand_recover(performance.now());
      if (!options.pose_enabled || XRA_visible_hands || XRA_recovery_due) {
        options.XRA_full_hand_recovery = !!XRA_recovery_due;
        if (use_hands_worker_parallel) {
          if (!_use_hands_worker_parallel && XRA_recovery_due) {
            hands_worker_data = null;
            options.XRA_full_hand_recovery = true;
            await process_hands_worker(pose);
            _use_hands_worker_parallel = true;
          }
          if (_use_hands_worker_parallel && !hands_worker_data) await new Promise((resolve)=>{ resolve_hands_worker_parallel = resolve; });
          resolve_hands_worker_parallel = null;
        }
        else if (use_hands_worker) {
          await process_hands_worker();
        }
        else if (handpose_model) {
          handpose_model.set_score?.(w,h, options);
          hands = await handpose_model.estimateHands(get_hand_canvas(pose), vt);
          hands = hands_adjust(hands, vt, pose);
        }
        else {
          const result = await human.detect(rgba)
          hands = result.hand
        }
        options.XRA_full_hand_recovery = false;
        no_hand_countdown = no_hand_countdown_max
      }
      else {
        if (use_hands_worker_parallel) {
// basically dummy to wait for hands worker to finish
          if (_use_hands_worker_parallel && !hands_worker_data) await new Promise((resolve)=>{ resolve_hands_worker_parallel = resolve; });
// ignore use_hands_worker_parallel for next frame
          pose_last = null;
        }

        no_hand_countdown--;
// discard outdated data when hands are hidden
        hands_worker_data = null;
      }
    }
  }
/*
  else {
    let p_list = [(use_human_pose) ? human.detect(rgba).then(result=>result.body[0]) : ((use_movenet) ? posenet.estimatePoses(rgba, {}, vt) : posenet_model.estimateSinglePose(rgba, {})).then(_pose=>_pose)]
    if (options.use_handpose && (handpose_model || use_human_hands) && (skip_hand_countdown-- <= 0)) {
      skip_hand_countdown = options.skip_hand_countdown_max||0
      p_list.push((handpose_model) ? handpose_model.estimateHands(get_hand_canvas(), vt).then(_hands=>_hands) : human.detect(rgba).then(result=>result.hand));
    }

    const values = await Promise.all(p_list);

    pose = pose_adjust(values[0])
    if (p_list.length > 1) {
      if (is_hand_visible(pose)) {
        hands = hands_adjust(values[1])
        no_hand_countdown = no_hand_countdown_max
      }
      else {
        no_hand_countdown--
      }
    }
  }
*/

  const XRA_pose_state = XRA_pose_tracking_state(pose, w, h, !!options.pose_enabled);
  const XRA_held_tracking = XRA_hold_invalid_tracking(pose, hands, XRA_pose_state);
  pose = XRA_held_tracking.pose;
  hands = XRA_held_tracking.hands;

  const XRA_fresh_hands_this_frame = !!(hands && Array.isArray(hands) && hands.length);
  if (XRA_fresh_hands_this_frame) XRA_last_hands_seen_ms = performance.now();



  // Standalone Split mode: when hand inference is intentionally throttled, keep
  // the latest valid hand pose briefly (up to ~140ms / during countdown) rather
  // than clearing/flickering between samples. Once hands leave camera, clear promptly.
  if (!options.use_holistic_landmarker && XRA_hands_enabled) {
    if (XRA_fresh_hands_this_frame) {
      XRA_last_hands_result = hands;
    }
    else if (XRA_last_hands_result && no_hand_countdown > 0 && (performance.now() - XRA_last_hands_seen_ms) < 140) {
      hands = XRA_last_hands_result;
    }
    else {
      XRA_last_hands_result = null;
      hands = [];
    }
  }
  if (!XRA_hands_enabled) {
    XRA_last_hands_result = null;
    hands = [];
  }

  _t = performance.now() - _t +(options._t||0);

  fps_ms += _t
  if (++fps_count >= 20) {
    fps = 1000 / (fps_ms/fps_count)
    fps_count = fps_ms = 0
  }

  let _t_hands, fps_hands;
  if (!XRA_hands_enabled) {
    hands_worker_data = null;
  }
  if (use_hands_worker_parallel && hands_worker_data) {
    hands = hands_worker_data.handpose;
    if (hands && Array.isArray(hands) && hands.length) XRA_last_hands_seen_ms = performance.now();
    hands_worker_data = null;
  }

  if (hands_worker_data) {
//console.log(hands_worker_data)
    _t_hands = hands_worker_data._t;
    fps_hands = hands_worker_data.fps;

    hands = hands_worker_data.handpose;
    for (const id of [9,10]) {
      const hand = hands.find(h=>h.label==((id==9)?'Left':'Right'));
      if (!hand) continue;

      const kp = pose.keypoints[get_pose_index(id)];
      if (!kp || kp.score < score_threshold) continue;

      const kp_hands = hands_worker_pose.keypoints[get_pose_index(id)];
      if (!kp_hands || kp_hands.score < score_threshold) continue;


      const x_offset = kp.position.x - kp_hands.position.x;
      const y_offset = kp.position.y - kp_hands.position.y;
      hand.keypoints.forEach(k=>{
        k[0] += x_offset;
        k[1] += y_offset;
      });
    }

    hands_worker_data = null;
  }
  else if (hands) {
    _t_hands = _t;
    fps_hands = fps;
    hands = hands.filter((h)=>h.annotations&&Object.keys(h.annotations).length);
  }

  // A parallel hand worker may finish after the body hold was selected above.
  // Re-assert cached hands only if body stabilization is on and hands were active.
  // Motion hysteresis ignores hands so they can enter/exit freely without freeze.
  if (XRA_body_stabilization_enabled && !XRA_motion_hysteresis_enabled && XRA_pose_loss_active && XRA_last_stable_hands && XRA_last_hands_result) {
    hands = XRA_last_stable_hands;
  }
 
  if (XRA_hands_enabled && XRA_fresh_hands_this_frame) {
    XRA_last_hands_result = hands;
  }

  if (facemesh) {
    facemesh._t = _t
    facemesh.fps = fps
  }

  if (!XRA_hands_enabled || !hands) hands = [];

  XRA_send_pose_tracking_state(XRA_pose_state);

  // Holistic pipelines can report face presence directly to the UI thread.
  // Split Face+Body uses the native facemesh runtime and is detected there.
  if (XRA_control_channel && (options.use_holistic_landmarker || options.use_holistic_legacy)) {
    const faces = facemesh?.faces;
    const present = !!(Array.isArray(faces) && faces.length);
    const c = present ? Number(faces[0]?.faceInViewConfidence ?? faces[0]?.faceScore) : NaN;
    XRA_control_channel.postMessage({
      type: 'face_tracking_state',
      available: true,
      present,
      confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null,
      source: 'mocap-worker',
      signature: present ? String(faces[0]?.scaledMesh?.length || faces[0]?.mesh?.length || 1) : '0'
    });
  }

  if (XRA_control_channel) {
    const leftHandDetected = Array.isArray(hands) && hands.some(h => (h.label || h.categoryName) === 'Left');
    const rightHandDetected = Array.isArray(hands) && hands.some(h => (h.label || h.categoryName) === 'Right');
    XRA_control_channel.postMessage({
      type: 'hands_tracking_state',
      left: leftHandDetected,
      right: rightHandDetected,
      timestamp: performance.now()
    });
  }

      const XRA_payload = { posenet:pose, object_detection:object_detection_data, handpose:hands, facemesh:facemesh, _t:_t, fps:fps, _t_hands:_t_hands, fps_hands:fps_hands };
      XRA_last_pose_payload = XRA_payload;

  XRA_send_telemetry({
    inference_ms:_t,
    fps:fps,
    hands_ms:_t_hands,
    hands_fps:fps_hands,
    holistic:!!options.use_holistic_landmarker
  });
  XRA_backend_post_output(XRA_payload);
}

async function HandsAT_process_video_buffer() {
  let _t = performance.now();

  if (options.timestamp != null) {
    vt = options.timestamp + vt_offset;
    if (vt <= vt_last + 1) {
      vt_offset = (vt_last - options.timestamp) + 16.6667;
      vt = options.timestamp + vt_offset;;
    }
    vt_last = vt;
  }
  else {
    vt = _t;
  }
//console.log(vt)

  if (rgba instanceof ArrayBuffer)
    rgba = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), w,h));
//rgba = tf.browser.fromPixels(rgba)

  let pose, hands;
  let score_threshold = 0.5;

  pose = options.pose;
  shoulder_width = options.shoulder_width;

  handpose_model.set_score?.(w,h, options);
  hands = await handpose_model.estimateHands(get_hand_canvas(pose), vt);
  hands = hands_adjust(hands, vt, pose);

  _t = performance.now() - _t +(options._t||0);

  fps_ms += _t
  if (++fps_count >= 20) {
    fps = 1000 / (fps_ms/fps_count)
    fps_count = fps_ms = 0
  }

  if (hands) {
    hands = hands.filter((h)=>h.annotations&&Object.keys(h.annotations).length);
  }

  if (!XRA_hands_enabled) hands = [];

  postMessageAT(JSON.stringify({ handpose:hands, _t:_t, fps:fps }));
}

  if (this.AT.type == 'PoseAT') {
    await PoseAT_process_video_buffer();
  }
  else if (this.AT.type == 'HandsAT') {
    await HandsAT_process_video_buffer();
  }

  if (rgba instanceof ImageBitmap) rgba.close();
//rgba.dispose();

  rgba = undefined;
}

// https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/constants.ts
const BLAZEPOSE_KEYPOINTS = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index'
];

const blazepose_translated = [
0, 2,5, 7,8, 11,12,13,14,15,16, 23,24,25,26,27,28
];

function get_pose_index(id) {
  return blazepose_translated[id];
}



// core START
this.AT = AT;

AT.path_adjusted = path_adjusted;

postMessageAT = (is_worker) ? postMessage : function (msg, transfer) {
  AT._worker.onmessage({data:msg});
};

if (AT.type == 'PoseAT') {
  this.init = PoseAT_init;
  this.load_lib = PoseAT_load_lib;
}
else if (AT.type == 'HandsAT') {
  this.init = HandsAT_init;
  this.load_lib = HandsAT_load_lib;
}

// core END

}

export { Core };
