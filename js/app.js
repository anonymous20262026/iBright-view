import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const SCENES = ["sofa", "BlueHawaii", "Cupcake", "GearWorks", "bike"];
const VIDEO_SCENES = ["BlueHawaii", "Sculpture", "Cupcake", "sofa"];
const COMPARE_SCENES = ["BlueHawaii", "Sculpture", "Cupcake", "sofa", "GearWorks"];
const COMPARE_METHODS = [
  ["input_lowlight.jpg", "Low-light input"],
  ["i3dgs.jpg", "i3DGS"],
  ["3dgs.jpg", "3DGS"],
  ["llgs.jpg", "LLGS"],
  ["luminance-gs.jpg", "Luminance-GS"],
  ["lita-gs.jpg", "LITA-GS"],
  ["retinexgs.jpg", "RetinexGS"],
  ["ours.jpg", "iBright-GS (Ours)"],
  ["gt.jpg", "Normal-light GT"],
];

const state = {
  scene: "sofa",
  appearance: "bright",
  compareScene: "BlueHawaii",
  videoScene: "BlueHawaii",
  videoMethod: "retinexgs",
  loadId: 0,
};

let renderer = null;
let scene3d = null;
let camera = null;
let controls = null;
let spark = null;
let splat = null;
let raf = 0;
let resizeObs = null;

const $ = (id) => document.getElementById(id);

function sceneButtons(container, scenes, active, onClick) {
  container.innerHTML = "";
  for (const scene of scenes) {
    const btn = document.createElement("button");
    btn.className = "chip" + (scene === active ? " active" : "");
    btn.textContent = scene;
    btn.addEventListener("click", () => onClick(scene));
    container.appendChild(btn);
  }
}

function setStatus(text, show = true) {
  const el = $("viewer-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("hidden", !show);
}

function stopLoop() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function disposeViewer() {
  stopLoop();
  if (resizeObs) {
    resizeObs.disconnect();
    resizeObs = null;
  }
  if (controls) {
    controls.dispose();
    controls = null;
  }
  if (splat && scene3d) {
    scene3d.remove(splat);
  }
  splat = null;
  spark = null;
  scene3d = null;
  camera = null;
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
}

function resizeToHost(host) {
  if (!renderer || !camera) return;
  const w = Math.max(host.clientWidth, 1);
  const h = Math.max(host.clientHeight, 1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let cameras = {};

function toYup(v) {
  return new THREE.Vector3(v[0], -v[1], -v[2]);
}

function frameSplat() {
  const cam = cameras[state.scene];
  if (cam) {
    const pos = toYup(cam.position);
    const look = toYup(cam.lookAt);
    const dist = Math.max(pos.distanceTo(look), 0.35);
    camera.near = Math.max(dist / 60, 0.02);
    camera.far = dist * 20;
    camera.up.set(0, 1, 0);
    camera.position.copy(pos);
    camera.lookAt(look);
    camera.updateProjectionMatrix();
    controls.target.copy(look);
    controls.minDistance = dist * 0.12;
    controls.maxDistance = dist * 8;
    controls.update();
    return;
  }
  splat.updateMatrixWorld(true);
  const box = typeof splat.getBoundingBox === "function"
    ? splat.getBoundingBox(true)
    : new THREE.Box3().setFromObject(splat);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.35) * 0.35;
  camera.near = Math.max(radius / 60, 0.02);
  camera.far = Math.max(radius * 30, 20);
  camera.up.set(0, 1, 0);
  camera.position.set(center.x, center.y + radius * 0.05, center.z + radius * 1.15);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = radius * 0.12;
  controls.maxDistance = radius * 12;
  controls.update();
}

async function loadScene() {
  const loadId = ++state.loadId;
  const host = $("viewer");
  disposeViewer();
  host.innerHTML = "";
  const status = document.createElement("div");
  status.id = "viewer-status";
  host.appendChild(status);
  setStatus("Loading Gaussians…");

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x0c0a09, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);

  scene3d = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.02, 50);
  spark = new SparkRenderer({ renderer });
  spark.maxPixelRadius = 160;
  scene3d.add(spark);
  resizeToHost(host);

  const url = `assets/ply/${state.scene}/${state.appearance}.ply`;
  splat = new SplatMesh({ url });
  splat.quaternion.set(1, 0, 0, 0);
  scene3d.add(splat);

  try {
    await splat.initialized;
    if (loadId !== state.loadId) return;
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 1.1;
    frameSplat();
    setStatus("", false);
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene3d, camera);
    };
    tick();
    resizeObs = new ResizeObserver(() => resizeToHost(host));
    resizeObs.observe(host);
  } catch (err) {
    if (loadId !== state.loadId) return;
    console.error(err);
    setStatus("Failed to load this scene. Try sofa or bike.");
  }
}

function renderCompare() {
  const grid = $("compare-grid");
  grid.innerHTML = "";
  const scene = state.compareScene;
  for (const [file, label] of COMPARE_METHODS) {
    const src = `assets/images/${scene}/${file}`;
    const card = document.createElement("figure");
    card.className = "card" + (file === "ours.jpg" ? " ours" : "");
    card.innerHTML = `<img src="${src}" alt="${label}" onerror="this.parentNode.style.display='none'"><figcaption>${label}</figcaption>`;
    grid.appendChild(card);
  }
}

function renderVideos() {
  const scene = state.videoScene;
  $("video-ours").src = `assets/videos/orbit_ibright_${scene}.mp4`;
  $("video-base").src = `assets/videos/orbit_${state.videoMethod}_${scene}.mp4`;
  $("video-ours").play().catch(() => {});
  $("video-base").play().catch(() => {});
}

function renderAblation() {
  const grid = $("ablation-grid");
  const items = [
    ["gt.jpg", "GT"],
    ["wo_bright_sh0.jpg", "w/o Bright SH0"],
    ["wo_freeze_geo.jpg", "w/o Freeze Geo"],
    ["ours.jpg", "Ours"],
  ];
  grid.innerHTML = items.map(([file, label]) => {
    const ours = file === "ours.jpg" ? " ours" : "";
    return `<figure class="card${ours}"><img src="assets/images/GearWorks/${file}" alt="${label}"><figcaption>${label}</figcaption></figure>`;
  }).join("");
}

function bindToolbar() {
  sceneButtons($("scene-tabs"), SCENES, state.scene, (scene) => {
    state.scene = scene;
    bindToolbar();
    loadScene();
  });
  $("btn-bright").classList.toggle("active", state.appearance === "bright");
  $("btn-dark").classList.toggle("active", state.appearance === "dark");
}

$("btn-bright").addEventListener("click", () => {
  state.appearance = "bright";
  bindToolbar();
  loadScene();
});
$("btn-dark").addEventListener("click", () => {
  state.appearance = "dark";
  bindToolbar();
  loadScene();
});

function bindCompare() {
  sceneButtons($("compare-tabs"), COMPARE_SCENES, state.compareScene, (scene) => {
    state.compareScene = scene;
    bindCompare();
    renderCompare();
  });
}
function bindVideos() {
  sceneButtons($("video-tabs"), VIDEO_SCENES, state.videoScene, (scene) => {
    state.videoScene = scene;
    bindVideos();
    renderVideos();
  });
}
bindCompare();
bindVideos();
$("video-method").addEventListener("change", (e) => {
  state.videoMethod = e.target.value;
  renderVideos();
});

bindToolbar();
fetch("assets/cameras.json")
  .then((r) => r.json())
  .then((data) => {
    cameras = data;
    loadScene();
  })
  .catch(() => loadScene());
renderCompare();
renderVideos();
renderAblation();
