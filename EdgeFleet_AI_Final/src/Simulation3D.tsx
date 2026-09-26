import React, { useRef, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export default function Simulation3D() {
  const [racks, setRacks] = useState<any[]>([]);
  const [worldW, setWorldW] = useState(1200);
  const [worldH, setWorldH] = useState(800);
  const [cellSize, setCellSize] = useState(25);

  useEffect(() => {
    const interval = setInterval(() => {
      if ((window as any).__AMR_SIM__) {
        const sim = (window as any).__AMR_SIM__;
        if (racks.length === 0 && sim.racks && sim.racks.length > 0) {
          setRacks(sim.racks);
          setWorldW(sim.WORLD_W || 1200);
          setWorldH(sim.WORLD_H || 800);
          setCellSize(sim.CELL_SIZE || 25);
          clearInterval(interval);
        }
      }
    }, 500);
    return () => clearInterval(interval);
  }, [racks]);

  return (
    <group position={[-worldW / 2, 0, -worldH / 2]}>
      {/* Infinite Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[worldW / 2, -1, worldH / 2]} receiveShadow>
        <planeGeometry args={[10000, 10000]} />
        <meshStandardMaterial color="#0f172a" roughness={0.9} metalness={0.1} />
      </mesh>

      {/* Click Interceptor Plane */}
      <mesh 
        rotation={[-Math.PI / 2, 0, 0]} 
        position={[worldW / 2, 0, worldH / 2]} 
        onPointerDown={(e) => {
          if (e.button !== 0) return; // Only primary click
          const pt = e.point;
          const x = pt.x + worldW / 2;
          const y = pt.z + worldH / 2;
          const sim = (window as any).__AMR_SIM__;
          if (sim && sim.handlePointerDown) {
            sim.handlePointerDown(x, y);
            const tool = sim.getActiveTool ? sim.getActiveTool() : '';
            if (tool === 'draw' || tool === 'erase') {
              e.stopPropagation(); // Prevent orbit controls from stealing drag
              (e.target as any).setPointerCapture(e.pointerId);
            }
          }
        }}
        onPointerMove={(e) => {
          const pt = e.point;
          const x = pt.x + worldW / 2;
          const y = pt.z + worldH / 2;
          const sim = (window as any).__AMR_SIM__;
          if (sim && sim.handlePointerMove) {
            sim.handlePointerMove(x, y);
          }
        }}
        onPointerUp={(e) => {
          const sim = (window as any).__AMR_SIM__;
          if (sim && sim.handlePointerUp) {
            sim.handlePointerUp();
            (e.target as any).releasePointerCapture(e.pointerId);
          }
        }}
        onContextMenu={(e) => {
          e.stopPropagation(); // Stop orbit controls pan if we want to quick-dispatch
          const pt = e.point;
          const x = pt.x + worldW / 2;
          const y = pt.z + worldH / 2;
          const sim = (window as any).__AMR_SIM__;
          if (sim && sim.handleRightClick) {
            sim.handleRightClick(x, y);
          }
        }}
      >
        <planeGeometry args={[worldW, worldH]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
      
      {/* Floor Grid */}
      <gridHelper args={[10000, 10000 / cellSize, '#1e293b', '#0a0e1a']} position={[worldW / 2, 0, worldH / 2]} />

      {/* Racks */}
      {racks.map((rack, i) => {
        const width = (rack.c2 - rack.c1) * cellSize;
        const depth = (rack.r2 - rack.r1) * cellSize;
        const x = rack.c1 * cellSize + width / 2;
        const z = rack.r1 * cellSize + depth / 2;
        const height = 40;
        return (
          <group key={`rack-${i}`} position={[x, height / 2, z]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[width - 2, height, depth - 2]} />
              <meshStandardMaterial color="#1e293b" roughness={0.8} metalness={0.8} />
            </mesh>
            <mesh>
              <boxGeometry args={[width - 2, height, depth - 2]} />
              <meshStandardMaterial color="#000000" emissive="#0ea5e9" emissiveIntensity={2} wireframe={true} transparent opacity={0.3} toneMapped={false} />
            </mesh>
          </group>
        );
      })}

      {/* Stations */}
      {(() => {
        const stations = (window as any).__AMR_SIM__?.STATIONS || {};
        return Object.entries(stations).map(([id, st]: [string, any], i) => {
          const x = (st.col !== undefined ? st.col : st.c) * cellSize + cellSize / 2;
          const z = (st.row !== undefined ? st.row : st.r) * cellSize + cellSize / 2;
          const color = st.type === 'pickup' ? '#10b981' : st.type === 'dropoff' ? '#ef4444' : '#eab308';
          return (
            <group key={`st-${i}`} position={[x, 2, z]}>
              <mesh receiveShadow>
                <boxGeometry args={[cellSize * 2, 4, cellSize * 2]} />
                <meshStandardMaterial color={color} roughness={0.8} metalness={0.2} emissive={color} emissiveIntensity={1.5} toneMapped={false} />
              </mesh>
              <mesh position={[0, 4, 0]}>
                <boxGeometry args={[cellSize * 2 - 4, 1, cellSize * 2 - 4]} />
                <meshStandardMaterial color="#000" emissive="#ffffff" emissiveIntensity={3} wireframe toneMapped={false} />
              </mesh>
            </group>
          );
        });
      })()}

      {/* Obstacles */}
      <DynamicObstacles />

      {/* AMRs */}
      <DynamicFleet />
    </group>
  );
}

function DynamicObstacles() {
  const [obstacles, setObstacles] = useState<number[]>([]);
  const [cellSize, setCellSize] = useState(25);
  const [gridCols, setGridCols] = useState(48);
  
  useEffect(() => {
    const interval = setInterval(() => {
      const sim = (window as any).__AMR_SIM__;
      if (sim && sim.dynamicObstacles) {
        if (sim.dynamicObstacles.size !== obstacles.length) {
          setObstacles(Array.from(sim.dynamicObstacles));
          setCellSize(sim.CELL_SIZE || 25);
          setGridCols(sim.GRID_COLS || 48);
        }
      }
    }, 250);
    return () => clearInterval(interval);
  }, [obstacles.length]);

  return (
    <group>
      {obstacles.map(idx => {
        const c = idx % gridCols;
        const r = Math.floor(idx / gridCols);
        const x = c * cellSize + cellSize / 2;
        const z = r * cellSize + cellSize / 2;
        return (
          <mesh key={`obs-${idx}`} position={[x, 1, z]}>
            <boxGeometry args={[cellSize, 2, cellSize]} />
            <meshStandardMaterial color="#000000" emissive="#ef4444" emissiveIntensity={4} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function DynamicFleet() {
  const [fleetCount, setFleetCount] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => {
      const sim = (window as any).__AMR_SIM__;
      if (sim && sim.fleet && sim.fleet.length !== fleetCount) {
        setFleetCount(sim.fleet.length);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [fleetCount]);

  const amrs = (window as any).__AMR_SIM__?.fleet || [];

  return (
    <group>
      {amrs.map((amr: any, i: number) => (
        <AMRNode key={amr.id || i} amr={amr} />
      ))}
    </group>
  );
}

function AMRNode({ amr }: { amr: any }) {
  const meshRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (meshRef.current) {
      // amr.x and amr.y are the 2D coordinates
      meshRef.current.position.set(amr.x || 0, 10, amr.y || 0);
      // Map the 2D rotation. 3D rotation around Y axis.
      meshRef.current.rotation.y = -(amr.heading || 0);
    }
  });

  const color = amr.id === 'AMR-01' ? '#06b6d4' : 
                amr.id === 'AMR-02' ? '#f59e0b' : 
                amr.id === 'AMR-03' ? '#10b981' : '#a855f7';

  return (
    <group ref={meshRef}>
      {/* Glowing Base Underglow */}
      <mesh position={[0, -5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[30, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} toneMapped={false} />
      </mesh>
      
      {/* Chassis */}
      <mesh castShadow position={[0, 0, 0]}>
        <boxGeometry args={[24, 12, 16]} />
        <meshStandardMaterial color={color} roughness={0.2} metalness={0.9} />
      </mesh>
      {/* Sensor Dome Glow */}
      <mesh castShadow position={[6, 8, 0]}>
        <cylinderGeometry args={[4, 4, 4, 16]} />
        <meshStandardMaterial color="#ffffff" emissive={color} emissiveIntensity={3} toneMapped={false} />
      </mesh>
    </group>
  );
}
