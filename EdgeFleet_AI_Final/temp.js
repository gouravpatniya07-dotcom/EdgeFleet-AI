
      (function () {
        'use strict';

        // --- SOUND SYNTHESIZER (Web Audio API - zero dependencies) ---
        let audioCtx = null;
        let soundEnabled = false;

        function initAudio() {
          if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
              audioCtx = new AudioContext();
            }
          }
          if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
          }
        }

        function playTone(freq, type, duration, gainVal = 0.05) {
          if (!soundEnabled || !audioCtx) return;
          try {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
            gain.gain.setValueAtTime(gainVal, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + duration);
          } catch (e) {
            // Audio context safely ignored if blocked
          }
        }

        function playConflictBeep() {
          playTone(520, 'sine', 0.12, 0.04);
          setTimeout(() => playTone(680, 'sine', 0.15, 0.04), 80);
        }

        function playObstacleBeep() {
          playTone(280, 'triangle', 0.2, 0.06);
        }

        function playCompleteBeep() {
          playTone(600, 'sine', 0.1, 0.03);
          setTimeout(() => playTone(880, 'sine', 0.18, 0.03), 100);
        }

        // --- SIMULATION CONFIG & CONSTANTS ---
        const WORLD_W = 1200;
        const WORLD_H = 800;
        const CELL_SIZE = 25; // 48 x 32 grid cells
        const GRID_COLS = Math.floor(WORLD_W / CELL_SIZE);
        const GRID_ROWS = Math.floor(WORLD_H / CELL_SIZE);

        // Mutable System & Physics Parameters (modifiable via Manual Tuner & JSON)
        let COMMS_RADIUS = 180; // P2P radio broadcast range
        let SAFETY_RADIUS = 26; // Hard collision bubble
        let YIELD_CLEARANCE = 44; // Space-time conflict trigger distance
        let HORIZON_SECONDS = 4.5;
        const HORIZON_STEPS = 12;
        let BATTERY_DRAIN_MULTIPLIER = 1.0;

        // Interactive Tool Mode
        let activeTool = 'select'; // 'select' | 'target' | 'draw' | 'erase' | 'station' | 'teleport'
        let isPointerDragging = false;
        let pendingStationPos = { col: 0, row: 0, x: 0, y: 0 };

        // --- GRID & WAREHOUSE ENVIRONMENT ---
        // 0: Free floor, 1: Static Shelf/Wall, 2: Dynamic Obstacle
        const grid = new Uint8Array(GRID_COLS * GRID_ROWS);

        function gridIndex(c, r) {
          return r * GRID_COLS + c;
        }

        function isBlocked(c, r) {
          if (c < 1 || c >= GRID_COLS - 1 || r < 1 || r >= GRID_ROWS - 1) return true;
          return grid[gridIndex(c, r)] > 0;
        }

        // Warehouse Racks definition (in grid cells)
        const racks = [
          // Shelf Block A (Top Left)
          { c1: 6, r1: 4, c2: 12, r2: 8, label: 'RACK A1' },
          { c1: 15, r1: 4, c2: 21, r2: 8, label: 'RACK A2' },
          // Shelf Block B (Mid Left)
          { c1: 6, r1: 12, c2: 12, r2: 16, label: 'RACK B1' },
          { c1: 15, r1: 12, c2: 21, r2: 16, label: 'RACK B2' },
          // Shelf Block C (Bottom Left)
          { c1: 6, r1: 20, c2: 12, r2: 24, label: 'RACK C1' },
          { c1: 15, r1: 20, c2: 21, r2: 24, label: 'RACK C2' },

          // Shelf Block D (Top Right)
          { c1: 27, r1: 4, c2: 33, r2: 8, label: 'RACK D1' },
          { c1: 36, r1: 4, c2: 42, r2: 8, label: 'RACK D2' },
          // Shelf Block E (Mid Right)
          { c1: 27, r1: 12, c2: 33, r2: 16, label: 'RACK E1' },
          { c1: 36, r1: 12, c2: 42, r2: 16, label: 'RACK E2' },
          // Shelf Block F (Bottom Right)
          { c1: 27, r1: 20, c2: 33, r2: 24, label: 'RACK F1' },
          { c1: 36, r1: 20, c2: 42, r2: 24, label: 'RACK F2' },
        ];

        // Populate static racks into grid
        racks.forEach(rack => {
          for (let c = rack.c1; c <= rack.c2; c++) {
            for (let r = rack.r1; r <= rack.r2; r++) {
              grid[gridIndex(c, r)] = 1;
            }
          }
        });

        // Stations
        const STATIONS = {
          PICKUP_1: { name: 'Inbound Bay 1', x: 2 * CELL_SIZE + 12, y: 6 * CELL_SIZE + 12, type: 'pickup', col: 2, row: 6 },
          PICKUP_2: { name: 'Inbound Bay 2', x: 2 * CELL_SIZE + 12, y: 14 * CELL_SIZE + 12, type: 'pickup', col: 2, row: 14 },
          PICKUP_3: { name: 'Inbound Bay 3', x: 2 * CELL_SIZE + 12, y: 22 * CELL_SIZE + 12, type: 'pickup', col: 2, row: 22 },

          DROPOFF_1: { name: 'Packing Dock 1', x: 45 * CELL_SIZE + 12, y: 6 * CELL_SIZE + 12, type: 'dropoff', col: 45, row: 6 },
          DROPOFF_2: { name: 'Packing Dock 2', x: 45 * CELL_SIZE + 12, y: 14 * CELL_SIZE + 12, type: 'dropoff', col: 45, row: 14 },
          DROPOFF_3: { name: 'Packing Dock 3', x: 45 * CELL_SIZE + 12, y: 22 * CELL_SIZE + 12, type: 'dropoff', col: 45, row: 22 },

          CHARGE_1: { name: 'Fast Charger 1', x: 18 * CELL_SIZE + 12, y: 29 * CELL_SIZE + 12, type: 'charge', col: 18, row: 29 },
          CHARGE_2: { name: 'Fast Charger 2', x: 30 * CELL_SIZE + 12, y: 29 * CELL_SIZE + 12, type: 'charge', col: 30, row: 29 },

          JUNCTION_CENTRAL: { name: 'Main Crossroads', x: 24 * CELL_SIZE + 12, y: 14 * CELL_SIZE + 12, type: 'waypoint', col: 24, row: 14 }
        };

        // --- DYNAMIC OBSTACLES ---
        const dynamicObstacles = new Set(); // set of gridIndex

        function toggleObstacleAtWorldPos(wx, wy) {
          const c = Math.floor(wx / CELL_SIZE);
          const r = Math.floor(wy / CELL_SIZE);
          if (c < 1 || c >= GRID_COLS - 1 || r < 1 || r >= GRID_ROWS - 1) return;

          const idx = gridIndex(c, r);
          if (grid[idx] === 1) return; // Cannot place on static shelves

          if (dynamicObstacles.has(idx)) {
            dynamicObstacles.delete(idx);
            grid[idx] = 0;
            addTelemetry('OBSTACLE', `Obstacle removed at (${c * CELL_SIZE}, ${r * CELL_SIZE})`);
          } else {
            dynamicObstacles.add(idx);
            grid[idx] = 2;
            playObstacleBeep();
            addTelemetry('OBSTACLE', `Dynamic obstacle placed at Grid[${c},${r}] (Cell: ${c * CELL_SIZE},${r * CELL_SIZE})`);
            
            // Check if any AMR is affected and trigger local dynamic replanning
            fleet.forEach(amr => {
              const d = Math.hypot(amr.x - (c * CELL_SIZE + CELL_SIZE / 2), amr.y - (r * CELL_SIZE + CELL_SIZE / 2));
              if (d < 220) {
                amr.handleObstacleDetected(c, r);
              }
            });
          }
        }

        function clearAllObstacles() {
          dynamicObstacles.forEach(idx => {
            grid[idx] = 0;
          });
          dynamicObstacles.clear();
          addTelemetry('OBSTACLE', 'All dynamic floor obstacles cleared.');
          fleet.forEach(amr => amr.replan());
        }

        // --- PATHFINDING: A* WITH SAFETY MARGINS & DIAGONALS ---
        function findPath(startCol, startRow, targetCol, targetRow, avoidDynamicIndices = null) {
          if (startCol === targetCol && startRow === targetRow) {
            return [{ c: targetCol, r: targetRow, x: targetCol * CELL_SIZE + CELL_SIZE / 2, y: targetRow * CELL_SIZE + CELL_SIZE / 2 }];
          }

          // Open set: min-heap or priority list
          const openList = [];
          const closedSet = new Uint8Array(GRID_COLS * GRID_ROWS);
          const gScore = new Float32Array(GRID_COLS * GRID_ROWS).fill(1e9);
          const parent = new Int32Array(GRID_COLS * GRID_ROWS).fill(-1);

          const startIdx = gridIndex(startCol, startRow);
          const targetIdx = gridIndex(targetCol, targetRow);

          gScore[startIdx] = 0;
          const hStart = Math.hypot(targetCol - startCol, targetRow - startRow);
          openList.push({ idx: startIdx, c: startCol, r: startRow, f: hStart });

          const neighbors = [
            { dc: 1, dr: 0, cost: 1.0 },
            { dc: -1, dr: 0, cost: 1.0 },
            { dc: 0, dr: 1, cost: 1.0 },
            { dc: 0, dr: -1, cost: 1.0 },
            // Diagonals with slightly higher cost
            { dc: 1, dr: 1, cost: 1.414 },
            { dc: -1, dr: 1, cost: 1.414 },
            { dc: 1, dr: -1, cost: 1.414 },
            { dc: -1, dr: -1, cost: 1.414 },
          ];

          let iterations = 0;
          const maxIterations = 2500;

          while (openList.length > 0 && iterations++ < maxIterations) {
            // Find lowest f
            let bestIndex = 0;
            for (let i = 1; i < openList.length; i++) {
              if (openList[i].f < openList[bestIndex].f) bestIndex = i;
            }
            const current = openList.splice(bestIndex, 1)[0];

            if (current.idx === targetIdx) {
              // Reconstruct path
              const path = [];
              let currIdx = targetIdx;
              while (currIdx !== -1) {
                const c = currIdx % GRID_COLS;
                const r = Math.floor(currIdx / GRID_COLS);
                path.push({ c, r, x: c * CELL_SIZE + CELL_SIZE / 2, y: r * CELL_SIZE + CELL_SIZE / 2 });
                currIdx = parent[currIdx];
              }
              path.reverse();
              return smoothPath(path);
            }

            closedSet[current.idx] = 1;

            for (let n of neighbors) {
              const nc = current.c + n.dc;
              const nr = current.r + n.dr;

              if (nc < 1 || nc >= GRID_COLS - 1 || nr < 1 || nr >= GRID_ROWS - 1) continue;
              const nIdx = gridIndex(nc, nr);

              if (closedSet[nIdx]) continue;

              // Check obstacle
              if (grid[nIdx] > 0 && nIdx !== targetIdx) continue;
              if (avoidDynamicIndices && avoidDynamicIndices.has(nIdx) && nIdx !== targetIdx) continue;

              // For diagonal movement, ensure no corner cutting through walls
              if (n.dc !== 0 && n.dr !== 0) {
                if (grid[gridIndex(current.c + n.dc, current.r)] > 0 || grid[gridIndex(current.c, current.r + n.dr)] > 0) {
                  continue;
                }
              }

              // Extra clearance penalty near rack corners for smooth robotic turns
              let clearancePenalty = 0;
              if (isBlocked(nc + 1, nr) || isBlocked(nc - 1, nr) || isBlocked(nc, nr + 1) || isBlocked(nc, nr - 1)) {
                clearancePenalty = 0.5;
              }

              const tentativeG = gScore[current.idx] + n.cost + clearancePenalty;
              if (tentativeG < gScore[nIdx]) {
                parent[nIdx] = current.idx;
                gScore[nIdx] = tentativeG;
                const h = Math.hypot(targetCol - nc, targetRow - nr);
                const f = tentativeG + h;

                const existing = openList.find(item => item.idx === nIdx);
                if (existing) {
                  existing.f = f;
                } else {
                  openList.push({ idx: nIdx, c: nc, r: nr, f });
                }
              }
            }
          }

          // Fallback if target unreached: return direct or empty
          return [];
        }

        // Line-of-sight path smoother for clean continuous AMR navigation
        function smoothPath(rawPath) {
          if (rawPath.length <= 2) return rawPath;
          const smoothed = [rawPath[0]];
          let currentIdx = 0;

          while (currentIdx < rawPath.length - 1) {
            let furthest = currentIdx + 1;
            for (let check = currentIdx + 2; check < rawPath.length; check++) {
              if (hasLineOfSight(rawPath[currentIdx].x, rawPath[currentIdx].y, rawPath[check].x, rawPath[check].y)) {
                furthest = check;
              } else {
                break;
              }
            }
            smoothed.push(rawPath[furthest]);
            currentIdx = furthest;
          }
          return smoothed;
        }

        function hasLineOfSight(x0, y0, x1, y1) {
          const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL_SIZE * 0.4));
          for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const px = x0 + (x1 - x0) * t;
            const py = y0 + (y1 - y0) * t;
            const c = Math.floor(px / CELL_SIZE);
            const r = Math.floor(py / CELL_SIZE);
            if (grid[gridIndex(c, r)] > 0) return false;
          }
          return true;
        }

        // --- AUTONOMOUS MOBILE ROBOT (AMR) CLASS ---
        let nextRobotUniqueId = 1;

        class AMR {
          constructor(config) {
            this.id = config.id;
            this.name = config.name;
            this.color = config.color;
            this.accent = config.accent;
            
            // Physics / Pose
            this.x = config.initialX;
            this.y = config.initialY;
            this.heading = config.initialHeading || 0; // radians
            this.speed = 0;
            this.maxSpeed = config.maxSpeed || 65; // px per sec
            this.turnRate = 4.5; // rad/sec
            
            // State: NAVIGATING, YIELDING, DETOURING, BLOCKED, CHARGING, DOCKED
            this.state = 'NAVIGATING';
            this.statusReason = 'Routine Logistics';
            
            // Priorities:
            // 5: Low Battery Critical
            // 4: Rush High-Priority Delivery
            // 3: Loaded Cargo Transport
            // 2: Empty Repositioning
            // 1: Low Priority Staging
            this.basePriority = config.basePriority || 3;
            this.priority = this.basePriority;
            this.priorityReason = 'Standard Mission';
            
            // Mission & Battery
            this.battery = config.battery || 85; // percentage
            this.carryingPayload = config.carryingPayload || false;
            this.payloadType = 'Smart Tote';
            this.deliveriesCompleted = 0;
            this.deconflictionsCount = 0;
            this.collisionsCount = 0;
            
            // Navigation
            this.currentTargetStation = null;
            this.path = [];
            this.pathIndex = 0;
            this.predictedHorizon = []; // Space-time horizon: [{ x, y, t, heading }]
            
            // P2P Deconfliction Engine
            this.yieldingTo = null; // AMR instance
            this.yieldTimer = 0;
            this.yieldDuration = 0;
            this.spaceTimeConflictPoint = null; // { x, y, timeToConflict, peerId }
            this.peersInRange = new Set();
            this.tempAvoidArea = new Set();
            
            // Initial task assignment
            this.assignNextTask(config.initialDestination);
          }

          assignNextTask(forcedStation = null) {
            if (this.battery < 22) {
              // Emergency Charging Docking
              const charger = Math.random() > 0.5 ? STATIONS.CHARGE_1 : STATIONS.CHARGE_2;
              this.currentTargetStation = charger;
              this.priority = 5;
              this.priorityReason = 'Critical Battery Override';
              this.statusReason = 'En Route to Charger';
              addTelemetry('BATTERY', `${this.id} low battery (${Math.round(this.battery)}%). Priority elevated to P5 (Emergency Dock).`);
            } else if (forcedStation) {
              this.currentTargetStation = forcedStation;
              this.statusReason = `Moving to ${forcedStation.name}`;
            } else {
              // Standard cycle: Pickup -> Dropoff
              if (!this.carryingPayload) {
                const pickups = [STATIONS.PICKUP_1, STATIONS.PICKUP_2, STATIONS.PICKUP_3];
                this.currentTargetStation = pickups[Math.floor(Math.random() * pickups.length)];
                this.priority = 2;
                this.priorityReason = 'Empty Relocation';
                this.statusReason = `Heading to ${this.currentTargetStation.name}`;
              } else {
                const dropoffs = [STATIONS.DROPOFF_1, STATIONS.DROPOFF_2, STATIONS.DROPOFF_3];
                this.currentTargetStation = dropoffs[Math.floor(Math.random() * dropoffs.length)];
                // Randomly assign rush priority to some missions
                const isRush = Math.random() < 0.25;
                this.priority = isRush ? 4 : 3;
                this.priorityReason = isRush ? 'Express Rush Order' : 'Standard Loaded Transport';
                this.statusReason = `Delivering to ${this.currentTargetStation.name}`;
              }
            }

            this.replan();
          }

          replan() {
            if (!this.currentTargetStation) return;
            const startCol = Math.max(1, Math.min(GRID_COLS - 2, Math.floor(this.x / CELL_SIZE)));
            const startRow = Math.max(1, Math.min(GRID_ROWS - 2, Math.floor(this.y / CELL_SIZE)));
            
            const newPath = findPath(startCol, startRow, this.currentTargetStation.col, this.currentTargetStation.row, this.tempAvoidArea);
            if (newPath.length > 0) {
              this.path = newPath;
              this.pathIndex = 0;
              this.state = 'NAVIGATING';
              this.spaceTimeConflictPoint = null;
            } else {
              this.state = 'BLOCKED';
              this.statusReason = 'Path completely obstructed';
            }
            this.updatePredictedHorizon();
          }

          handleObstacleDetected(col, row) {
            // Check if this obstacle sits along upcoming path
            for (let i = this.pathIndex; i < Math.min(this.pathIndex + 6, this.path.length); i++) {
              const wp = this.path[i];
              const d = Math.hypot(wp.x - (col * CELL_SIZE + CELL_SIZE / 2), wp.y - (row * CELL_SIZE + CELL_SIZE / 2));
              if (d < CELL_SIZE * 1.8) {
                this.state = 'DETOURING';
                this.statusReason = 'Dynamic Obstacle Avoidance';
                addTelemetry('DETOUR', `${this.id} on-board LIDAR detected floor spill at Grid[${col},${row}]. Local A* replan triggered.`);
                this.replan();
                return;
              }
            }
          }

          updatePredictedHorizon() {
            this.predictedHorizon = [];
            if (!this.path || this.pathIndex >= this.path.length) {
              this.predictedHorizon.push({ x: this.x, y: this.y, t: 0, heading: this.heading });
              return;
            }

            let currX = this.x;
            let currY = this.y;
            let accumulatedDist = 0;
            let currentPathIdx = this.pathIndex;

            this.predictedHorizon.push({ x: currX, y: currY, t: 0, heading: this.heading });

            const estSpeed = Math.max(25, this.speed > 5 ? this.speed : this.maxSpeed * 0.85);

            for (let step = 1; step <= HORIZON_STEPS; step++) {
              const targetTime = (step / HORIZON_STEPS) * HORIZON_SECONDS;
              const targetDist = targetTime * estSpeed;

              // Step forward along path until targetDist is reached
              while (currentPathIdx < this.path.length) {
                const targetWp = this.path[currentPathIdx];
                const segDist = Math.hypot(targetWp.x - currX, targetWp.y - currY);
                if (accumulatedDist + segDist >= targetDist) {
                  const rem = targetDist - accumulatedDist;
                  const ratio = segDist > 0.001 ? rem / segDist : 0;
                  const projX = currX + (targetWp.x - currX) * ratio;
                  const projY = currY + (targetWp.y - currY) * ratio;
                  const projHeading = Math.atan2(targetWp.y - currY, targetWp.x - currX);
                  this.predictedHorizon.push({ x: projX, y: projY, t: targetTime, heading: projHeading });
                  break;
                } else {
                  accumulatedDist += segDist;
                  currX = targetWp.x;
                  currY = targetWp.y;
                  currentPathIdx++;
                }
              }

              if (currentPathIdx >= this.path.length) {
                // Past end of path, stay at goal
                const lastWp = this.path[this.path.length - 1] || { x: this.x, y: this.y };
                this.predictedHorizon.push({ x: lastWp.x, y: lastWp.y, t: targetTime, heading: this.heading });
              }
            }
          }

          // --- P2P DECONFLICTION STEP ---
          evaluateP2PBroadcast(peers) {
            this.peersInRange.clear();
            let activeConflict = null;

            for (let peer of peers) {
              if (peer === this) continue;
              const dist = Math.hypot(peer.x - this.x, peer.y - this.y);
              if (dist <= COMMS_RADIUS) {
                this.peersInRange.add(peer);
                // Check future space-time trajectory overlap
                const conflict = this.detectSpaceTimeConflict(peer);
                if (conflict) {
                  activeConflict = conflict;
                }
              }
            }

            if (activeConflict) {
              const peer = activeConflict.peer;
              const conflictTime = activeConflict.time;
              const conflictLoc = activeConflict.loc;

              // Deterministic priority calculation:
              // Higher score wins right of way. Tie-breaker: lexicographical ID comparison
              const myRank = this.priority * 100 + (this.id.charCodeAt(4) || 0);
              const peerRank = peer.priority * 100 + (peer.id.charCodeAt(4) || 0);

              if (myRank < peerRank) {
                // We are LOWER priority -> WE YIELD
                if (this.state !== 'YIELDING') {
                  this.state = 'YIELDING';
                  this.yieldingTo = peer;
                  this.statusReason = `Yielding to ${peer.name} (Pri: ${this.priority} < ${peer.priority})`;
                  this.yieldTimer = 0;
                  this.deconflictionsCount++;
                  playConflictBeep();
                  addTelemetry('DECONFLICT', `[SPACE-TIME CONFLICT] ${this.id} yields to ${peer.id} at (${Math.round(conflictLoc.x)}, ${Math.round(conflictLoc.y)}) t=${conflictTime.toFixed(1)}s [P${this.priority} < P${peer.priority}]`);
                }
                this.spaceTimeConflictPoint = { ...conflictLoc, time: conflictTime, peerId: peer.id };
              } else {
                // We are HIGHER priority -> MAINTAIN RIGHT OF WAY
                if (this.state === 'YIELDING' && this.yieldingTo === peer) {
                  this.state = 'NAVIGATING';
                  this.yieldingTo = null;
                }
                this.spaceTimeConflictPoint = { ...conflictLoc, time: conflictTime, peerId: peer.id };
                this.statusReason = `Right-of-Way over ${peer.name}`;
              }
            } else {
              // No space-time conflict detected
              if (this.state === 'YIELDING') {
                this.yieldTimer += 0.1;
                // Wait until peer has cleared or yield timeout
                if (!this.yieldingTo || Math.hypot(this.yieldingTo.x - this.x, this.yieldingTo.y - this.y) > YIELD_CLEARANCE * 1.5 || this.yieldTimer > 2.0) {
                  this.state = 'NAVIGATING';
                  this.yieldingTo = null;
                  this.spaceTimeConflictPoint = null;
                  this.statusReason = 'Cleared intersection; resuming track';
                }
              } else if (this.state !== 'CHARGING' && this.state !== 'BLOCKED') {
                this.spaceTimeConflictPoint = null;
              }
            }
          }

          detectSpaceTimeConflict(peer) {
            if (!this.predictedHorizon || !peer.predictedHorizon) return null;
            const count = Math.min(this.predictedHorizon.length, peer.predictedHorizon.length);

            for (let i = 1; i < count; i++) {
              const myPos = this.predictedHorizon[i];
              const peerPos = peer.predictedHorizon[i];
              const dist = Math.hypot(myPos.x - peerPos.x, myPos.y - peerPos.y);

              if (dist < YIELD_CLEARANCE) {
                return {
                  peer: peer,
                  time: myPos.t,
                  loc: { x: (myPos.x + peerPos.x) / 2, y: (myPos.y + peerPos.y) / 2 }
                };
              }
            }
            return null;
          }

          // --- KINEMATICS & MOVEMENT UPDATE ---
          update(dt) {
            // Battery drain / recharge
            if (this.state === 'CHARGING') {
              this.battery = Math.min(100, this.battery + dt * 3.5);
              if (this.battery >= 98) {
                this.state = 'NAVIGATING';
                this.priority = this.basePriority;
                this.priorityReason = 'Routine Logistics';
                addTelemetry('BATTERY', `${this.id} fully charged. Resuming logistics duties.`);
                this.assignNextTask();
              }
              return;
            } else {
              this.battery = Math.max(5, this.battery - dt * 0.16 * BATTERY_DRAIN_MULTIPLIER);
              if (this.battery < 20 && this.priority < 5 && this.currentTargetStation?.type !== 'charge') {
                this.assignNextTask();
              }
            }

            // If yielding: decelerate smoothly to zero
            if (this.state === 'YIELDING') {
              this.speed = Math.max(0, this.speed - dt * 60);
              this.yieldTimer += dt;
              // If stuck in yield for too long, execute dynamic detour around conflict point
              if (this.yieldTimer > 3.2) {
                addTelemetry('DETOUR', `${this.id} standoff duration exceeded 3.2s. Computing dynamic detour corridor.`);
                this.state = 'DETOURING';
                this.statusReason = 'Taking alternate detour';
                // Add temporary cost to current next waypoint to force detour
                if (this.path[this.pathIndex]) {
                  const wp = this.path[this.pathIndex];
                  this.tempAvoidArea.add(gridIndex(Math.floor(wp.x / CELL_SIZE), Math.floor(wp.y / CELL_SIZE)));
                  this.replan();
                  setTimeout(() => this.tempAvoidArea.clear(), 6000);
                }
              }
              return;
            }

            if (!this.path || this.pathIndex >= this.path.length) {
              this.speed = 0;
              // Check if reached station
              if (this.currentTargetStation) {
                const distToGoal = Math.hypot(this.currentTargetStation.x - this.x, this.currentTargetStation.y - this.y);
                if (distToGoal < CELL_SIZE * 1.5) {
                  this.onStationReached();
                }
              }
              return;
            }

            // Normal Navigation along path
            const target = this.path[this.pathIndex];
            const dx = target.x - this.x;
            const dy = target.y - this.y;
            const dist = Math.hypot(dx, dy);

            if (dist < 12) {
              this.pathIndex++;
              if (this.pathIndex >= this.path.length) {
                this.onStationReached();
                return;
              }
            }

            // Desired heading
            const desiredHeading = Math.atan2(dy, dx);
            let angleDiff = desiredHeading - this.heading;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

            // Turn smoothly toward waypoint
            const turnStep = this.turnRate * dt;
            if (Math.abs(angleDiff) < turnStep) {
              this.heading = desiredHeading;
            } else {
              this.heading += Math.sign(angleDiff) * turnStep;
            }

            // Align speed with heading error (slow down during sharp turns)
            const alignmentFactor = Math.max(0.2, Math.cos(angleDiff));
            const targetSpeed = this.maxSpeed * alignmentFactor;

            // Accelerate / decelerate
            if (this.speed < targetSpeed) {
              this.speed = Math.min(targetSpeed, this.speed + dt * 45);
            } else {
              this.speed = Math.max(targetSpeed, this.speed - dt * 55);
            }

            // Move forward
            this.x += Math.cos(this.heading) * this.speed * dt;
            this.y += Math.sin(this.heading) * this.speed * dt;

            this.updatePredictedHorizon();
          }

          onStationReached() {
            if (!this.currentTargetStation) return;

            if (this.currentTargetStation.type === 'charge') {
              this.state = 'CHARGING';
              this.statusReason = 'Inductive High-Power Fast Charging';
              addTelemetry('BATTERY', `${this.id} docked at ${this.currentTargetStation.name}. Recharging...`);
            } else if (this.currentTargetStation.type === 'pickup') {
              this.carryingPayload = true;
              this.statusReason = 'Loaded smart tote; transferring to dropoff';
              playCompleteBeep();
              addTelemetry('MISSION', `${this.id} picked up cargo at ${this.currentTargetStation.name}.`);
              this.assignNextTask();
            } else if (this.currentTargetStation.type === 'dropoff') {
              this.carryingPayload = false;
              this.deliveriesCompleted++;
              updateTotalDeliveries();
              playCompleteBeep();
              addTelemetry('MISSION', `${this.id} completed delivery at ${this.currentTargetStation.name}! (Total: ${this.deliveriesCompleted})`);
              this.assignNextTask();
            } else {
              this.assignNextTask();
            }
          }

          setManualDestination(col, row, x, y, name = 'Target Waypoint') {
            this.currentTargetStation = {
              name: name,
              col: col,
              row: row,
              x: x,
              y: y,
              type: 'manual',
              isManualWaypoint: true
            };
            this.state = 'NAVIGATING';
            this.statusReason = `Dispatched to (${Math.round(x)}, ${Math.round(y)})`;
            this.replan();
            addTelemetry('MISSION', `${this.id} manually dispatched to target (${Math.round(x)}, ${Math.round(y)}).`);
          }

          teleport(x, y) {
            this.x = x;
            this.y = y;
            this.speed = 0;
            this.replan();
            addTelemetry('P2P', `Operator teleported ${this.id} to (${Math.round(x)}, ${Math.round(y)}).`);
          }

          teleop(action) {
            if (action === 'fwd') {
              this.speed = Math.min(this.maxSpeed, this.speed + 15);
              this.x += Math.cos(this.heading) * 12;
              this.y += Math.sin(this.heading) * 12;
              this.statusReason = 'Manual Teleop Driving Forward';
            } else if (action === 'back') {
              this.x -= Math.cos(this.heading) * 10;
              this.y -= Math.sin(this.heading) * 10;
              this.statusReason = 'Manual Teleop Reversing';
            } else if (action === 'left') {
              this.heading -= 0.25;
              this.statusReason = 'Manual Teleop Steering Left';
            } else if (action === 'right') {
              this.heading += 0.25;
              this.statusReason = 'Manual Teleop Steering Right';
            } else if (action === 'stop') {
              this.speed = 0;
              this.state = 'BLOCKED';
              this.statusReason = 'Manual Teleop Emergency Stop';
              addTelemetry('P2P', `Emergency halt issued to ${this.id}`);
            }
            this.x = Math.max(15, Math.min(WORLD_W - 15, this.x));
            this.y = Math.max(15, Math.min(WORLD_H - 15, this.y));
            this.predictedHorizon = [];
          }
        }

        // --- FLEET INITIALIZATION ---
        const fleet = [
          new AMR({
            id: 'AMR-01',
            name: 'Alpha',
            color: '#06b6d4',
            accent: 'rgba(6, 182, 212, 0.25)',
            initialX: 2 * CELL_SIZE + 12,
            initialY: 6 * CELL_SIZE + 12,
            initialHeading: 0,
            basePriority: 3,
            battery: 88,
            initialDestination: STATIONS.DROPOFF_1
          }),
          new AMR({
            id: 'AMR-02',
            name: 'Beta',
            color: '#f59e0b',
            accent: 'rgba(245, 158, 11, 0.25)',
            initialX: 45 * CELL_SIZE + 12,
            initialY: 14 * CELL_SIZE + 12,
            initialHeading: Math.PI,
            basePriority: 2,
            battery: 76,
            initialDestination: STATIONS.PICKUP_2
          }),
          new AMR({
            id: 'AMR-03',
            name: 'Gamma',
            color: '#10b981',
            accent: 'rgba(16, 185, 129, 0.25)',
            initialX: 24 * CELL_SIZE + 12,
            initialY: 29 * CELL_SIZE + 12,
            initialHeading: -Math.PI / 2,
            basePriority: 2,
            battery: 92,
            initialDestination: STATIONS.PICKUP_3
          }),
          new AMR({
            id: 'AMR-04',
            name: 'Delta',
            color: '#a855f7',
            accent: 'rgba(168, 85, 247, 0.25)',
            initialX: 24 * CELL_SIZE + 12,
            initialY: 2 * CELL_SIZE + 12,
            initialHeading: Math.PI / 2,
            basePriority: 4,
            battery: 64,
            initialDestination: STATIONS.DROPOFF_3
          })
        ];

        let selectedAMR = fleet[0];

        // --- TELEMETRY & STATS SYSTEM ---
        let simTime = 0;
        let isRunning = true;
        let simSpeed = 2.0;
        let totalDeliveries = 0;
        let totalDeconflictions = 0;
        let totalCollisions = 0;
        let packetsPerSec = 0;
        let packetsCountInWindow = 0;

        const telemetryLogs = [];
        const maxLogs = 120;

        function addTelemetry(tag, message) {
          const timestamp = formatSimTime(simTime);
          const entry = { time: timestamp, tag, message };
          telemetryLogs.unshift(entry);
          if (telemetryLogs.length > maxLogs) telemetryLogs.pop();
          renderTelemetryLog();
        }

        function formatSimTime(sec) {
          const m = Math.floor(sec / 60);
          const s = (sec % 60).toFixed(1);
          return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
        }

        function updateTotalDeliveries() {
          totalDeliveries++;
          document.getElementById('hdr-deliveries').textContent = totalDeliveries;
          recordDeliveryEvent(simTime);
        }

        // --- D3 REAL-TIME FLEET THROUGHPUT (DPM) ENGINE ---
        const deliveryTimestamps = [];
        const throughputSamples = [];
        let peakDpm = 0;

        // Initialize with 60 historical second slots (trailing 60 seconds)
        for (let i = 59; i >= 0; i--) {
          throughputSamples.push({ timeAgo: -i, dpm: 0 });
        }

        function recordDeliveryEvent(t) {
          deliveryTimestamps.push(t);
        }

        function updateThroughputMetrics() {
          const windowSec = 60;
          const cutoff = simTime - windowSec;

          // Prune events outside rolling 60-second window
          while (deliveryTimestamps.length > 0 && deliveryTimestamps[0] < cutoff) {
            deliveryTimestamps.shift();
          }

          // Count deliveries in the last 60 seconds
          const recentCount = deliveryTimestamps.length;
          // Calculate Deliveries Per Minute (DPM)
          const effectiveTimeWindow = Math.min(windowSec, Math.max(10, simTime));
          const currentDpm = Number(((recentCount / effectiveTimeWindow) * 60).toFixed(1));

          if (currentDpm > peakDpm) {
            peakDpm = currentDpm;
          }

          // Push new sample
          throughputSamples.push({ timeAgo: 0, dpm: currentDpm });
          if (throughputSamples.length > 60) {
            throughputSamples.shift();
          }

          // Shift timeAgo indices (-59 ... 0)
          for (let i = 0; i < throughputSamples.length; i++) {
            throughputSamples[i].timeAgo = -(throughputSamples.length - 1 - i);
          }

          // Average DPM over the trailing window
          const sumDpm = throughputSamples.reduce((acc, s) => acc + s.dpm, 0);
          const avgDpm = (sumDpm / throughputSamples.length).toFixed(1);

          // Update HUD readout elements
          const curEl = document.getElementById('d3-stat-current');
          const peakEl = document.getElementById('d3-stat-peak');
          const avgEl = document.getElementById('d3-stat-avg');
          if (curEl) curEl.textContent = currentDpm.toFixed(1);
          if (peakEl) peakEl.textContent = peakDpm.toFixed(1);
          if (avgEl) avgEl.textContent = avgDpm;

          renderD3ThroughputChart();
        }

        function renderD3ThroughputChart() {
          const container = document.getElementById('d3-chart-wrapper');
          const svgEl = document.getElementById('d3-throughput-svg');
          if (!container || !svgEl) return;

          const rect = container.getBoundingClientRect();
          if (rect.width <= 0) return; // pane not currently visible

          const width = rect.width;
          const height = rect.height || 160;
          const margin = { top: 12, right: 16, bottom: 22, left: 28 };
          const innerW = width - margin.left - margin.right;
          const innerH = height - margin.top - margin.bottom;

          if (window.d3) {
            const d3 = window.d3;
            const svg = d3.select(svgEl);
            svg.attr('viewBox', `0 0 ${width} ${height}`);
            svg.selectAll('*').remove();

            // Gradient for glowing area
            const defs = svg.append('defs');
            const grad = defs.append('linearGradient')
              .attr('id', 'd3-throughput-gradient')
              .attr('x1', '0%').attr('y1', '0%')
              .attr('x2', '0%').attr('y2', '100%');
            grad.append('stop').attr('offset', '0%').attr('stop-color', '#06b6d4').attr('stop-opacity', 0.4);
            grad.append('stop').attr('offset', '100%').attr('stop-color', '#06b6d4').attr('stop-opacity', 0.0);

            const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

            // Scales
            const xScale = d3.scaleLinear()
              .domain([-60, 0])
              .range([0, innerW]);

            const maxDataDpm = d3.max(throughputSamples, d => d.dpm) || 0;
            const yDomainMax = Math.max(6, Math.ceil(maxDataDpm * 1.3));
            const yScale = d3.scaleLinear()
              .domain([0, yDomainMax])
              .range([innerH, 0]);

            // Subtle Gridlines
            const yGrid = d3.axisLeft(yScale)
              .ticks(4)
              .tickSize(-innerW)
              .tickFormat('');
            g.append('g')
              .attr('class', 'd3-grid')
              .call(yGrid);

            // Area under curve
            const area = d3.area()
              .x(d => xScale(d.timeAgo))
              .y0(innerH)
              .y1(d => yScale(d.dpm))
              .curve(d3.curveMonotoneX);

            g.append('path')
              .datum(throughputSamples)
              .attr('class', 'd3-area')
              .attr('d', area);

            // Line stroke
            const line = d3.line()
              .x(d => xScale(d.timeAgo))
              .y(d => yScale(d.dpm))
              .curve(d3.curveMonotoneX);

            g.append('path')
              .datum(throughputSamples)
              .attr('class', 'd3-line')
              .attr('d', line);

            // Axes
            const xAxis = d3.axisBottom(xScale)
              .ticks(5)
              .tickFormat(d => d === 0 ? 'Now' : `${d}s`);
            g.append('g')
              .attr('class', 'd3-axis')
              .attr('transform', `translate(0,${innerH})`)
              .call(xAxis);

            const yAxis = d3.axisLeft(yScale)
              .ticks(4)
              .tickFormat(d => `${d}`);
            g.append('g')
              .attr('class', 'd3-axis')
              .call(yAxis);

            // Pulse point at current now position
            const latest = throughputSamples[throughputSamples.length - 1];
            if (latest) {
              const cx = xScale(latest.timeAgo);
              const cy = yScale(latest.dpm);

              g.append('circle')
                .attr('cx', cx)
                .attr('cy', cy)
                .attr('r', 7)
                .attr('fill', 'rgba(6, 182, 212, 0.35)');

              g.append('circle')
                .attr('cx', cx)
                .attr('cy', cy)
                .attr('r', 3.5)
                .attr('class', 'd3-point');
            }

            // Interactive Tooltip on hover
            const tooltip = document.getElementById('d3-chart-tooltip');
            const bisect = d3.bisector(d => d.timeAgo).center;

            svg.on('mousemove', function (event) {
              if (!tooltip) return;
              const [mx, my] = d3.pointer(event, g.node());
              if (mx < 0 || mx > innerW || my < 0 || my > innerH) {
                tooltip.style.display = 'none';
                return;
              }
              const x0 = xScale.invert(mx);
              const idx = bisect(throughputSamples, x0);
              const d = throughputSamples[idx];
              if (d) {
                tooltip.style.display = 'block';
                tooltip.style.left = `${margin.left + xScale(d.timeAgo)}px`;
                tooltip.style.top = `${margin.top + yScale(d.dpm)}px`;
                tooltip.innerHTML = `<strong>${d.timeAgo === 0 ? 'Now' : d.timeAgo + 's'}</strong>: ${d.dpm.toFixed(1)} DPM`;
              }
            });

            svg.on('mouseleave', function () {
              if (tooltip) tooltip.style.display = 'none';
            });
          } else {
            // Offline Zero-Setup Fallback Renderer
            renderFallbackSVG(svgEl, innerW, innerH, margin, width, height);
          }
        }

        function renderFallbackSVG(svgEl, innerW, innerH, margin, width, height) {
          svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
          svgEl.innerHTML = '';

          const maxDataDpm = throughputSamples.reduce((max, d) => Math.max(max, d.dpm), 0);
          const yDomainMax = Math.max(6, Math.ceil(maxDataDpm * 1.3));

          const getX = t => margin.left + ((t + 60) / 60) * innerW;
          const getY = v => margin.top + innerH - (v / yDomainMax) * innerH;

          let pathD = '';
          let areaD = `M ${getX(-60)} ${margin.top + innerH} `;

          throughputSamples.forEach((pt, i) => {
            const x = getX(pt.timeAgo);
            const y = getY(pt.dpm);
            if (i === 0) {
              pathD += `M ${x} ${y}`;
              areaD += `L ${x} ${y}`;
            } else {
              pathD += ` L ${x} ${y}`;
              areaD += ` L ${x} ${y}`;
            }
          });
          areaD += ` L ${getX(0)} ${margin.top + innerH} Z`;

          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          defs.innerHTML = `
            <linearGradient id="d3-throughput-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.4"/>
              <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.0"/>
            </linearGradient>
          `;
          svgEl.appendChild(defs);

          // Grid lines
          for (let tick = 0; tick <= 4; tick++) {
            const yVal = (tick / 4) * yDomainMax;
            const yPos = getY(yVal);
            const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            gridLine.setAttribute('x1', margin.left);
            gridLine.setAttribute('y1', yPos);
            gridLine.setAttribute('x2', margin.left + innerW);
            gridLine.setAttribute('y2', yPos);
            gridLine.setAttribute('stroke', 'rgba(255,255,255,0.05)');
            svgEl.appendChild(gridLine);

            const yText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            yText.setAttribute('x', margin.left - 6);
            yText.setAttribute('y', yPos + 3);
            yText.setAttribute('text-anchor', 'end');
            yText.setAttribute('fill', '#64748b');
            yText.setAttribute('font-size', '9px');
            yText.setAttribute('font-family', 'ui-monospace, monospace');
            yText.textContent = Math.round(yVal);
            svgEl.appendChild(yText);
          }

          // X Axis ticks
          [-60, -45, -30, -15, 0].forEach(t => {
            const xPos = getX(t);
            const xText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            xText.setAttribute('x', xPos);
            xText.setAttribute('y', margin.top + innerH + 16);
            xText.setAttribute('text-anchor', 'middle');
            xText.setAttribute('fill', '#64748b');
            xText.setAttribute('font-size', '9px');
            xText.setAttribute('font-family', 'ui-monospace, monospace');
            xText.textContent = t === 0 ? 'Now' : `${t}s`;
            svgEl.appendChild(xText);
          });

          // Area
          const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          areaPath.setAttribute('d', areaD);
          areaPath.setAttribute('fill', 'url(#d3-throughput-gradient)');
          svgEl.appendChild(areaPath);

          // Line
          const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          linePath.setAttribute('d', pathD);
          linePath.setAttribute('fill', 'none');
          linePath.setAttribute('stroke', '#06b6d4');
          linePath.setAttribute('stroke-width', '2.2');
          svgEl.appendChild(linePath);

          // Pulse point
          const latest = throughputSamples[throughputSamples.length - 1];
          if (latest) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', getX(0));
            circle.setAttribute('cy', getY(latest.dpm));
            circle.setAttribute('r', '3.5');
            circle.setAttribute('fill', '#06b6d4');
            circle.setAttribute('stroke', '#fff');
            circle.setAttribute('stroke-width', '1.5');
            svgEl.appendChild(circle);
          }
        }

        // --- RENDERING PIPELINE (HTML5 Canvas API) ---
        const canvas = document.getElementById('sim-canvas');
        const ctx = canvas.getContext('2d');
        let baseScale = 1;
        let zoomLevel = 1.0;
        let viewScale = 1;
        let viewOffsetX = 0;
        let viewOffsetY = 0;
        let panOffsetX = 0;
        let panOffsetY = 0;

        function updateZoomUI() {
          const pct = Math.round(zoomLevel * 100);
          const navLabel = document.getElementById('nav-zoom-label');
          if (navLabel) navLabel.textContent = `Zoom: ${pct}%`;
          const vpIndicator = document.getElementById('viewport-zoom-indicator');
          if (vpIndicator) vpIndicator.textContent = `${pct}%`;

          // Update active check in dropdown
          document.querySelectorAll('[data-zoom]').forEach(btn => {
            const z = parseFloat(btn.dataset.zoom);
            const isMatch = Math.abs(z - zoomLevel) < 0.05;
            btn.classList.toggle('active', isMatch);
          });
        }

        function setZoom(newZoom, centerX = null, centerY = null) {
          const clamped = Math.min(Math.max(newZoom, 0.4), 3.5);
          const rect = canvas.parentElement.getBoundingClientRect();
          const cx = centerX !== null ? centerX : rect.width / 2;
          const cy = centerY !== null ? centerY : rect.height / 2;

          // Maintain mouse or screen center anchor point
          const oldScale = baseScale * zoomLevel;
          const newScale = baseScale * clamped;

          const worldX = (cx - (viewOffsetX + panOffsetX)) / oldScale;
          const worldY = (cy - (viewOffsetY + panOffsetY)) / oldScale;

          zoomLevel = clamped;
          viewScale = newScale;

          panOffsetX = cx - viewOffsetX - worldX * newScale;
          panOffsetY = cy - viewOffsetY - worldY * newScale;

          updateZoomUI();
        }

        function resetZoom() {
          zoomLevel = 1.0;
          panOffsetX = 0;
          panOffsetY = 0;
          viewScale = baseScale * zoomLevel;
          updateZoomUI();
          addTelemetry('P2P', 'Viewport zoom reset to default warehouse fit (100%).');
        }

        function resizeCanvas() {
          const rect = canvas.parentElement.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          canvas.width = rect.width * dpr;
          canvas.height = rect.height * dpr;
          canvas.style.width = rect.width + 'px';
          canvas.style.height = rect.height + 'px';

          // Fit world to cover the screen entirely
          const scaleX = rect.width / WORLD_W;
          const scaleY = rect.height / WORLD_H;
          baseScale = Math.max(scaleX, scaleY);
          viewScale = baseScale * zoomLevel;
          viewOffsetX = (rect.width - WORLD_W * viewScale) / 2;
          viewOffsetY = (rect.height - WORLD_H * viewScale) / 2;
          updateZoomUI();
        }

        window.addEventListener('resize', () => {
          resizeCanvas();
          renderD3ThroughputChart();
        });
        resizeCanvas();

        // Layer visibility toggles
        let showP2PMesh = true;
        let showTrajectories = true;
        let showHalos = true;
        let showAllNav = false; // Clean Focused View by default to prevent visual clutter; toggle to show all simultaneously

        function drawWarehouseFloor() {
          // Floor base
          ctx.fillStyle = '#0a0e1a';
          ctx.fillRect(0, 0, WORLD_W, WORLD_H);

          // Subtle floor grid
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
          ctx.lineWidth = 1;
          for (let x = 0; x <= WORLD_W; x += CELL_SIZE) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, WORLD_H);
            ctx.stroke();
          }
          for (let y = 0; y <= WORLD_H; y += CELL_SIZE) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(WORLD_W, y);
            ctx.stroke();
          }

          // Main transit corridors with dashed lane markers
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
          ctx.setLineDash([8, 8]);
          // Central crossway
          ctx.beginPath();
          ctx.moveTo(24 * CELL_SIZE + CELL_SIZE / 2, 2 * CELL_SIZE);
          ctx.lineTo(24 * CELL_SIZE + CELL_SIZE / 2, 29 * CELL_SIZE);
          ctx.stroke();
          // Horizontal highway
          ctx.beginPath();
          ctx.moveTo(3 * CELL_SIZE, 14 * CELL_SIZE + CELL_SIZE / 2);
          ctx.lineTo(44 * CELL_SIZE, 14 * CELL_SIZE + CELL_SIZE / 2);
          ctx.stroke();
          ctx.setLineDash([]);

          // Central intersection hazard box
          drawHazardZone(23 * CELL_SIZE, 13 * CELL_SIZE, 3 * CELL_SIZE, 3 * CELL_SIZE, 'CHOKE POINT: MAIN JUNCTION');

          // Draw Shelving Racks
          racks.forEach(rack => {
            const rx = rack.c1 * CELL_SIZE;
            const ry = rack.r1 * CELL_SIZE;
            const rw = (rack.c2 - rack.c1 + 1) * CELL_SIZE;
            const rh = (rack.r2 - rack.r1 + 1) * CELL_SIZE;

            // Shadow
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(rx + 2, ry + 2, rw, rh);

            // Rack body
            ctx.fillStyle = '#1e2638';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(rx, ry, rw, rh);

            // Shelf bays & pallet graphics
            const bayW = CELL_SIZE;
            const bayH = CELL_SIZE;
            for (let bx = rx; bx < rx + rw - 2; bx += bayW) {
              for (let by = ry; by < ry + rh - 2; by += bayH) {
                // Shelf uprights
                ctx.fillStyle = '#0f172a';
                ctx.fillRect(bx + 2, by + 2, bayW - 4, bayH - 4);
                // Pallet cargo box
                ctx.fillStyle = '#3b4252';
                ctx.fillRect(bx + 4, by + 4, bayW - 8, bayH - 8);
              }
            }

            // Rack Label
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 9px ' + 'var(--font-mono)';
            ctx.fillText(rack.label, rx + 4, ry - 4);
          });

          // Draw Stations
          drawStation(STATIONS.PICKUP_1, '#10b981', 'INBOUND 1');
          drawStation(STATIONS.PICKUP_2, '#10b981', 'INBOUND 2');
          drawStation(STATIONS.PICKUP_3, '#10b981', 'INBOUND 3');

          drawStation(STATIONS.DROPOFF_1, '#a855f7', 'PACK DOCK 1');
          drawStation(STATIONS.DROPOFF_2, '#a855f7', 'PACK DOCK 2');
          drawStation(STATIONS.DROPOFF_3, '#a855f7', 'PACK DOCK 3');

          drawChargingBay(STATIONS.CHARGE_1, 'DOCK 1');
          drawChargingBay(STATIONS.CHARGE_2, 'DOCK 2');

          // Draw Custom Stations
          Object.keys(STATIONS).forEach(key => {
            const st = STATIONS[key];
            if (st && st.custom) {
              const col = st.type === 'pickup' ? '#10b981' : st.type === 'dropoff' ? '#a855f7' : st.type === 'charge' ? '#06b6d4' : '#38bdf8';
              drawStation(st, col, (st.name || 'CUSTOM DOCK').toUpperCase());
            }
          });

          // Draw Dynamic Obstacles
          dynamicObstacles.forEach(idx => {
            const c = idx % GRID_COLS;
            const r = Math.floor(idx / GRID_COLS);
            const ox = c * CELL_SIZE;
            const oy = r * CELL_SIZE;

            // Hazard striped box
            ctx.save();
            ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
            ctx.fillRect(ox, oy, CELL_SIZE, CELL_SIZE);
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.strokeRect(ox + 1, oy + 1, CELL_SIZE - 2, CELL_SIZE - 2);

            // Caution Cross
            ctx.beginPath();
            ctx.moveTo(ox + 3, oy + 3);
            ctx.lineTo(ox + CELL_SIZE - 3, oy + CELL_SIZE - 3);
            ctx.moveTo(ox + CELL_SIZE - 3, oy + 3);
            ctx.lineTo(ox + 3, oy + CELL_SIZE - 3);
            ctx.stroke();

            // Label
            ctx.fillStyle = '#f87171';
            ctx.font = 'bold 8px ' + 'var(--font-mono)';
            ctx.fillText('SPILL', ox + 2, oy + CELL_SIZE / 2 + 3);
            ctx.restore();
          });
        }

        function drawHazardZone(x, y, w, h, label) {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.05)';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);

          ctx.fillStyle = 'rgba(245, 158, 11, 0.4)';
          ctx.font = 'bold 8px ' + 'var(--font-mono)';
          ctx.fillText(label, x + 4, y + 10);
        }

        function drawStation(st, color, title) {
          const sw = CELL_SIZE * 1.5;
          const sh = CELL_SIZE * 2;
          const sx = st.x - sw / 2;
          const sy = st.y - sh / 2;

          ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
          ctx.fillRect(sx, sy, sw, sh);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx, sy, sw, sh);

          // Rollers texture
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
          ctx.lineWidth = 1;
          for (let ry = sy + 6; ry < sy + sh - 4; ry += 6) {
            ctx.beginPath();
            ctx.moveTo(sx + 3, ry);
            ctx.lineTo(sx + sw - 3, ry);
            ctx.stroke();
          }

          ctx.fillStyle = color;
          ctx.font = 'bold 8px ' + 'var(--font-mono)';
          ctx.fillText(title, sx, sy - 4);
        }

        function drawChargingBay(st, title) {
          const sw = CELL_SIZE * 2;
          const sh = CELL_SIZE * 1.4;
          const sx = st.x - sw / 2;
          const sy = st.y - sh / 2;

          ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
          ctx.fillRect(sx, sy, sw, sh);
          ctx.strokeStyle = '#06b6d4';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx, sy, sw, sh);

          // Induction coil symbol
          ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(st.x, st.y, 8, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#06b6d4';
          ctx.font = 'bold 8px ' + 'var(--font-mono)';
          ctx.fillText(title, sx + 4, sy - 4);
        }

        // Draw P2P Network Mesh Lines & Radio Pulses
        function drawP2PMesh() {
          if (!showP2PMesh) return;

          for (let i = 0; i < fleet.length; i++) {
            for (let j = i + 1; j < fleet.length; j++) {
              const a = fleet[i];
              const b = fleet[j];

              // In clean view (!showAllNav), only draw mesh links connected to the selected AMR (or between yielding/conflict robots)
              if (!showAllNav && selectedAMR) {
                const isConflict = a.state === 'YIELDING' || b.state === 'YIELDING';
                if (a !== selectedAMR && b !== selectedAMR && !isConflict) continue;
              }

              const dist = Math.hypot(b.x - a.x, b.y - a.y);

              if (dist <= COMMS_RADIUS) {
                packetsCountInWindow++;
                const opacity = (1 - dist / COMMS_RADIUS) * 0.5;

                // Mesh broadcast line
                ctx.strokeStyle = `rgba(6, 182, 212, ${opacity})`;
                ctx.lineWidth = 1.2;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
                ctx.setLineDash([]);

                // Traveling radio packet animation
                const packetPhase = (simTime * 2.5) % 1.0;
                const px = a.x + (b.x - a.x) * packetPhase;
                const py = a.y + (b.y - a.y) * packetPhase;
                ctx.fillStyle = '#38bdf8';
                ctx.beginPath();
                ctx.arc(px, py, 2.5, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }

        // Draw AMR Robot, Trajectories, and Halos
        function drawAMRs() {
          fleet.forEach(amr => {
            const isSel = amr === selectedAMR;
            // Clean view mode: only render full navigation graphics (trajectories, LIDAR cones, halos, waypoints)
            // for the selected AMR or during active yielding/conflict, eliminating visual clutter
            const showThisAmrNav = showAllNav || isSel || (!selectedAMR && amr === fleet[0]);

            // 1. P2P Radio Broadcast Halo
            if (showHalos && (showAllNav || isSel)) {
              ctx.strokeStyle = isSel ? 'rgba(6, 182, 212, 0.35)' : 'rgba(255, 255, 255, 0.04)';
              ctx.lineWidth = 1;
              ctx.setLineDash([6, 6]);
              ctx.beginPath();
              ctx.arc(amr.x, amr.y, COMMS_RADIUS, 0, Math.PI * 2);
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // 2. Safety Clearance Halo
            if (showHalos && (showThisAmrNav || amr.state === 'YIELDING')) {
              ctx.strokeStyle = amr.state === 'YIELDING' ? 'rgba(245, 158, 11, 0.7)' : amr.color + '44';
              ctx.fillStyle = amr.state === 'YIELDING' ? 'rgba(245, 158, 11, 0.1)' : amr.color + '11';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(amr.x, amr.y, SAFETY_RADIUS, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }

            // 3. Sensor Cone (LIDAR sweep forward)
            if (showHalos && showThisAmrNav) {
              ctx.save();
              ctx.translate(amr.x, amr.y);
              ctx.rotate(amr.heading);
              ctx.fillStyle = amr.color + '18';
              ctx.beginPath();
              ctx.moveTo(0, 0);
              ctx.arc(0, 0, 52, -Math.PI / 4, Math.PI / 4);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }

            // 4. Planned Path and Projected Space-Time Trajectory Horizon
            if (showTrajectories && showThisAmrNav) {
              // Full planned corridor path line
              if (amr.path && amr.path.length > 0 && amr.pathIndex < amr.path.length) {
                ctx.save();
                ctx.strokeStyle = amr.color + '44';
                ctx.lineWidth = isSel ? 1.8 : 1.2;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(amr.x, amr.y);
                for (let i = amr.pathIndex; i < amr.path.length; i++) {
                  ctx.lineTo(amr.path[i].x, amr.path[i].y);
                }
                ctx.stroke();
                ctx.restore();
              }

              // Dynamic projected space-time horizon vector
              if (amr.predictedHorizon && amr.predictedHorizon.length > 1) {
                ctx.strokeStyle = amr.state === 'YIELDING' ? 'rgba(245, 158, 11, 0.9)' : amr.color;
                ctx.lineWidth = isSel ? 2.5 : 1.6;
                ctx.beginPath();
                ctx.moveTo(amr.x, amr.y);
                for (let i = 1; i < amr.predictedHorizon.length; i++) {
                  ctx.lineTo(amr.predictedHorizon[i].x, amr.predictedHorizon[i].y);
                }
                ctx.stroke();

                // Trajectory Space-Time Beads
                amr.predictedHorizon.forEach((wp, idx) => {
                  if (idx % 2 === 0 && idx > 0) {
                    ctx.fillStyle = amr.color;
                    ctx.beginPath();
                    ctx.arc(wp.x, wp.y, 2.5, 0, Math.PI * 2);
                    ctx.fill();
                  }
                });
              }
            }

            // 5. Space-Time Conflict Alert Marker
            if (amr.spaceTimeConflictPoint && (showThisAmrNav || isSel || amr.state === 'YIELDING')) {
              const cp = amr.spaceTimeConflictPoint;
              const pulse = (Math.sin(simTime * 8) + 1) / 2;
              ctx.save();
              ctx.strokeStyle = '#ef4444';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(cp.x, cp.y, 14 + pulse * 6, 0, Math.PI * 2);
              ctx.stroke();

              ctx.fillStyle = '#f59e0b';
              ctx.beginPath();
              ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
              ctx.fill();

              // Warning Tag
              ctx.fillStyle = '#ef4444';
              ctx.font = 'bold 9px ' + 'var(--font-mono)';
              ctx.fillText(`CONFLICT t=${cp.time?.toFixed(1)}s`, cp.x + 8, cp.y - 8);
              ctx.restore();
            }

            // 6. AMR Physical Chassis
            ctx.save();
            ctx.translate(amr.x, amr.y);
            ctx.rotate(amr.heading);

            // Drop shadow
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.beginPath();
            ctx.roundRect(-14, -12, 28, 24, 4);
            ctx.fill();

            // Tread Wheels
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(-12, -15, 24, 4); // Left tread
            ctx.fillRect(-12, 11, 24, 4);  // Right tread

            // Main Industrial Chassis
            ctx.fillStyle = isSel ? '#ffffff' : '#1e293b';
            ctx.strokeStyle = amr.color;
            ctx.lineWidth = isSel ? 2.5 : 1.8;
            ctx.beginPath();
            ctx.roundRect(-14, -11, 28, 22, 5);
            ctx.fill();
            ctx.stroke();

            // Inner Accent Plate
            ctx.fillStyle = amr.color + '33';
            ctx.fillRect(-8, -7, 16, 14);

            // Payload Cargo Box (if carrying)
            if (amr.carryingPayload) {
              ctx.fillStyle = '#3b82f6';
              ctx.strokeStyle = '#93c5fd';
              ctx.lineWidth = 1;
              ctx.fillRect(-6, -5, 12, 10);
              ctx.strokeRect(-6, -5, 12, 10);
            }

            // Forward Direction Indicator Arrow
            ctx.fillStyle = amr.color;
            ctx.beginPath();
            ctx.moveTo(10, 0);
            ctx.lineTo(4, -5);
            ctx.lineTo(4, 5);
            ctx.closePath();
            ctx.fill();

            // Rotating LIDAR scanner turret on top
            ctx.fillStyle = '#0f172a';
            ctx.beginPath();
            ctx.arc(0, 0, 4, 0, Math.PI * 2);
            ctx.fill();

            // Status LED flasher
            const ledColor = amr.state === 'NAVIGATING' ? '#10b981' :
                             amr.state === 'YIELDING' ? '#f59e0b' :
                             amr.state === 'CHARGING' ? '#06b6d4' : '#ef4444';
            ctx.fillStyle = ledColor;
            ctx.beginPath();
            ctx.arc(-8, 0, 2, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();

            // 7. AMR Overhead Tag
            ctx.fillStyle = isSel ? '#ffffff' : '#cbd5e1';
            ctx.font = 'bold 10px ' + 'var(--font-mono)';
            ctx.fillText(amr.id, amr.x - 18, amr.y - 18);

            // Priority Badge above head
            ctx.fillStyle = amr.color;
            ctx.font = 'bold 9px ' + 'var(--font-mono)';
            ctx.fillText(`P${amr.priority}`, amr.x + 18, amr.y - 18);

            // 8. Target Destination Waypoint Pin
            if (amr.currentTargetStation) {
              const tx = amr.currentTargetStation.x;
              const ty = amr.currentTargetStation.y;
              if (amr.currentTargetStation.isManualWaypoint || isSel || showAllNav) {
                ctx.save();
                ctx.strokeStyle = amr.color;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.arc(tx, ty, 9 + Math.sin(simTime * 5) * 2.5, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = amr.color;
                ctx.beginPath();
                ctx.arc(tx, ty, 3.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.setLineDash([]);
                ctx.font = 'bold 8.5px var(--font-mono)';
                ctx.fillText(`🎯 ${amr.id}`, tx + 10, ty + 3);
                ctx.restore();
              }
            }
          });
        }

        // --- HARD COLLISION AUDITOR ---
        function checkCollisions() {
          for (let i = 0; i < fleet.length; i++) {
            for (let j = i + 1; j < fleet.length; j++) {
              const a = fleet[i];
              const b = fleet[j];
              const d = Math.hypot(b.x - a.x, b.y - a.y);
              if (d < 18) {
                // Physical overlap breached!
                a.collisionsCount++;
                b.collisionsCount++;
                totalCollisions++;
                document.getElementById('hdr-collisions').textContent = totalCollisions;
                document.getElementById('hdr-collisions').style.color = '#ef4444';
                addTelemetry('COLLISION', `CRITICAL: Proximity breach between ${a.id} and ${b.id} at (${Math.round(a.x)}, ${Math.round(a.y)})!`);
              }
            }
          }
        }

        // --- MAIN SIMULATION LOOP ---
        let lastTime = performance.now();
        let secondTimer = 0;

        function mainLoop(now) {
          const rawDt = (now - lastTime) / 1000;
          lastTime = now;
          const dt = Math.min(0.1, rawDt) * (isRunning ? simSpeed : 0);

          if (isRunning) {
            simTime += dt;
            document.getElementById('hdr-sim-time').textContent = formatSimTime(simTime);

            // 1. P2P Neighborhood Horizon Exchange
            fleet.forEach(amr => {
              amr.evaluateP2PBroadcast(fleet);
            });

            // 2. Kinematics & Physics update
            fleet.forEach(amr => {
              amr.update(dt);
            });

            // 3. Collision safety check
            checkCollisions();

            // 4. Update packet telemetry rate every second
            secondTimer += rawDt;
            if (secondTimer >= 1.0) {
              packetsPerSec = Math.round(packetsCountInWindow / secondTimer);
              document.getElementById('hdr-packets').textContent = packetsPerSec;
              packetsCountInWindow = 0;
              secondTimer = 0;

              // Update total deconflictions counter
              const totalDeconf = fleet.reduce((acc, r) => acc + r.deconflictionsCount, 0);
              document.getElementById('hdr-deconflictions').textContent = totalDeconf;

              // Update D3 Throughput metrics & chart
              updateThroughputMetrics();
            }
          }

          // Render Pass
          ctx.save();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          
          const dpr = window.devicePixelRatio || 1;
          ctx.scale(dpr, dpr);
          
          // Apply transformation to center warehouse world with zoom and pan
          ctx.translate(viewOffsetX + panOffsetX, viewOffsetY + panOffsetY);
          ctx.scale(viewScale, viewScale);

          drawWarehouseFloor();
          drawP2PMesh();
          drawAMRs();

          ctx.restore();

          // Update HUD fleet cards (throttled every few frames)
          updateFleetCardsUI();

          requestAnimationFrame(mainLoop);
        }

        requestAnimationFrame(mainLoop);

        // --- UI & DASHBOARD UPDATES ---
        function updateFleetCardsUI() {
          const container = document.getElementById('fleet-card-list');
          if (!container) return;

          // Build or update cards
          fleet.forEach((amr, idx) => {
            let card = document.getElementById(`card-${amr.id}`);
            if (!card) {
              card = document.createElement('div');
              card.id = `card-${amr.id}`;
              card.className = 'robot-card';
              card.onclick = () => selectAMR(amr);
              container.appendChild(card);
            }

            if (amr === selectedAMR) {
              card.classList.add('selected');
            } else {
              card.classList.remove('selected');
            }

            const statusClass = `status-${amr.state.toLowerCase()}`;
            const battPct = Math.round(amr.battery);
            const battColor = battPct > 40 ? '#10b981' : battPct > 20 ? '#f59e0b' : '#ef4444';

            card.innerHTML = `
              <div class="robot-card-top">
                <div class="robot-identity">
                  <span class="robot-id-tag" style="background:${amr.accent}; color:${amr.color};">${amr.id}</span>
                  <span class="robot-name">${amr.name}</span>
                </div>
                <span class="status-pill ${statusClass}">
                  ${amr.state}
                </span>
              </div>

              <div class="robot-meta-grid">
                <div class="meta-item">
                  <span class="meta-label">Priority</span>
                  <span class="meta-value" style="color:${amr.color};">P${amr.priority} (${amr.priorityReason.split(' ')[0]})</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Speed</span>
                  <span class="meta-value">${(amr.speed / 20).toFixed(1)} m/s</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Deconflicts</span>
                  <span class="meta-value" style="color:var(--accent-amber);">${amr.deconflictionsCount}</span>
                </div>
              </div>

              <div style="display:flex; flex-direction:column; gap:3px;">
                <div style="display:flex; justify-content:space-between; font-size:10px; font-family:var(--font-mono);">
                  <span style="color:var(--text-muted);">BATTERY</span>
                  <span style="color:${battColor}; font-weight:700;">${battPct}%</span>
                </div>
                <div class="battery-track">
                  <div class="battery-fill" style="width:${battPct}%; background:${battColor};"></div>
                </div>
              </div>

              <div class="robot-footer">
                <span style="font-size:10.5px; color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:240px;">
                  ${amr.statusReason}
                </span>
                <div class="card-actions">
                  <button class="mini-btn btn-primary" onclick="event.stopPropagation(); window.openAmrEditor('${amr.id}');" title="Manual Edit AMR">✏️ Edit</button>
                  <button class="mini-btn" onclick="event.stopPropagation(); window.overridePriority('${amr.id}');" title="Elevate Priority">P+</button>
                  <button class="mini-btn" onclick="event.stopPropagation(); window.sendToCharge('${amr.id}');" title="Send to Charger">⚡</button>
                </div>
              </div>
            `;
          });
        }

        function selectAMR(amr) {
          selectedAMR = amr;
          addTelemetry('P2P', `Selected ${amr.id} for telemetry telemetry tracking.`);
        }

        window.overridePriority = function (id) {
          const amr = fleet.find(r => r.id === id);
          if (amr) {
            amr.priority = amr.priority >= 5 ? 2 : amr.priority + 1;
            amr.priorityReason = 'Manual Operator Override';
            addTelemetry('P2P', `Operator override: ${amr.id} priority set to P${amr.priority}`);
          }
        };

        window.sendToCharge = function (id) {
          const amr = fleet.find(r => r.id === id);
          if (amr) {
            const charger = Math.random() > 0.5 ? STATIONS.CHARGE_1 : STATIONS.CHARGE_2;
            amr.currentTargetStation = charger;
            amr.priority = 5;
            amr.priorityReason = 'Manual Charger Dispatch';
            amr.replan();
            addTelemetry('BATTERY', `${amr.id} dispatched manually to ${charger.name}`);
          }
        };

        // --- TELEMETRY LOG RENDERER ---
        let currentFilter = 'ALL';
        const logContainer = document.getElementById('telemetry-log');

        function renderTelemetryLog() {
          if (!logContainer) return;
          const filtered = telemetryLogs.filter(item => {
            if (currentFilter === 'ALL') return true;
            if (currentFilter === 'CONFLICT') return item.tag === 'DECONFLICT';
            if (currentFilter === 'DETOUR') return item.tag === 'DETOUR' || item.tag === 'OBSTACLE';
            if (currentFilter === 'P2P') return item.tag === 'P2P' || item.tag === 'MISSION';
            return true;
          });

          logContainer.innerHTML = filtered.map(log => {
            const tagClass = `log-tag-${log.tag.toLowerCase()}`;
            return `
              <div class="log-row">
                <span class="log-time">[${log.time}]</span>
                <span class="log-tag ${tagClass}">[${log.tag}]</span>
                <span class="log-msg">${escapeHtml(log.message)}</span>
              </div>
            `;
          }).join('');
        }

        function escapeHtml(str) {
          return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        // --- INTERACTION & EVENT LISTENERS ---
        // Nav Dropdowns (Tools, View Layers, & Zoom)
        const btnNavTool = document.getElementById('btn-nav-tool');
        const menuNavTool = document.getElementById('menu-nav-tool');
        const btnNavView = document.getElementById('btn-nav-view');
        const menuNavView = document.getElementById('menu-nav-view');
        const btnNavZoom = document.getElementById('btn-nav-zoom');
        const menuNavZoom = document.getElementById('menu-nav-zoom');

        function closeAllNavDropdowns() {
          btnNavTool?.classList.remove('open');
          menuNavTool?.classList.remove('show');
          btnNavView?.classList.remove('open');
          menuNavView?.classList.remove('show');
          btnNavZoom?.classList.remove('open');
          menuNavZoom?.classList.remove('show');
        }

        btnNavTool?.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = menuNavTool?.classList.contains('show');
          closeAllNavDropdowns();
          if (!isOpen) {
            btnNavTool.classList.add('open');
            menuNavTool?.classList.add('show');
          }
        });

        btnNavView?.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = menuNavView?.classList.contains('show');
          closeAllNavDropdowns();
          if (!isOpen) {
            btnNavView.classList.add('open');
            menuNavView?.classList.add('show');
          }
        });

        btnNavZoom?.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = menuNavZoom?.classList.contains('show');
          closeAllNavDropdowns();
          if (!isOpen) {
            btnNavZoom.classList.add('open');
            menuNavZoom?.classList.add('show');
          }
        });

        // Zoom dropdown preset buttons
        document.querySelectorAll('[data-zoom]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const z = parseFloat(btn.dataset.zoom);
            setZoom(z);
            closeAllNavDropdowns();
            addTelemetry('P2P', `Viewport zoom preset activated: ${Math.round(z * 100)}%`);
          });
        });

        document.getElementById('btn-zoom-reset-dropdown')?.addEventListener('click', (e) => {
          e.stopPropagation();
          resetZoom();
          closeAllNavDropdowns();
        });

        // Floating Viewport Zoom Controls (+, -, ⟲)
        document.getElementById('btn-zoom-in')?.addEventListener('click', (e) => {
          e.stopPropagation();
          setZoom(zoomLevel + 0.25);
        });

        document.getElementById('btn-zoom-out')?.addEventListener('click', (e) => {
          e.stopPropagation();
          setZoom(zoomLevel - 0.25);
        });

        document.getElementById('btn-zoom-reset')?.addEventListener('click', (e) => {
          e.stopPropagation();
          resetZoom();
        });

        document.addEventListener('click', (e) => {
          if (!e.target.closest('.nav-dropdown-wrapper')) {
            closeAllNavDropdowns();
          }
        });

        // Tool Selector with Label and Icon Updates
        const toolButtons = document.querySelectorAll('[data-tool]');
        const currentToolIcon = document.getElementById('current-tool-icon');
        const currentToolName = document.getElementById('current-tool-name');

        const toolMeta = {
          select: { icon: '🖱️', label: 'Tool: Select' },
          pan: { icon: '✋', label: 'Tool: Pan Canvas' },
          target: { icon: '🎯', label: 'Tool: Destination' },
          draw: { icon: '🧱', label: 'Tool: Draw Spill' },
          erase: { icon: '🧽', label: 'Tool: Erase' },
          station: { icon: '📌', label: 'Tool: Add Station' },
          teleport: { icon: '⚡', label: 'Tool: Teleport' }
        };

        function setToolMode(mode) {
          activeTool = mode;
          toolButtons.forEach(btn => {
            const isMatch = btn.dataset.tool === mode;
            btn.classList.toggle('active', isMatch);
            const check = btn.querySelector('.item-check');
            if (check) check.style.display = isMatch ? 'inline' : 'none';
          });

          if (toolMeta[mode]) {
            if (currentToolIcon) currentToolIcon.textContent = toolMeta[mode].icon;
            if (currentToolName) currentToolName.textContent = toolMeta[mode].label;
          }
          canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
          closeAllNavDropdowns();
        }

        toolButtons.forEach(btn => {
          btn.addEventListener('click', () => setToolMode(btn.dataset.tool));
        });

        // Helper to convert screen coordinates to warehouse world coordinates
        function getCanvasWorldCoords(e) {
          const rect = canvas.getBoundingClientRect();
          const clientX = e.clientX - rect.left;
          const clientY = e.clientY - rect.top;
          return {
            x: (clientX - (viewOffsetX + panOffsetX)) / viewScale,
            y: (clientY - (viewOffsetY + panOffsetY)) / viewScale
          };
        }

        function getRobotAtWorldPos(wx, wy) {
          for (let amr of fleet) {
            if (Math.hypot(amr.x - wx, amr.y - wy) < 22) {
              return amr;
            }
          }
          return null;
        }

        // Canvas interactive mouse & pan operations
        let isMiddlePanning = false;
        let panStartX = 0;
        let panStartY = 0;

        window.__AMR_SIM__ = window.__AMR_SIM__ || {};
        window.__AMR_SIM__.handleWorldClick = function(worldX, worldY) {
          if (worldX < 0 || worldX > WORLD_W || worldY < 0 || worldY > WORLD_H) return;
          
          isPointerDragging = true;
          const clickedRobot = getRobotAtWorldPos(worldX, worldY);
          
          // Use a local pos object to minimize diff changes below
          const pos = { x: worldX, y: worldY };

          if (activeTool === 'select') {
            if (clickedRobot) {
              selectAMR(clickedRobot);
              window.openAmrEditor(clickedRobot.id);
            } else {
              toggleObstacleAtWorldPos(pos.x, pos.y);
            }
          } else if (activeTool === 'target') {
            const targetRobot = selectedAMR || fleet[0];
            if (targetRobot) {
              const c = Math.floor(pos.x / CELL_SIZE);
              const r = Math.floor(pos.y / CELL_SIZE);
              targetRobot.setManualDestination(c, r, pos.x, pos.y, 'Target Waypoint');
              playCompleteBeep();
            } else {
              addTelemetry('P2P', 'Please select an AMR first before setting destination.');
            }
          } else if (activeTool === 'draw') {
            const c = Math.floor(pos.x / CELL_SIZE);
            const r = Math.floor(pos.y / CELL_SIZE);
            const idx = gridIndex(c, r);
            if (grid[idx] === 0) {
              grid[idx] = 2;
              dynamicObstacles.add(idx);
              fleet.forEach(amr => amr.replan());
            }
          } else if (activeTool === 'erase') {
            const c = Math.floor(pos.x / CELL_SIZE);
            const r = Math.floor(pos.y / CELL_SIZE);
            const idx = gridIndex(c, r);
            if (grid[idx] === 2) {
              grid[idx] = 0;
              dynamicObstacles.delete(idx);
              fleet.forEach(amr => amr.replan());
            }
          } else if (activeTool === 'station') {
            const c = Math.floor(pos.x / CELL_SIZE);
            const r = Math.floor(pos.y / CELL_SIZE);
            window.openAddStationModal(c, r);
          } else if (activeTool === 'teleport') {
            const targetRobot = selectedAMR || fleet[0];
            if (targetRobot) {
              targetRobot.teleport(pos.x, pos.y);
              playTone(720, 'sine', 0.15, 0.05);
            } else {
              addTelemetry('P2P', 'Please select an AMR first before teleporting.');
            }
          }
        };

        canvas.addEventListener('mousedown', (e) => {
          // Middle click (button 1) or Left click with Space or Alt key or Pan tool initiates viewport pan
          if (e.button === 1 || (e.button === 0 && (e.altKey || e.shiftKey || activeTool === 'pan'))) {
            e.preventDefault();
            isMiddlePanning = true;
            panStartX = e.clientX - panOffsetX;
            panStartY = e.clientY - panOffsetY;
            canvas.style.cursor = 'grab';
            return;
          }

          if (e.button !== 0) return; // Primary left click
          const pos = getCanvasWorldCoords(e);
          window.__AMR_SIM__.handleWorldClick(pos.x, pos.y);
        });

        canvas.addEventListener('mousemove', (e) => {
          if (isMiddlePanning) {
            panOffsetX = e.clientX - panStartX;
            panOffsetY = e.clientY - panStartY;
            return;
          }

          if (!isPointerDragging) return;
          const pos = getCanvasWorldCoords(e);
          if (pos.x < 0 || pos.x > WORLD_W || pos.y < 0 || pos.y > WORLD_H) return;
          const c = Math.floor(pos.x / CELL_SIZE);
          const r = Math.floor(pos.y / CELL_SIZE);
          const idx = gridIndex(c, r);

          if (activeTool === 'draw') {
            if (grid[idx] === 0) {
              grid[idx] = 2;
              dynamicObstacles.add(idx);
              fleet.forEach(amr => amr.replan());
            }
          } else if (activeTool === 'erase') {
            if (grid[idx] === 2) {
              grid[idx] = 0;
              dynamicObstacles.delete(idx);
              fleet.forEach(amr => amr.replan());
            }
          }
        });

        window.addEventListener('mouseup', () => {
          isPointerDragging = false;
          if (isMiddlePanning) {
            isMiddlePanning = false;
            canvas.style.cursor = activeTool === 'pan' ? 'grab' : 'crosshair';
          }
        });

        // Mouse Wheel Zoom
        canvas.addEventListener('wheel', (e) => {
          e.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          const zoomDelta = e.deltaY < 0 ? 0.12 : -0.12;
          setZoom(zoomLevel + zoomDelta, mouseX, mouseY);
        }, { passive: false });

        // Quick Right-Click Dispatch
        canvas.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const pos = getCanvasWorldCoords(e);
          if (pos.x < 0 || pos.x > WORLD_W || pos.y < 0 || pos.y > WORLD_H) return;
          const targetRobot = selectedAMR || fleet[0];
          if (targetRobot) {
            const c = Math.floor(pos.x / CELL_SIZE);
            const r = Math.floor(pos.y / CELL_SIZE);
            targetRobot.setManualDestination(c, r, pos.x, pos.y, 'Direct Waypoint');
            playTone(660, 'sine', 0.1, 0.04);
            addTelemetry('MISSION', `Quick Right-Click: ${targetRobot.id} dispatched to (${Math.round(pos.x)}, ${Math.round(pos.y)})`);
          }
        });

        // Controls
        const btnPlayPause = document.getElementById('btn-play-pause');
        const txtPlayPause = document.getElementById('txt-play-pause');
        const iconPlayPause = document.getElementById('icon-play-pause');

        function togglePlayPause() {
          isRunning = !isRunning;
          txtPlayPause.textContent = isRunning ? 'Pause' : 'Play';
          iconPlayPause.innerHTML = isRunning
            ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
            : '<path d="M8 5v14l11-7z"/>';
          addTelemetry('P2P', isRunning ? 'Simulation resumed.' : 'Simulation paused.');
        }

        btnPlayPause.addEventListener('click', togglePlayPause);

        window.addEventListener('keydown', (e) => {
          if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            togglePlayPause();
          }
        });

        document.getElementById('btn-step').addEventListener('click', () => {
          if (!isRunning) {
            simTime += 0.1;
            fleet.forEach(amr => {
              amr.evaluateP2PBroadcast(fleet);
              amr.update(0.1);
            });
          }
        });

        document.getElementById('btn-reset').addEventListener('click', () => {
          simTime = 0;
          totalDeliveries = 0;
          totalDeconflictions = 0;
          totalCollisions = 0;
          document.getElementById('hdr-deliveries').textContent = '0';
          document.getElementById('hdr-deconflictions').textContent = '0';
          document.getElementById('hdr-collisions').textContent = '0';
          clearAllObstacles();
          deliveryTimestamps.length = 0;
          peakDpm = 0;
          for (let i = 0; i < throughputSamples.length; i++) {
            throughputSamples[i].dpm = 0;
          }
          updateThroughputMetrics();
          fleet.forEach(amr => {
            amr.speed = 0;
            amr.battery = 90;
            amr.deconflictionsCount = 0;
            amr.collisionsCount = 0;
            amr.state = 'NAVIGATING';
            amr.assignNextTask();
          });
          addTelemetry('P2P', 'Fleet simulation reset to initial layout.');
        });

        // Speed buttons
        const speedButtons = document.querySelectorAll('[data-speed]');
        speedButtons.forEach(btn => {
          btn.addEventListener('click', () => {
            speedButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            simSpeed = parseFloat(btn.dataset.speed);
            addTelemetry('P2P', `Simulation clock speed set to ${simSpeed}x`);
          });
        });

        // Toggle layer buttons
        const btnToggleAllNav = document.getElementById('toggle-show-all-nav');
        const chkShowAllNav = document.getElementById('chk-show-all-nav');
        btnToggleAllNav.addEventListener('click', function (e) {
          e.stopPropagation();
          showAllNav = !showAllNav;
          this.classList.toggle('active', showAllNav);
          if (chkShowAllNav) chkShowAllNav.style.display = showAllNav ? 'inline' : 'none';
          addTelemetry('P2P', showAllNav 
            ? 'Navigation View: Showing all fleet trajectory lines simultaneously.' 
            : 'Navigation View: Clean Focused mode active (showing selected robot nav only to eliminate clutter).');
        });

        const chkP2p = document.getElementById('chk-p2p');
        document.getElementById('toggle-p2p').addEventListener('click', function (e) {
          e.stopPropagation();
          showP2PMesh = !showP2PMesh;
          this.classList.toggle('active', showP2PMesh);
          if (chkP2p) chkP2p.style.display = showP2PMesh ? 'inline' : 'none';
        });

        const chkTraj = document.getElementById('chk-traj');
        document.getElementById('toggle-traj').addEventListener('click', function (e) {
          e.stopPropagation();
          showTrajectories = !showTrajectories;
          this.classList.toggle('active', showTrajectories);
          if (chkTraj) chkTraj.style.display = showTrajectories ? 'inline' : 'none';
        });

        const chkHalos = document.getElementById('chk-halos');
        document.getElementById('toggle-halos').addEventListener('click', function (e) {
          e.stopPropagation();
          showHalos = !showHalos;
          this.classList.toggle('active', showHalos);
          if (chkHalos) chkHalos.style.display = showHalos ? 'inline' : 'none';
        });

        // Clear Obstacles button
        document.getElementById('btn-clear-obstacles').addEventListener('click', clearAllObstacles);

        // Sound Toggle
        const btnSound = document.getElementById('btn-sound');
        const soundLabel = document.getElementById('sound-label');
        if (btnSound && soundLabel) {
          btnSound.addEventListener('click', () => {
            initAudio();
            soundEnabled = !soundEnabled;
            soundLabel.textContent = soundEnabled ? 'Audio: On' : 'Audio: Off';
            btnSound.classList.toggle('active', soundEnabled);
            if (soundEnabled) playConflictBeep();
          });
        }

        // Tab Navigation
        const tabBtns = document.querySelectorAll('.tab-btn');
        const tabPanes = document.querySelectorAll('.tab-pane');
        tabBtns.forEach(btn => {
          btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => (p.style.display = 'none'));
            btn.classList.add('active');
            const targetPane = document.getElementById(`pane-${btn.dataset.tab}`);
            if (targetPane) targetPane.style.display = 'flex';
            if (btn.dataset.tab === 'arch') {
              setTimeout(renderD3ThroughputChart, 40);
            }
          });
        });

        // Log Filter & Clear
        document.getElementById('log-filter').addEventListener('change', (e) => {
          currentFilter = e.target.value;
          renderTelemetryLog();
        });
        document.getElementById('btn-clear-log').addEventListener('click', () => {
          telemetryLogs.length = 0;
          renderTelemetryLog();
        });

        // --- TEST SCENARIO PRESETS ---
        // Scenario 1: Choke Point Standoff (Two robots head-on in central aisle)
        document.getElementById('scen-choke').addEventListener('click', () => {
          clearAllObstacles();
          // AMR-01 Alpha from left to right through middle aisle
          fleet[0].x = 13 * CELL_SIZE;
          fleet[0].y = 14 * CELL_SIZE + CELL_SIZE / 2;
          fleet[0].heading = 0;
          fleet[0].priority = 4;
          fleet[0].priorityReason = 'Rush Express (P4)';
          fleet[0].currentTargetStation = STATIONS.DROPOFF_2;
          fleet[0].replan();

          // AMR-02 Beta from right to left in same aisle
          fleet[1].x = 35 * CELL_SIZE;
          fleet[1].y = 14 * CELL_SIZE + CELL_SIZE / 2;
          fleet[1].heading = Math.PI;
          fleet[1].priority = 2;
          fleet[1].priorityReason = 'Empty Relocation (P2)';
          fleet[1].currentTargetStation = STATIONS.PICKUP_2;
          fleet[1].replan();

          addTelemetry('DECONFLICT', 'SCENARIO LOADED: Head-on Aisle Choke Point. AMR-02 should yield to AMR-01.');
        });

        // Scenario 2: 4-Way Crossroad Convergence
        document.getElementById('scen-cross').addEventListener('click', () => {
          clearAllObstacles();
          const cx = 24 * CELL_SIZE + CELL_SIZE / 2;
          const cy = 14 * CELL_SIZE + CELL_SIZE / 2;

          fleet[0].x = cx - 180;
          fleet[0].y = cy;
          fleet[0].heading = 0;
          fleet[0].priority = 4;
          fleet[0].priorityReason = 'Critical Order';
          fleet[0].currentTargetStation = STATIONS.DROPOFF_2;
          fleet[0].replan();

          fleet[1].x = cx + 180;
          fleet[1].y = cy;
          fleet[1].heading = Math.PI;
          fleet[1].priority = 2;
          fleet[1].priorityReason = 'Standard Loaded';
          fleet[1].currentTargetStation = STATIONS.PICKUP_2;
          fleet[1].replan();

          fleet[2].x = cx;
          fleet[2].y = cy + 180;
          fleet[2].heading = -Math.PI / 2;
          fleet[2].priority = 3;
          fleet[2].priorityReason = 'Tote Transfer';
          fleet[2].currentTargetStation = STATIONS.PICKUP_1;
          fleet[2].replan();

          fleet[3].x = cx;
          fleet[3].y = cy - 180;
          fleet[3].heading = Math.PI / 2;
          fleet[3].priority = 1;
          fleet[3].priorityReason = 'Empty Return';
          fleet[3].currentTargetStation = STATIONS.CHARGE_1;
          fleet[3].replan();

          addTelemetry('DECONFLICT', 'SCENARIO LOADED: 4-Way Crossroad Convergence. AMRs negotiating right-of-way symmetrically via P2P.');
        });

        // Scenario 3: Dynamic Obstacle Spill in front of AMR-01
        document.getElementById('scen-spill').addEventListener('click', () => {
          const amr = fleet[0];
          if (amr.path && amr.path.length > amr.pathIndex + 3) {
            const nextWp = amr.path[amr.pathIndex + 2];
            toggleObstacleAtWorldPos(nextWp.x, nextWp.y);
          } else {
            toggleObstacleAtWorldPos(amr.x + 60, amr.y);
          }
        });

        // Scenario 4: Low Battery Priority Override
        document.getElementById('scen-batt').addEventListener('click', () => {
          fleet[1].battery = 14;
          fleet[1].assignNextTask();
          addTelemetry('BATTERY', 'SCENARIO LOADED: AMR-02 battery drained to 14%. Elevated to Priority 5 (Emergency Docking).');
        });

        // Initial Seed Logs
        addTelemetry('P2P', 'Edge-AI Distributed Fleet Bus initialized (Zero-Central-Server architecture).');
        addTelemetry('P2P', '4 Autonomous Mobile Robots active on localized peer-to-peer ad-hoc network.');
        addTelemetry('MISSION', 'Dispatching AMRs to storage racks and picking bays.');

        // --- MANUAL EDITORS & MODAL CONTROLLERS ---
        let currentEditingAmrId = 'AMR-01';

        // 1. AMR Inspector Modal
        const modalAmr = document.getElementById('modal-amr-inspector');
        const amrTabBtns = document.querySelectorAll('.robot-tab-btn');
        const inputAmrName = document.getElementById('edit-amr-name');
        const inputAmrBattery = document.getElementById('edit-amr-battery');
        const lblAmrBattery = document.getElementById('lbl-edit-amr-battery');
        const inputAmrSpeed = document.getElementById('edit-amr-speed');
        const lblAmrSpeed = document.getElementById('lbl-edit-amr-speed');
        const selectAmrState = document.getElementById('edit-amr-state');
        const selectAmrPriority = document.getElementById('edit-amr-priority');
        const inputAmrReason = document.getElementById('edit-amr-priority-reason');
        const chkAmrPayload = document.getElementById('edit-amr-payload');
        const selectAmrStation = document.getElementById('edit-amr-station-select');
        const inputAmrCoordX = document.getElementById('edit-amr-coord-x');
        const inputAmrCoordY = document.getElementById('edit-amr-coord-y');

        function populateAmrEditorForm(amr) {
          if (!amr) return;
          currentEditingAmrId = amr.id;

          amrTabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.robot === amr.id);
          });

          if (inputAmrName) inputAmrName.value = amr.name;
          if (inputAmrBattery) {
            inputAmrBattery.value = Math.round(amr.battery);
            if (lblAmrBattery) lblAmrBattery.textContent = Math.round(amr.battery) + '%';
          }
          if (inputAmrSpeed) {
            inputAmrSpeed.value = Math.round(amr.maxSpeed);
            if (lblAmrSpeed) lblAmrSpeed.textContent = (amr.maxSpeed / 20).toFixed(1) + ' m/s';
          }
          if (selectAmrState) selectAmrState.value = amr.state;
          if (selectAmrPriority) selectAmrPriority.value = String(amr.priority);
          if (inputAmrReason) inputAmrReason.value = amr.priorityReason || '';
          if (chkAmrPayload) chkAmrPayload.checked = !!amr.carryingPayload;

          if (inputAmrCoordX) inputAmrCoordX.value = Math.round(amr.x);
          if (inputAmrCoordY) inputAmrCoordY.value = Math.round(amr.y);

          // Populate stations dropdown
          if (selectAmrStation) {
            selectAmrStation.innerHTML = '';
            Object.keys(STATIONS).forEach(key => {
              const st = STATIONS[key];
              if (st) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = `${st.name} (${st.type.toUpperCase()})`;
                if (amr.currentTargetStation?.name === st.name) {
                  opt.selected = true;
                }
                selectAmrStation.appendChild(opt);
              }
            });
          }
        }

        window.openAmrEditor = function(id) {
          const amr = fleet.find(r => r.id === (id || currentEditingAmrId)) || fleet[0];
          if (amr) {
            populateAmrEditorForm(amr);
            selectAMR(amr);
            if (modalAmr) modalAmr.classList.remove('hidden');
          }
        };

        function closeAmrEditor() {
          if (modalAmr) modalAmr.classList.add('hidden');
        }

        document.getElementById('btn-open-amr-editor')?.addEventListener('click', () => {
          window.openAmrEditor(selectedAMR ? selectedAMR.id : 'AMR-01');
        });
        document.getElementById('btn-close-amr-modal')?.addEventListener('click', closeAmrEditor);
        document.getElementById('btn-cancel-amr-edits')?.addEventListener('click', closeAmrEditor);

        amrTabBtns.forEach(btn => {
          btn.addEventListener('click', () => {
            const amr = fleet.find(r => r.id === btn.dataset.robot);
            if (amr) {
              populateAmrEditorForm(amr);
              selectAMR(amr);
            }
          });
        });

        // Quick battery presets
        document.getElementById('btn-batt-15')?.addEventListener('click', () => {
          if (inputAmrBattery) {
            inputAmrBattery.value = 15;
            if (lblAmrBattery) lblAmrBattery.textContent = '15%';
          }
        });
        document.getElementById('btn-batt-50')?.addEventListener('click', () => {
          if (inputAmrBattery) {
            inputAmrBattery.value = 50;
            if (lblAmrBattery) lblAmrBattery.textContent = '50%';
          }
        });
        document.getElementById('btn-batt-80')?.addEventListener('click', () => {
          if (inputAmrBattery) {
            inputAmrBattery.value = 80;
            if (lblAmrBattery) lblAmrBattery.textContent = '80%';
          }
        });
        document.getElementById('btn-batt-100')?.addEventListener('click', () => {
          if (inputAmrBattery) {
            inputAmrBattery.value = 100;
            if (lblAmrBattery) lblAmrBattery.textContent = '100%';
          }
        });

        inputAmrBattery?.addEventListener('input', (e) => {
          if (lblAmrBattery) lblAmrBattery.textContent = e.target.value + '%';
        });
        inputAmrSpeed?.addEventListener('input', (e) => {
          if (lblAmrSpeed) lblAmrSpeed.textContent = (parseFloat(e.target.value) / 20).toFixed(1) + ' m/s';
        });

        // Station Dispatch button
        document.getElementById('btn-edit-dispatch-station')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr && selectAmrStation) {
            const st = STATIONS[selectAmrStation.value];
            if (st) {
              amr.currentTargetStation = st;
              amr.replan();
              addTelemetry('MISSION', `Manual Dispatch: ${amr.id} dispatched to ${st.name}`);
              playCompleteBeep();
            }
          }
        });

        // Coordinate Dispatch button
        document.getElementById('btn-edit-dispatch-coord')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr && inputAmrCoordX && inputAmrCoordY) {
            const x = Math.max(10, Math.min(WORLD_W - 10, parseFloat(inputAmrCoordX.value) || 100));
            const y = Math.max(10, Math.min(WORLD_H - 10, parseFloat(inputAmrCoordY.value) || 100));
            const c = Math.floor(x / CELL_SIZE);
            const r = Math.floor(y / CELL_SIZE);
            amr.setManualDestination(c, r, x, y, 'Manual Waypoint');
            playCompleteBeep();
          }
        });

        // Coordinate Teleport button
        document.getElementById('btn-edit-teleport')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr && inputAmrCoordX && inputAmrCoordY) {
            const x = Math.max(15, Math.min(WORLD_W - 15, parseFloat(inputAmrCoordX.value) || 100));
            const y = Math.max(15, Math.min(WORLD_H - 15, parseFloat(inputAmrCoordY.value) || 100));
            amr.teleport(x, y);
            playTone(750, 'sine', 0.15, 0.05);
          }
        });

        // D-Pad drive buttons
        document.getElementById('dpad-fwd')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr) amr.teleop('fwd');
        });
        document.getElementById('dpad-back')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr) amr.teleop('back');
        });
        document.getElementById('dpad-left')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr) amr.teleop('left');
        });
        document.getElementById('dpad-right')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr) amr.teleop('right');
        });
        document.getElementById('dpad-stop')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr) amr.teleop('stop');
        });

        // Save & Apply AMR edits
        document.getElementById('btn-save-amr-edits')?.addEventListener('click', () => {
          const amr = fleet.find(r => r.id === currentEditingAmrId);
          if (amr) {
            if (inputAmrName) amr.name = inputAmrName.value.trim() || amr.name;
            if (inputAmrBattery) amr.battery = Math.max(5, Math.min(100, parseFloat(inputAmrBattery.value)));
            if (inputAmrSpeed) amr.maxSpeed = Math.max(15, Math.min(120, parseFloat(inputAmrSpeed.value)));
            if (selectAmrState) amr.state = selectAmrState.value;
            if (selectAmrPriority) amr.priority = parseInt(selectAmrPriority.value, 10);
            if (inputAmrReason) amr.priorityReason = inputAmrReason.value.trim() || 'Manual Operator Override';
            if (chkAmrPayload) amr.carryingPayload = chkAmrPayload.checked;

            addTelemetry('P2P', `Manual parameters applied to ${amr.id} (${amr.name}): P${amr.priority}, ${Math.round(amr.battery)}% batt.`);
            updateFleetCardsUI();
            closeAmrEditor();
          }
        });

        // 2. System & Physics Config Modal
        const modalConfig = document.getElementById('modal-system-config');
        const cfgComms = document.getElementById('cfg-comms');
        const lblCfgComms = document.getElementById('lbl-cfg-comms');
        const cfgSafety = document.getElementById('cfg-safety');
        const lblCfgSafety = document.getElementById('lbl-cfg-safety');
        const cfgYield = document.getElementById('cfg-yield');
        const lblCfgYield = document.getElementById('lbl-cfg-yield');
        const cfgHorizon = document.getElementById('cfg-horizon');
        const lblCfgHorizon = document.getElementById('lbl-cfg-horizon');
        const cfgBattery = document.getElementById('cfg-battery');
        const lblCfgBattery = document.getElementById('lbl-cfg-battery');

        function populateSystemConfig() {
          if (cfgComms) { cfgComms.value = COMMS_RADIUS; if (lblCfgComms) lblCfgComms.textContent = COMMS_RADIUS + ' px'; }
          if (cfgSafety) { cfgSafety.value = SAFETY_RADIUS; if (lblCfgSafety) lblCfgSafety.textContent = SAFETY_RADIUS + ' px'; }
          if (cfgYield) { cfgYield.value = YIELD_CLEARANCE; if (lblCfgYield) lblCfgYield.textContent = YIELD_CLEARANCE + ' px'; }
          if (cfgHorizon) { cfgHorizon.value = HORIZON_SECONDS; if (lblCfgHorizon) lblCfgHorizon.textContent = HORIZON_SECONDS + ' s'; }
          if (cfgBattery) { cfgBattery.value = BATTERY_DRAIN_MULTIPLIER; if (lblCfgBattery) lblCfgBattery.textContent = BATTERY_DRAIN_MULTIPLIER.toFixed(2) + 'x'; }
        }

        window.openSystemConfig = function() {
          populateSystemConfig();
          if (modalConfig) modalConfig.classList.remove('hidden');
        };

        function closeSystemConfig() {
          if (modalConfig) modalConfig.classList.add('hidden');
        }

        document.getElementById('btn-open-system-config')?.addEventListener('click', window.openSystemConfig);
        document.getElementById('btn-close-config-modal')?.addEventListener('click', closeSystemConfig);
        document.getElementById('btn-cancel-sys-config')?.addEventListener('click', closeSystemConfig);

        cfgComms?.addEventListener('input', e => { if (lblCfgComms) lblCfgComms.textContent = e.target.value + ' px'; });
        cfgSafety?.addEventListener('input', e => { if (lblCfgSafety) lblCfgSafety.textContent = e.target.value + ' px'; });
        cfgYield?.addEventListener('input', e => { if (lblCfgYield) lblCfgYield.textContent = e.target.value + ' px'; });
        cfgHorizon?.addEventListener('input', e => { if (lblCfgHorizon) lblCfgHorizon.textContent = e.target.value + ' s'; });
        cfgBattery?.addEventListener('input', e => { if (lblCfgBattery) lblCfgBattery.textContent = parseFloat(e.target.value).toFixed(2) + 'x'; });

        document.getElementById('btn-apply-sys-config')?.addEventListener('click', () => {
          if (cfgComms) COMMS_RADIUS = parseFloat(cfgComms.value);
          if (cfgSafety) SAFETY_RADIUS = parseFloat(cfgSafety.value);
          if (cfgYield) YIELD_CLEARANCE = parseFloat(cfgYield.value);
          if (cfgHorizon) HORIZON_SECONDS = parseFloat(cfgHorizon.value);
          if (cfgBattery) BATTERY_DRAIN_MULTIPLIER = parseFloat(cfgBattery.value);

          addTelemetry('P2P', `System Parameters Tuned: Comms=${COMMS_RADIUS}px, Safety=${SAFETY_RADIUS}px, Yield=${YIELD_CLEARANCE}px, Horizon=${HORIZON_SECONDS}s, BattDrain=${BATTERY_DRAIN_MULTIPLIER}x`);
          closeSystemConfig();
        });

        document.getElementById('btn-reset-sys-config')?.addEventListener('click', () => {
          COMMS_RADIUS = 180;
          SAFETY_RADIUS = 26;
          YIELD_CLEARANCE = 44;
          HORIZON_SECONDS = 4.5;
          BATTERY_DRAIN_MULTIPLIER = 1.0;
          populateSystemConfig();
          addTelemetry('P2P', 'System parameters restored to factory defaults.');
        });

        // 3. Layout Raw JSON Modal
        const modalJson = document.getElementById('modal-layout-json');
        const txtLayoutJson = document.getElementById('txt-layout-json');

        function generateLayoutJsonString() {
          const customStationsList = Object.keys(STATIONS)
            .filter(k => STATIONS[k].custom)
            .map(k => STATIONS[k]);

          const data = {
            metadata: {
              title: "Autonomous Mobile Robot Warehouse Layout",
              timestamp: new Date().toISOString(),
              version: "2.4.0"
            },
            grid: {
              cols: GRID_COLS,
              rows: GRID_ROWS,
              cellSize: CELL_SIZE,
              worldWidth: WORLD_W,
              worldHeight: WORLD_H
            },
            dynamicObstacles: Array.from(dynamicObstacles),
            customStations: customStationsList,
            systemParameters: {
              commsRadius: COMMS_RADIUS,
              safetyRadius: SAFETY_RADIUS,
              yieldClearance: YIELD_CLEARANCE,
              horizonSeconds: HORIZON_SECONDS,
              batteryDrainMultiplier: BATTERY_DRAIN_MULTIPLIER
            }
          };
          return JSON.stringify(data, null, 2);
        }

        window.openLayoutJson = function() {
          if (txtLayoutJson) {
            txtLayoutJson.value = generateLayoutJsonString();
          }
          if (modalJson) modalJson.classList.remove('hidden');
        };

        function closeLayoutJson() {
          if (modalJson) modalJson.classList.add('hidden');
        }

        document.getElementById('btn-open-layout-json')?.addEventListener('click', window.openLayoutJson);
        document.getElementById('btn-close-json-modal')?.addEventListener('click', closeLayoutJson);
        document.getElementById('btn-cancel-json')?.addEventListener('click', closeLayoutJson);

        document.getElementById('btn-copy-json')?.addEventListener('click', async function() {
          if (txtLayoutJson) {
            try {
              await navigator.clipboard.writeText(txtLayoutJson.value);
              const orig = this.textContent;
              this.textContent = '✓ Copied!';
              setTimeout(() => { this.textContent = orig; }, 1800);
            } catch (err) {
              txtLayoutJson.select();
              document.execCommand('copy');
            }
          }
        });

        document.getElementById('btn-download-json')?.addEventListener('click', () => {
          if (txtLayoutJson) {
            const blob = new Blob([txtLayoutJson.value], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `warehouse-layout-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        });

        document.getElementById('btn-apply-json')?.addEventListener('click', () => {
          if (!txtLayoutJson) return;
          try {
            const data = JSON.parse(txtLayoutJson.value);
            // Apply dynamic obstacles
            if (Array.isArray(data.dynamicObstacles)) {
              clearAllObstacles();
              data.dynamicObstacles.forEach(idx => {
                if (typeof idx === 'number' && idx >= 0 && idx < GRID_COLS * GRID_ROWS) {
                  dynamicObstacles.add(idx);
                  grid[idx] = 2;
                }
              });
            }
            // Apply custom stations
            if (Array.isArray(data.customStations)) {
              data.customStations.forEach((st, i) => {
                const key = `CUSTOM_${i + 1}`;
                STATIONS[key] = {
                  id: key,
                  name: st.name || `Station ${i + 1}`,
                  type: st.type || 'pickup',
                  col: st.col,
                  row: st.row,
                  x: st.x || (st.col * CELL_SIZE + CELL_SIZE / 2),
                  y: st.y || (st.row * CELL_SIZE + CELL_SIZE / 2),
                  custom: true
                };
              });
            }
            // Apply system parameters
            if (data.systemParameters) {
              const sp = data.systemParameters;
              if (typeof sp.commsRadius === 'number') COMMS_RADIUS = sp.commsRadius;
              if (typeof sp.safetyRadius === 'number') SAFETY_RADIUS = sp.safetyRadius;
              if (typeof sp.yieldClearance === 'number') YIELD_CLEARANCE = sp.yieldClearance;
              if (typeof sp.horizonSeconds === 'number') HORIZON_SECONDS = sp.horizonSeconds;
              if (typeof sp.batteryDrainMultiplier === 'number') BATTERY_DRAIN_MULTIPLIER = sp.batteryDrainMultiplier;
            }

            fleet.forEach(amr => amr.replan());
            addTelemetry('P2P', `Loaded and applied layout JSON configuration (${dynamicObstacles.size} obstacles, ${data.customStations?.length || 0} custom stations).`);
            closeLayoutJson();
          } catch (err) {
            alert('Invalid JSON syntax: ' + err.message);
          }
        });

        // 4. Custom Station Modal
        const modalStation = document.getElementById('modal-add-station');
        const inputStationName = document.getElementById('new-station-name');
        const selectStationType = document.getElementById('new-station-type');
        const inputStationCol = document.getElementById('new-station-col');
        const inputStationRow = document.getElementById('new-station-row');
        let nextCustomStationId = 1;

        window.openAddStationModal = function(col, row) {
          pendingStationPos = {
            col: col,
            row: row,
            x: col * CELL_SIZE + CELL_SIZE / 2,
            y: row * CELL_SIZE + CELL_SIZE / 2
          };
          if (inputStationCol) inputStationCol.value = col;
          if (inputStationRow) inputStationRow.value = row;
          if (inputStationName) inputStationName.value = `Dock ${Object.keys(STATIONS).length + 1}`;
          if (modalStation) modalStation.classList.remove('hidden');
        };

        function closeAddStationModal() {
          if (modalStation) modalStation.classList.add('hidden');
        }

        document.getElementById('btn-close-station-modal')?.addEventListener('click', closeAddStationModal);
        document.getElementById('btn-cancel-station')?.addEventListener('click', closeAddStationModal);

        document.getElementById('btn-save-station')?.addEventListener('click', () => {
          const name = inputStationName ? inputStationName.value.trim() : `Custom Station ${nextCustomStationId}`;
          const type = selectStationType ? selectStationType.value : 'pickup';
          const key = `CUSTOM_${nextCustomStationId++}`;

          STATIONS[key] = {
            id: key,
            name: name || `Custom Station`,
            type: type,
            col: pendingStationPos.col,
            row: pendingStationPos.row,
            x: pendingStationPos.x,
            y: pendingStationPos.y,
            custom: true
          };

          addTelemetry('MISSION', `New warehouse station added: "${name}" at cell [${pendingStationPos.col}, ${pendingStationPos.row}].`);
          closeAddStationModal();
          playCompleteBeep();
        });

        // Expose simulation API to AI, Cloud, and Developer Console
        window.__AMR_SIM__ = window.__AMR_SIM__ || {};
        Object.assign(window.__AMR_SIM__, {
          fleet,
          dynamicObstacles,
          STATIONS,
          CELL_SIZE,
          GRID_COLS,
          GRID_ROWS,
          WORLD_W,
          WORLD_H,
          racks,
          addTelemetry,
          toggleObstacleAtWorldPos,
          clearAllObstacles,
          setToolMode,
          getActiveTool: () => activeTool,
          handlePointerDown: (x, y) => {
            isPointerDragging = true;
            window.__AMR_SIM__.handleWorldClick(x, y);
          },
          handlePointerMove: (x, y) => {
            if (!isPointerDragging) return;
            if (x < 0 || x > WORLD_W || y < 0 || y > WORLD_H) return;
            const c = Math.floor(x / CELL_SIZE);
            const r = Math.floor(y / CELL_SIZE);
            const idx = gridIndex(c, r);
            if (activeTool === 'draw') {
              if (grid[idx] === 0) {
                grid[idx] = 2;
                dynamicObstacles.add(idx);
                fleet.forEach(amr => amr.replan());
              }
            } else if (activeTool === 'erase') {
              if (grid[idx] === 2) {
                grid[idx] = 0;
                dynamicObstacles.delete(idx);
                fleet.forEach(amr => amr.replan());
              }
            }
          },
          handlePointerUp: () => {
            isPointerDragging = false;
          },
          handleRightClick: (x, y) => {
            if (x < 0 || x > WORLD_W || y < 0 || y > WORLD_H) return;
            const targetRobot = selectedAMR || fleet[0];
            if (targetRobot) {
              const c = Math.floor(x / CELL_SIZE);
              const r = Math.floor(y / CELL_SIZE);
              targetRobot.setManualDestination(c, r, x, y, 'Direct Waypoint');
              playTone(660, 'sine', 0.1, 0.04);
              addTelemetry('MISSION', `Quick Right-Click: ${targetRobot.id} dispatched to (${Math.round(x)}, ${Math.round(y)})`);
            }
          },
          getShowAllNav: () => showAllNav,
          setShowAllNav: (val) => {
            showAllNav = !!val;
            if (btnToggleAllNav) {
              btnToggleAllNav.classList.toggle('active', showAllNav);
              btnToggleAllNav.textContent = showAllNav ? '✓ All Nav Shown' : '🧭 Show All Nav';
            }
          },
          openAmrEditor: window.openAmrEditor,
          openSystemConfig: window.openSystemConfig,
          openLayoutJson: window.openLayoutJson,
          openAddStationModal: window.openAddStationModal,
          getObstacleList: () => Array.from(dynamicObstacles),
          setObstacleList: (list) => {
            clearAllObstacles();
            if (Array.isArray(list)) {
              list.forEach(idx => {
                dynamicObstacles.add(idx);
                grid[idx] = 2;
              });
              fleet.forEach(amr => amr.replan());
            }
          },
          getSystemParameters: () => ({
            commsRadius: COMMS_RADIUS,
            safetyRadius: SAFETY_RADIUS,
            yieldClearance: YIELD_CLEARANCE,
            horizonSeconds: HORIZON_SECONDS,
            batteryDrainMultiplier: BATTERY_DRAIN_MULTIPLIER
          }),
          setSystemParameters: (params) => {
            if (!params) return;
            if (typeof params.commsRadius === 'number') COMMS_RADIUS = params.commsRadius;
            if (typeof params.safetyRadius === 'number') SAFETY_RADIUS = params.safetyRadius;
            if (typeof params.yieldClearance === 'number') YIELD_CLEARANCE = params.yieldClearance;
            if (typeof params.horizonSeconds === 'number') HORIZON_SECONDS = params.horizonSeconds;
            if (typeof params.batteryDrainMultiplier === 'number') BATTERY_DRAIN_MULTIPLIER = params.batteryDrainMultiplier;
            populateSystemConfig();
          },
          getTelemetrySnapshot: () => {
            return fleet.map(f => `${f.id} (${f.name}): Pos=(${Math.round(f.x)}, ${Math.round(f.y)}), Battery=${Math.round(f.battery)}%, State=${f.state}, Priority=${f.priority} (${f.priorityReason}), Target=${f.currentTargetStation?.name || 'None'}, CarryingPayload=${f.carryingPayload ? 'Yes' : 'No'}`).join('\n');
          },
          setZoom,
          resetZoom,
          getZoomLevel: () => zoomLevel
        });

        // Keyboard shortcuts for quick zoom (+, -, 0)
        window.addEventListener('keydown', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          if (e.key === '+' || e.key === '=') {
            setZoom(zoomLevel + 0.25);
          } else if (e.key === '-' || e.key === '_') {
            setZoom(zoomLevel - 0.25);
          } else if (e.key === '0') {
            resetZoom();
          }
        });
      })();
    