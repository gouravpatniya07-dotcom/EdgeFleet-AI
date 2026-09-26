import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Grid } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import Simulation3D from './Simulation3D';

export default function App() {
  return (
    <Canvas camera={{ position: [0, 800, 800], fov: 60, near: 1, far: 10000 }} shadows>
      <color attach="background" args={['#060911']} />
      <fog attach="fog" args={['#060911', 1000, 4000]} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[500, 2000, 1000]} intensity={2} castShadow shadow-mapSize={[2048, 2048]} />
      
      <Simulation3D />
      
      <EffectComposer enableNormalPass={false}>
        <Bloom luminanceThreshold={1} mipmapBlur intensity={1.5} />
      </EffectComposer>

      <OrbitControls makeDefault target={[0, 0, 0]} maxPolarAngle={Math.PI / 2 - 0.05} />
    </Canvas>
  );
}
