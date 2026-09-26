import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp
} from "firebase/firestore";

// Configuration from firebase-applet-config.json
const firebaseConfig = {
  projectId: "gen-lang-client-0834911833",
  appId: "1:663008399141:web:10612d5acb6142d8d3d4cc",
  apiKey: "AIzaSyBE_9ucCdG9SxVe4asFUVTFu0W5r35Aw10",
  authDomain: "gen-lang-client-0834911833.firebaseapp.com",
  storageBucket: "gen-lang-client-0834911833.firebasestorage.app",
  messagingSenderId: "663008399141",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, "ai-studio-autonomousmobile-d1b9ca86-b2e6-4c19-9fed-b1164e4e1698");

const googleProvider = new GoogleAuthProvider();

export function handleFirestoreError(error: any, operation: string, path: string) {
  const errPayload = {
    error: error?.message || String(error),
    code: error?.code,
    operation,
    path
  };
  console.error("Firestore operation failure:", errPayload);
  return errPayload;
}

// Connection test on boot
export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, "_connection_test_", "ping"));
    return true;
  } catch (error: any) {
    if (error?.code === "permission-denied") {
      // Permission denied still confirms successful Firestore connection reachability
      return true;
    }
    console.warn("Firestore connection check warning:", error);
    return false;
  }
}

export async function loginWithGoogle(): Promise<User> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    // Persist/update user profile in /users/{userId}
    const userDocRef = doc(db, "users", user.uid);
    await setDoc(
      userDocRef,
      {
        userId: user.uid,
        email: user.email || "",
        displayName: user.displayName || "Warehouse Operator",
        role: "lead",
        createdAt: new Date().toISOString(),
      },
      { merge: true }
    );

    return user;
  } catch (err) {
    handleFirestoreError(err, "loginWithGoogle", "users");
    throw err;
  }
}

export async function logoutUser(): Promise<void> {
  await firebaseSignOut(auth);
}

export interface SavedLayout {
  id: string;
  name: string;
  userId: string;
  obstacles: number[];
  description?: string;
  createdAt: string;
  updatedAt?: string;
}

export async function saveWarehouseLayout(
  name: string,
  obstacles: number[],
  description: string = ""
): Promise<SavedLayout> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Must be signed in to save custom warehouse floorplans.");
  }

  const layoutId = "layout_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const layoutData: SavedLayout = {
    id: layoutId,
    name: name.trim() || "Custom Layout " + new Date().toLocaleTimeString(),
    userId: currentUser.uid,
    obstacles,
    description: description.trim() || "Warehouse sector snapshot",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await setDoc(doc(db, "layouts", layoutId), layoutData);
    return layoutData;
  } catch (err) {
    handleFirestoreError(err, "saveWarehouseLayout", `layouts/${layoutId}`);
    throw err;
  }
}

export async function getSavedLayouts(): Promise<SavedLayout[]> {
  const currentUser = auth.currentUser;
  if (!currentUser) return [];

  try {
    const q = query(collection(db, "layouts"), where("userId", "==", currentUser.uid));
    const snapshot = await getDocs(q);
    const layouts: SavedLayout[] = [];
    snapshot.forEach((docSnap) => {
      layouts.push(docSnap.data() as SavedLayout);
    });
    return layouts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } catch (err) {
    handleFirestoreError(err, "getSavedLayouts", "layouts");
    return [];
  }
}

export async function deleteWarehouseLayout(layoutId: string): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("Authentication required.");

  try {
    await deleteDoc(doc(db, "layouts", layoutId));
  } catch (err) {
    handleFirestoreError(err, "deleteWarehouseLayout", `layouts/${layoutId}`);
    throw err;
  }
}

export async function updateWarehouseLayout(
  layoutId: string,
  updates: Partial<SavedLayout>
): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("Authentication required.");

  try {
    const layoutRef = doc(db, "layouts", layoutId);
    await setDoc(
      layoutRef,
      {
        ...updates,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    handleFirestoreError(err, "updateWarehouseLayout", `layouts/${layoutId}`);
    throw err;
  }
}

export interface FleetMissionRecord {
  id: string;
  userId: string;
  amrId: string;
  taskType: string;
  startNode?: string;
  destNode?: string;
  status: "dispatched" | "in_transit" | "completed" | "halted";
  createdAt: string;
}

export async function logFleetMission(
  amrId: string,
  taskType: string,
  startNode: string,
  destNode: string,
  status: "dispatched" | "in_transit" | "completed" | "halted" = "dispatched"
): Promise<FleetMissionRecord | null> {
  const currentUser = auth.currentUser;
  if (!currentUser) return null; // Silent for unauthenticated local simulation

  const missionId = "mis_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const mission: FleetMissionRecord = {
    id: missionId,
    userId: currentUser.uid,
    amrId,
    taskType,
    startNode,
    destNode,
    status,
    createdAt: new Date().toISOString(),
  };

  try {
    await setDoc(doc(db, "missions", missionId), mission);
    return mission;
  } catch (err) {
    handleFirestoreError(err, "logFleetMission", `missions/${missionId}`);
    return null;
  }
}

export async function getRecentFleetMissions(): Promise<FleetMissionRecord[]> {
  const currentUser = auth.currentUser;
  if (!currentUser) return [];

  try {
    const q = query(collection(db, "missions"), where("userId", "==", currentUser.uid));
    const snapshot = await getDocs(q);
    const missions: FleetMissionRecord[] = [];
    snapshot.forEach((docSnap) => {
      missions.push(docSnap.data() as FleetMissionRecord);
    });
    return missions.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 25);
  } catch (err) {
    handleFirestoreError(err, "getRecentFleetMissions", "missions");
    return [];
  }
}
