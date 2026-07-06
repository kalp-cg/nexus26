/**
 * Nexus26 - Procedural 3D WebGL Stadium Map Renderer
 * Built using Three.js and OrbitControls
 */

/* eslint-disable no-unused-vars */

class Stadium3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;

    this.gateSpheres = {};
    this.gateLines = {};
    this.pathMesh = null;
    this.userPinMesh = null;

    this.isPulsing = false;
    this.pulseScale = 1.0;
    this.pulseDir = 1;

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 390;
    const height = this.container.clientHeight || 240;

    // 1. Scene Setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a); // Slate dark

    // 2. Camera Setup (Isometric Angle)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 1, 1000);
    this.camera.position.set(0, 180, 240);

    // 3. Renderer Setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    // 4. OrbitControls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2.1; // Don't allow camera to go below ground
    this.controls.minDistance = 80;
    this.controls.maxDistance = 450;

    // 5. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight1.position.set(100, 200, 100);
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x06b6d4, 0.3); // Cyan ambient direction
    dirLight2.position.set(-100, 50, -100);
    this.scene.add(dirLight2);

    // 6. Build procedural geometries
    this.buildGround();
    this.buildPitch();
    this.buildStands();
    this.buildStaticNodes();
    this.buildGates();

    // 7. Start Render Loop
    this.animate();

    // Handle Resize
    window.addEventListener('resize', () => this.onWindowResize());
  }

  buildGround() {
    // Floor Grid / Platform
    const floorGeo = new THREE.PlaneGeometry(380, 380);
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0x1e293b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.2
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = Math.PI / 2;
    floor.position.y = -0.5;
    this.scene.add(floor);

    // Subtle radial grid lines
    const grid = new THREE.GridHelper(340, 16, 0x334155, 0x1e293b);
    grid.position.y = 0;
    this.scene.add(grid);
  }

  buildPitch() {
    // Grass Field in the Center
    const pitchGeo = new THREE.PlaneGeometry(100, 65);
    const pitchMat = new THREE.MeshStandardMaterial({
      color: 0x10b981, // Emerald Green
      roughness: 0.8,
      metalness: 0.1
    });
    const pitch = new THREE.Mesh(pitchGeo, pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.y = 0.1;
    this.scene.add(pitch);

    // Simple touchline boundary helper
    const borderGeo = new THREE.PlaneGeometry(102, 67);
    const borderMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const border = new THREE.Mesh(borderGeo, borderMat);
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.05;
    this.scene.add(border);
  }

  buildStands() {
    // Create nested elliptical arenas for Stands
    const createEllipticalStand = (rx, rz, height, yPos, color) => {
      const standGroup = new THREE.Group();

      const geom = new THREE.CylinderGeometry(rx, rx - 15, height, 32, 1, true);
      const mat = new THREE.MeshStandardMaterial({
        color: color,
        side: THREE.DoubleSide,
        roughness: 0.5,
        transparent: true,
        opacity: 0.85
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.y = yPos;

      // Make it slightly elliptical by scaling Z
      mesh.scale.set(1.0, 1.0, rz / rx);
      standGroup.add(mesh);
      return standGroup;
    };

    // Stacking 3 tiers of stands
    const tier1 = createEllipticalStand(90, 75, 12, 6, 0x334155); // Tier 1 (Low)
    const tier2 = createEllipticalStand(115, 95, 18, 21, 0x1e293b); // Tier 2 (Mid)
    const tier3 = createEllipticalStand(140, 115, 24, 42, 0x0f172a); // Tier 3 (Upper)

    this.scene.add(tier1);
    this.scene.add(tier2);
    this.scene.add(tier3);

    // Outer Stadium columns / structural pillars
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const x = Math.cos(angle) * 142;
      const z = Math.sin(angle) * 117;

      const colGeo = new THREE.CylinderGeometry(1.5, 2.5, 54, 8);
      const colMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
      const column = new THREE.Mesh(colGeo, colMat);
      column.position.set(x, 27, z);
      this.scene.add(column);
    }
  }

  buildStaticNodes() {
    // Mapping function from 2D coordinates to 3D
    const mapCoord = (x, y) => {
      return {
        x: (x - 225) * 0.75,
        z: (y - 225) * 0.75
      };
    };

    // Transit Hub (T)
    const transit = mapCoord(200, 420);
    const transitRingGeo = new THREE.RingGeometry(10, 13, 32);
    const transitRingMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, side: THREE.DoubleSide });
    const transitRing = new THREE.Mesh(transitRingGeo, transitRingMat);
    transitRing.rotation.x = -Math.PI / 2;
    transitRing.position.set(transit.x, 0.5, transit.z);
    this.scene.add(transitRing);

    // Rideshare Hub (R)
    const rideshare = mapCoord(380, 380);
    const rideshareRingGeo = new THREE.RingGeometry(10, 13, 32);
    const rideshareRingMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, side: THREE.DoubleSide });
    const rideshareRing = new THREE.Mesh(rideshareRingGeo, rideshareRingMat);
    rideshareRing.rotation.x = -Math.PI / 2;
    rideshareRing.position.set(rideshare.x, 0.5, rideshare.z);
    this.scene.add(rideshareRing);

    // User Position Marker (Initially at transit hub)
    const pinGeo = new THREE.SphereGeometry(3.5, 16, 16);
    const pinMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    this.userPinMesh = new THREE.Mesh(pinGeo, pinMat);
    this.userPinMesh.position.set(transit.x, 3.5, transit.z);
    this.scene.add(this.userPinMesh);
  }

  buildGates() {
    const gatesData = [
      { id: 'A1', x: 100, y: 160 },
      { id: 'A2', x: 300, y: 100 },
      { id: 'B1', x: 200, y: 300 }
    ];

    gatesData.forEach(gate => {
      const pos = this.mapSVGTo3D(gate.x, gate.y);
      const floatHeight = 25;

      // 1. Dashed coordinate support line to ground
      const linePoints = [
        new THREE.Vector3(pos.x, 0.1, pos.z),
        new THREE.Vector3(pos.x, floatHeight, pos.z)
      ];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const lineMat = new THREE.LineDashedMaterial({
        color: 0x64748b,
        dashSize: 4,
        gapSize: 3
      });
      const supportLine = new THREE.Line(lineGeo, lineMat);
      supportLine.computeLineDistances();
      this.scene.add(supportLine);
      this.gateLines[gate.id] = supportLine;

      // 2. Base ground circle indicator
      const baseGeo = new THREE.RingGeometry(0, 5, 16);
      const baseMat = new THREE.MeshBasicMaterial({ color: 0x475569, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.rotation.x = -Math.PI / 2;
      base.position.set(pos.x, 0.2, pos.z);
      this.scene.add(base);

      // 3. Floating 3D status sphere
      const sphereGeo = new THREE.SphereGeometry(6, 32, 32);
      const sphereMat = new THREE.MeshStandardMaterial({
        color: 0x10b981, // Default Stable Green
        roughness: 0.1,
        metalness: 0.9,
        emissive: 0x10b981,
        emissiveIntensity: 0.2
      });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.set(pos.x, floatHeight, pos.z);
      this.scene.add(sphere);

      this.gateSpheres[gate.id] = sphere;
    });
  }

  mapSVGTo3D(svgX, svgY, svgHeight = 0) {
    // Map SVG bounding box (0 to 450) to 3D dimensions centered on [0, 0]
    return {
      x: (svgX - 225) * 0.75,
      z: (svgY - 225) * 0.75,
      y: svgHeight
    };
  }

  setGateCongestion(gateId, level) {
    const sphere = this.gateSpheres[gateId];
    if (!sphere) return;

    let color = 0x10b981; // Green
    if (level === 'critical') {
      color = 0xef4444; // Red
      this.isPulsing = true;
    } else if (level === 'high') {
      color = 0xff7a00; // Amber
    }

    sphere.material.color.setHex(color);
    sphere.material.emissive.setHex(color);

    if (level === 'critical') {
      sphere.material.emissiveIntensity = 0.5;
    } else {
      sphere.material.emissiveIntensity = 0.15;
    }
  }

  drawPath3D(pathCoords, rerouted) {
    this.clearPath3D();

    if (!pathCoords || pathCoords.length < 2) return;

    const points3D = [];

    // Map path coordinates
    for (let i = 0; i < pathCoords.length; i++) {
      const pt = pathCoords[i];
      let y = 0.4; // Ground height

      // Lift the final coordinate (Seat Section) into the stands!
      if (i === pathCoords.length - 1) {
        y = 18; // Height elevation inside Tier 1
      }

      const pos = this.mapSVGTo3D(pt[0], pt[1], y);
      points3D.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    // Move user pin to first point
    if (this.userPinMesh && points3D.length > 0) {
      this.userPinMesh.position.copy(points3D[0]);
      this.userPinMesh.position.y += 3.5; // sit above floor
    }

    // Render path as a glowing 3D Tube geometry
    const curve = new THREE.CatmullRomCurve3(points3D);
    const tubeGeo = new THREE.TubeGeometry(curve, 64, 2.2, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: rerouted ? 0xef4444 : 0x06b6d4, // Red or Cyan
      transparent: true,
      opacity: 0.85
    });

    this.pathMesh = new THREE.Mesh(tubeGeo, tubeMat);
    this.scene.add(this.pathMesh);
  }

  clearPath3D() {
    if (this.pathMesh) {
      this.scene.remove(this.pathMesh);
      this.pathMesh.geometry.dispose();
      this.pathMesh.material.dispose();
      this.pathMesh = null;
    }
    // Return pin to transit hub default
    if (this.userPinMesh) {
      const def = this.mapSVGTo3D(200, 420, 3.5);
      this.userPinMesh.position.set(def.x, def.y, def.z);
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    // Update controls
    if (this.controls) this.controls.update();

    // Pulse critical gates
    if (this.isPulsing) {
      this.pulseScale += 0.015 * this.pulseDir;
      if (this.pulseScale > 1.3) this.pulseDir = -1;
      if (this.pulseScale < 0.9) this.pulseDir = 1;

      Object.keys(this.gateSpheres).forEach(gateId => {
        const sphere = this.gateSpheres[gateId];
        // Check if gate is red (critical)
        if (sphere && sphere.material.color.getHexString() === 'ef4444') {
          sphere.scale.set(this.pulseScale, this.pulseScale, this.pulseScale);
        } else if (sphere) {
          sphere.scale.set(1.0, 1.0, 1.0);
        }
      });
    }

    // Render scene
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  onWindowResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    if (this.camera && this.renderer) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    }
  }
}
