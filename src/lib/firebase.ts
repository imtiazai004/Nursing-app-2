import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer, initializeFirestore } from 'firebase/firestore';
import { toast } from 'sonner';
import firebaseConfig from '@/firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Use initializeFirestore to force long polling, which is more reliable in some proxied environments
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, (firebaseConfig as any).firestoreDatabaseId || '(default)');

const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = async () => {
  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (error: any) {
    console.error("Login Error:", error);
    throw error;
  }
};
export const logout = () => signOut(auth);

async function testConnection() {
  try {
    // Try to reach the server directly to verify config and networking
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firebase connection test successful.");
  } catch (error: any) {
    console.error("Firebase Connection Result:", error.code, error.message);
    if (error.code === 'unavailable') {
      toast.error("Database Unavailable: Check your internet or Firebase region settings.", { id: 'fb-conn-err' });
    } else if (error.code === 'permission-denied') {
      console.warn("Connectivity Test: Document access restricted. This is normal if security rules are strictly enforced.");
    } else if (error.message.includes('the client is offline') || error.code === 'failed-precondition') {
      console.error("Please check your Firebase configuration or setup the database first.");
    }
  }
}

testConnection();
